"""The slide master: a deck's layouts and overlays, as the editor's master
view and ``inkflow layout`` / ``inkflow overlay`` show and change them.

Two composition axes make the master (CLAUDE.md, "Overlays are the second
composition axis"): the layout chain *behind* a slide (``base`` → ``numbered``
→ ``title`` → ``agenda``…) and the deck's overlays *on top* of every slide.
Editing "all slides" is editing the root of that chain (the background) or an
overlay; editing "all agenda slides" is editing ``agenda``.

A theme's layouts live in an installed package and are never written. Editing
one first copies it into the project (`copy_bytes`): the same name in
``layouts/``, its ``inkflow:parent`` naming the theme's ancestor explicitly
(``builtin:title``) and ``inkflow:copy-of`` naming the file it replaces. Such a
copy stands in for the theme's file everywhere, also inside the theme's own
chains (`layout.deck_copy`), so a copy of ``base`` is the background of every
built-in layout, and only what was edited is copied. Deleting the copy reverts
to the theme's.

A template is a layout made from a slide (`template_bytes`): its drawing, its
parent, its zones emptied (their text optionally kept as ``inkflow:hint``
prompts), its pictures kept or turned into picture placeholders.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, cast

from lxml import etree

from inkflow import ns
from inkflow.clean import is_preview_layer, strip_preview_layers
from inkflow.editor.previews import sample_zones
from inkflow.editor.provenance import is_element
from inkflow.editor.svgops import SvgFile
from inkflow.layout import (
    AssetKind,
    builtin_theme_dir,
    copy_of,
    discover_assets,
    label_of,
    layout_zones,
    layouts_for,
    resolve_chain,
    resolve_parent_path,
    theme_ref,
)
from inkflow.manifest import Deck, Slide
from inkflow.overlay import Overlay
from inkflow.pipeline import resolve_overlay_chains, resolve_slide_src
from inkflow.svgio import SvgElement

if TYPE_CHECKING:
    from inkflow.themes import Theme


class MasterError(Exception):
    """A slide-master change that cannot be made; the message is for the user."""


# ── Names ─────────────────────────────────────────────────────────────────────


def slug_name(name: str) -> str:
    """A layout file's stem for a typed name: ``customCodeExamples`` →
    ``custom-code-examples``, ``Code examples`` → ``code-examples``."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", name.strip())
    spaced = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", "-", spaced)
    return re.sub(r"[^a-z0-9]+", "-", spaced.lower()).strip("-")


# ── What the deck's master holds ──────────────────────────────────────────────


@dataclass
class LayoutEntry:
    name: str
    path: Path
    """The file slides get: the project's own when it has one."""
    source: str
    """``local`` (the project's own), ``theme`` or ``builtin``."""
    copy_of: str | None = None
    """For the project's copy of a theme layout: the ref it replaces."""
    shadows: bool = False
    """A project layout named like a theme's, not a marked copy of it: it
    replaces the theme's for slides naming it, not inside the theme's chains."""
    label: str | None = None
    parent: str | None = None
    slides: list[int] = field(default_factory=list)
    """Deck indices of the slides built directly on it."""
    reach: list[int] = field(default_factory=list)
    """Deck indices of every slide whose chain goes through it."""


def _layout_entries(deck: Deck, project_dir: Path) -> dict[str, LayoutEntry]:
    found = discover_assets(AssetKind.LAYOUT, project_dir, deck.theme)
    shown = layouts_for(found, deck.effective_size)
    by_name: dict[str, dict[str, Path]] = {}
    for label, path in found:
        by_name.setdefault(path.stem, {})[label] = path
    names = list(dict.fromkeys(p.stem for _, p in shown))
    entries: dict[str, LayoutEntry] = {}
    for name in names:
        sources = by_name[name]
        source = next(s for s in ("local", "theme", "builtin") if s in sources)
        path = sources[source]
        entry = LayoutEntry(name, path, source, label=label_of(path))
        if source == "local":
            entry.copy_of = copy_of(path)
            entry.shadows = entry.copy_of is None and len(sources) > 1
        try:
            chain = resolve_chain(path, project_dir, deck.theme)
        except ValueError:
            chain = []
        entry.parent = chain[-1].stem if chain else None
        entries[name] = entry
    return entries


