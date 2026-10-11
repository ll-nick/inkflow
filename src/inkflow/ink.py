"""Ink: what a presenter or author draws on a slide with a pen.

A slide's saved ink lives in a file of its own, ``ink/<slide id>.svg`` (or the
path ``Slide(ink=...)`` names), never in the slide's SVG: drawing on a slide
then cannot disturb its drawing, a shared layout stays shared, and deleting one
file clears the slide. The pipeline paints the file over everything else,
overlays included (``compose_ink``).

Each stroke is a plain filled ``<path>``: the outline perfect-freehand computes
around the pen's track (``src/ts/shared/ink.ts``), so a stroke renders the same
in Inkscape, on GitHub or in a PDF, with nothing of inkflow's to interpret it.
``inkflow:tool`` and ``inkflow:size`` only describe how it was drawn. A theme
colour is a ``inkflow-fill-<token>`` class over a literal ``fill``: the class
follows the theme inside inkflow, the attribute is what everything else shows.

Strokes are direct children of the file's root, not of a group, so each one is
an object of its own in the editor and in Inkscape (selected, moved or deleted
alone); the composed slide still gets them as one ``<g class="inkflow-ink">``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.colors import SVG_TOKENS
from inkflow.editor.provenance import is_element
from inkflow.manifest import Slide
from inkflow.svgio import SvgElement, parse_svg

INK_DIR = "ink"
INK_CLASS = "inkflow-ink"
"""The group the composed slide holds a slide's saved ink in."""
HIGHLIGHTER_CLASS = "inkflow-highlighter"
TOOLS = frozenset({"pen", "highlighter"})

INKFLOW_TOOL = f"{{{ns.INKFLOW}}}tool"
INKFLOW_SIZE = f"{{{ns.INKFLOW}}}size"

_ID_RE = re.compile(r"ink-[A-Za-z0-9_-]{1,64}")
_PATH_RE = re.compile(r"M[MQLZ0-9eE.,\s+-]*")
_HEX_RE = re.compile(r"#(?:[0-9a-fA-F]{3}){1,2}")
_MAX_PATH = 2_000_000
_FILE_NAME_RE = re.compile(r"[^\w.-]+")


class InkError(ValueError):
    """A stroke or ink file that cannot be written; the message is for the user."""


def ink_path(slide: Slide, slide_id: str, project_dir: Path) -> Path:
    """The file a slide's saved ink is in (which need not exist yet).

    The id is made safe as a file name, so an explicit ``Slide(id="a/../b")``
    still names a file inside ``ink/``.
    """
    if slide.ink is not None:
        path = Path(slide.ink)
        return path if path.is_absolute() else project_dir / path
    name = _FILE_NAME_RE.sub("-", slide_id).strip(".-") or "slide"
    return project_dir / INK_DIR / f"{name}.svg"


def view_box(root: SvgElement) -> tuple[float, float, float, float] | None:
    """An SVG root's viewBox, or its width and height when it has none."""
    parts = re.split(r"[\s,]+", (root.get("viewBox") or "").strip())
    try:
        if len(parts) == 4:
            x, y, w, h = (float(p) for p in parts)
        else:
            x, y = 0.0, 0.0
            w = float(re.sub(r"px$", "", root.get("width", "")))
            h = float(re.sub(r"px$", "", root.get("height", "")))
    except ValueError:
        return None
    return (x, y, w, h) if w > 0 and h > 0 else None


def compose_ink(slide_root: SvgElement, ink_root: SvgElement) -> SvgElement:
    """Paint an ink file's strokes over the whole slide, as one group.

    Appended last, so ink lands above overlays too: it is what the presenter
    drew *on* the slide as shown. Ink drawn before the slide changed size is
    stretched onto the new canvas, so a mark stays on what it marked.
    """
    group = etree.SubElement(slide_root, f"{{{ns.SVG}}}g", {"class": INK_CLASS})
    own, drawn = view_box(slide_root), view_box(ink_root)
    if own is not None and drawn is not None and own != drawn:
        sx, sy = own[2] / drawn[2], own[3] / drawn[3]
        tx, ty = own[0] - drawn[0] * sx, own[1] - drawn[1] * sy
        group.set("transform", f"matrix({sx:g} 0 0 {sy:g} {tx:g} {ty:g})")
    for child in list(ink_root):
        if child.tag == f"{{{ns.SVG}}}defs":
            # Not written by inkflow, but a hand-edited file may use them.
            defs = slide_root.find(f"{{{ns.SVG}}}defs")
            if defs is None:
                defs = etree.Element(f"{{{ns.SVG}}}defs")
                slide_root.insert(0, defs)
            defs.extend(list(child))
        else:
            group.append(child)
    return slide_root


# ── Strokes ───────────────────────────────────────────────────────────────────


def _number(raw: object, what: str, low: float, high: float) -> float:
    if not isinstance(raw, int | float) or isinstance(raw, bool):
        raise InkError(f"stroke {what} must be a number")
    value = float(raw)
    if not math.isfinite(value) or not low < value <= high:
        raise InkError(f"stroke {what} out of range")
    return value


