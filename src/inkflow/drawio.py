"""draw.io diagrams kept as editable SVG (``*.drawio.svg``).

draw.io's "editable SVG" is an ordinary SVG picture of the diagram whose root
carries the diagram's source, an ``<mxfile>``, in its ``content`` attribute.
GitHub and GitLab show the picture; draw.io (desktop, the VS Code extension,
the inkflow editor) opens the source. A slide shows one as an ``<image>``.

draw.io usually compresses each page of the source (deflate + base64), which
makes every change one unreadable line in a diff. Saving through inkflow
stores the pages uncompressed, and ``textconv`` gives git's diff the source,
pretty-printed, compressed or not.
"""

from __future__ import annotations

import base64
import re
import urllib.parse
import zlib
from dataclasses import dataclass
from pathlib import Path

from lxml import etree

from inkflow.svgio import SvgElement, parse_svg, serialize_svg, svg_parser

SUFFIX = ".drawio.svg"
DEFAULT_URL = "https://embed.diagrams.net/"


class DrawioError(ValueError):
    pass


def is_drawio_path(path: Path) -> bool:
    return path.name.lower().endswith(SUFFIX)


def _content(root: SvgElement) -> str | None:
    content = root.get("content")
    return content if content and content.lstrip().startswith("<mxfile") else None


def is_drawio_svg(data: bytes) -> bool:
    """Whether ``data`` is an SVG with a draw.io diagram inside."""
    try:
        return _content(parse_svg(data)) is not None
    except (etree.XMLSyntaxError, ValueError):
        return False


def _inflate(text: str) -> str:
    """One compressed draw.io page: base64, raw deflate, URI-encoded XML."""
    try:
        raw = zlib.decompress(base64.b64decode(text), -15)
    except (ValueError, zlib.error) as exc:
        raise DrawioError(f"cannot read a compressed diagram page: {exc}") from exc
    return urllib.parse.unquote(raw.decode("utf-8"))


def decompress(mxfile: str) -> str:
    """``mxfile`` with every page stored as plain XML."""
    try:
        root = etree.fromstring(
            mxfile.encode("utf-8"),
            parser=svg_parser(),
        )
    except etree.XMLSyntaxError as exc:
        raise DrawioError(f"the diagram source is not valid XML: {exc}") from exc
    if root.tag != "mxfile":
        raise DrawioError("the diagram source is not an <mxfile>")
    for page in root.iter("diagram"):
        text = (page.text or "").strip()
        if len(page) or not text:
            continue
        model = etree.fromstring(
            _inflate(text).encode("utf-8"),
            parser=svg_parser(),
        )
        page.text = None
        page.append(model)
    root.set("compressed", "false")
    return etree.tostring(root, encoding="unicode")


Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class Cell:
    """One cell of a diagram's source, as far as the slide needs it."""

    kind: str
    """``vertex`` (a shape), ``edge`` (an arrow), ``label`` (an arrow's
    label, a vertex inside an edge) or ``other`` (the root and its layers)."""
    parent: str | None
    box: Box | None = None
    """A shape's box (x, y, width, height) on the page: its geometry plus that
    of the shapes it sits in (a child's geometry is relative to its parent)."""


def model(mxfile: str) -> SvgElement:
    """The ``<mxfile>`` element of a diagram source, every page uncompressed."""
    return etree.fromstring(decompress(mxfile).encode("utf-8"), parser=svg_parser())


def cell_elements(root: SvgElement) -> dict[str, tuple[SvgElement, SvgElement]]:
    """Each cell by id: the element carrying its id (an ``<mxCell>``, or the
    ``<UserObject>``/``<object>`` holding a cell with data) and its ``<mxCell>``.
    The first page's cell wins when pages share ids."""
    found: dict[str, tuple[SvgElement, SvgElement]] = {}
    for cell in root.iter("mxCell", "UserObject", "object"):
        inner = cell if cell.tag == "mxCell" else cell.find("mxCell")
        cell_id = cell.get("id")
        if inner is not None and cell_id is not None and cell_id not in found:
            found[cell_id] = (cell, inner)
    return found


def _number(value: str | None) -> float:
    try:
        return float(value or 0)
    except ValueError:
        return 0.0