def slide_layouts(
    deck: Deck, project_dir: Path
) -> list[tuple[Path | None, list[Path]]]:
    """For each deck slide: the layout it is built on directly and every
    layout of its chain (resolved paths)."""
    out: list[tuple[Path | None, list[Path]]] = []
    for slide in deck.slides:
        try:
            src = resolve_slide_src(slide.src, project_dir, deck.theme)
            chain = [p.resolve() for p in resolve_chain(src, project_dir, deck.theme)]
        except (ValueError, OSError):
            out.append((None, []))
            continue
        if _is_layout_file(src, project_dir, deck.theme):
            out.append((src.resolve(), [*chain, src.resolve()]))
        else:
            out.append((chain[-1] if chain else None, chain))
    return out


def _is_layout_file(path: Path, project_dir: Path, theme: Theme | None) -> bool:
    folder = path.resolve().parent
    dirs = [project_dir / "layouts", builtin_theme_dir() / "layouts"]
    if theme is not None:
        dirs.append(theme.layouts_dir)
    return any(folder == d.resolve() for d in dirs)


def layout_entries(deck: Deck, project_dir: Path) -> dict[str, LayoutEntry]:
    """Every layout the deck offers (`layouts_for`), the project's own copy
    winning, with its parent and the slides using it."""
    entries = _layout_entries(deck, project_dir)
    by_path = {e.path.resolve(): e for e in entries.values()}
    for i, (direct, chain) in enumerate(slide_layouts(deck, project_dir)):
        if direct is not None and direct in by_path:
            by_path[direct].slides.append(i)
        for p in chain:
            if p in by_path:
                by_path[p].reach.append(i)
    return entries


def background_name(entries: dict[str, LayoutEntry]) -> str | None:
    """The layout behind every slide: the root of the chains (``base``)."""
    roots = [e for e in entries.values() if e.parent is None]
    if not roots:
        return None
    if "base" in entries and entries["base"].parent is None:
        return "base"

    def weight(e: LayoutEntry) -> tuple[int, int]:
        children = sum(1 for x in entries.values() if x.parent == e.name)
        return (len(e.reach), children)

    return max(roots, key=weight).name


@dataclass
class OverlayEntry:
    src: str
    """As deck.py (or the theme) names it."""
    name: str
    path: Path | None
    source: str
    copy_of: str | None = None
    deck: bool = True
    """Among the deck's default overlays (else: a slide's own or a draft)."""
    slides: list[int] = field(default_factory=list)


def _overlay_source(path: Path, project_dir: Path, theme: Theme | None) -> str:
    ref = theme_ref(path, theme, AssetKind.OVERLAY)
    if ref is not None:
        return ref.partition(":")[0]
    return "local" if path.resolve().is_relative_to(project_dir.resolve()) else "other"


def _resolve_overlay(
    overlay: Overlay, project_dir: Path, theme: Theme | None
) -> Path | None:
    try:
        return resolve_overlay_chains([overlay], project_dir, theme)[0][-1]
    except (ValueError, OSError):
        return None


def overlay_entries(deck: Deck, project_dir: Path) -> list[OverlayEntry]:
    """The deck's overlays (its own or its theme's), then any a slide names
    itself, then the project's overlay files nothing uses yet."""
    out: list[OverlayEntry] = []
    seen: dict[Path, OverlayEntry] = {}

    def add(overlay: Overlay, in_deck: bool) -> OverlayEntry:
        path = _resolve_overlay(overlay, project_dir, deck.theme)
        key = path.resolve() if path is not None else Path(overlay.src)
        if key in seen:
            return seen[key]
        entry = OverlayEntry(
            overlay.src,
            Path(overlay.src).stem,
            path,
            _overlay_source(path, project_dir, deck.theme) if path else "missing",
            copy_of(path) if path is not None else None,
            in_deck,
        )
        seen[key] = entry
        out.append(entry)
        return entry

    for overlay in deck.effective_overlays:
        _ = add(overlay, True)
    for i, slide in enumerate(deck.slides):
        overlays = slide.overlays if slide.overlays is not None else None
        for overlay in overlays if overlays is not None else deck.effective_overlays:
            add(overlay, overlays is None).slides.append(i)
    folder = project_dir / "overlays"
    if folder.is_dir():
        for path in sorted(folder.glob("*.svg")):
            if path.resolve() not in seen:
                entry = OverlayEntry(
                    path.stem, path.stem, path, "local", copy_of(path), False
                )
                seen[path.resolve()] = entry
                out.append(entry)
    return out


