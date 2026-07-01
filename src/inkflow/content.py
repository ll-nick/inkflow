from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.manifest import Media, MediaAlign, TextBox
from inkflow.markdown import html_fragment_to_xml
from inkflow.svg import ensure_defs

_VIDEO_SUFFIXES = {".mp4", ".webm", ".ogg", ".mov"}


_ALIGN_MAP: dict[MediaAlign, tuple[int, int]] = {
    MediaAlign.CENTER: (50, 50),
    MediaAlign.TOP: (50, 0),
    MediaAlign.BOTTOM: (50, 100),
    MediaAlign.LEFT: (0, 50),
    MediaAlign.RIGHT: (100, 50),
    MediaAlign.TOP_LEFT: (0, 0),
    MediaAlign.TOP_RIGHT: (100, 0),
    MediaAlign.BOTTOM_LEFT: (0, 100),
    MediaAlign.BOTTOM_RIGHT: (100, 100),
}

_VALIGN_CSS: dict[str, str] = {
    "top": "start",
    "center": "center",
    "bottom": "end",
}


@dataclass
class _ZoneRect:
    x: str
    y: str
    width: str
    height: str


@dataclass
class _ZoneGeometry:
    rect: _ZoneRect
    clip_shape: etree._Element | None = None  # pyright: ignore[reportPrivateUsage]


def substitute_zone_numbers(svg_str: str, slide_number: int, total: int) -> str:
    root = etree.fromstring(svg_str.encode())
    for el in root.iter(f"{{{ns.SVG}}}text"):
        eid = el.get("id", "")
        if eid == "zone-slide-number":
            el.text = str(slide_number)
        elif eid == "zone-slide-total":
            el.text = str(total)
    return etree.tostring(root, encoding="unicode")


def _rect_geometry(el: etree._Element) -> _ZoneRect:  # pyright: ignore[reportPrivateUsage]
    x = el.get("x", "0")
    y = el.get("y", "0")
    w = el.get("width")
    h = el.get("height")
    if w is None or h is None:
        raise ValueError(f"Zone rect missing width/height: {el.get('id')}")
    return _ZoneRect(x=x, y=y, width=w, height=h)


def _polygon_bbox(points_str: str) -> _ZoneRect:
    nums = [float(v) for v in re.split(r"[,\s]+", points_str.strip()) if v]
    xs = nums[0::2]
    ys = nums[1::2]
    x0, y0 = min(xs), min(ys)
    return _ZoneRect(
        x=str(x0), y=str(y0), width=str(max(xs) - x0), height=str(max(ys) - y0)
    )


_PATH_CMD_RE = re.compile(r"([MmZzLlHhVvCcSsQqTtAa])")
_PATH_NUM_RE = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")

_PATH_CLOSEPATH = frozenset("Zz")
_PATH_LINE = frozenset("MmLl")  # moveto and lineto share coordinate layout
_PATH_HORIZ = frozenset("Hh")
_PATH_VERT = frozenset("Vv")
_PATH_CURVE = frozenset("CcSsQqTt")
_PATH_ARC = frozenset("Aa")

_CURVE_COORDS_PER_SEGMENT: dict[str, int] = {
    "C": 6,
    "c": 6,  # cubic bézier: x1,y1  x2,y2  x,y
    "S": 4,
    "s": 4,  # smooth cubic: x2,y2  x,y
    "Q": 4,
    "q": 4,  # quadratic bézier: x1,y1  x,y
    "T": 2,
    "t": 2,  # smooth quadratic: x,y
}
_ARC_PARAMS = 7  # rx ry x-rotation large-arc-flag sweep-flag x y


def _to_abs(value: float, origin: float, is_relative: bool) -> float:
    return origin + value if is_relative else value


