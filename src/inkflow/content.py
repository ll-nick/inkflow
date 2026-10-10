from __future__ import annotations

import copy
import re
from collections.abc import Mapping
from dataclasses import dataclass

from lxml import etree

from inkflow import ns
from inkflow.backgrounds import MARGIN, background_paint
from inkflow.charts import ZONE_TEXT_SCALE, ResolvedChart, render
from inkflow.editor.provenance import copy_provenance
from inkflow.enums import Muted
from inkflow.logging import logger
from inkflow.manifest import Image, Media, TextBox, Video
from inkflow.markdown import html_fragment_to_xml
from inkflow.svg import ensure_defs
from inkflow.svgio import SvgElement

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
    clip_shape: SvgElement | None = None


def substitute_zone_numbers(
    root: SvgElement, slide_number: int, total: int
) -> SvgElement:
    for el in root.iter(f"{{{ns.SVG}}}text"):
        eid = el.get("id", "")
        if eid == "zone-slide-number":
            el.text = str(slide_number)
        elif eid == "zone-slide-total":
            el.text = str(total)
    return root


def _rect_geometry(el: SvgElement) -> _ZoneRect:
    x = el.get("x", "0")
    y = el.get("y", "0")
    w = el.get("width")
    h = el.get("height")
    if w is None or h is None:
        raise ValueError(f"Zone rect missing width/height: {el.get('id')}")
    return _ZoneRect(x=x, y=y, width=w, height=h)


def _is_rounded_rect(el: SvgElement) -> bool:
    return (
        _parse_dimension(el.get("rx", "0")) > 0
        or _parse_dimension(el.get("ry", "0")) > 0
    )


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
    el: SvgElement,
) -> _ZoneGeometry:
    tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag

    shape_copy = copy.deepcopy(el)
    if "id" in shape_copy.attrib:
        del shape_copy.attrib["id"]
    if "transform" in shape_copy.attrib:
        del shape_copy.attrib["transform"]

    if tag == "rect":
        clip_shape = shape_copy if _is_rounded_rect(el) else None
        return _ZoneGeometry(rect=_rect_geometry(el), clip_shape=clip_shape)

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
    root: SvgElement,
    zone_id: str,
    shape_el: SvgElement,
) -> str:
    clip_id = f"inkflow-clip-{zone_id}"
    defs = ensure_defs(root)
    clip = etree.SubElement(defs, f"{{{ns.SVG}}}clipPath")
    clip.set("id", clip_id)
    clip.append(shape_el)
    return f"url(#{clip_id})"


def _swap_zone(
    old_el: SvgElement,
    new_el: SvgElement,
    rect: _ZoneRect,
    zone_id: str,
) -> None:
    """Set geometry + id on new_el and swap it in place of old_el in the tree."""
    new_el.set("id", zone_id)
    copy_provenance(old_el, new_el)
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


def _style_props(el: SvgElement) -> dict[str, str]:
    props: dict[str, str] = {}
    for decl in (el.get("style") or "").split(";"):
        name, sep, value = decl.partition(":")
        if sep and name.strip():
            props[name.strip()] = value.strip()
    return props


_PAINT = re.compile(
    r"^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s.,%/+-]+\)|[a-zA-Z]+)$"
)
_TOKEN_CLASS = re.compile(r"^inkflow-(fill|stroke)-([\w-]+)$")


def _paint(el: SvgElement, props: dict[str, str], prop: str) -> str | None:
    """A shape's fill or stroke as a CSS colour (a theme token's var or a plain
    colour), or None when it has none. Anything else is ignored, never copied."""
    for cls in (el.get("class") or "").split():
        m = _TOKEN_CLASS.match(cls)
        if m and m[1] == prop:
            return f"var(--inkflow-{m[2]})"
    value = props.get(prop) or el.get(prop)
    if not value or value == "none" or not _PAINT.match(value):
        return None
    return value


def _number(value: str | None) -> float | None:
    try:
        return float(str(value).removesuffix("px")) if value is not None else None
    except ValueError:
        return None