def _rel(path: Path | None, project_dir: Path) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        return None


def master_tree(deck: Deck, deck_path: Path) -> dict[str, object]:
    """The master view's list: the background, the overlays on top, every
    layout with its parent and the slides on it (JSON for the editor)."""
    project_dir = deck_path.parent
    entries = layout_entries(deck, project_dir)
    overlays = overlay_entries(deck, project_dir)
    return {
        "background": background_name(entries),
        "layouts": [
            {
                "name": e.name,
                "label": e.label,
                "path": str(e.path),
                "rel": _rel(e.path, project_dir),
                "source": e.source,
                "copyOf": e.copy_of,
                "shadows": e.shadows,
                "parent": e.parent,
                "slides": e.slides,
                "reach": e.reach,
                "zones": _zones(e.path, project_dir, deck.theme),
            }
            for e in entries.values()
        ],
        "overlays": [
            {
                "src": o.src,
                "name": o.name,
                "path": str(o.path) if o.path else None,
                "rel": _rel(o.path, project_dir),
                "source": o.source,
                "copyOf": o.copy_of,
                "deck": o.deck,
                "slides": o.slides,
            }
            for o in overlays
        ],
        "overlaysFromTheme": deck.overlays is None and bool(deck.theme.overlays),
        "overrides": [
            {"slide": i, "overlays": [o.src for o in s.overlays]}
            for i, s in enumerate(deck.slides)
            if s.overlays is not None
        ],
        "canvas": list(deck.effective_size.canvas),
    }


def _zones(path: Path, project_dir: Path, theme: Theme | None) -> list[str]:
    try:
        return layout_zones(path, project_dir, theme).zones
    except (ValueError, OSError):
        return []


# ── Copy-on-write ─────────────────────────────────────────────────────────────

_REF_ATTRS = ("href", f"{{{ns.XLINK}}}href", "src", "poster")
_URL = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)


def _rebase_refs(root: SvgElement, src_dir: Path, dst_dir: Path) -> None:
    """Rewrite the file references written in ``root`` (relative to
    ``src_dir``) so they name the same files from ``dst_dir``. A file outside
    the project stays where it is, named by its absolute path (``inkflow
    pack`` copies such files in)."""
    if src_dir.resolve() == dst_dir.resolve():
        return
    for el in root.iter():
        if not is_element(el):
            continue
        for attr in _REF_ATTRS:
            raw = el.get(attr)
            if not raw or raw.startswith("#") or _URL.match(raw):
                continue
            file, sep, rest = raw.partition("#")
            if not file or os.path.isabs(file):
                continue
            target = (src_dir / file).resolve()
            if not target.exists():
                continue
            new = Path(os.path.relpath(target, dst_dir)).as_posix()
            el.set(attr, new + (sep + rest if sep else ""))


def copy_target(path: Path, project_dir: Path, kind: AssetKind) -> Path:
    """Where the project's copy of the theme's ``path`` goes."""
    return project_dir / kind / path.name