def _path_bbox(d: str) -> _ZoneRect:
    """Bounding box from an SVG path d attribute.

    Straight-line commands are exact. Bézier control points are treated as
    bbox contributors (conservative: the curve always lies within its control
    point convex hull). Arc endpoints contribute but arc curvature does not
    (acceptable approximation; clip path uses the exact shape anyway).
    """
    parts = _PATH_CMD_RE.split(d)
    segments = [(parts[i], parts[i + 1]) for i in range(1, len(parts) - 1, 2)]

    xs: list[float] = []
    ys: list[float] = []
    cur_x, cur_y = 0.0, 0.0

    for cmd, args_str in segments:
        raw: list[str] = _PATH_NUM_RE.findall(args_str)
        args = [float(v) for v in raw]
        is_relative = cmd.islower()

        if cmd in _PATH_CLOSEPATH:
            pass

        elif cmd in _PATH_LINE:
            for j in range(0, len(args) - 1, 2):
                cur_x = _to_abs(args[j], cur_x, is_relative)
                cur_y = _to_abs(args[j + 1], cur_y, is_relative)
                xs.append(cur_x)
                ys.append(cur_y)

        elif cmd in _PATH_HORIZ:
            for a in args:
                cur_x = _to_abs(a, cur_x, is_relative)
                xs.append(cur_x)
                ys.append(cur_y)

        elif cmd in _PATH_VERT:
            for a in args:
                cur_y = _to_abs(a, cur_y, is_relative)
                xs.append(cur_x)
                ys.append(cur_y)

        elif cmd in _PATH_CURVE:
            step = _CURVE_COORDS_PER_SEGMENT[cmd]
            for seg_start in range(0, len(args) - 1, step):
                seg = args[seg_start : seg_start + step]
                for j in range(0, len(seg) - 1, 2):
                    xs.append(_to_abs(seg[j], cur_x, is_relative))
                    ys.append(_to_abs(seg[j + 1], cur_y, is_relative))
                if len(seg) >= 2:
                    cur_x = _to_abs(seg[-2], cur_x, is_relative)
                    cur_y = _to_abs(seg[-1], cur_y, is_relative)

        elif cmd in _PATH_ARC:
            for seg_start in range(0, len(args), _ARC_PARAMS):
                seg = args[seg_start : seg_start + _ARC_PARAMS]
                if len(seg) == _ARC_PARAMS:
                    *_, endpoint_x, endpoint_y = seg
                    cur_x = _to_abs(endpoint_x, cur_x, is_relative)
                    cur_y = _to_abs(endpoint_y, cur_y, is_relative)
                    xs.append(cur_x)
                    ys.append(cur_y)

    if not xs:
        raise ValueError(f"Zone path has no parseable coordinates: {d!r}")
    x0, y0 = min(xs), min(ys)
    return _ZoneRect(
        x=str(x0), y=str(y0), width=str(max(xs) - x0), height=str(max(ys) - y0)
    )


def _zone_geometry(
    el: etree._Element,  # pyright: ignore[reportPrivateUsage]
) -> _ZoneGeometry:
    tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag

    shape_copy = copy.deepcopy(el)
    if "id" in shape_copy.attrib:
        del shape_copy.attrib["id"]
    if "transform" in shape_copy.attrib:
        del shape_copy.attrib["transform"]

    if tag == "rect":
        return _ZoneGeometry(rect=_rect_geometry(el), clip_shape=shape_copy)

    if tag in ("polygon", "polyline"):
        rect = _polygon_bbox(el.get("points", ""))
    elif tag == "path":
        rect = _path_bbox(el.get("d", ""))
    elif tag == "ellipse":
        cx = float(el.get("cx", 0))
        cy = float(el.get("cy", 0))
        rx = float(el.get("rx", 0))
        ry = float(el.get("ry", 0))
        rect = _ZoneRect(
            x=str(cx - rx), y=str(cy - ry), width=str(2 * rx), height=str(2 * ry)
        )
    elif tag == "circle":
        cx = float(el.get("cx", 0))
        cy = float(el.get("cy", 0))
        r = float(el.get("r", 0))
        rect = _ZoneRect(
            x=str(cx - r), y=str(cy - r), width=str(2 * r), height=str(2 * r)
        )
    else:
        return _ZoneGeometry(rect=_rect_geometry(el))

    return _ZoneGeometry(rect=rect, clip_shape=shape_copy)