@dataclass(frozen=True)
class Stroke:
    """One finished stroke, as a page sends it.

    Validated field by field and written as attributes of a fresh element, so a
    request can only ever add a filled path, whatever the page sent.
    """

    id: str
    d: str
    fill: str
    tool: str = "pen"
    size: float = 4.0
    token: str | None = None
    opacity: float | None = None

    @classmethod
    def from_json(cls, raw: object) -> Stroke:
        if not isinstance(raw, dict):
            raise InkError("a stroke must be an object")
        data = cast("dict[str, object]", raw)
        stroke_id, d, fill = data.get("id"), data.get("d"), data.get("fill")
        if not isinstance(stroke_id, str) or not _ID_RE.fullmatch(stroke_id):
            raise InkError("invalid stroke id")
        if (
            not isinstance(d, str)
            or len(d) > _MAX_PATH
            or not _PATH_RE.fullmatch(d.strip())
        ):
            raise InkError("invalid stroke outline")
        if not isinstance(fill, str) or not _HEX_RE.fullmatch(fill):
            raise InkError("invalid stroke colour")
        tool = data.get("tool", "pen")
        if tool not in TOOLS:
            raise InkError(f"unknown ink tool {tool!r}")
        token = data.get("token")
        if token is not None and token not in SVG_TOKENS:
            raise InkError(f"unknown colour token {token!r}")
        opacity = data.get("opacity")
        return cls(
            id=stroke_id,
            d=d.strip(),
            fill=fill.lower(),
            tool=cast("str", tool),
            size=_number(data.get("size", 4), "size", 0, 2000),
            token=cast("str | None", token),
            opacity=None if opacity is None else _number(opacity, "opacity", 0, 1),
        )

    def element(self) -> SvgElement:
        el = etree.Element(f"{{{ns.SVG}}}path", nsmap={"inkflow": ns.INKFLOW})
        el.set("id", self.id)
        el.set("d", self.d)
        el.set("fill", self.fill)
        if self.opacity is not None and self.opacity < 1:
            el.set("fill-opacity", f"{self.opacity:g}")
        classes = [f"inkflow-fill-{self.token}"] if self.token else []
        if self.tool == "highlighter":
            classes.append(HIGHLIGHTER_CLASS)
        if classes:
            el.set("class", " ".join(classes))
        el.set(INKFLOW_TOOL, self.tool)
        el.set(INKFLOW_SIZE, f"{self.size:g}")
        return el


# ── Ink files ─────────────────────────────────────────────────────────────────


def new_ink_root(box: tuple[float, float, float, float]) -> SvgElement:
    """An empty ink file on a slide's canvas."""
    x, y, w, h = box
    nsmap = cast("dict[str, str]", {None: ns.SVG, "inkflow": ns.INKFLOW})
    root = etree.Element(f"{{{ns.SVG}}}svg", nsmap=nsmap)
    root.set("viewBox", f"{x:g} {y:g} {w:g} {h:g}")
    root.set("width", f"{w:g}")
    root.set("height", f"{h:g}")
    return root


def serialize_ink(root: SvgElement) -> bytes:
    """The file's bytes, laid out exactly as ``inkflow clean`` would.

    Whitespace between elements is dropped and re-indented, so a stroke appended
    to a parsed file lines up like the rest, and the pre-commit cleaner (which
    pretty-prints every staged SVG) leaves an ink file byte-for-byte alone.
    """
    etree.cleanup_namespaces(root)
    for el in root.iter():
        if el.text is not None and not el.text.strip():
            el.text = None
        if el.tail is not None and not el.tail.strip():
            el.tail = None
    return etree.tostring(root, encoding="unicode", pretty_print=True).encode()


def stroke_ids(data: bytes) -> list[str]:
    """Ids of the strokes in an ink file, in paint order."""
    return [
        el.get("id", "") for el in parse_svg(data) if is_element(el) and el.get("id")
    ]


def add_strokes(
    data: bytes | None,
    strokes: list[Stroke],
    box: tuple[float, float, float, float],
) -> bytes:
    """``data`` (an ink file, or None for a new one) with ``strokes`` on top.

    A stroke whose id is already there replaces it in place, so re-sending one
    (a page retrying, or putting back an erased stroke) never doubles it.
    """
    root = parse_svg(data) if data is not None else new_ink_root(box)
    existing = {el.get("id"): el for el in root if is_element(el)}
    for stroke in strokes:
        el = stroke.element()
        old = existing.get(stroke.id)
        if old is not None:
            root.replace(old, el)
        else:
            root.append(el)
    return serialize_ink(root)


def erase_strokes(data: bytes, ids: set[str]) -> bytes | None:
    """``data`` without the strokes ``ids`` names; None once no stroke is left,
    so the caller deletes the file rather than keep an empty one."""
    root = parse_svg(data)
    for el in [el for el in root if is_element(el) and el.get("id") in ids]:
        root.remove(el)
    if not any(is_element(el) for el in root):
        return None
    return serialize_ink(root)
