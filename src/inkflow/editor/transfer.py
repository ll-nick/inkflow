"""Copy slides and objects between decks through the system clipboard.

Copying packs everything a slide needs into a self-contained bundle: its
``Slide(...)`` call as written in ``deck.py`` and the files that call reaches
(its SVG, Markdown, notes, the project's own layouts it is built on, and every
image or video those reference), read by the server that owns them. Pasting
unpacks the bundle into another project (or the same one) as one undoable
step: a file already there with the same bytes is reused, anything else that
would clash gets a fresh name, and every reference to a renamed file is
rewritten so it still points at its copy.

The clipboard is outside anyone's control, so a pasted ``Slide(...)`` is only
accepted when it is plain data spelled with inkflow's own names (see
``check_slide_code``): pasting can never put arbitrary Python into a deck.
Custom animation or transition classes a deck defines for itself cannot travel
for the same reason; copying drops them and says so.
"""

from __future__ import annotations

import base64
import os
import posixpath
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import cast

import libcst as cst
from typing_extensions import override

import inkflow
from inkflow import animations as animations_module
from inkflow import enums
from inkflow import transitions as transitions_module
from inkflow.assets import is_local_ref, rewrite_references
from inkflow.editor.deckedit import DeckEditError, DeckSource
from inkflow.layout import discover_layouts, resolve_chain
from inkflow.loaders import resolve_content_src
from inkflow.manifest import Chart, Deck, Image, Inline, Video
from inkflow.pipeline import resolve_slide_src

BUNDLE_VERSION = 1
MAX_BUNDLE_BYTES = 80 * 1024 * 1024

ROLES = frozenset({"slide", "md", "notes", "layout", "asset"})
_OWN_ROLES = frozenset({"slide", "md", "notes"})
"""Files that belong to one slide: a paste always gets its own copy."""

_PARENT_RE = re.compile(r'(\binkflow:parent=")([^"]*)(")')
_MD_IMAGE_RE = re.compile(r"(!\[[^\]]*\]\()([^)\s]+)")


class TransferError(Exception):
    """A bundle that cannot be copied or pasted; the message is for the user."""


# ── What a pasted Slide(...) may contain ───────────────────────────────────────

_CALLABLE_NAMES = frozenset(
    {"Slide", "Image", "Video", "TextBox", "Inline", "Overlay", "Chart"}
)
_VALUE_CLASSES: dict[str, object] = {
    name: getattr(enums, name)
    for name in (
        "Trigger",
        "Easing",
        "Direction",
        "Align",
        "VAlign",
        "MediaFit",
        "MediaAlign",
        "Muted",
        "ChartKind",
        "ColorMode",
        "AnimationKind",
    )
}
_VALUE_METHODS = frozenset({"at", "cubic_bezier", "raw"})
_NAMESPACES: dict[str, list[str]] = {
    "animations": list(animations_module.__all__),
    "transitions": list(transitions_module.__all__),
}


def _callee_ok(func: cst.BaseExpression) -> bool:
    if isinstance(func, cst.Name):
        return func.value in _CALLABLE_NAMES
    if isinstance(func, cst.Attribute) and isinstance(func.value, cst.Name):
        base, attr = func.value.value, func.attr.value
        if base in _NAMESPACES:
            return attr in _NAMESPACES[base] and attr not in (
                "Animation",
                "Cue",
                "Enter",
                "Exit",
                "Emphasis",
                "Transition",
            )
        if base in _VALUE_CLASSES:
            return attr in _VALUE_METHODS and hasattr(_VALUE_CLASSES[base], attr)
    return False


def _expr_ok(node: cst.BaseExpression) -> bool:
    if isinstance(node, cst.SimpleString):
        prefix = node.prefix.lower()
        return "f" not in prefix and "b" not in prefix
    if isinstance(node, cst.ConcatenatedString):
        return _expr_ok(node.left) and _expr_ok(node.right)
    if isinstance(node, cst.Integer | cst.Float):
        return True
    if isinstance(node, cst.UnaryOperation):
        return isinstance(node.operator, cst.Minus) and isinstance(
            node.expression, cst.Integer | cst.Float
        )
    if isinstance(node, cst.Name):
        return node.value in ("True", "False", "None")
    if isinstance(node, cst.Attribute) and isinstance(node.value, cst.Name):
        cls = _VALUE_CLASSES.get(node.value.value)
        attr = node.attr.value
        return cls is not None and attr.isupper() and hasattr(cls, attr)
    if isinstance(node, cst.List | cst.Tuple):
        return all(
            isinstance(el, cst.Element) and _expr_ok(el.value) for el in node.elements
        )
    if isinstance(node, cst.Dict):
        return all(
            isinstance(el, cst.DictElement) and _expr_ok(el.key) and _expr_ok(el.value)
            for el in node.elements
        )
    if isinstance(node, cst.Call):
        return _callee_ok(node.func) and all(
            arg.star == "" and _expr_ok(arg.value) for arg in node.args
        )
    return False


