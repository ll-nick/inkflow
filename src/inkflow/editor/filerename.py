"""Rename or move a project file, with every reference to it following.

Inserted and created files get generated names (``assets/IMG_0042.jpg``,
``data/chart-3.csv``, ``diagrams/diagram-2.drawio.svg``); renaming one by hand
breaks every slide that names it. `plan_rename` works out, without writing
anything, the whole change a rename is: the move itself and the new text of
every file that refers to the renamed one, which the editor session then applies
as one undoable step (``EditorSession._rename``).

A reference is found and rewritten where it is written and resolved the way the
build resolves it, against the file it is written in (inkflow/assets.py): never
by matching a bare name across the project. The kinds of reference:

- in an SVG: ``href``/``xlink:href`` (pictures, draw.io pictures, PDFs with
  their ``#page=``, links), ``src``/``poster`` of embedded HTML, CSS ``url(…)``
  in ``<style>`` and ``style=""``, ``inkflow:parent`` (a bare name in the
  layouts/ or, for an overlay, the overlays/ namespace), the preview-layer
  markers ``inkflow:layout-src``/``overlay-src`` and the authoring hints
  ``inkflow:preview``/``inkflow:preview-overlays``;
- in Markdown (slides, notes, any ``.md``): images and links ``![](…)``,
  ``[](…)``, reference definitions, ``<img>``/``<video>``/``<a>`` tags, and the
  ``data:`` line of a ```` ```chart ```` fence (not ``slide:`` links, not code);
- in CSS files (``styles.css``): ``url(…)`` and ``@import``;
- in deck.py, string literals in calls (libcst, comments and layout kept):
  ``Slide`` src (a file path or a slides/ or layout name), ``md=``, ``notes=``,
  ``ink=``, ``extra_style=``; ``Image``/``Video``/``Chart`` src (and
  ``alt_src``, ``poster``); ``Overlay`` src; ``Deck(style=)``; Markdown in
  ``Inline(…)`` and in plain-string zone values, CSS in ``Inline`` styles.

A slide's id is inferred from its Markdown file's name, else its drawing's, and
its ink is ``ink/<id>.svg``: a rename that changes an id takes the slide's ink
file along and rewrites ``slide:<old id>`` links, as ``inkflow slide rename``
does for an ``id=`` change. A slide whose ink file is renamed directly gets an
``ink=`` naming it. References built in code (``Image(ASSETS / "x.png")``) cannot
be followed; deck.py still naming the old file afterwards is reported.
"""

from __future__ import annotations

import html
import json
import os
import posixpath
import re
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import cast

import libcst as cst
from typing_extensions import override

from inkflow.editor.codegen import Code
from inkflow.editor.deckedit import DeckEditError, DeckSource
from inkflow.ink import ink_path
from inkflow.layout import AssetKind, builtin_theme_dir
from inkflow.manifest import Deck, Inline, Slide
from inkflow.pipeline import slide_ids
from inkflow.themes import Theme


class RenameError(Exception):
    """A rename that cannot be done; the message is for the user."""


class Kind(Enum):
    """How a reference resolves."""

    PATH = "path"
    """A file path relative to the file it is written in."""
    LAYOUT = "layout"
    """``inkflow:parent`` grammar in the layouts/ namespace (``local:x``, a
    bare name searched project → theme → built-in, or a path)."""
    OVERLAY = "overlay"
    """The same grammar in the overlays/ namespace."""
    SLIDE = "slide"
    """``Slide("…")``: a bare name is slides/<name>.svg, else a layout."""
    MD = "md"
    """``Slide(md="…")``: a bare name is slides/<name>.md."""


@dataclass(frozen=True)
class RefEdit:
    """One reference rewritten: where it is written, what kind, old and new."""

    file: str
    kind: str
    old: str
    new: str


@dataclass
class RenamePlan:
    moves: list[tuple[Path, Path]]
    """Absolute old path → new path, for every file that moves."""
    writes: dict[Path, bytes]
    """New contents by the file's path after the moves."""
    edits: list[RefEdit]
    ids: dict[str, str] = field(default_factory=dict)
    """Slide ids that change, old → new."""
    links: int = 0
    """``slide:`` links rewritten."""
    shared: list[str] = field(default_factory=list)
    """Files a slide rename leaves alone because other slides use them too."""
    warnings: list[str] = field(default_factory=list)

    def summary(self, project_dir: Path) -> dict[str, object]:
        """The plan as the editor's preview and the CLI's ``--dry-run`` show it."""
        root = _abs(project_dir)
        return {
            "moves": [
                {"from": _rel(old, root), "to": _rel(new, root)}
                for old, new in self.moves
            ],
            "edits": [
                {"file": e.file, "kind": e.kind, "old": e.old, "new": e.new}
                for e in self.edits
            ],
            "references": len(self.edits),
            "files": len({e.file for e in self.edits}),
            "ids": dict(self.ids),
            "links": self.links,
            "shared": list(self.shared),
            "warnings": list(self.warnings),
        }


# ── Paths ─────────────────────────────────────────────────────────────────────


def _abs(path: Path) -> Path:
    """Absolute and ``..``-free, without resolving symlinks."""
    return Path(os.path.abspath(path))


def _rel(path: Path, base: Path) -> str:
    return Path(os.path.relpath(path, base)).as_posix()


_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def _is_file_ref(ref: str) -> bool:
    """Whether a reference names a file (not a URL, an anchor or a data URI)."""
    return bool(ref) and not ref.startswith(("#", "//")) and not _SCHEME.match(ref)


def _split_ref(ref: str) -> tuple[str, str]:
    """A reference as its file and what follows it (``plot.pdf#page=2``)."""
    cut = min((i for i in (ref.find("#"), ref.find("?")) if i > 0), default=len(ref))
    return ref[:cut], ref[cut:]


def full_suffix(name: str) -> str:
    """A file's kind as its name says it: ``.drawio.svg`` is not just ``.svg``."""
    lower = name.lower()
    if lower.endswith(".drawio.svg"):
        return name[-len(".drawio.svg") :]
    return Path(name).suffix


def _is_bare(raw: str) -> bool:
    """A name rather than a path: no folder, no prefix, not ``./``."""
    return (
        "/" not in raw
        and not raw.startswith((".", "local:", "theme:", "builtin:"))
        and not os.path.isabs(raw)
    )


_NAME = re.compile(r"[\w][\w.+@,=-]*")
_RESERVED_TOP = frozenset({"_theme", "_pdf"})
_FOUND_BY_NAME = frozenset({"deck.py", "styles.css", "scripts.js", "pyproject.toml"})
"""Project files inkflow finds by their name, which a rename would lose."""
_SKIP_DIRS = frozenset({"node_modules", "__pycache__"})
_MAX_SCAN = 20 * 1024 * 1024


def _project_path(root: Path, raw: str, what: str) -> Path:
    """``raw`` (relative to the project, or absolute inside it) as an absolute path."""
    if not raw.strip():
        raise RenameError(f"no {what} file given")
    candidate = Path(raw)
    path = _abs(candidate if candidate.is_absolute() else root / raw)
    if not path.is_relative_to(root) or path == root:
        raise RenameError(f"{raw} is outside the project")
    parts = path.relative_to(root).parts
    if any(p.startswith(".") for p in parts):
        raise RenameError(f"{raw}: inkflow does not rename files in hidden folders")
    if parts[0] in _RESERVED_TOP:
        raise RenameError(f"{raw}: {parts[0]}/ is reserved (theme and PDF pages)")
    return path


