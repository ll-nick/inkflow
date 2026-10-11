"""Draw a draw.io diagram into its slide instead of showing its picture.

A slide shows a ``*.drawio.svg`` as an ``<image>``: a picture, drawn exactly
as draw.io drew it. With ``inkflow:drawio="inline"`` on that ``<image>`` the
build puts the diagram's own SVG in its place (a nested ``<svg>`` with the
picture's box, id and provenance), so:

* each draw.io shape is an element of the slide with an id,
  ``<picture id>-<cell id>``, that animations can target;
* draw.io's default font (Helvetica) becomes the deck's body font; a font
  chosen in draw.io stays, and is embedded like any other slide font;
* draw.io's own dark-mode colours (``light-dark()``) follow the deck's colour
  mode rather than the viewer's system setting.

``inkflow:drawio="themed"`` also redraws it in the deck's theme: colours
become theme tokens (draw.io's standard palette by name, any other colour by
hue and lightness) and all text uses the deck's fonts.

The diagram file stays the source and is never changed; the slide's
``<image>`` keeps its place and size, which is what the editor moves.
"""

from __future__ import annotations

import colorsys
import copy
import re
from collections.abc import Callable
from enum import StrEnum
from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.assets import AssetRoots, AssetSource
from inkflow.colors import parse_style, serialize_style
from inkflow.drawio import DrawioError, cells, is_drawio_path, size
from inkflow.editor.provenance import INK, INK_TAG, is_element
from inkflow.logging import logger
from inkflow.svgio import SvgElement, parse_svg_file


class DiagramMode(StrEnum):
    """How a slide shows a draw.io diagram (``inkflow:drawio`` on its picture)."""

    PICTURE = "picture"
    """The default (no attribute): the picture draw.io saved."""
    INLINE = "inline"
    """Drawn into the slide: shapes can be animated, the deck's font."""
    THEMED = "themed"
    """Drawn into the slide in the deck's theme colours and fonts."""


_HREFS = ("href", f"{{{ns.XLINK}}}href")
DRAWN_GEOMETRY = "data-drawn-geometry"
"""On a shape of the diagram's picture moved by the editor before draw.io
redrew it: the box its drawing shows (it is under a transform until then)."""


def diagram_mode(image: SvgElement) -> DiagramMode:
    value = image.get(ns.INKFLOW_DRAWIO)
    try:
        return DiagramMode(value) if value else DiagramMode.PICTURE
    except ValueError:
        return DiagramMode.PICTURE


def inline_diagrams(
    root: SvgElement,
    roots: AssetRoots,
    register: Callable[[Path], int] | None = None,
) -> SvgElement:
    """Replace each draw.io picture asked to be drawn inline (see module doc).

    ``register`` (the editor's source table) numbers the diagram file, and its
    shapes get locators into it (``<key>:#<cell id>``): the editor edits them
    there, in the diagram's source (editor/drawioedit.py).
    """
    taken = {i for el in root.iter() if (i := el.get("id"))}
    for image in list(root.iter(f"{{{ns.SVG}}}image")):
        mode = diagram_mode(image)
        if mode is DiagramMode.PICTURE:
            continue
        href = next((v for a in _HREFS if (v := image.get(a))), "")
        path = roots.locate(href.split("?")[0])
        if path is None or not is_drawio_path(path):
            logger.warning(
                "inkflow:drawio is set on a picture that is not a draw.io"
                + f" diagram: {href}"
            )
            continue
        try:
            diagram = AssetSource.for_file(roots, path).svg(parse_svg_file(path))
        except (OSError, ValueError) as exc:  # unreadable, or not an SVG
            logger.warning(f"cannot draw the diagram {href} into the slide: {exc}")
            continue
        prefix = image.get("id") or _fresh_id(
            path.name.removesuffix(".drawio.svg"), taken
        )
        taken.add(prefix)
        key = register(path) if register is not None else None
        drawn = _drawn(image, diagram, prefix, href, mode, key)
        parent = image.getparent()
        if parent is not None:
            parent.replace(image, drawn)
    return root