def check_slide_code(code: str) -> cst.Call:
    """Parse a pasted ``Slide(...)`` and refuse anything but plain data."""
    try:
        expr = cst.parse_expression(code)
    except cst.ParserSyntaxError as exc:
        raise TransferError("the copied slide is not valid Python") from exc
    if not (
        isinstance(expr, cst.Call)
        and isinstance(expr.func, cst.Name)
        and expr.func.value == "Slide"
        and _expr_ok(expr)
    ):
        raise TransferError(
            "the copied slide uses something other than inkflow's own types"
        )
    return expr


def _names_used(node: cst.CSTNode) -> set[str]:
    """inkflow names a Slide(...) refers to, for the deck's import line."""
    exported = set(inkflow.__all__)
    found: set[str] = set()

    class Visitor(cst.CSTVisitor):
        @override
        def visit_Name(self, node: cst.Name) -> None:
            if node.value in exported:
                found.add(node.value)

    node.visit(Visitor())
    return found


# ── Copy ──────────────────────────────────────────────────────────────────────


@dataclass
class _Packer:
    project_dir: Path
    files: dict[str, dict[str, str]] = field(default_factory=dict)

    def rel(self, path: Path) -> str | None:
        resolved = Path(os.path.abspath(path))
        root = Path(os.path.abspath(self.project_dir))
        if not resolved.is_relative_to(root) or ".venv" in resolved.parts:
            return None
        return resolved.relative_to(root).as_posix()

    def add(self, path: Path, role: str) -> str | None:
        rel = self.rel(path)
        if rel is None or not path.is_file():
            return None
        if rel not in self.files:
            data = path.read_bytes()
            self.files[rel] = {"role": role, "data": base64.b64encode(data).decode()}
            if (
                path.suffix.lower() == ".svg" and role != "asset"
            ) or path.suffix.lower() == ".md":
                self._add_refs(path, data.decode("utf-8", "replace"))
        return rel

    def _add_refs(self, path: Path, text: str) -> None:
        def note(ref: str) -> None:
            if is_local_ref(ref) and not ref.startswith(("#", "/", "_theme/")):
                self.add(path.parent / _file_part(ref)[0], "asset")

        rewrite_references(text, lambda ref: note(ref))
        for match in _MD_IMAGE_RE.finditer(text):
            note(match.group(2))


def _file_part(ref: str) -> tuple[str, str]:
    """A reference as its file and what follows it (``plot.pdf#page=2``: a
    page of a PDF), which stays on the reference wherever the file moves."""
    cut = min((i for i in (ref.find("#"), ref.find("?")) if i > 0), default=len(ref))
    return ref[:cut], ref[cut:]


def _keep(
    items: list[cst.Element] | list[cst.Arg], kept: list[cst.Element] | list[cst.Arg]
) -> list[cst.Element] | list[cst.Arg]:
    """``kept`` with the original last item's comma (trailing comma and the
    whitespace before the closing bracket) moved onto its new last item."""
    if not kept or kept[-1] is items[-1]:
        return kept
    last = kept[-1].with_changes(comma=items[-1].comma)
    return [*kept[:-1], last]  # pyright: ignore[reportReturnType]