def _check_renames(
    root: Path, deck_path: Path, renames: Mapping[str, str]
) -> dict[Path, Path]:
    moves: dict[Path, Path] = {}
    for old_raw, new_raw in renames.items():
        old = _project_path(root, old_raw, "")
        new = _project_path(root, new_raw, "new")
        old_rel, new_rel = _rel(old, root), _rel(new, root)
        if old == _abs(deck_path) or old_rel in _FOUND_BY_NAME:
            raise RenameError(f"{old_rel} is found by its name: it cannot be renamed")
        if not old.is_file():
            raise RenameError(f"{old_rel} does not exist")
        if new == old:
            raise RenameError(f"{old_rel} already has that name")
        for part in Path(new_rel).parts:
            if not _NAME.fullmatch(part):
                raise RenameError(
                    f"{part!r} cannot be part of a file name here: use letters, "
                    + "digits and - _ . (no spaces)"
                )
        old_suffix, new_suffix = full_suffix(old.name), full_suffix(new.name)
        if old_suffix.lower() != new_suffix.lower() or not new.name[
            : -len(new_suffix) or None
        ].strip("."):
            raise RenameError(
                f"keep the extension {old_suffix or '(none)'}: a file's kind is "
                + f"its extension ({new_rel})"
            )
        if new.exists() and not (old.exists() and os.path.samefile(old, new)):
            raise RenameError(f"{new_rel} already exists")
        if new in moves.values() or new in moves:
            raise RenameError(f"{new_rel} is named twice")
        for ancestor in new.parents:
            if ancestor == root:
                break
            if ancestor.exists() and not ancestor.is_dir():
                raise RenameError(f"{_rel(ancestor, root)} is a file, not a folder")
        moves[old] = new
    if not moves:
        raise RenameError("nothing to rename")
    return moves


# ── Resolution ────────────────────────────────────────────────────────────────


@dataclass
class _World:
    """The project before and after the moves, and how references resolve in it."""

    root: Path
    theme: Theme | None
    moves: dict[Path, Path]
    relative: bool = False
    """Write every rewritten reference relative (``plan_copy_in``: an
    absolute path names this machine's folders)."""

    def exists(self, path: Path, after: bool) -> bool:
        if after:
            if path in self.moves.values():
                return True
            if path in self.moves:
                return False
        return path.is_file()

    def _named(self, raw: str, base: Path, kind: AssetKind, after: bool) -> Path | None:
        """`layout.resolve_parent_path`, with existence as it is ``after`` the
        moves; None when nothing is found."""

        def svg(p: Path) -> Path:
            return _abs(p if p.suffix else p.with_suffix(".svg"))

        prefix, sep, name = raw.partition(":")
        if sep and prefix == "local":
            return svg(self.root / kind.value / name)
        if sep and prefix == "theme":
            return (
                svg(self.theme.asset_dir() / kind.value / name) if self.theme else None
            )
        if sep and prefix == "builtin":
            return svg(builtin_theme_dir() / kind.value / name)
        if os.path.isabs(raw):
            return svg(Path(raw))
        if raw.startswith(("./", "../")) or "/" in raw:
            return svg(base / raw)
        candidates = [(svg(self.root / kind.value / raw), True)]
        if self.theme is not None:
            candidates.append((svg(self.theme.asset_dir() / kind.value / raw), False))
        candidates.append((svg(builtin_theme_dir() / kind.value / raw), False))
        for candidate, ours in candidates:
            if self.exists(candidate, after) if ours else candidate.is_file():
                return candidate
        return None

    def resolve(self, raw: str, kind: Kind, base: Path, after: bool) -> Path | None:
        if not raw:
            return None
        if kind is Kind.PATH:
            if not _is_file_ref(raw):
                return None
            file = _split_ref(raw)[0]
            if not file:
                return None
            return _abs(Path(file)) if os.path.isabs(file) else _abs(base / file)
        if kind is Kind.MD:
            p = Path(raw)
            if p.is_absolute():
                return _abs(p if p.suffix else p.with_suffix(".md"))
            if len(p.parts) == 1:
                return _abs(
                    self.root / "slides" / ((p.stem if p.suffix else raw) + ".md")
                )
            return _abs(self.root / (p if p.suffix else p.with_suffix(".md")))
        if kind is Kind.SLIDE:
            if _is_bare(raw):
                name = raw if Path(raw).suffix else raw + ".svg"
                candidate = _abs(self.root / "slides" / name)
                if self.exists(candidate, after):
                    return candidate
            return self._named(raw, self.root, AssetKind.LAYOUT, after)
        namespace = AssetKind.OVERLAY if kind is Kind.OVERLAY else AssetKind.LAYOUT
        return self._named(raw, base, namespace, after)

    def express(self, raw: str, kind: Kind, base: Path, target: Path) -> str:
        """A reference to ``target`` written like ``raw`` was, from ``base``."""
        if kind is Kind.PATH:
            file, rest = _split_ref(raw)
            if os.path.isabs(file) and not self.relative:
                return target.as_posix() + rest
            rel = _rel(target, base)
            if file.startswith("./") and not rel.startswith("../"):
                rel = "./" + rel
            return rel + rest
        if kind is Kind.MD:
            p = Path(raw)
            if p.is_absolute() and not self.relative:
                return str(target)
            if len(p.parts) == 1 and target.parent == self.root / "slides":
                return target.name if p.suffix else target.stem
            rel = _rel(target, self.root)
            if "/" not in rel:
                raise RenameError(
                    f"a slide's Markdown file must be in a folder (slides/{rel})"
                )
            return rel if p.suffix or not rel.endswith(".md") else rel[: -len(".md")]
        if kind is Kind.SLIDE:
            keep = bool(Path(raw).suffix)
            name = target.name if keep else target.stem
            homes = (self.root / "slides", self.root / "layouts")
            if (
                _is_bare(raw)
                and target.parent in homes
                and self.resolve(name, kind, base, after=True) == target
            ):
                return name
            if _is_bare(raw) and target.parent == self.root / "layouts":
                return f"local:{target.stem}"
            if raw.startswith("local:") and target.parent == self.root / "layouts":
                return f"local:{name}"
            if os.path.isabs(raw) and not self.relative:
                return str(target)
            rel = _rel(target, self.root)
            return rel if "/" in rel else f"./{rel}"
        namespace = AssetKind.OVERLAY if kind is Kind.OVERLAY else AssetKind.LAYOUT
        home = self.root / namespace.value
        prefix, sep, rest = raw.partition(":")
        written = rest if sep and prefix in ("local", "theme", "builtin") else raw
        name = target.name if Path(written).suffix else target.stem
        if (_is_bare(raw) or raw.startswith("local:")) and target.parent == home:
            if raw.startswith("local:"):
                return f"local:{name}"
            if self.resolve(name, kind, base, after=True) == target:
                return name
            return f"local:{name}"
        if (
            raw.startswith("theme:")
            and self.theme is not None
            and target.parent == _abs(self.theme.asset_dir() / namespace.value)
        ):
            return f"theme:{name}"
        if os.path.isabs(raw) and not self.relative:
            return str(target)
        rel = _rel(target, base)
        if not Path(written).suffix and rel.endswith(".svg"):
            rel = rel[: -len(".svg")]
        return rel if "/" in rel else f"./{rel}"

    def rewrite(
        self, raw: str, kind: Kind, base_old: Path, base_new: Path, where: str
    ) -> str | None:
        """The new text of a reference, or None when it stays as written."""
        target = self.resolve(raw, kind, base_old, after=False)
        if target is None:
            return None
        new_target = self.moves.get(target, target)
        if new_target == target and (
            base_old == base_new or (kind is not Kind.PATH and not _is_path_form(raw))
        ):
            return None
        new = self.express(raw, kind, base_new, new_target)
        if self.resolve(new, kind, base_new, after=True) != new_target:
            raise RenameError(
                f"{where}: {raw!r} cannot be pointed at {_rel(new_target, self.root)}"
            )
        return None if new == raw else new