def _add_clip_path(
    root: etree._Element,  # pyright: ignore[reportPrivateUsage]
    zone_id: str,
    shape_el: etree._Element,  # pyright: ignore[reportPrivateUsage]
) -> str:
    clip_id = f"inkflow-clip-{zone_id}"
    defs = ensure_defs(root)
    clip = etree.SubElement(defs, f"{{{ns.SVG}}}clipPath")
    clip.set("id", clip_id)
    clip.append(shape_el)
    return f"url(#{clip_id})"


def _swap_zone(
    old_el: etree._Element,  # pyright: ignore[reportPrivateUsage]
    new_el: etree._Element,  # pyright: ignore[reportPrivateUsage]
    rect: _ZoneRect,
    zone_id: str,
) -> None:
    """Set geometry + id on new_el and swap it in place of old_el in the tree."""
    new_el.set("id", zone_id)
    new_el.set("x", rect.x)
    new_el.set("y", rect.y)
    new_el.set("width", rect.width)
    new_el.set("height", rect.height)
    transform = old_el.get("transform")
    if transform is not None:
        new_el.set("transform", transform)
    parent = old_el.getparent()
    if parent is None:
        return
    idx = list(parent).index(old_el)
    parent.remove(old_el)
    parent.insert(idx, new_el)


def _replace_with_foreignobject(
    el: etree._Element,  # pyright: ignore[reportPrivateUsage]
    zone_id: str,
    font_size: int,
    item: TextBox,
) -> None:
    rect = _zone_geometry(el).rect

    fo = etree.Element(f"{{{ns.SVG}}}foreignObject")
    fo.set("overflow", "visible")
    fo.set("font-size", str(font_size))  # SVG user units; cascades into HTML via em

    wrapper_style_parts: list[str] = []
    if item.valign is not None:
        wrapper_style_parts.append(f"justify-content:{_VALIGN_CSS[item.valign]}")
    if item.padding is not None:
        wrapper_style_parts.append(f"padding:{item.padding:g}px")

    content_style_parts: list[str] = []
    if item.align is not None:
        content_style_parts.append(f"text-align:{item.align}")

    # Use XHTML as default namespace so lxml serialises <div>, <p>, <ul>
    # without a prefix — required for the browser's HTML parser to recognise
    # them as real HTML elements inside foreignObject.
    wrapper_attrs: dict[str, str] = {"class": "inkflow-wrapper"}
    if wrapper_style_parts:
        wrapper_attrs["style"] = ";".join(wrapper_style_parts)
    wrapper = etree.Element(
        f"{{{ns.XHTML}}}div",
        wrapper_attrs,
        nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
    )

    content_attrs: dict[str, str] = {"class": "inkflow-content"}
    if content_style_parts:
        content_attrs["style"] = ";".join(content_style_parts)
    content_div = etree.SubElement(wrapper, f"{{{ns.XHTML}}}div", content_attrs)

    html = html_fragment_to_xml(item.text or "")
    fragment = etree.fromstring(f"<div xmlns='{ns.XHTML}'>{html}</div>")
    content_div.text = fragment.text
    for child in fragment:
        content_div.append(child)

    # Drop <hr class="footnotes-sep"> (CSS border-top on the section replaces it)
    # and hoist <section class="footnotes"> to wrapper so margin-top:auto anchors
    # it to the bottom of the zone regardless of content height.
    for child in list(content_div):
        tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
        cls = (child.get("class") or "").split()
        if tag == "hr" and "footnotes-sep" in cls:
            content_div.remove(child)
        elif tag == "section" and "footnotes" in cls:
            content_div.remove(child)
            wrapper.append(child)

    fo.append(wrapper)

    _swap_zone(el, fo, rect, zone_id)


def _fmt_pos(base: int, offset_pct: float) -> str:
    if offset_pct == 0.0:
        return f"{base}%"
    sign = "+" if offset_pct >= 0 else "-"
    return f"calc({base}% {sign} {abs(offset_pct):.6g}%)"