def copy_bytes(
    path: Path, project_dir: Path, theme: Theme | None, kind: AssetKind
) -> bytes:
    """The theme's file ``path`` as the project's own copy: unchanged but for
    its root's ``inkflow:parent`` (naming the theme's ancestor explicitly,
    ``builtin:title``, which the project's copy of that ancestor stands in
    for whenever there is one), ``inkflow:copy-of`` and file references
    rebased onto ``layouts/``. Nothing else moves, so an element's place in
    the file (an editor locator) is the same in both."""
    ref = theme_ref(path, theme, kind)
    if ref is None:
        raise MasterError(f"{path.name} is not a theme's {kind.singular}")
    svg = SvgFile.from_bytes(path, path.read_bytes())
    root = with_inkflow(svg)
    parent = root.get(ns.INKFLOW_PARENT)
    if parent is not None:
        target = resolve_parent_path(
            parent, path.parent, project_dir, theme, kind, False
        )
        named = theme_ref(target, theme, kind)
        root.set(ns.INKFLOW_PARENT, named or target.as_posix())
    root.set(ns.INKFLOW_COPY_OF, ref)
    dest = copy_target(path, project_dir, kind)
    # Only the file's own content: what sits in a preview layer is a copy of
    # another file and is rewritten by the next preview refresh.
    for child in root:
        if not is_preview_layer(child):
            _rebase_refs(child, path.parent, dest.parent)
    return svg.to_bytes()


# ── Templates (a layout made from a slide) ────────────────────────────────────

_PICTURE = re.compile(r"^zone-picture(?:-\d+)?$")


def _unique_zone(base: str, taken: set[str]) -> str:
    zone_id, n = f"zone-{base}", 2
    while zone_id in taken:
        zone_id, n = f"zone-{base}-{n}", n + 1
    taken.add(zone_id)
    return zone_id


def _placeholders_for_pictures(root: SvgElement, taken: set[str]) -> int:
    """Turn the drawing's pictures into picture placeholder zones of the same
    box (a cropped picture: its frame). Returns how many."""
    count = 0
    images = [
        el
        for el in root.iter(f"{{{ns.SVG}}}image")
        if el.getparent() is not None and not _in_preview_layer(el, root)
    ]
    for image in images:
        target = image
        frame = image.getparent()
        if (
            frame is not None
            and frame is not root
            and frame.tag == f"{{{ns.SVG}}}svg"
            and len(frame) == 1
        ):
            target = frame  # a crop: the frame is the visible box
        parent = target.getparent()
        if parent is None:
            continue
        rect = etree.Element(f"{{{ns.SVG}}}rect")
        rect.set("id", _unique_zone("picture", taken))
        for attr in ("x", "y", "width", "height", "transform"):
            value = target.get(attr)
            if value is not None:
                rect.set(attr, value)
        rect.tail = target.tail
        parent.replace(target, rect)
        count += 1
    return count


def _in_preview_layer(el: SvgElement, root: SvgElement) -> bool:
    node = el
    while node is not None and node is not root:
        if is_preview_layer(node):
            return True
        node = node.getparent()
    return False


def _hint_element(zone: str, text: str) -> SvgElement:
    el = etree.Element(ns.INKFLOW_HINT, nsmap={"inkflow": ns.INKFLOW})
    el.set("zone", zone)
    el.text = text
    return el


def hint_of(text: str) -> str:
    """A zone's text as a one-line placeholder prompt: its first line with
    Markdown's heading and list marks taken off, at most 80 characters."""
    for raw in text.splitlines():
        if raw.strip().startswith(("::", "```", "~~~", "<!--")):
            continue
        line = re.sub(r"^\s*(?:#+|[-*+]|\d+[.)]|>)\s*", "", raw).strip()
        line = re.sub(r"[*_`]", "", line).strip()
        if line:
            return line if len(line) <= 80 else line[:79].rstrip() + "…"
    return ""


def with_inkflow(svg: SvgFile) -> SvgElement:
    """The file's root, declaring the ``inkflow:`` prefix (lxml cannot add a
    declaration to an element: the root is rebuilt, its children moved)."""
    root = svg.root
    if ns.INKFLOW in root.nsmap.values():
        return root
    new_root = etree.Element(
        root.tag,
        attrib=cast("dict[str, str]", dict(root.attrib)),
        nsmap=cast("dict[str, str]", {**root.nsmap, "inkflow": ns.INKFLOW}),
    )
    new_root.text = root.text
    for child in root:
        new_root.append(child)
    svg.tree._setroot(new_root)
    return new_root


def _drop(el: SvgElement, name: str) -> None:
    if name in el.attrib:
        del el.attrib[name]


@dataclass
class Template:
    data: bytes
    pictures: int = 0
    """Pictures turned into placeholders."""
    hints: dict[str, str] = field(default_factory=dict)