def _is_path_form(raw: str) -> bool:
    """A layout/overlay reference written as a path (which a move of the file
    it is written in changes), not as a name."""
    return not _is_bare(raw) and not raw.startswith(("local:", "theme:", "builtin:"))


# ── Scanning: SVG ─────────────────────────────────────────────────────────────

_XML_TOKEN = re.compile(
    r"<!--.*?-->"
    + r"|<!\[CDATA\[(?P<cdata>.*?)\]\]>"
    + r"|<\?.*?\?>"
    + r"|<!(?:[^>\[]|\[[^\]]*\])*>"
    + r"|</(?P<end>[^\s>]+)\s*>"
    + r"|<(?P<start>[^\s/>!?]+)"
    + r"(?P<attrs>(?:\s+[^\s=/>]+\s*=\s*(?:\"[^\"]*\"|'[^']*'))*)\s*(?P<empty>/?)>",
    re.S,
)
_XML_ATTR = re.compile(r"([^\s=/>]+)\s*=\s*(?:\"([^\"]*)\"|'([^']*)')")
_INKFLOW_NS = "urn:inkflow"

Visit = Callable[[str, Kind, str], "str | None"]
"""A scanner's callback: (reference as written, kind, label) → its new text."""


def _xml_escape(value: str, quote: str | None) -> str:
    value = value.replace("&", "&amp;").replace("<", "&lt;")
    if quote == '"':
        value = value.replace('"', "&quot;")
    elif quote == "'":
        value = value.replace("'", "&apos;")
    return value


def _apply(text: str, edits: list[tuple[int, int, str]]) -> str:
    for start, end, new in sorted(edits, reverse=True):
        text = text[:start] + new + text[end:]
    return text


def scan_svg(
    text: str, visit: Visit, overlay: bool = False, marker: Visit | None = None
) -> str:
    """``text`` with every reference ``visit`` rewrites replaced.

    ``marker`` sees the preview layers' ``inkflow:layout-src``/``overlay-src``,
    which name a layer the way the file that declared it did (an ancestor's
    ``inkflow:parent``, a deck ``Overlay``): not necessarily this file
    (default: ``visit``).

    A light tokenizer rather than lxml, so only the changed attribute values
    change and the file keeps its layout. What sits inside a preview layer is
    a copy of a layout or overlay (``inkflow sync``), whose references belong
    to that file: only the layer's own marker is followed there.
    """
    edits: list[tuple[int, int, str]] = []
    stack: list[tuple[str, bool]] = []
    prefixes = {"inkflow"}
    pos = 0
    rooted = False

    def in_style() -> bool:
        return bool(stack) and stack[-1][0] == "style" and not stack[-1][1]

    for m in _XML_TOKEN.finditer(text):
        if in_style() and m.start() > pos:
            segment = text[pos : m.start()]
            css = rewrite_css(html.unescape(segment), visit)
            if css != html.unescape(segment):
                edits.append((pos, m.start(), _xml_escape(css, None)))
        pos = m.end()
        if m.group("cdata") is not None:
            if in_style():
                css = rewrite_css(m.group("cdata"), visit)
                if css != m.group("cdata"):
                    edits.append((m.start("cdata"), m.end("cdata"), css))
            continue
        if m.group("end") is not None:
            if stack:
                stack.pop()
            continue
        tag = m.group("start")
        if tag is None:
            continue
        local = tag.rpartition(":")[2]
        inside = bool(stack) and stack[-1][1]
        attrs = list(_XML_ATTR.finditer(m.group("attrs")))
        offset = m.start("attrs")
        if not rooted:
            rooted = True
            for a in attrs:
                name, value = a.group(1), a.group(2) or a.group(3) or ""
                if name.startswith("xmlns:") and value == _INKFLOW_NS:
                    prefixes.add(name.removeprefix("xmlns:"))
        layer = False
        for a in attrs:
            name = a.group(1)
            prefix, _, attr = name.rpartition(":")
            if prefix in prefixes and attr in ("layout-src", "overlay-src"):
                layer = True
            if inside and not (prefix in prefixes and attr.endswith("-src")):
                continue
            group = 2 if a.group(2) is not None else 3
            quote = '"' if group == 2 else "'"
            raw = a.group(group)
            value = html.unescape(raw)
            new = _svg_attr(
                tag, prefix, attr, value, prefix in prefixes, overlay, visit, marker
            )
            if new is not None and new != value:
                start, end = offset + a.start(group), offset + a.end(group)
                edits.append((start, end, _xml_escape(new, quote)))
        if not m.group("empty"):
            stack.append((local, inside or layer))
    return _apply(text, edits)


def _svg_attr(
    tag: str,
    prefix: str,
    attr: str,
    value: str,
    inkflow: bool,
    overlay: bool,
    visit: Visit,
    marker: Visit | None,
) -> str | None:
    if inkflow:
        if attr == "parent":
            kind = Kind.OVERLAY if overlay else Kind.LAYOUT
            return visit(value, kind, "inkflow:parent")
        if attr == "layout-src":
            return (marker or visit)(value, Kind.LAYOUT, "Inkscape preview layer")
        if attr == "overlay-src":
            return (marker or visit)(value, Kind.OVERLAY, "Inkscape preview layer")
        if attr == "preview":
            return visit(value, Kind.LAYOUT, "inkflow:preview")
        if attr == "preview-overlays":
            names = value.split()
            new = [
                visit(n, Kind.OVERLAY, "inkflow:preview-overlays") or n for n in names
            ]
            return " ".join(new) if new != names else None
        return None
    local_tag = tag.rpartition(":")[2]
    if attr == "href" and prefix in ("", "xlink"):
        label = {"image": "picture", "a": "link", "use": "use"}.get(local_tag, "href")
        return visit(value, Kind.PATH, label)
    if prefix:
        return None
    if attr in ("src", "poster"):
        return visit(value, Kind.PATH, f"{local_tag} {attr}")
    if attr == "style":
        css = rewrite_css(value, visit)
        return css if css != value else None
    return None


# ── Scanning: CSS ─────────────────────────────────────────────────────────────

_CSS_URL = re.compile(
    r"""(url\(\s*)(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))(\s*\))"""
    + r"""|(@import\s+)(?:"([^"]*)"|'([^']*)')""",
    re.I,
)


def rewrite_css(css: str, visit: Visit) -> str:
    """``url(…)`` and ``@import`` references rewritten."""

    def replace_one(m: re.Match[str]) -> str:
        for group in (2, 3, 4, 6, 7):
            raw = m.group(group)
            if raw is None:
                continue
            new = visit(raw, Kind.PATH, "CSS url()")
            if new is None:
                return m.group(0)
            start, end = m.start(group) - m.start(0), m.end(group) - m.start(0)
            whole = m.group(0)
            return whole[:start] + new + whole[end:]
        return m.group(0)

    return _CSS_URL.sub(replace_one, css)


# ── Scanning: Markdown ────────────────────────────────────────────────────────