def _fresh_id(stem: str, taken: set[str]) -> str:
    base = re.sub(r"[^\w-]+", "-", stem).strip("-") or "diagram"
    if base[0].isdigit():
        base = f"diagram-{base}"
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    return name


def _drawn(
    image: SvgElement,
    diagram: SvgElement,
    prefix: str,
    href: str,
    mode: DiagramMode,
    key: int | None = None,
) -> SvgElement:
    svg = image.makeelement(f"{{{ns.SVG}}}svg", {})
    for name, value in image.attrib.items():
        if name not in _HREFS and name != ns.INKFLOW_DRAWIO:
            svg.set(name, value)
    if image.get(INK) is not None and INK_TAG not in image.attrib:
        # The editor moves and resizes it as the <image> it is in the file.
        svg.set(INK_TAG, "image")
    measured = _size(diagram)
    if measured is not None:
        svg.set(
            "viewBox", diagram.get("viewBox") or f"0 0 {measured[0]:g} {measured[1]:g}"
        )
        if image.get("width") is None or image.get("height") is None:
            svg.set("width", f"{measured[0]:g}")
            svg.set("height", f"{measured[1]:g}")
    svg.set("id", prefix)
    svg.set("data-drawio", href.split("?")[0])
    svg.set("data-drawio-mode", str(mode))
    svg.set("class", " ".join([*(image.get("class") or "").split(), "inkflow-diagram"]))
    # (Its colour scheme, the deck's mode, comes from contract.css.)
    decls = parse_style(image.get("style") or "")
    if mode is DiagramMode.THEMED:
        # draw.io's "automatic" fill (label backgrounds and the like).
        decls.append(("--ge-adaptive-bg", "var(--inkflow-bg)"))
    if decls:
        svg.set("style", serialize_style(decls))
    svg.text = None
    for kid in image:  # a <title>/<desc>: the picture's alt text
        svg.append(copy.deepcopy(kid))
    for kid in diagram:
        svg.append(copy.deepcopy(kid))
    _rename_ids(svg, diagram.get("id"), prefix)
    _mark_cells(svg, diagram.get("content"), key)
    themed = mode is DiagramMode.THEMED
    for el in svg.iterdescendants():
        if is_element(el):
            _restyle(el, themed)
    return svg


def _mark_cells(svg: SvgElement, content: str | None, key: int | None) -> None:
    """``data-cell-kind`` on each cell: the editor attaches arrows to shapes
    (vertices), never to draw.io's own arrows, their labels or the layers.

    A shape also gets ``data-cell-geometry``, the box (in the source's page
    coordinates) its drawing shows: the editor measures where draw.io put
    the page on the picture from it. With ``key``, shapes get locators.
    """
    try:
        known = cells(content) if content else {}
    except (DrawioError, etree.XMLSyntaxError):
        known = {}
    for el in svg.iterdescendants():
        if not is_element(el) or (cell_id := el.get("data-cell-id")) is None:
            continue
        cell = known.get(cell_id)
        el.set("data-cell-kind", cell.kind if cell else "other")
        if cell is not None and cell.kind == "other" and cell.parent is not None:
            # A layer: the group the editor enters to edit the shapes on it.
            if key is not None:
                el.set(INK, f"{key}:#{cell_id}")
            continue
        if cell is None or cell.kind != "vertex" or cell.box is None:
            continue
        # A shape moved on the slide but not yet redrawn by draw.io still
        # shows its old box, under a transform (editor/drawioedit.py).
        drawn = el.get(DRAWN_GEOMETRY) or " ".join(f"{v:g}" for v in cell.box)
        el.set("data-cell-geometry", drawn)
        if key is not None:
            el.set(INK, f"{key}:#{cell_id}")


def _size(diagram: SvgElement) -> tuple[float, float] | None:
    box = (diagram.get("viewBox") or "").split()
    if len(box) == 4:
        return float(box[2]), float(box[3])
    return size(etree.tostring(diagram))