def _make_media_element(src: str, style: str) -> etree._Element:  # pyright: ignore[reportPrivateUsage]
    suffix = Path(src).suffix.lower()
    if suffix in _VIDEO_SUFFIXES:
        el = etree.Element(
            f"{{{ns.XHTML}}}video",
            {"src": src, "controls": ""},
            nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
        )
        # prevent XML self-close: <video/> breaks HTML5 parsing
        el.append(etree.Comment(""))
    else:
        el = etree.Element(
            f"{{{ns.XHTML}}}img",
            {"src": src},
            nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
        )
    el.set("style", style)
    return el


def _replace_with_media(
    el: etree._Element,  # pyright: ignore[reportPrivateUsage]
    root: etree._Element,  # pyright: ignore[reportPrivateUsage]
    zone_id: str,
    dark_mode: bool,
    item: Media,
) -> None:
    geom = _zone_geometry(el)
    rect = geom.rect

    base_x, base_y = _ALIGN_MAP[item.align]
    x_pct = item.x / float(rect.width) * 100
    y_pct = item.y / float(rect.height) * 100
    base_style = (
        f"width:100%;height:100%;"
        f"object-fit:{item.fit};"
        f"object-position:{_fmt_pos(base_x, x_pct)} {_fmt_pos(base_y, y_pct)};"
    )

    fo = etree.Element(f"{{{ns.SVG}}}foreignObject")
    fo.set("overflow", "visible")
    if geom.clip_shape is not None:
        fo.set("clip-path", _add_clip_path(root, zone_id, geom.clip_shape))

    if item.alt_src is None:
        fo.append(_make_media_element(item.src, base_style + "display:block;"))
    else:
        # display is managed by CSS via [data-inkflow-theme] selectors
        primary_theme = "dark" if dark_mode else "light"
        alt_theme = "light" if dark_mode else "dark"
        primary_el = _make_media_element(item.src, base_style)
        primary_el.set("data-inkflow-theme", primary_theme)
        alt_el = _make_media_element(item.alt_src, base_style)
        alt_el.set("data-inkflow-theme", alt_theme)
        fo.append(primary_el)
        fo.append(alt_el)

    _swap_zone(el, fo, rect, zone_id)


def substitute_content(
    svg_str: str,
    content: dict[str, TextBox | Media],
    font_size: int = 36,
    dark_mode: bool = True,
) -> str:
    root = etree.fromstring(svg_str.encode())

    for zone_id, item in content.items():
        el = root.find(f'.//*[@id="{zone_id}"]')
        if el is None:
            print(f"[inkflow] warning: zone #{zone_id} not found in SVG")
            continue

        if isinstance(item, TextBox):
            _replace_with_foreignobject(el, zone_id, font_size, item)
        else:
            _replace_with_media(el, root, zone_id, dark_mode, item)

    return etree.tostring(root, encoding="unicode")


_ZONE_SHAPE_TAGS = frozenset(
    {
        f"{{{ns.SVG}}}rect",
        f"{{{ns.SVG}}}polygon",
        f"{{{ns.SVG}}}polyline",
        f"{{{ns.SVG}}}ellipse",
        f"{{{ns.SVG}}}circle",
        f"{{{ns.SVG}}}path",
    }
)


def remove_unreferenced_zones(svg_str: str) -> str:
    root = etree.fromstring(svg_str.encode())
    to_remove = [
        el
        for el in root.iter(*_ZONE_SHAPE_TAGS)
        if (el.get("id") or "").startswith("zone-") and not el.get("class")
    ]
    for el in to_remove:
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
    return etree.tostring(root, encoding="unicode")


def inject_style(svg_str: str, css: str) -> str:
    if not css:
        return svg_str
    root = etree.fromstring(svg_str.encode())
    defs = root.find(f"{{{ns.SVG}}}defs")
    if defs is None:
        defs = etree.Element(f"{{{ns.SVG}}}defs")
        root.insert(0, defs)
    style = etree.SubElement(defs, f"{{{ns.SVG}}}style")
    style.text = css
    return etree.tostring(root, encoding="unicode")