_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([\w-]*)")
_CODE_SPAN = re.compile(r"(`+)(?:(?!\1).)+?\1", re.S)
_MD_LINK = re.compile(r"\]\(\s*(?:<([^>\n]*)>|([^)\s]+))")
_MD_REFDEF = re.compile(r"^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]*)>|(\S+))", re.M)
_HTML_TAG = re.compile(
    r"<(img|video|source|audio|a|track|embed|iframe|object)\b[^>]*>", re.I
)
_HTML_ATTR = re.compile(
    r"""\b(src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I
)
_CHART_DATA = re.compile(r"^(\s*data\s*:\s*)(\S.*?)\s*$", re.I)


def rewrite_markdown(text: str, visit: Visit) -> str:
    """Images, links, HTML tags and chart data files rewritten; code is left alone."""
    edits: list[tuple[int, int, str]] = []
    prose: list[tuple[int, int]] = []
    fence: tuple[str, str] | None = None
    start = 0
    pos = 0
    for line in text.splitlines(keepends=True):
        m = _FENCE.match(line)
        if fence is None and m:
            prose.append((start, pos))
            fence = (m.group(1), m.group(2).lower())
        elif fence is not None:
            closing = re.match(r"^ {0,3}(`{3,}|~{3,})\s*$", line)
            if (
                closing
                and closing.group(1)[0] == fence[0][0]
                and len(closing.group(1)) >= len(fence[0])
            ):
                fence = None
                start = pos + len(line)
            elif fence[1] == "chart":
                data = _CHART_DATA.match(line.rstrip("\r\n"))
                if data:
                    new = visit(data.group(2), Kind.PATH, "chart data")
                    if new is not None:
                        edits.append((pos + data.start(2), pos + data.end(2), new))
        pos += len(line)
    if fence is None:
        prose.append((start, len(text)))
    for begin, end in prose:
        chunk = text[begin:end]
        code = [(c.start(), c.end()) for c in _CODE_SPAN.finditer(chunk)]

        def in_code(i: int, code: list[tuple[int, int]] = code) -> bool:
            return any(a <= i < b for a, b in code)

        for pattern, label in (
            (_MD_LINK, "Markdown link"),
            (_MD_REFDEF, "link definition"),
        ):
            for m in pattern.finditer(chunk):
                group = 1 if m.group(1) is not None else 2
                if in_code(m.start()):
                    continue
                kind = label
                if pattern is _MD_LINK and m.start() > 0:
                    opening = chunk.rfind("[", 0, m.start())
                    if opening > 0 and chunk[opening - 1] == "!":
                        kind = "Markdown image"
                new = visit(m.group(group), Kind.PATH, kind)
                if new is not None:
                    edits.append((begin + m.start(group), begin + m.end(group), new))
        for tag in _HTML_TAG.finditer(chunk):
            if in_code(tag.start()):
                continue
            for a in _HTML_ATTR.finditer(tag.group(0)):
                group = 2 if a.group(2) is not None else 3
                new = visit(
                    html.unescape(a.group(group)),
                    Kind.PATH,
                    f"<{tag.group(1).lower()} {a.group(1).lower()}>",
                )
                if new is not None:
                    at = begin + tag.start() + a.start(group)
                    edits.append((at, at + len(a.group(group)), new))
    return _apply(text, edits)


# ── Scanning: deck.py ─────────────────────────────────────────────────────────

_FIELDS: dict[str, dict[str, tuple[int | None, Kind, str]]] = {
    "Slide": {
        "src": (0, Kind.SLIDE, "Slide src"),
        "md": (None, Kind.MD, "Slide md="),
        "notes": (None, Kind.PATH, "Slide notes="),
        "ink": (None, Kind.PATH, "Slide ink="),
        "extra_style": (None, Kind.PATH, "Slide extra_style="),
    },
    "Image": {
        "src": (0, Kind.PATH, "Image src"),
        "alt_src": (None, Kind.PATH, "Image alt_src="),
    },
    "Video": {
        "src": (0, Kind.PATH, "Video src"),
        "alt_src": (None, Kind.PATH, "Video alt_src="),
        "poster": (None, Kind.PATH, "Video poster="),
    },
    "Chart": {"src": (0, Kind.PATH, "Chart src")},
    "Overlay": {"src": (0, Kind.OVERLAY, "Overlay src")},
    "Deck": {"style": (None, Kind.PATH, "Deck style=")},
}
_TEXT_FIELDS = {
    "md": "markdown",
    "notes": "markdown",
    "extra_style": "css",
    "style": "css",
}


def _callee(func: cst.BaseExpression) -> str | None:
    if isinstance(func, cst.Name):
        return func.value
    if isinstance(func, cst.Attribute):
        return func.attr.value
    return None


def _string_value(node: cst.BaseExpression) -> str | None:
    if isinstance(node, cst.SimpleString) and "b" not in node.prefix.lower():
        value = node.evaluated_value
        return value if isinstance(value, str) else None
    return None


def _set_string(node: cst.SimpleString, old: str, new: str) -> cst.SimpleString:
    """``node`` holding ``new`` instead of ``old``, quoted as it was where possible."""
    prefix, quote = node.prefix, node.quote
    inner = node.value[len(prefix) + len(quote) : -len(quote)]
    if inner == old:
        safe = "\\" not in new and quote[0] not in new and "\n" not in new
        if safe or (len(quote) == 3 and quote not in new and "\\" not in new):
            return node.with_changes(value=prefix + quote + new + quote)
    return node.with_changes(value=json.dumps(new, ensure_ascii=False))


class _DeckRewriter(cst.CSTTransformer):
    def __init__(self, visit: Visit) -> None:
        super().__init__()
        self.visit_ref: Visit = visit

    def _text(
        self, node: cst.BaseExpression, what: str, label: str
    ) -> cst.BaseExpression:
        """Markdown or CSS written in deck.py (``Inline(…)`` or a zone string)."""
        if isinstance(node, cst.Call) and _callee(node.func) == "Inline" and node.args:
            inner = self._text(node.args[0].value, what, label)
            if inner is node.args[0].value:
                return node
            first = node.args[0].with_changes(value=inner)
            return node.with_changes(args=[first, *node.args[1:]])
        value = _string_value(node)
        if value is None or not isinstance(node, cst.SimpleString):
            return node
        rewrite = rewrite_markdown if what == "markdown" else rewrite_css
        new = rewrite(value, lambda raw, kind, _l: self.visit_ref(raw, kind, label))
        return node if new == value else _set_string(node, value, new)

    @override
    def leave_Call(
        self, original_node: cst.Call, updated_node: cst.Call
    ) -> cst.BaseExpression:
        name = _callee(updated_node.func)
        fields = _FIELDS.get(name or "")
        if fields is None:
            return updated_node
        args = list(updated_node.args)
        positional = 0
        for i, arg in enumerate(args):
            if arg.star:
                continue
            if arg.keyword is None:
                field_name = next(
                    (f for f, (pos, _, _) in fields.items() if pos == positional), None
                )
                positional += 1
            else:
                field_name = arg.keyword.value
            if (
                name == "Slide"
                and field_name == "zones"
                and isinstance(arg.value, cst.Dict)
            ):
                args[i] = arg.with_changes(value=self._zones(arg.value))
                continue
            if field_name not in fields:
                continue
            _, kind, label = fields[field_name]
            value = _string_value(arg.value)
            if value is not None and isinstance(arg.value, cst.SimpleString):
                new = self.visit_ref(value, kind, label)
                if new is not None:
                    args[i] = arg.with_changes(value=_set_string(arg.value, value, new))
            elif field_name in _TEXT_FIELDS:
                new_node = self._text(arg.value, _TEXT_FIELDS[field_name], label)
                if new_node is not arg.value:
                    args[i] = arg.with_changes(value=new_node)
        return updated_node.with_changes(args=args)

    def _zones(self, zones: cst.Dict) -> cst.Dict:
        elements: list[cst.BaseDictElement] = []
        for el in zones.elements:
            if isinstance(el, cst.DictElement) and (
                isinstance(el.value, cst.SimpleString)
                or (
                    isinstance(el.value, cst.Call)
                    and _callee(el.value.func) == "Inline"
                )
            ):
                el = el.with_changes(
                    value=self._text(el.value, "markdown", "zone Markdown")
                )
            elements.append(el)
        return zones.with_changes(elements=elements)


def scan_deck(code: str, visit: Visit) -> str:
    """deck.py with every reference ``visit`` rewrites replaced."""
    module = cst.parse_module(code)
    return module.visit(_DeckRewriter(visit)).code


# ── The project's text files ──────────────────────────────────────────────────


def _walk(root: Path) -> Iterator[Path]:
    """Every file in the project, except hidden folders (.inkflow/, .git/),
    virtual environments, node_modules and built presentations (a folder
    holding an index.html, such as build/)."""
    for folder, dirs, files in os.walk(root):
        here = Path(folder)
        dirs[:] = sorted(
            d
            for d in dirs
            if not d.startswith(".")
            and d not in _SKIP_DIRS
            and not (here / d / "pyvenv.cfg").exists()
            and not (here / d / "index.html").exists()
        )
        for name in sorted(files):
            if not name.startswith("."):
                yield _abs(here / name)


def text_files(root: Path, deck_path: Path) -> Iterator[Path]:
    """Every SVG, Markdown and CSS file in the project that may name another
    (not draw.io sources, which name none)."""
    deck = _abs(deck_path)
    for path in _walk(root):
        lower = path.name.lower()
        if lower.endswith(".drawio.svg") or not lower.endswith((".svg", ".md", ".css")):
            continue
        if path == deck:
            continue
        try:
            if path.stat().st_size > _MAX_SCAN:
                continue
        except OSError:
            continue
        yield path


_DECK_FILES = frozenset(
    {
        ".svg",
        ".md",
        ".css",
        ".csv",
        ".tsv",
        ".json",
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".avif",
        ".bmp",
        ".tif",
        ".tiff",
        ".mp4",
        ".webm",
        ".ogg",
        ".ogv",
        ".mov",
        ".m4v",
        ".mkv",
        ".mp3",
        ".wav",
        ".m4a",
        ".vtt",
    }
)


def project_files(project_dir: Path, deck_path: Path) -> list[Path]:
    """The project's files a deck can name (drawings, Markdown, pictures,
    videos, data, PDFs, styles), for the editor's Files view; not the files
    inkflow finds by their name (styles.css, deck.py)."""
    root = _abs(project_dir)
    deck = _abs(deck_path)
    return [
        path
        for path in _walk(root)
        if path.suffix.lower() in _DECK_FILES
        and path != deck
        and _rel(path, root) not in _FOUND_BY_NAME
    ]


def _scan(
    path: Path, text: str, visit: Visit, overlay: bool, marker: Visit | None = None
) -> str:
    suffix = path.suffix.lower()
    if suffix == ".svg":
        return scan_svg(text, visit, overlay, marker)
    if suffix == ".md":
        return rewrite_markdown(text, visit)
    return rewrite_css(text, visit)


def _overlay_srcs(deck: Deck) -> list[str]:
    """Every ``Overlay`` src the deck names (deck default, theme, per slide)."""
    srcs = [o.src for o in deck.effective_overlays]
    for slide in deck.slides:
        srcs.extend(o.src for o in slide.overlays or [])
    return list(dict.fromkeys(srcs))


def _overlay_files(root: Path, deck: Deck) -> set[Path]:
    """Files used as overlays: in an overlays/ folder or named by the deck."""
    world = _World(root, deck.theme, {})
    found: set[Path] = set()
    for src in _overlay_srcs(deck):
        path = world.resolve(src, Kind.OVERLAY, root, after=False)
        if path is not None:
            found.add(path)
    return found


def root_attrs(text: str) -> dict[str, str]:
    """The root element's ``inkflow:`` attributes (``parent``, ``preview``…)."""
    for m in _XML_TOKEN.finditer(text):
        if m.group("start") is None:
            continue
        attrs = [
            (a.group(1), html.unescape(a.group(2) or a.group(3) or ""))
            for a in _XML_ATTR.finditer(m.group("attrs"))
        ]
        prefixes = {"inkflow"} | {
            name.removeprefix("xmlns:")
            for name, value in attrs
            if name.startswith("xmlns:") and value == _INKFLOW_NS
        }
        out: dict[str, str] = {}
        for name, value in attrs:
            prefix, _, local = name.rpartition(":")
            if prefix in prefixes:
                out[local] = value
        return out
    return {}