def _custom_free(call: cst.Call, dropped: list[str]) -> cst.Call:
    """``call`` without what cannot travel: custom animation/transition types
    (defined in the copied deck's own code) and slide-specific overlays."""
    args: list[cst.Arg] = []
    for arg in call.args:
        name = arg.keyword.value if arg.keyword else None
        if name == "animations" and isinstance(arg.value, cst.List):
            elements = [el for el in arg.value.elements if isinstance(el, cst.Element)]
            kept = [el for el in elements if _expr_ok(el.value)]
            for el in elements:
                if el not in kept:
                    code = cst.Module([]).code_for_node(el.value)
                    dropped.append(f"the animation {code[:60]}")
            if kept:
                value = arg.value.with_changes(elements=_keep(elements, kept))
                args.append(arg.with_changes(value=value))
            continue
        if name == "overlays" and not (
            isinstance(arg.value, cst.List) and not arg.value.elements
        ):
            dropped.append("its own overlays (the receiving deck's apply)")
            continue
        if not _expr_ok(arg.value):
            dropped.append(f"its {name or 'argument'} (a type its deck defines)")
            continue
        args.append(arg)
    return call.with_changes(args=_keep(list(call.args), args))


def export_slides(deck: Deck, deck_path: Path, indices: list[int]) -> dict[str, object]:
    """A bundle of the slides at ``indices`` (deck order) and their files."""
    project_dir = deck_path.parent
    source = DeckSource.read(deck_path)
    if source.slide_calls(expected=len(deck.slides)) is None:
        raise TransferError(
            "deck.py builds its slide list in code; copy these slides by hand"
        )
    packer = _Packer(project_dir)
    slides: list[dict[str, object]] = []
    dropped: list[str] = []
    for index in indices:
        if not 0 <= index < len(deck.slides):
            raise TransferError(f"no slide {index + 1}")
        slide = deck.slides[index]
        try:
            call = source.slide_call(index)
        except DeckEditError as exc:
            raise TransferError(str(exc)) from exc
        call = _custom_free(call, dropped)
        refs: dict[str, object] = {}
        try:
            src_path = resolve_slide_src(slide.src, project_dir, deck.theme)
        except (ValueError, OSError):
            src_path = None
        if src_path is not None:
            in_layouts = "layouts" in Path(packer.rel(src_path) or "").parts
            refs["src"] = packer.add(src_path, "layout" if in_layouts else "slide")
            for ancestor in resolve_chain(src_path, project_dir, deck.theme):
                packer.add(ancestor, "layout")
        if slide.md is not None and not isinstance(slide.md, Inline):
            refs["md"] = packer.add(
                resolve_content_src(str(slide.md), project_dir), "md"
            )
        if slide.notes and not isinstance(slide.notes, Inline):
            notes = Path(str(slide.notes))
            refs["notes"] = packer.add(
                notes if notes.is_absolute() else project_dir / notes, "notes"
            )
        media: dict[str, dict[str, str]] = {}
        for zone, value in slide.zones.items():
            # A chart's data file travels like a picture.
            if isinstance(value, Image | Video | Chart):
                entry: dict[str, str] = {}
                for attr in ("src", "alt_src", "poster"):
                    ref = cast("str | None", getattr(value, attr, None))
                    if ref and is_local_ref(ref):
                        rel = packer.add(project_dir / _file_part(ref)[0], "asset")
                        if rel is not None:
                            entry[ref] = rel
                if entry:
                    media[zone] = entry
        refs["media"] = media
        slides.append(
            {
                "code": cst.Module([]).code_for_node(call),
                "refs": refs,
                "title": slide.title,
            }
        )
    size = sum(len(f["data"]) for f in packer.files.values())
    if size > MAX_BUNDLE_BYTES:
        raise TransferError(
            f"these slides bring {size // 1_000_000} MB of files, too much to copy"
        )
    bundle: dict[str, object] = {
        "type": "inkflow-slides",
        "version": BUNDLE_VERSION,
        "project": str(project_dir.resolve()),
        "slides": slides,
        "files": packer.files,
        "dropped": dropped,
    }
    return bundle


def export_assets(project_dir: Path, refs: list[str]) -> dict[str, dict[str, str]]:
    """The project files behind canonical (project-relative) asset references."""
    packer = _Packer(project_dir)
    for ref in refs:
        if is_local_ref(ref) and not ref.startswith(("#", "/", "_theme/")):
            packer.add(project_dir / _file_part(ref)[0], "asset")
    return packer.files


# ── Paste ─────────────────────────────────────────────────────────────────────


def _safe_rel(rel: object) -> str:
    if not isinstance(rel, str) or not rel:
        raise TransferError("the clipboard holds a malformed file entry")
    pure = PurePosixPath(rel)
    if pure.is_absolute() or ".." in pure.parts or rel.startswith("~"):
        raise TransferError(f"refusing to write {rel!r}: outside the project")
    return pure.as_posix()