# Fills (theme tokens) bright enough that body text needs the on-accent colour.
_VIVID = frozenset(
    (
        "accent",
        "red",
        "orange",
        "yellow",
        "green",
        "teal",
        "blue",
        "purple",
        "pink",
        "grey",
    )
)


def zone_shape_css(el: SvgElement) -> list[str]:
    """The zone shape's own look, as CSS for the box its text is drawn in.

    Only for a shape marked ``inkflow:show-shape``: a zone's shape is otherwise a
    placeholder (Inkscape gives every rect a style) and draws nothing. The fill
    becomes the background, the stroke a border, ``rx``/``ry`` (or an ellipse)
    the corner radius, so the text and its box stay one element for animations,
    transitions and the editor."""
    if el.get(ns.INKFLOW_SHOW_SHAPE) != "true":
        return []
    props = _style_props(el)
    css: list[str] = []
    fill = _paint(el, props, "fill")
    if fill:
        css.append(f"background:{fill}")
        if fill.removeprefix("var(--inkflow-").removesuffix(")") in _VIVID:
            # Text on an accent-coloured box: the theme's colour for that.
            css.append("color:var(--inkflow-accent-fg)")
    stroke = _paint(el, props, "stroke")
    if stroke:
        width = _number(props.get("stroke-width") or el.get("stroke-width")) or 1.0
        dashed = props.get("stroke-dasharray") or el.get("stroke-dasharray") or "none"
        style = "solid" if dashed == "none" else "dashed"
        css.append(f"border:{width:g}px {style} {stroke}")
    tag = el.tag.rsplit("}", 1)[-1]
    if tag in ("ellipse", "circle"):
        css.append("border-radius:50%")
    else:
        rx = _number(el.get("rx"))
        ry = _number(el.get("ry"))
        if rx or ry:
            rx = rx if rx is not None else ry
            ry = ry if ry is not None else rx
            css.append(
                f"border-radius:{rx:g}px"
                if rx == ry
                else f"border-radius:{rx:g}px / {ry:g}px"
            )
    # Text kept off the border; an ellipse needs more to stay inside its curve.
    inset = "14% 16%" if tag in ("ellipse", "circle") else "0.45em 0.7em"
    css.append(f"padding:var(--inkflow-padding,{inset})")
    return css


def _zone_vars(el: SvgElement) -> str:
    """``--inkflow-*`` custom properties set on the zone shape itself (padding,
    alignment): they apply to its text like the layout CSS that sets them."""
    return ";".join(
        f"{k}:{v}" for k, v in _style_props(el).items() if k.startswith("--inkflow-")
    )


def _replace_with_foreignobject(
    el: SvgElement,
    zone_id: str,
    font_size: int,
    item: TextBox,
) -> None:
    rect = _zone_geometry(el).rect

    fo = etree.Element(f"{{{ns.SVG}}}foreignObject")
    fo.set("overflow", "visible")
    fo.set("font-size", str(font_size))  # SVG user units; cascades into HTML via em
    shape_css = zone_shape_css(el)
    if shape_css:
        # The shape's classes and style ride along (they paint nothing on a
        # foreignObject) so the editor reads the box's look from the element.
        for attr in ("class", "style", "rx", "ry"):
            if el.get(attr) is not None:
                fo.set(attr, el.get(attr, ""))
        fo.set(ns.INKFLOW_SHOW_SHAPE, "true")
        opacity = el.get("opacity") or _style_props(el).get("opacity")
        if opacity:
            fo.set("opacity", opacity)
    else:
        variables = _zone_vars(el)
        if variables:
            fo.set("style", variables)
    if el.get(ns.INKFLOW_SITES) is not None:
        # How many connection points the box offers (the editor's arrows).
        fo.set(ns.INKFLOW_SITES, el.get(ns.INKFLOW_SITES, ""))

    wrapper_style_parts: list[str] = list(shape_css)
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

    # Into the slide first, then the content: lxml drops the xmlns of an inline
    # <svg> (a chart) as "redundant" with the slide root's when the two arrive
    # together, though the XHTML div between them shadows it.
    _swap_zone(el, fo, rect, zone_id)
    fo.append(wrapper)