# ── Ids: one namespace per diagram, each shape named after its cell ──

_URL_RE = re.compile(r"url\(\s*(['\"]?)#([^'\")\s]+)\1\s*\)")
_CSS_ID_RE = re.compile(r"#([\w-]+)")


def _rename_ids(svg: SvgElement, root_id: str | None, prefix: str) -> None:
    """Prefix every id inside with ``prefix`` and give each draw.io cell one,
    so a diagram shown twice (or next to its own slide's ids) cannot clash,
    and so animations can name its shapes."""
    rename = {
        old: f"{prefix}-{old}"
        for el in svg.iterdescendants()
        if (old := el.get("id")) is not None
    }
    if root_id:
        rename[root_id] = prefix

    def url(match: re.Match[str]) -> str:
        new = rename.get(match.group(2))
        return f"url(#{new})" if new else match.group(0)

    for el in svg.iterdescendants():
        if not is_element(el):
            continue
        old = el.get("id")
        if old is not None:
            el.set("id", rename[old])
        elif (cell := el.get("data-cell-id")) is not None:
            el.set("id", f"{prefix}-{cell}")
        for name, value in [(str(k), str(v)) for k, v in el.attrib.items()]:
            if name in _HREFS and value.startswith("#") and value[1:] in rename:
                el.set(name, f"#{rename[value[1:]]}")
            elif "url(" in value:
                el.set(name, _URL_RE.sub(url, value))
        if etree.QName(el).localname == "style" and el.text:
            text = _URL_RE.sub(url, el.text)
            el.text = _CSS_ID_RE.sub(
                lambda m: (
                    f"#{rename[m.group(1)]}" if m.group(1) in rename else m.group(0)
                ),
                text,
            )


# ── Fonts and colours ──

_FONT_ATTRS = ("font-family",)
_PAINT_ATTRS = ("fill", "stroke", "stop-color")
# The CSS property's role: an area (filled) or a line / text (ink).
_ROLES = {
    "fill": "fill",
    "stop-color": "fill",
    "flood-color": "fill",
    "background-color": "background",
    "background": "background",
    "stroke": "ink",
    "color": "ink",
    "border": "ink",
    "border-color": "ink",
}


_TEXT_TAGS = frozenset({"text", "tspan", "textPath"})


def _restyle(el: SvgElement, themed: bool) -> None:
    # A text's fill is its ink, not an area.
    text = etree.QName(el).localname in _TEXT_TAGS
    roles = {**_ROLES, "fill": "ink"} if text else _ROLES
    decls = parse_style(el.get("style") or "")
    styled = {prop for prop, _ in decls}
    changed = False
    out: list[tuple[str, str]] = []
    for prop, value in decls:
        new = value
        if prop == "font-family":
            new = _font(value, themed)
        elif themed and prop in _ROLES:
            new = _recolor(value, roles[prop])
        changed = changed or new != value
        out.append((prop, new))
    # Presentation attributes cannot hold var(): what changes moves to style.
    for attr in (*_FONT_ATTRS, *(_PAINT_ATTRS if themed else ())):
        value = el.get(attr)
        if value is None:
            continue
        if attr in styled:  # shadowed by the style: never shows
            if themed:
                del el.attrib[attr]
            continue
        new = (
            _font(value, themed)
            if attr == "font-family"
            else _recolor(value, roles[attr])
        )
        if new != value:
            del el.attrib[attr]
            out.append((attr, new))
            changed = True
    if changed:
        el.set("style", serialize_style(out))


_MONO = ("mono", "courier", "consolas", "menlo")


def _font(value: str, themed: bool) -> str:
    families = [f.strip().strip("'\"").lower() for f in value.split(",")]
    if themed:
        if any(m in f for f in families for m in _MONO):
            return "var(--inkflow-mono-font)"
        return "var(--inkflow-body-font)"
    # Helvetica is draw.io's default, not a choice: the deck's font instead.
    if families and families[0] == "helvetica":
        return "var(--inkflow-body-font)"
    return value