@dataclass
class Placement:
    """Where each bundled file lands in the target project."""

    targets: dict[str, str]
    """Bundle rel → target rel (identical files map to themselves)."""
    writes: dict[str, bytes]
    """Target rel → bytes to write (reused files are absent)."""


def _unique_rel(project_dir: Path, rel: str, taken: set[str], avoid: set[str]) -> str:
    pure = PurePosixPath(rel)
    stem, suffix, parent = pure.stem, pure.suffix, pure.parent
    candidate = rel
    n = 2
    while (
        (project_dir / candidate).exists()
        or candidate in taken
        or PurePosixPath(candidate).stem in avoid
    ):
        candidate = (parent / f"{stem}-{n}{suffix}").as_posix()
        n += 1
    return candidate


def place_files(
    project_dir: Path,
    files: dict[str, object],
    layout_names: set[str],
) -> Placement:
    """Decide each bundled file's target path; nothing is written here."""
    targets: dict[str, str] = {}
    datas: dict[str, bytes] = {}
    taken: set[str] = set()
    # Shared files first: own files must not take the names they keep.
    entries = sorted(
        ((rel, cast("dict[str, str]", info)) for rel, info in files.items()),
        key=lambda item: item[1].get("role") in _OWN_ROLES,
    )
    for raw_rel, info in entries:
        rel = _safe_rel(raw_rel)
        role = info.get("role")
        if role not in ROLES:
            raise TransferError(f"unknown file role {role!r}")
        try:
            data = base64.b64decode(info.get("data", ""), validate=True)
        except ValueError as exc:
            raise TransferError("the clipboard holds a damaged file") from exc
        existing = project_dir / rel
        if (
            role not in _OWN_ROLES
            and existing.is_file()
            and existing.read_bytes() == data
        ):
            targets[rel] = rel
            continue
        # A slide SVG named like a layout would shadow that layout for every
        # bare Slide("name") in the deck.
        avoid: set[str] = layout_names if role == "slide" else set()
        target = _unique_rel(project_dir, rel, taken, avoid)
        taken.add(target)
        targets[rel] = target
        datas[target] = data
    return Placement(targets, datas)


def _resolve_parent_rel(value: str, file_rel: str) -> str | None:
    """The project-relative file an ``inkflow:parent`` names, if it is local."""
    if value.startswith(("builtin:", "theme:")):
        return None
    if value.startswith("local:"):
        name = value.removeprefix("local:")
        return f"layouts/{name if name.endswith('.svg') else name + '.svg'}"
    if "/" not in value and not value.startswith("."):
        return f"layouts/{value if value.endswith('.svg') else value + '.svg'}"
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(file_rel), value))
    return joined if joined.endswith(".svg") else joined + ".svg"


def _relative(from_file_rel: str, target_rel: str) -> str:
    return posixpath.relpath(target_rel, posixpath.dirname(from_file_rel) or ".")


def _rewrite_file(
    text: str, old_rel: str, new_rel: str, targets: dict[str, str], svg: bool
) -> str:
    def moved(ref_rel: str) -> str | None:
        target = targets.get(ref_rel)
        return target if target is not None and target != ref_rel else None

    def ref(raw: str) -> str | None:
        if not is_local_ref(raw) or raw.startswith(("#", "/", "_theme/")):
            return None
        file, rest = _file_part(raw)
        source = posixpath.normpath(posixpath.join(posixpath.dirname(old_rel), file))
        target = targets.get(source)
        if target is None or (target == source and old_rel == new_rel):
            return None
        return _relative(new_rel, target) + rest

    text = rewrite_references(text, ref)
    text = _MD_IMAGE_RE.sub(
        lambda m: m.group(1) + (ref(m.group(2)) or m.group(2)), text
    )
    if svg:

        def parent(m: re.Match[str]) -> str:
            value = m.group(2)
            source = _resolve_parent_rel(value, old_rel)
            target = moved(source) if source else None
            if target is None:
                return m.group(0)
            if "/" not in value and not value.startswith("."):
                # Named, so it stays named: the renamed layout's own name.
                new = "local:" + PurePosixPath(target).stem
            else:
                new = _relative(new_rel, target)
            return m.group(1) + new + m.group(3)

        text = _PARENT_RE.sub(parent, text)
    return text


