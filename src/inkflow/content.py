from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.manifest import Content, TextBox

_MIME_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}

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


@dataclass
class _ZoneRect:
    x: str
    y: str
    width: str
    height: str


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
) -> None:
    rect = _rect_geometry(el)

    fo = etree.Element(f"{{{ns.SVG}}}foreignObject")
    fo.set("overflow", "hidden")
    fo.set(
        "font-size", str(font_size)
    )  # SVG user units; cascades into HTML content via em

    # Use XHTML as default namespace so lxml serialises <div>, <p>, <ul>
    # without a prefix — required for the browser's HTML parser to recognise
    # them as real HTML elements inside foreignObject.
    div = etree.Element(
        f"{{{ns.XHTML}}}div",
        {"class": "inkflow-content"},
        nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
    )
    try:
        fragment = etree.fromstring(f"<div xmlns='{ns.XHTML}'>{html}</div>")
        div.text = fragment.text
        for child in fragment:
            div.append(child)
    except etree.XMLSyntaxError:
        div.text = html
    fo.append(div)

    _swap_zone(el, fo, rect, zone_id)


def _fmt_pos(base: int, offset_pct: float) -> str:
    if offset_pct == 0.0:
        return f"{base}%"
    sign = "+" if offset_pct >= 0 else "-"
    return f"calc({base}% {sign} {abs(offset_pct):.6g}%)"


def _replace_with_media(
    el: etree._Element,  # pyright: ignore[reportPrivateUsage]
    src: str,
    zone_id: str,
    fit: str,
    align: str,
    x: float,
    y: float,
    project_dir: Path,
) -> None:
    rect = _rect_geometry(el)

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
    fo.set("overflow", "hidden")

    suffix = Path(src).suffix.lower()
    if suffix in _VIDEO_SUFFIXES:
        media_el = etree.Element(
            f"{{{ns.XHTML}}}video",
            {"src": src, "controls": ""},
            nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
        )
    else:
        img_path = project_dir / src
        mime = (
            _MIME_MAP.get(suffix)
            or mimetypes.guess_type(str(img_path))[0]
            or "image/png"
        )
        b64 = base64.b64encode(img_path.read_bytes()).decode()
        media_el = etree.Element(
            f"{{{ns.XHTML}}}img",
            {"src": f"data:{mime};base64,{b64}"},
            nsmap={None: ns.XHTML},  # pyright: ignore[reportArgumentType]
        )

    media_el.set("style", style)
    fo.append(media_el)
    _swap_zone(el, fo, rect, zone_id)


def substitute_content(
    svg_str: str,
    content: list[Content],
    project_dir: Path,
    font_size: int = 36,
) -> str:
    root = etree.fromstring(svg_str.encode())

    for item in content:
        zone_id = item.element.lstrip("#")
        el = root.find(f'.//*[@id="{zone_id}"]')
        if el is None:
            print(f"[inkflow] warning: zone #{zone_id} not found in SVG")
            continue

        if isinstance(item, TextBox):
            _replace_with_foreignobject(el, item.text or "", zone_id, font_size)
        else:
            _replace_with_media(
                el, item.src, zone_id, item.fit, item.align, item.x, item.y, project_dir
            )

    return etree.tostring(root, encoding="unicode")


def remove_unreferenced_zones(svg_str: str) -> str:
    root = etree.fromstring(svg_str.encode())
    to_remove = [
        el
        for el in root.iter(f"{{{ns.SVG}}}rect")
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