def _fmt_pos(base: int, offset_pct: float) -> str:
    if offset_pct == 0.0:
        return f"{base}%"
    sign = "+" if offset_pct >= 0 else "-"
    return f"calc({base}% {sign} {abs(offset_pct):.6g}%)"


def _parse_dimension(value: str) -> float:
    """Zone width/height as a user-unit number, for the media-offset math.

    Zone dimensions come from the layout/slide SVG: a ``<rect>``'s width/height
    (editors emit bare user-unit numbers) or a bbox inkflow computes for non-rect
    zones (always unitless). ``item.x``/``item.y`` are user-unit offsets from
    ``deck.py``. A unit-bearing value (e.g. ``"2cm"``) can only appear if a zone
    rect is hand-authored with one; rather than silently reinterpret the unit as
    user units, we decline: ``0.0`` makes ``_replace_with_media`` skip the offset
    and fall back to base alignment. Same graceful path guards a zero dimension.
    """
    try:
        return float(value)
    except ValueError:
        return 0.0


def _make_image_element(src: str, style: str) -> SvgElement:
    el = etree.Element(
        f"{{{ns.XHTML}}}img",
        {"src": src},
        nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
    )
    el.set("style", style)
    return el


def _make_video_element(src: str, style: str, item: Video) -> SvgElement:
    """Build a ``<video>``. Playback (autoplay/loop/trim/step) is driven by the
    presenter via ``data-*`` attributes, not the HTML ``autoplay``/``loop``
    attributes, so outgoing transition-layer clips stay silent."""
    el = etree.Element(
        f"{{{ns.XHTML}}}video",
        {"src": src},
        nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
    )
    if item.controls:
        el.set("controls", "")
    # AUTO mutes only when the clip autoplays (gesture-less), sidestepping the
    # browser's autoplay block; ON always mutes; OFF never does.
    muted = item.muted is Muted.ON or (item.muted is Muted.AUTO and item.autoplay)
    if muted:
        el.set("muted", "")
    if item.poster is not None:
        el.set("poster", item.poster)
    if item.autoplay:
        el.set("data-autoplay", "")
    if item.loop:
        el.set("data-loop", "")
    # data-play-on-step is written later by annotate_svg from a PlayVideo cue.
    if item.start is not None:
        el.set("data-start", f"{item.start:g}")
    if item.end is not None:
        el.set("data-end", f"{item.end:g}")
    # prevent XML self-close: <video/> breaks HTML5 parsing
    el.append(etree.Comment(""))
    el.set("style", style)
    return el


def _replace_with_media(
    el: SvgElement,
    root: SvgElement,
    zone_id: str,
    dark_mode: bool,
    item: Media,
) -> None:
    geom = _zone_geometry(el)
    rect = geom.rect

    base_x, base_y = item.align.position
    width = _parse_dimension(rect.width)
    height = _parse_dimension(rect.height)
    x_pct = item.x / width * 100 if width else 0.0
    y_pct = item.y / height * 100 if height else 0.0
    base_style = (
        f"width:100%;height:100%;"
        f"object-fit:{item.fit};"
        f"object-position:{_fmt_pos(base_x, x_pct)} {_fmt_pos(base_y, y_pct)};"
    )

    if isinstance(item, Image) and item.background is not None:
        # Behind the picture, inside the zone: the margin is the padding.
        base_style += (
            f"background:{background_paint(item.background)};"
            + f"padding:{MARGIN * 100:g}%;box-sizing:border-box;border-radius:8px;"
        )

    def make(src: str, style: str) -> SvgElement:
        if isinstance(item, Video):
            return _make_video_element(src, style, item)
        return _make_image_element(src, style)

    fo = etree.Element(f"{{{ns.SVG}}}foreignObject")
    if geom.clip_shape is not None:
        # Plain rects need no clip-path: the foreignObject's own box is the shape,
        # and its native viewport clipping (default overflow: hidden) crops exactly
        # on the SVG's own rasterization pass. A redundant clip-path here doubles up
        # with that pass and can leave a hairline seam where the two disagree by a
        # subpixel. Only non-rect and rounded-rect shapes need the explicit clip.
        fo.set("overflow", "visible")
        fo.set("clip-path", _add_clip_path(root, zone_id, geom.clip_shape))

    if item.alt_src is None:
        fo.append(make(item.src, base_style + "display:block;"))
    else:
        # display is managed by CSS via [data-inkflow-theme] selectors
        primary_theme = "dark" if dark_mode else "light"
        alt_theme = "light" if dark_mode else "dark"
        primary_el = make(item.src, base_style)
        primary_el.set("data-inkflow-theme", primary_theme)
        alt_el = make(item.alt_src, base_style)
        alt_el.set("data-inkflow-theme", alt_theme)
        fo.append(primary_el)
        fo.append(alt_el)

    _swap_zone(el, fo, rect, zone_id)