@dataclass
class _Chains:
    """Which file declared each preview layer's reference.

    A slide's preview layers (``inkflow sync``) are named by the reference
    that brought them in: the slide's own ``inkflow:parent``, then each
    ancestor's, written relative to *that* ancestor; a backdrop by
    ``inkflow:preview``; overlays by the deck's ``Overlay`` (relative to the
    project) or ``inkflow:preview-overlays``.
    """

    world: _World
    deck_file: Path
    overlay_srcs: list[str]
    attrs: dict[Path, dict[str, str]] = field(default_factory=dict)

    def _attrs(self, path: Path) -> dict[str, str]:
        if path not in self.attrs:
            text = _read(path) if path.is_file() else None
            self.attrs[path] = root_attrs(text) if text else {}
        return self.attrs[path]

    def _walk(
        self, start: Path, kind: Kind, found: dict[tuple[str, Kind], Path]
    ) -> None:
        current: Path | None = start
        seen: set[Path] = set()
        while current is not None and current not in seen:
            seen.add(current)
            raw = self._attrs(current).get("parent")
            if not raw:
                return
            _ = found.setdefault((raw, kind), current)
            current = self.world.resolve(raw, kind, current.parent, after=False)

    def declarers(self, path: Path, overlay: bool) -> dict[tuple[str, Kind], Path]:
        found: dict[tuple[str, Kind], Path] = {}
        attrs = self._attrs(path)
        self._walk(path, Kind.OVERLAY if overlay else Kind.LAYOUT, found)
        backdrop_ref = attrs.get("preview")
        if backdrop_ref:
            _ = found.setdefault((backdrop_ref, Kind.LAYOUT), path)
            backdrop = self.world.resolve(
                backdrop_ref, Kind.LAYOUT, path.parent, after=False
            )
            if backdrop is not None:
                self._walk(backdrop, Kind.LAYOUT, found)
        named = [(n, path) for n in attrs.get("preview-overlays", "").split()]
        named += [(src, self.deck_file) for src in self.overlay_srcs]
        for name, declarer in named:
            _ = found.setdefault((name, Kind.OVERLAY), declarer)
            target = self.world.resolve(
                name, Kind.OVERLAY, declarer.parent, after=False
            )
            if target is not None:
                self._walk(target, Kind.OVERLAY, found)
        return found


def _is_overlay(path: Path, root: Path, overlays: set[Path]) -> bool:
    return path in overlays or "overlays" in Path(_rel(path, root)).parts


def _read(path: Path) -> str | None:
    try:
        return path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


# ── Planning ──────────────────────────────────────────────────────────────────


def _link_pattern(old: str) -> re.Pattern[str]:
    return re.compile(rf"(?<=slide:){re.escape(old)}(?![\w.-])")


def _visible_ids(slides: list[Slide]) -> dict[int, str]:
    """Each shown slide's id by its position in ``slides``."""
    shown = [i for i, s in enumerate(slides) if s.visible]
    ids = slide_ids([slides[i] for i in shown])
    return dict(zip(shown, ids, strict=True))