def _string_arg(call: cst.Call, name: str, positional: int | None) -> cst.Arg | None:
    for i, arg in enumerate(call.args):
        if arg.keyword is not None and arg.keyword.value == name:
            return arg
        if arg.keyword is None and positional is not None and i == positional:
            return arg
    return None


def _set_string(call: cst.Call, arg: cst.Arg | None, value: str) -> cst.Call:
    if arg is None:
        return call
    new = arg.with_changes(value=cst.SimpleString(_quote(value)))
    return call.with_changes(args=[new if a is arg else a for a in call.args])


def _quote(value: str) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)


def _src_value(target: str, role: str) -> str:
    pure = PurePosixPath(target)
    if role == "layout" and pure.parent.as_posix() == "layouts":
        return f"local:{pure.stem}"
    if pure.parent.as_posix() == "slides":
        return pure.name
    return target


def _rewrite_call(
    call: cst.Call,
    refs: dict[str, object],
    targets: dict[str, str],
    roles: dict[str, str],
) -> cst.Call:
    src = refs.get("src")
    if isinstance(src, str) and src in targets:
        target = targets[src]
        if target != src or roles.get(src) == "slide":
            call = _set_string(
                call, _string_arg(call, "src", 0), _src_value(target, roles[src])
            )
    md = refs.get("md")
    if isinstance(md, str) and md in targets and targets[md] != md:
        target = PurePosixPath(targets[md])
        value = (
            target.name if target.parent.as_posix() == "slides" else target.as_posix()
        )
        call = _set_string(call, _string_arg(call, "md", None), value)
    notes = refs.get("notes")
    if isinstance(notes, str) and notes in targets and targets[notes] != notes:
        call = _set_string(call, _string_arg(call, "notes", None), targets[notes])
    media = cast("dict[str, dict[str, str]]", refs.get("media") or {})
    if media:
        call = _rewrite_media(call, media, targets)
    return call


def _rewrite_media(
    call: cst.Call, media: dict[str, dict[str, str]], targets: dict[str, str]
) -> cst.Call:
    zones = _string_arg(call, "zones", None)
    if zones is None or not isinstance(zones.value, cst.Dict):
        return call

    def fix(value: cst.BaseExpression) -> cst.BaseExpression:
        if not isinstance(value, cst.Call):
            return value
        out = value
        for i, arg in enumerate(value.args):
            if not isinstance(arg.value, cst.SimpleString):
                continue
            name = arg.keyword.value if arg.keyword else ("src" if i == 0 else None)
            if name not in ("src", "alt_src", "poster"):
                continue
            raw = cast("str", arg.value.evaluated_value)
            for entries in media.values():
                rel = entries.get(raw)
                if rel and targets.get(rel, rel) != rel:
                    page = _file_part(raw)[1]
                    out = _set_string(out, out.args[i], targets[rel] + page)
        return out

    elements = [
        el.with_changes(value=fix(el.value)) if isinstance(el, cst.DictElement) else el
        for el in zones.value.elements
    ]
    new = zones.with_changes(value=zones.value.with_changes(elements=elements))
    return call.with_changes(args=[new if a is zones else a for a in call.args])


@dataclass
class PastePlan:
    writes: dict[str, bytes]
    """Target rel → bytes."""
    calls: list[str]
    """``Slide(...)`` source, one per pasted slide, references rewritten."""
    imports: set[str]
    reused: list[str]