def template_bytes(
    *,
    dest: Path,
    label: str | None,
    own: Path | None,
    own_data: bytes | None,
    parent: str | None,
    canvas: tuple[float, float],
    hints: dict[str, str],
    pictures: bool,
    zones_taken: set[str],
) -> Template:
    """A layout made from a slide: ``own`` (its own drawing, ``own_data``) or
    nothing but ``parent`` (a slide drawn straight from a layout). The
    drawing's parent is re-expressed from ``dest``'s folder by the caller
    (``parent``); its zones stay, empty; ``hints`` become ``inkflow:hint``
    prompts; with ``pictures`` its pictures become picture placeholders."""
    if own is not None and own_data is not None:
        svg = SvgFile.from_bytes(own, own_data)
        root = svg.root
        strip_preview_layers(root)
        for style in root.iter(f"{{{ns.SVG}}}style"):
            if style.get("id") == "inkflow-preview":
                holder = style.getparent()
                if holder is not None:
                    holder.remove(style)
        for el in list(root.iter(ns.INKFLOW_HINT)):
            holder = el.getparent()
            if holder is not None:
                holder.remove(el)
        _rebase_refs(root, own.parent, dest.parent)
    else:
        w, h = (f"{v:g}" for v in canvas)
        svg = SvgFile.from_bytes(
            dest,
            (
                f'<svg xmlns="{ns.SVG}" viewBox="0 0 {w} {h}" '
                + f'width="{w}" height="{h}"></svg>\n'
            ).encode(),
        )
        root = svg.root
    root = with_inkflow(svg)
    if parent is None:
        _drop(root, ns.INKFLOW_PARENT)
    else:
        root.set(ns.INKFLOW_PARENT, parent)
    _drop(root, ns.INKFLOW_COPY_OF)
    if label and label != dest.stem:
        root.set(ns.INKFLOW_LABEL, label)
    else:
        _drop(root, ns.INKFLOW_LABEL)
    taken = set(zones_taken) | {str(el.get("id")) for el in root.iter() if el.get("id")}
    count = _placeholders_for_pictures(root, taken) if pictures else 0
    kept: dict[str, str] = {}
    for zone, text in hints.items():
        if text:
            el = _hint_element(zone, text)
            el.tail = "\n"
            root.append(el)
            kept[zone] = text
    return Template(svg.to_bytes(), count, kept)


# ── Overlays ──────────────────────────────────────────────────────────────────


def overlay_bytes(canvas: tuple[float, float], backdrop: str | None) -> bytes:
    """A new, empty overlay of the deck's canvas. ``backdrop`` (the deck's
    background layout) is what Inkscape shows behind it (``inkflow:preview``)."""
    w, h = (f"{v:g}" for v in canvas)
    preview = f' inkflow:preview="{backdrop}"' if backdrop else ""
    return (
        f'<svg xmlns="{ns.SVG}" xmlns:inkflow="{ns.INKFLOW}"{preview}\n'
        + f'     viewBox="0 0 {w} {h}" width="{w}" height="{h}">\n'
        + "</svg>\n"
    ).encode()


def overlay_name(raw: str) -> str:
    name = slug_name(raw)
    if not name:
        raise MasterError("give the overlay a name")
    return name


# ── The master view's canvas ──────────────────────────────────────────────────


def master_slide(
    deck: Deck, project_dir: Path, kind: str, path: Path
) -> tuple[Slide, Path]:
    """The one-slide composition the master view draws for a layout or an
    overlay, and the file whose objects are edited there."""
    if kind == "layout":
        zones = sample_zones(path, project_dir, deck.theme)
        return Slide(str(path), zones=dict(zones)), path
    # An overlay: drawn over the background, with the deck's other overlays.
    entries = layout_entries(deck, project_dir)
    background = background_name(entries)
    overlays = [
        o
        for o in deck.effective_overlays
        if (p := _resolve_overlay(o, project_dir, deck.theme)) is not None
        and p.resolve() != path.resolve()
    ]
    overlays.append(Overlay(str(path)))
    if background is None:
        return Slide(str(path), overlays=[]), path
    return Slide(str(entries[background].path), overlays=overlays), path