def plan_rename(
    project_dir: Path,
    deck_path: Path,
    deck: Deck,
    renames: Mapping[str, str],
    *,
    slide_args: Mapping[int, Mapping[str, str | None]] | None = None,
) -> RenamePlan:
    """Everything renaming ``renames`` (old → new, relative to the project)
    changes, worked out without writing anything.

    ``slide_args`` sets ``Slide(...)`` arguments in the same step (by deck
    index; None removes one), for a slide rename that pins or drops its id.
    Raises `RenameError` when the rename cannot be done as asked.
    """
    root = _abs(project_dir)
    deck_file = _abs(deck_path)
    moves = _check_renames(root, deck_file, renames)
    world = _World(root, deck.theme, moves)
    overlays = _overlay_files(root, deck)
    args: dict[int, dict[str, str | None]] = {
        i: dict(values) for i, values in (slide_args or {}).items()
    }
    edits: list[RefEdit] = []

    def visitor(path: Path) -> Visit:
        base_old = path.parent
        base_new = moves.get(path, path).parent
        where = _rel(path, root)

        def visit(raw: str, kind: Kind, label: str) -> str | None:
            new = world.rewrite(raw, kind, base_old, base_new, where)
            if new is not None:
                edits.append(RefEdit(where, label, raw, new))
            return new

        return visit

    chains = _Chains(world, deck_file, _overlay_srcs(deck))

    def marker(path: Path, overlay: bool) -> Visit:
        declared = chains.declarers(path, overlay)
        own = visitor(path)
        where = _rel(path, root)

        def visit(raw: str, kind: Kind, label: str) -> str | None:
            declarer = declared.get((raw, kind))
            if declarer is None:
                return own(raw, kind, label)
            base_new = moves.get(declarer, declarer).parent
            new = world.rewrite(raw, kind, declarer.parent, base_new, where)
            if new is not None:
                edits.append(RefEdit(where, label, raw, new))
            return new

        return visit

    # A slide whose saved ink is renamed keeps it by naming it (ink=).
    ids_before = _visible_ids(list(deck.slides))
    for index, slide_id in ids_before.items():
        slide = deck.slides[index]
        if slide.ink is None:
            path = _abs(ink_path(slide, slide_id, root))
            if path in moves:
                args.setdefault(index, {})["ink"] = _rel(moves[path], root)

    texts: dict[Path, tuple[str, str]] = {}
    for path in text_files(root, deck_file):
        text = _read(path)
        if text is None:
            continue
        overlay = _is_overlay(path, root, overlays)
        texts[path] = (
            text,
            _scan(path, text, visitor(path), overlay, marker(path, overlay)),
        )
    deck_text = deck_file.read_text(encoding="utf-8")
    try:
        new_deck = scan_deck(deck_text, visitor(deck_file))
    except cst.ParserSyntaxError as exc:
        raise RenameError(f"deck.py does not parse: {exc}") from exc

    # The slides as they will read, for their ids.
    after: list[Slide] = []
    for index, slide in enumerate(deck.slides):
        changes: dict[str, object] = {}
        src = world.rewrite(slide.src, Kind.SLIDE, root, root, "deck.py")
        if src is not None:
            changes["src"] = src
        if isinstance(slide.md, str) and not isinstance(slide.md, Inline):
            md = world.rewrite(slide.md, Kind.MD, root, root, "deck.py")
            if md is not None:
                changes["md"] = md
        for name, value in args.get(index, {}).items():
            if name in ("id", "ink"):
                changes[name] = value
        after.append(replace(slide, **changes) if changes else slide)
    ids_after = _visible_ids(after)
    renamed_ids: dict[str, str] = {}
    affected = {
        i for i, (a, b) in enumerate(zip(deck.slides, after, strict=True)) if a is not b
    }
    for index, old_id in ids_before.items():
        new_id = ids_after[index]
        if new_id == old_id:
            continue
        raw_new = slide_ids([after[index]])[0]
        if index not in affected or new_id != raw_new:
            other = next(
                (
                    k + 1
                    for k, i in enumerate(ids_after)
                    if i != index and raw_new in (ids_after[i], ids_before.get(i))
                ),
                None,
            )
            raise RenameError(
                f"another slide is already called {raw_new!r}"
                + (f" (slide {other})" if other else "")
                + ": pick another name"
            )
        renamed_ids[old_id] = new_id
        before_slide, after_slide = deck.slides[index], after[index]
        if before_slide.ink is None and after_slide.ink is None:
            old_ink = _abs(ink_path(before_slide, old_id, root))
            new_ink = _abs(ink_path(after_slide, new_id, root))
            if old_ink.is_file() and old_ink not in moves and old_ink != new_ink:
                if new_ink.exists() or new_ink in moves.values():
                    raise RenameError(
                        f"{_rel(new_ink, root)} already exists: the slide's ink "
                        + "cannot follow its new id"
                    )
                moves[old_ink] = new_ink

    # slide:<id> links follow the ids.
    links = 0
    for old_id, new_id in renamed_ids.items():
        pattern = _link_pattern(old_id)
        for path, (orig, text) in list(texts.items()):
            text, n = pattern.subn(new_id, text)
            if n:
                links += n
                texts[path] = (orig, text)
                edits.extend(
                    [
                        RefEdit(
                            _rel(path, root),
                            "slide link",
                            f"slide:{old_id}",
                            f"slide:{new_id}",
                        )
                    ]
                    * n
                )
        new_deck, n = pattern.subn(new_id, new_deck)
        if n:
            links += n
            edits.extend(
                [RefEdit("deck.py", "slide link", f"slide:{old_id}", f"slide:{new_id}")]
                * n
            )

    if args:
        new_deck = _set_slide_args(new_deck, deck, args, ids_before, edits)

    warnings = _leftovers(new_deck, moves, root)
    writes: dict[Path, bytes] = {}
    for path, (orig, text) in texts.items():
        if text != orig:
            writes[moves.get(path, path)] = text.encode("utf-8")
    if new_deck != deck_text:
        writes[deck_file] = new_deck.encode("utf-8")
    return RenamePlan(
        moves=list(moves.items()),
        writes=writes,
        edits=edits,
        ids=renamed_ids,
        links=links,
        warnings=warnings,
    )


def _set_slide_args(
    code: str,
    deck: Deck,
    args: Mapping[int, Mapping[str, str | None]],
    ids: Mapping[int, str],
    edits: list[RefEdit],
) -> str:
    source = DeckSource(code)
    if source.slide_calls(expected=len(deck.slides)) is None:
        raise RenameError(
            "deck.py builds its slide list in code; set the slide's "
            + ", ".join(sorted({n for a in args.values() for n in a}))
            + " there by hand"
        )
    for index, values in args.items():
        slide = deck.slides[index]
        for name, value in values.items():
            old = cast("str | None", getattr(slide, name, None))
            try:
                source.set_slide_arg(
                    index, name, Code().literal(value) if value is not None else None
                )
            except DeckEditError as exc:
                raise RenameError(str(exc)) from exc
            if name == "id" and old is None:
                before = f"inferred {ids.get(index, '')!r}"
            else:
                before = repr(old) if old is not None else "(none)"
            after = repr(value) if value is not None else "(inferred)"
            edits.append(RefEdit("deck.py", f"slide {name}=", before, after))
    return source.code