# draw.io's standard palette (Format panel → Style), fill and line colour.
_PALETTE: dict[str, str] = {
    "#dae8fc": "blue",
    "#6c8ebf": "blue",
    "#d5e8d4": "green",
    "#82b366": "green",
    "#ffe6cc": "orange",
    "#d79b00": "orange",
    "#fff2cc": "yellow",
    "#d6b656": "yellow",
    "#f8cecc": "red",
    "#b85450": "red",
    "#e1d5e7": "purple",
    "#9673a6": "purple",
}
_HUES = (
    ("red", 0),
    ("orange", 30),
    ("yellow", 52),
    ("green", 120),
    ("teal", 175),
    ("blue", 215),
    ("purple", 275),
    ("pink", 325),
    ("red", 360),
)

_COLOR_RE = re.compile(
    r"#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)|(?<![\w-])(?:white|black)(?![\w-])"
)


def _recolor(value: str, role: str) -> str:
    """``value`` with each colour in it replaced by its theme token."""
    out: list[str] = []
    i = 0
    while i < len(value):
        if value.startswith("light-dark(", i):
            end = _closing(value, i + len("light-dark"))
            if end < 0:
                break
            light = _first_argument(value[i + len("light-dark(") : end])
            out.append(_token(light, role) or value[i : end + 1])
            i = end + 1
            continue
        match = _COLOR_RE.match(value, i)
        if match:
            out.append(_token(match.group(0), role) or match.group(0))
            i = match.end()
            continue
        out.append(value[i])
        i += 1
    return "".join(out) + value[i:]


def _closing(text: str, open_at: int) -> int:
    depth = 0
    for j in range(open_at, len(text)):
        if text[j] == "(":
            depth += 1
        elif text[j] == ")":
            depth -= 1
            if depth == 0:
                return j
    return -1


def _first_argument(args: str) -> str:
    depth = 0
    for j, c in enumerate(args):
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "," and depth == 0:
            return args[:j].strip()
    return args.strip()


def _rgb(text: str) -> tuple[float, float, float] | None:
    text = text.strip().lower()
    if text == "white":
        return 1.0, 1.0, 1.0
    if text == "black":
        return 0.0, 0.0, 0.0
    if text.startswith("#"):
        h = text[1:]
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h[:3])
        if len(h) == 8 and h[6:] == "00":
            return None  # fully transparent
        if len(h) not in (6, 8):
            return None
        return int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255
    match = re.fullmatch(r"rgba?\(([^()]*)\)", text)
    if not match:
        return None
    parts = [p.strip() for p in re.split(r"[,\s/]+", match.group(1)) if p.strip()]
    try:
        r, g, b = (float(p) / 255 for p in parts[:3])
        if len(parts) > 3 and float(parts[3].rstrip("%")) == 0:
            return None
    except ValueError:
        return None
    return r, g, b


def _var(name: str) -> str:
    return f"var(--inkflow-{name})"


def _tint(name: str) -> str:
    return f"color-mix(in srgb, {_var(name)} 25%, {_var('surface')})"


def _token(color: str, role: str) -> str | None:
    """The theme's stand-in for one draw.io colour in a role, or None."""
    rgb = _rgb(color)
    if rgb is None:
        return None
    hue, light, sat = colorsys.rgb_to_hls(*rgb)
    family = _PALETTE.get(color.strip().lower()) if color.startswith("#") else None
    if family is None and sat >= 0.12 and max(rgb) - min(rgb) >= 0.03:
        degrees = hue * 360
        family = min(_HUES, key=lambda h: abs(h[1] - degrees))[0]
    if family is None:  # a grey
        if role == "ink":
            if light < 0.35:
                return _var("text")
            return _var("grey") if light < 0.8 else _var("bg")
        if light >= 0.93:
            return _var("bg" if role == "background" else "surface")
        if light >= 0.6:
            return _tint("grey")
        return _var("grey") if light >= 0.3 else _var("text")
    if role != "ink" and light >= 0.7:
        return _tint(family)
    return _var(family)
