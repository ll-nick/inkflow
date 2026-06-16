from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.manifest import Align, Media, TextBox, VAlign
from inkflow.svg import ensure_defs

_VIDEO_SUFFIXES = {".mp4", ".webm", ".ogg", ".mov"}


_ALIGN_MAP: dict[str, tuple[int, int]] = {
    "center": (50, 50),
    "top": (50, 0),
    "bottom": (50, 100),
    "left": (0, 50),
    "right": (100, 50),
    "top-left": (0, 0),
    "top-right": (100, 0),
    "bottom-left": (0, 100),
    "bottom-right": (100, 100),
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

    if tag == "rect":
        return _ZoneGeometry(rect=_rect_geometry(el))

    shape_copy = copy.deepcopy(el)
    if "id" in shape_copy.attrib:
        del shape_copy.attrib["id"]

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
    parent = old_el.getparent()
    if parent is None:
        return
    idx = list(parent).index(old_el)
    parent.remove(old_el)
    parent.insert(idx, new_el)


def _replace_with_foreignobject(
    el: etree._Element,  # pyright: ignore[reportPrivateUsage]
    html: str,
    zone_id: str,
    font_size: int,
    align: Align | None = None,
    valign: VAlign | None = None,
    padding: float | None = None,
) -> None:
    rect = _zone_geometry(el).rect

    fo = etree.Element(f"{{{ns.SVG}}}foreignObject")
    fo.set("overflow", "visible")
    fo.set("font-size", str(font_size))  # SVG user units; cascades into HTML via em

    wrapper_style_parts: list[str] = []
    if valign is not None:
        wrapper_style_parts.append(f"justify-content:{_VALIGN_CSS[valign]}")
    if padding is not None:
        wrapper_style_parts.append(f"padding:{padding:g}px")

    content_style_parts: list[str] = []
    if align is not None:
        content_style_parts.append(f"text-align:{align}")

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

    try:
        fragment = etree.fromstring(f"<div xmlns='{ns.XHTML}'>{html}</div>")
        content_div.text = fragment.text
        for child in fragment:
            content_div.append(child)
    except etree.XMLSyntaxError:
        content_div.text = html
    fo.append(wrapper)

    _swap_zone(el, fo, rect, zone_id)


def _fmt_pos(base: int, offset_pct: float) -> str:
    if offset_pct == 0.0:
        return f"{base}%"
    sign = "+" if offset_pct >= 0 else "-"
    return f"calc({base}% {sign} {abs(offset_pct):.6g}%)"


def _replace_with_media(
    el: etree._Element,  # pyright: ignore[reportPrivateUsage]
    root: etree._Element,  # pyright: ignore[reportPrivateUsage]
    src: str,
    zone_id: str,
    fit: str,
    align: str,
    x: float,
    y: float,
) -> None:
    geom = _zone_geometry(el)
    rect = geom.rect

    base_x, base_y = _ALIGN_MAP.get(align, (50, 50))
    x_pct = x / float(rect.width) * 100
    y_pct = y / float(rect.height) * 100
    style = (
        f"width:100%;height:100%;"
        f"object-fit:{fit};"
        f"object-position:{_fmt_pos(base_x, x_pct)} {_fmt_pos(base_y, y_pct)};"
        f"display:block;"
    )

    fo = etree.Element(f"{{{ns.SVG}}}foreignObject")
    fo.set("overflow", "visible")
    if geom.clip_shape is not None:
        fo.set("clip-path", _add_clip_path(root, zone_id, geom.clip_shape))

    suffix = Path(src).suffix.lower()
    if suffix in _VIDEO_SUFFIXES:
        media_el = etree.Element(
            f"{{{ns.XHTML}}}video",
            {"src": src, "controls": ""},
            nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
        )
    elif _is_url(src):
        media_el = etree.Element(
            f"{{{ns.XHTML}}}img",
            {"src": src},
            nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
        )
    else:
        media_el = etree.Element(
            f"{{{ns.XHTML}}}img",
            {"src": src},
            nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
        )

    media_el.set("style", style)
    fo.append(media_el)
    _swap_zone(el, fo, rect, zone_id)


def substitute_content(
    svg_str: str,
    content: dict[str, TextBox | Media],
    font_size: int = 36,
) -> str:
    root = etree.fromstring(svg_str.encode())

    for zone_id, item in content.items():
        el = root.find(f'.//*[@id="{zone_id}"]')
        if el is None:
            print(f"[inkflow] warning: zone #{zone_id} not found in SVG")
            continue

        if isinstance(item, TextBox):
            _replace_with_foreignobject(
                el,
                item.text or "",
                zone_id,
                font_size,
                align=item.align,
                valign=item.valign,
                padding=item.padding,
            )
        else:
            _replace_with_media(
                el,
                root,
                item.src,
                zone_id,
                item.fit,
                item.align,
                item.x,
                item.y,
            )

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