def _leftovers(code: str, moves: Mapping[Path, Path], root: Path) -> list[str]:
    """deck.py still naming a moved file in code inkflow cannot follow."""
    found: list[str] = []
    for old in moves:
        rel = _rel(old, root)
        if re.search(rf"""["']{re.escape(rel)}["']""", code):
            found.append(
                f"deck.py still names {rel!r} in code inkflow cannot follow: check it"
            )
    return found


# ── A slide's own files ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class SlideFile:
    role: str
    path: Path
    own: bool


def _slide_paths(slide: Slide, world: _World) -> list[tuple[str, Path]]:
    root = world.root
    found: list[tuple[str, Path]] = []
    src = world.resolve(slide.src, Kind.SLIDE, root, after=False)
    if src is not None:
        found.append(("drawing", src))
    if isinstance(slide.md, str) and not isinstance(slide.md, Inline):
        md = world.resolve(slide.md, Kind.MD, root, after=False)
        if md is not None:
            found.append(("markdown", md))
    if (
        isinstance(slide.notes, str)
        and not isinstance(slide.notes, Inline)
        and slide.notes
    ):
        notes = world.resolve(slide.notes, Kind.PATH, root, after=False)
        if notes is not None:
            found.append(("notes", notes))
    if slide.ink:
        ink = world.resolve(slide.ink, Kind.PATH, root, after=False)
        if ink is not None:
            found.append(("ink", ink))
    return found


def slide_files(project_dir: Path, deck: Deck, index: int) -> list[SlideFile]:
    """The files slide ``index`` is made of, and which are its alone: a layout,
    an overlay or a file another slide also uses is shared."""
    root = _abs(project_dir)
    world = _World(root, deck.theme, {})
    used: dict[Path, int] = {}
    for other in deck.slides:
        for _, path in _slide_paths(other, world):
            used[path] = used.get(path, 0) + 1
    out: list[SlideFile] = []
    for role, path in _slide_paths(deck.slides[index], world):
        if not path.is_file():
            continue
        inside = path.is_relative_to(root)
        parts = Path(_rel(path, root)).parts if inside else ()
        own = (
            inside
            and used.get(path, 0) == 1
            and not {"layouts", "overlays"} & set(parts)
            and not any(p.startswith(".") for p in parts)
        )
        out.append(SlideFile(role, path, own))
    return out


def plan_slide_rename(
    project_dir: Path,
    deck_path: Path,
    deck: Deck,
    index: int,
    stem: str,
    *,
    keep_id: bool = False,
) -> RenamePlan:
    """Rename slide ``index``'s own files (drawing, Markdown, notes, a named
    ink file) to ``stem``, each in its folder with its extension.

    A slide's id is inferred from those names, so by default it becomes
    ``stem`` too: its default ink file and ``slide:`` links follow. An explicit
    ``id=`` stays (and is dropped when it now equals the inferred id);
    ``keep_id`` writes the old id as ``id=`` instead of letting it change.
    Files the slide shares are listed in ``shared`` and left alone.
    """
    stem = stem.strip()
    if "/" in stem or not _NAME.fullmatch(stem) or full_suffix(stem):
        raise RenameError(
            f"{stem!r} is not a file name stem: use letters, digits and - _ "
            + "(no folder, no extension)"
        )
    if not 0 <= index < len(deck.slides):
        raise RenameError("no such slide")
    root = _abs(project_dir)
    slide = deck.slides[index]
    files = slide_files(root, deck, index)
    renames: dict[str, str] = {}
    shared: list[str] = []
    for f in files:
        inside = f.path.is_relative_to(root)
        rel = _rel(f.path, root) if inside else slide.src
        if not f.own:
            parts: set[str] = set(Path(rel).parts) if inside else set()
            why = (
                "a theme layout"
                if not inside
                else "a layout"
                if parts & {"layouts", "overlays"}
                else "other slides use it too"
            )
            shared.append(f"{rel} ({why})")
            continue
        target = f.path.with_name(stem + full_suffix(f.path.name))
        if target != f.path:
            renames[rel] = _rel(target, root)
    args: dict[str, str | None] = {}
    ids = _visible_ids(list(deck.slides))
    governing = next((f for f in files if f.role == "markdown"), None)
    if governing is None and not (
        isinstance(slide.md, str) and not isinstance(slide.md, Inline)
    ):
        governing = next((f for f in files if f.role == "drawing"), None)
    inferred_after = (
        stem
        if governing is not None
        and (governing.own or Path(governing.path).stem == stem)
        else None
    )
    if slide.id:
        others = {
            slide_ids([s])[0]
            for i, s in enumerate(deck.slides)
            if i != index and s.visible
        }
        if slide.id == stem and inferred_after == stem and stem not in others:
            args["id"] = None
    elif keep_id and governing is not None and _rel(governing.path, root) in renames:
        old_id = ids.get(index, slide_ids([slide])[0])
        args["id"] = old_id
    if not renames and not args:
        if any(f.own for f in files):
            raise RenameError(f"its files are already called {stem}")
        raise RenameError("this slide has no files of its own to rename")
    if not renames:
        # Only the id= to drop: no file moves, but still one step.
        plan = RenamePlan(moves=[], writes={}, edits=[])
        code = _abs(deck_path).read_text(encoding="utf-8")
        new = _set_slide_args(code, deck, {index: args}, ids, plan.edits)
        plan.writes[_abs(deck_path)] = new.encode("utf-8")
        plan.shared = shared
        return plan
    plan = plan_rename(
        root, deck_path, deck, renames, slide_args={index: args} if args else None
    )
    plan.shared = shared
    return plan


# ── What uses each file (the Files view) ─────────────────────────────────────


def reference_counts(project_dir: Path, deck_path: Path, deck: Deck) -> dict[str, int]:
    """How many references name each project file (project-relative paths),
    counted the way a rename would find them."""
    root = _abs(project_dir)
    world = _World(root, deck.theme, {})
    counts: dict[str, int] = {}

    def visitor(path: Path) -> Visit:
        def visit(raw: str, kind: Kind, _label: str) -> None:
            target = world.resolve(raw, kind, path.parent, after=False)
            if target is not None and target.is_relative_to(root):
                rel = _rel(target, root)
                counts[rel] = counts.get(rel, 0) + 1

        return visit

    overlays = _overlay_files(root, deck)
    for path in text_files(root, deck_path):
        text = _read(path)
        if text is not None:
            # Preview layers are copies, not uses: their markers are not counted.
            _ = _scan(
                path,
                text,
                visitor(path),
                _is_overlay(path, root, overlays),
                lambda _raw, _kind, _label: None,
            )
    deck_file = _abs(deck_path)
    _ = scan_deck(deck_file.read_text(encoding="utf-8"), visitor(deck_file))
    # Saved ink is found by its slide's id.
    for index, slide_id in _visible_ids(list(deck.slides)).items():
        slide = deck.slides[index]
        if slide.ink is None:
            path = _abs(ink_path(slide, slide_id, root))
            if path.is_file():
                rel = _rel(path, root)
                counts[rel] = counts.get(rel, 0) + 1
    return counts


def posix_join(folder: str, name: str) -> str:
    """``folder/name`` (no folder: just the name)."""
    return posixpath.join(folder, name) if folder.strip("/") else name


# ── Copying outside files in (inkflow pack) ───────────────────────────────────

_LINK_LABELS = frozenset({"link", "Markdown link", "link definition", "<a href>"})
_HOME_OF = {
    Kind.PATH: "assets",
    Kind.SLIDE: "slides",
    Kind.MD: "slides",
    Kind.LAYOUT: "layouts",
    Kind.OVERLAY: "overlays",
}
_TEXT_SUFFIXES = (".svg", ".md", ".css")