def _replace_with_chart(
    el: SvgElement, zone_id: str, font_size: float, item: ResolvedChart
) -> None:
    """Draw a chart into the zone's box: a nested ``<svg>`` in its place, whose
    user units are the zone's, so the chart is laid out for its real size."""
    rect = _zone_geometry(el).rect
    chart = render(
        item,
        _parse_dimension(rect.width),
        _parse_dimension(rect.height),
        zone_id.removeprefix("zone-"),
        font_size,
    )
    _swap_zone(el, chart, rect, zone_id)


def substitute_content(
    root: SvgElement,
    content: Mapping[str, TextBox | Media | ResolvedChart],
    font_size: int = 36,
    dark_mode: bool = True,
    chart_scale: float = ZONE_TEXT_SCALE,
) -> SvgElement:
    """Fill each zone with its content. A chart's text is ``chart_scale`` of
    the body text ``font_size`` (`PageSize.chart_text_scale`)."""
    for zone_id, item in content.items():
        el = root.find(f'.//*[@id="{zone_id}"]')
        if el is None:
            logger.warning(f"zone #{zone_id} not found in SVG")
            continue

        if isinstance(item, TextBox):
            _replace_with_foreignobject(el, zone_id, font_size, item)
        elif isinstance(item, ResolvedChart):
            _replace_with_chart(el, zone_id, font_size * chart_scale, item)
        else:
            _replace_with_media(el, root, zone_id, dark_mode, item)

    return root


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


def unreferenced_zones(root: SvgElement) -> list[SvgElement]:
    """Zone shapes nothing filled: still placeholders, pruned before rendering.

    A shape shown as a box (``inkflow:show-shape``) stays, empty."""
    return [
        el
        for el in root.iter(*_ZONE_SHAPE_TAGS)
        if (el.get("id") or "").startswith("zone-")
        and not el.get("class")
        and el.get(ns.INKFLOW_SHOW_SHAPE) != "true"
    ]


def zone_box(el: SvgElement) -> tuple[float, float, float, float]:
    """A zone shape's ``(x, y, width, height)`` in its own user units."""
    rect = _zone_geometry(el).rect
    return (
        _parse_dimension(rect.x),
        _parse_dimension(rect.y),
        _parse_dimension(rect.width),
        _parse_dimension(rect.height),
    )


def remove_unreferenced_zones(root: SvgElement) -> SvgElement:
    to_remove = unreferenced_zones(root)
    for el in to_remove:
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
    return root


def inject_style(root: SvgElement, css: str) -> SvgElement:
    if not css:
        return root
    defs = root.find(f"{{{ns.SVG}}}defs")
    if defs is None:
        defs = etree.Element(f"{{{ns.SVG}}}defs")
        root.insert(0, defs)
    style = etree.SubElement(defs, f"{{{ns.SVG}}}style")
    style.text = css
    return root