def cells(mxfile: str) -> dict[str, Cell]:
    """The cells of every page of a diagram source, by id (first page wins)."""
    raw: dict[str, tuple[str, str | None, Box | None]] = {}
    for cell_id, (_, inner) in cell_elements(model(mxfile)).items():
        kind = (
            "vertex"
            if inner.get("vertex") == "1"
            else "edge"
            if inner.get("edge") == "1"
            else "other"
        )
        geometry = inner.find("mxGeometry")
        own: Box | None = None
        if (
            kind == "vertex"
            and geometry is not None
            and geometry.get("relative") != "1"
        ):
            own = (
                _number(geometry.get("x")),
                _number(geometry.get("y")),
                _number(geometry.get("width")),
                _number(geometry.get("height")),
            )
        raw[cell_id] = (kind, inner.get("parent"), own)

    def origin(cell_id: str | None, depth: int = 0) -> tuple[float, float]:
        parent = raw.get(cell_id or "")
        if parent is None or parent[2] is None or depth > 100:
            return 0.0, 0.0
        px, py = origin(parent[1], depth + 1)
        return px + parent[2][0], py + parent[2][1]

    out: dict[str, Cell] = {}
    for cell_id, (kind, parent, own) in raw.items():
        if kind == "vertex" and parent and raw.get(parent, ("",))[0] == "edge":
            out[cell_id] = Cell("label", parent)
            continue
        box = None
        if own is not None:
            ox, oy = origin(parent)
            box = (ox + own[0], oy + own[1], own[2], own[3])
        out[cell_id] = Cell(kind, parent, box)
    return out


def source(data: bytes) -> str:
    """The diagram source (``<mxfile>``) inside a draw.io SVG, uncompressed."""
    try:
        content = _content(parse_svg(data))
    except etree.XMLSyntaxError as exc:
        raise DrawioError(f"not an SVG: {exc}") from exc
    if content is None:
        raise DrawioError("this SVG has no draw.io diagram inside")
    return decompress(content)


def normalize(data: bytes) -> bytes:
    """A draw.io SVG as inkflow keeps it: the source uncompressed."""
    try:
        root = parse_svg(data)
    except etree.XMLSyntaxError as exc:
        raise DrawioError(f"not an SVG: {exc}") from exc
    if etree.QName(root).localname != "svg":
        raise DrawioError("not an SVG")
    content = _content(root)
    if content is None:
        raise DrawioError("this SVG has no draw.io diagram inside")
    root.set("content", decompress(content))
    return serialize_svg(root).encode("utf-8")


def size(data: bytes) -> tuple[float, float] | None:
    """The picture's size in CSS pixels (draw.io writes ``width="123px"``)."""
    root = parse_svg(data)
    match = [re.match(r"([\d.]+)", root.get(k) or "") for k in ("width", "height")]
    if match[0] and match[1]:
        return float(match[0].group(1)), float(match[1].group(1))
    box = (root.get("viewBox") or "").split()
    if len(box) == 4:
        return float(box[2]), float(box[3])
    return None


_EMPTY = (
    '<mxfile compressed="false"><diagram id="page-1" name="Page-1">'
    + '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root>'
    + "</mxGraphModel></diagram></mxfile>"
)

BLANK_SIZE = (640, 360)


def blank() -> bytes:
    """A new, empty diagram for draw.io desktop to open (no internet needed).

    Its picture is a placeholder saying so, until the first save in draw.io
    replaces it with the drawing; the source inside is an empty page.
    """
    w, h = BLANK_SIZE
    root = parse_svg(
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{w}px"'
        + f' height="{h}px" viewBox="0 0 {w} {h}">'
        + f'<rect x="2" y="2" width="{w - 4}" height="{h - 4}" rx="12"'
        + ' fill="none" stroke="#888" stroke-width="3" stroke-dasharray="12 8"/>'
        + f'<text x="{w / 2}" y="{h / 2}" text-anchor="middle" fill="#888"'
        + ' font-family="sans-serif" font-size="28">New diagram: draw it in'
        + " draw.io and save</text></svg>"
    )
    root.set("content", _EMPTY)
    return serialize_svg(root).encode("utf-8")


def textconv(data: bytes) -> str:
    """What ``git diff`` shows for a draw.io SVG: its source, one tag a line."""
    mxfile = etree.fromstring(
        source(data).encode("utf-8"),
        parser=svg_parser(),
    )
    for el in mxfile.iter():
        # Only the tree's own layout: whitespace a page kept is re-indented.
        if el.text is not None and not el.text.strip():
            el.text = None
        if el.tail is not None and not el.tail.strip():
            el.tail = None
    return etree.tostring(mxfile, encoding="unicode", pretty_print=True)