@dataclass(frozen=True)
class FoundRef:
    """A reference as written, in the file it is written in."""

    file: str
    kind: str
    raw: str


@dataclass
class CopyInPlan:
    """What makes a deck independent of files outside its folder: each such
    file copied in, every reference to it rewritten (``plan_copy_in``)."""

    copies: list[tuple[Path, Path]]
    """The real file (outside the deck, or behind a symlink) → its new place."""
    writes: dict[Path, bytes]
    """New contents by path: rewritten references, copied text files."""
    edits: list[RefEdit]
    remote: list[FoundRef] = field(default_factory=list)
    """Pictures and data read from the web (``https://…``)."""
    warnings: list[str] = field(default_factory=list)

    def summary(self, project_dir: Path) -> dict[str, object]:
        root = _abs(project_dir)
        created = {dst for dst in self.writes if not dst.exists()} | {
            dst for _, dst in self.copies
        }
        return {
            "copies": [
                {"from": str(src), "to": _rel(dst, root)} for src, dst in self.copies
            ],
            "created": sorted(_rel(p, root) for p in created),
            "edits": [
                {"file": e.file, "kind": e.kind, "old": e.old, "new": e.new}
                for e in self.edits
            ],
            "references": len(self.edits),
            "files": len({e.file for e in self.edits}),
            "remote": [
                {"file": r.file, "kind": r.kind, "ref": r.raw} for r in self.remote
            ],
            "warnings": list(self.warnings),
        }


def through_symlink(path: Path, root: Path) -> bool:
    """Whether ``path`` (inside ``root``) is a symlink or lies in a linked folder."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return False
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            return True
    return False


def _shipped(path: Path, theme: Theme | None) -> bool:
    """A file of the theme or of inkflow: it comes with the pinned version."""
    homes = [builtin_theme_dir()]
    if theme is not None:
        homes.append(theme.asset_dir())
    real = path.resolve()
    return any(
        real.is_relative_to(h.resolve()) or path.is_relative_to(h) for h in homes
    )


def _same_bytes(a: Path, b: Path) -> bool:
    try:
        return a.stat().st_size == b.stat().st_size and a.read_bytes() == b.read_bytes()
    except OSError:
        return False


def _ignore(_raw: str, _kind: Kind, _label: str) -> str | None:
    return None


def plan_copy_in(project_dir: Path, deck_path: Path, deck: Deck) -> CopyInPlan:
    """Every file the deck names that a clone of its folder would not have:
    outside the folder, or reached through a symlink (git keeps the link,
    not the file, and Windows checks links out as text files). Each is copied
    into the deck (pictures and data to ``assets/``, layouts to ``layouts/``,
    overlays to ``overlays/``, slides to ``slides/``), names kept unique, and
    every reference to it rewritten where it is written, as a rename rewrites
    them, but always relative. A copied SVG, Markdown or CSS file's own
    references are followed too. Theme and inkflow files are left alone: they
    come with the version the deck pins. Links (``<a href>``, Markdown links)
    are not copied in."""
    root = _abs(project_dir)
    deck_file = _abs(deck_path)
    theme = deck.theme
    plain = _World(root, theme, {})
    remote: list[FoundRef] = []
    wanted: dict[Path, Kind] = {}
    pending: list[Path] = []

    def needs_copy(target: Path) -> bool:
        if not target.is_file() or _shipped(target, theme):
            return False
        if not target.is_relative_to(root):
            return True
        top = target.relative_to(root).parts[0]
        if top in _RESERVED_TOP or top.startswith("."):
            return False
        return through_symlink(target, root)

    def collector(path: Path) -> Visit:
        where = _rel(path, root) if path.is_relative_to(root) else str(path)

        def visit(raw: str, kind: Kind, label: str) -> str | None:
            if raw.startswith(("http://", "https://", "//")):
                if label not in _LINK_LABELS:
                    remote.append(FoundRef(where, label, raw))
                return None
            if label in _LINK_LABELS:
                return None
            target = plain.resolve(raw, kind, path.parent, after=False)
            if target is not None and target not in wanted and needs_copy(target):
                wanted[target] = kind
                if target.suffix.lower() in _TEXT_SUFFIXES:
                    pending.append(target)
            return None

        return visit

    overlays = _overlay_files(root, deck)
    texts: dict[Path, str] = {}
    for path in text_files(root, deck_file):
        text = _read(path)
        if text is None:
            continue
        texts[path] = text
        _ = _scan(
            path, text, collector(path), _is_overlay(path, root, overlays), _ignore
        )
    deck_text = deck_file.read_text(encoding="utf-8")
    try:
        _ = scan_deck(deck_text, collector(deck_file))
    except cst.ParserSyntaxError as exc:
        raise RenameError(f"deck.py does not parse: {exc}") from exc
    outside: dict[Path, str] = {}
    while pending:
        path = pending.pop()
        text = _read(path)
        if text is None or path.name.lower().endswith(".drawio.svg"):
            continue
        outside[path] = text
        _ = _scan(path, text, collector(path), wanted[path] is Kind.OVERLAY, _ignore)

    # Where each goes: its kind's folder (not one that is itself a link).
    mapping: dict[Path, Path] = {}
    taken: set[Path] = set()
    for target, kind in wanted.items():
        folder = root / _HOME_OF[kind]
        if through_symlink(folder, root) or (folder.exists() and not folder.is_dir()):
            folder = root / f"{_HOME_OF[kind]}-packed"
        suffix = full_suffix(target.name)
        stem = target.name[: len(target.name) - len(suffix)]
        dest = folder / target.name
        n = 2
        while dest in taken or (
            dest.exists()
            and (through_symlink(dest, root) or not _same_bytes(dest, target))
        ):
            dest = folder / f"{stem}-{n}{suffix}"
            n += 1
        taken.add(dest)
        mapping[target] = dest

    world = _World(root, theme, mapping, relative=True)
    edits: list[RefEdit] = []
    warnings: list[str] = []

    def visitor(path: Path) -> Visit:
        base_old = path.parent
        base_new = mapping.get(path, path).parent
        where = _rel(mapping.get(path, path), root)

        def visit(raw: str, kind: Kind, label: str) -> str | None:
            if label in _LINK_LABELS and path not in mapping:
                return None
            if raw.startswith(("http://", "https://", "//")):
                return None
            target = world.resolve(raw, kind, base_old, after=False)
            if target is None or (target not in mapping and base_old == base_new):
                return None
            try:
                new = world.rewrite(raw, kind, base_old, base_new, where)
            except RenameError as exc:
                warnings.append(str(exc))
                return None
            if new is not None:
                edits.append(RefEdit(where, label, raw, new))
            return new

        return visit

    writes: dict[Path, bytes] = {}
    for path, text in texts.items():
        overlay = _is_overlay(path, root, overlays)
        new = _scan(path, text, visitor(path), overlay, _ignore)
        if new != text:
            writes[path] = new.encode("utf-8")
    new_deck = scan_deck(deck_text, visitor(deck_file))
    if new_deck != deck_text:
        writes[deck_file] = new_deck.encode("utf-8")
    copies: list[tuple[Path, Path]] = []
    for target, dest in mapping.items():
        if dest.exists():
            continue  # the same file is there already
        text = outside.get(target)
        if text is not None:
            overlay = wanted[target] is Kind.OVERLAY
            rewritten = _scan(target, text, visitor(target), overlay, _ignore)
            writes[dest] = rewritten.encode("utf-8")
        else:
            copies.append((target.resolve(), dest))
    return CopyInPlan(copies, writes, edits, remote, warnings)