def plan_slide_paste(project_dir: Path, deck: Deck, bundle: object) -> PastePlan:
    """Check a clipboard bundle and work out the files and code it becomes."""
    if not isinstance(bundle, dict):
        raise TransferError("the clipboard holds no inkflow slides")
    data = cast("dict[str, object]", bundle)
    if data.get("type") != "inkflow-slides" or data.get("version") != BUNDLE_VERSION:
        raise TransferError("the clipboard holds no inkflow slides")
    raw_files: object = data.get("files") or {}
    if not isinstance(raw_files, dict):
        raise TransferError("the clipboard holds a malformed bundle")
    files = cast("dict[str, object]", raw_files)
    layout_names = {p.stem for _, p in discover_layouts(project_dir, deck.theme)}
    placement = place_files(project_dir, files, layout_names)
    roles = {
        _safe_rel(rel): str(cast("dict[str, str]", info).get("role"))
        for rel, info in files.items()
    }
    writes: dict[str, bytes] = {}
    for old_rel, new_rel in placement.targets.items():
        if new_rel not in placement.writes:
            continue
        payload = placement.writes[new_rel]
        suffix = PurePosixPath(new_rel).suffix.lower()
        if suffix in (".svg", ".md") and roles[old_rel] != "asset":
            text = payload.decode("utf-8")
            payload = _rewrite_file(
                text, old_rel, new_rel, placement.targets, suffix == ".svg"
            ).encode("utf-8")
        writes[new_rel] = payload
    calls: list[str] = []
    imports: set[str] = set()
    for entry in cast("list[object]", data.get("slides") or []):
        if not isinstance(entry, dict):
            raise TransferError("the clipboard holds a malformed slide")
        slide = cast("dict[str, object]", entry)
        call = check_slide_code(str(slide.get("code", "")))
        refs = cast("dict[str, object]", slide.get("refs") or {})
        call = _rewrite_call(call, refs, placement.targets, roles)
        imports |= _names_used(call)
        calls.append(cst.Module([]).code_for_node(call))
    if not calls:
        raise TransferError("the clipboard holds no slides")
    reused = [t for t in placement.targets.values() if t not in placement.writes]
    return PastePlan(writes, calls, imports, reused)


def plan_slide_replace(project_dir: Path, bundle: object) -> PastePlan:
    """Another version of one slide, taken over in place (the compare view's
    "Take this slide"): unlike a paste, its files are written at their own
    paths, so the slide's SVG, Markdown, notes, layouts and pictures become
    that version's, and its ``Slide(...)`` call needs no rewriting. Files
    already as they should be are left alone (``reused``)."""
    if not isinstance(bundle, dict):
        raise TransferError("there is no slide to take")
    data = cast("dict[str, object]", bundle)
    if data.get("type") != "inkflow-slides" or data.get("version") != BUNDLE_VERSION:
        raise TransferError("there is no slide to take")
    entries = cast("list[object]", data.get("slides") or [])
    if len(entries) != 1 or not isinstance(entries[0], dict):
        raise TransferError("take one slide at a time")
    raw_files: object = data.get("files") or {}
    if not isinstance(raw_files, dict):
        raise TransferError("a malformed slide bundle")
    writes: dict[str, bytes] = {}
    reused: list[str] = []
    for raw_rel, info in cast("dict[str, object]", raw_files).items():
        rel = _safe_rel(raw_rel)
        entry = cast("dict[str, str]", info)
        if entry.get("role") not in ROLES:
            raise TransferError(f"unknown file role {entry.get('role')!r}")
        try:
            payload = base64.b64decode(entry.get("data", ""), validate=True)
        except ValueError as exc:
            raise TransferError("a damaged file in the slide bundle") from exc
        existing = project_dir / rel
        if existing.is_file() and existing.read_bytes() == payload:
            reused.append(rel)
        else:
            writes[rel] = payload
    slide = cast("dict[str, object]", entries[0])
    call = check_slide_code(str(slide.get("code", "")))
    code = cst.Module([]).code_for_node(call)
    return PastePlan(writes, [code], _names_used(call), reused)


def plan_asset_paste(
    project_dir: Path, files: object
) -> tuple[dict[str, bytes], dict[str, str]]:
    """Asset files for pasted objects: (writes, bundle rel → target rel)."""
    if not isinstance(files, dict):
        return {}, {}
    entries = cast("dict[str, object]", files)
    for info in entries.values():
        if cast("dict[str, str]", info).get("role") != "asset":
            raise TransferError("pasted objects can only bring images along")
    placement = place_files(project_dir, entries, set())
    return placement.writes, placement.targets


def retarget_fragment(xml: str, target_file_rel: str, targets: dict[str, str]) -> str:
    """Point a copied object's project-relative image references at their
    copies, relative to the SVG the object is pasted into."""

    def ref(raw: str) -> str | None:
        if not is_local_ref(raw) or raw.startswith(("#", "/", "_theme/")):
            return None
        file, rest = _file_part(raw)
        target = targets.get(file, file)
        return _relative(target_file_rel, target) + rest

    return rewrite_references(xml, ref)
