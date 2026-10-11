"""Edits to the shapes of a draw.io diagram, made on the slide.

With "Edit shapes here" on, the editor selects the shapes of a diagram drawn
into its slide (drawio_inline.py) and edits them in the diagram's source,
the ``<mxfile>`` in the picture's ``content``: a shape's geometry, label and
colours, or the shape itself. The source stays draw.io's to read, so the
diagram keeps opening in draw.io as before.

draw.io draws the picture from the source, and the editor asks it to (a
hidden draw.io frame, then ``drawio-save`` in the same undo step). Until it
does, or when draw.io cannot be reached, the picture is patched here so the
slide shows the change at once: a moved shape's drawing is put under a
transform (``data-drawn-geometry`` keeps the box it was drawn at), a
relabelled one shows its new text, a recoloured one its colour, a deleted one
is gone. draw.io's own arrows catch up when it next draws the diagram.
"""

from __future__ import annotations

import html
import re
from collections.abc import Iterable
from typing import cast

from lxml import etree

from inkflow import drawio
from inkflow.drawio_inline import DRAWN_GEOMETRY
from inkflow.editor.provenance import is_element
from inkflow.svgio import SvgElement, parse_svg, serialize_svg


class DiagramEditError(ValueError):
    pass


# Colours a shape's style can take, and what they paint in its drawing.
STYLE_KEYS = {
    "fillColor": "fill",
    "strokeColor": "stroke",
    "fontColor": "color",
    "strokeWidth": "stroke-width",
    "opacity": "opacity",
}
_COLOR = re.compile(r"^(#[0-9a-fA-F]{6}|none)$")


def apply_cell_ops(data: bytes, ops: Iterable[dict[str, object]]) -> bytes:
    """``data`` (a ``*.drawio.svg``) with the ops applied to its source, and
    its picture patched to match until draw.io redraws it."""
    try:
        picture = parse_svg(data)
    except etree.XMLSyntaxError as exc:
        raise DiagramEditError(f"not an SVG: {exc}") from exc
    content = picture.get("content")
    if not content or not content.lstrip().startswith("<mxfile"):
        raise DiagramEditError("this SVG has no draw.io diagram inside")
    try:
        mxfile = drawio.model(content)
    except (drawio.DrawioError, etree.XMLSyntaxError) as exc:
        raise DiagramEditError(str(exc)) from exc
    for op in ops:
        cell_id = op.get("cell")
        if not isinstance(cell_id, str):
            raise DiagramEditError("which shape?")
        kind = op.get("kind")
        if kind == "cell-geometry":
            _geometry(mxfile, picture, cell_id, op)
        elif kind == "cell-delete":
            _delete(mxfile, picture, cell_id)
        elif kind == "cell-style":
            _style(mxfile, picture, cell_id, op)
        elif kind == "cell-label":
            _label(mxfile, picture, cell_id, op.get("text"))
        else:
            raise DiagramEditError(
                "that change to a diagram's shape is made in draw.io (Edit diagram)"
            )
    picture.set("content", etree.tostring(mxfile, encoding="unicode"))
    return serialize_svg(picture).encode("utf-8")


def _cell(mxfile: SvgElement, cell_id: str) -> tuple[SvgElement, SvgElement]:
    found = drawio.cell_elements(mxfile).get(cell_id)
    if found is None or found[1].get("vertex") != "1":
        raise DiagramEditError(f"the diagram has no shape {cell_id!r}")
    return found


def _drawn(picture: SvgElement, cell_id: str) -> SvgElement | None:
    for el in picture.iter():
        if is_element(el) and el.get("data-cell-id") == cell_id:
            return el
    return None


def _number(op: dict[str, object], key: str) -> float:
    value = op.get(key)
    if not isinstance(value, int | float):
        raise DiagramEditError(f"{key} must be a number")
    return float(value)


def _fmt(value: float) -> str:
    return f"{round(value, 2):g}"


# ── Geometry ──


def _geometry(
    mxfile: SvgElement, picture: SvgElement, cell_id: str, op: dict[str, object]
) -> None:
    """A shape's new box, in page coordinates (``x y width height``); the
    picture's drawing of it moves by ``offset``, where the page sits on the
    picture (draw.io crops its pictures to the drawing)."""
    _, inner = _cell(mxfile, cell_id)
    box = tuple(_number(op, k) for k in ("x", "y", "width", "height"))
    if box[2] <= 0 or box[3] <= 0:
        raise DiagramEditError("a shape needs a size")
    before = drawio.cells(etree.tostring(mxfile, encoding="unicode"))
    cell = before[cell_id]
    parent = before.get(inner.get("parent") or "")
    px, py = (parent.box[0], parent.box[1]) if parent and parent.box else (0, 0)
    geometry = inner.find("mxGeometry")
    if geometry is None:
        geometry = etree.SubElement(inner, "mxGeometry", {"as": "geometry"})
    geometry.set("x", _fmt(box[0] - px))
    geometry.set("y", _fmt(box[1] - py))
    geometry.set("width", _fmt(box[2]))
    geometry.set("height", _fmt(box[3]))
    # Shapes inside it move with it (their geometry is relative to it).
    old = cell.box
    drawn = _drawn(picture, cell_id)
    if drawn is None or old is None:
        return
    offset = op.get("offset")
    if not isinstance(offset, list) or len(cast("list[object]", offset)) != 2:
        return
    ox, oy = (float(cast("float", v)) for v in cast("list[object]", offset))
    shown = drawn.get(DRAWN_GEOMETRY)
    if shown is None:
        shown = " ".join(_fmt(v) for v in old)
        drawn.set(DRAWN_GEOMETRY, shown)
    sx0, sy0, sw0, sh0 = (float(v) for v in shown.split())
    sx = box[2] / sw0 if sw0 else 1.0
    sy = box[3] / sh0 if sh0 else 1.0
    # Its drawing at (shown + offset) goes to (box + offset).
    tx = box[0] + ox - sx * (sx0 + ox)
    ty = box[1] + oy - sy * (sy0 + oy)
    drawn.set(
        "transform",
        f"matrix({_fmt(sx)} 0 0 {_fmt(sy)} {_fmt(tx)} {_fmt(ty)})",
    )


# ── Removing ──


def _delete(mxfile: SvgElement, picture: SvgElement, cell_id: str) -> None:
    """The shape, the shapes inside it, and the arrows to or from any of them."""
    _cell(mxfile, cell_id)
    elements = drawio.cell_elements(mxfile)
    gone = {cell_id}
    changed = True
    while changed:
        changed = False
        for other, (_, inner) in elements.items():
            if other in gone:
                continue
            if (
                inner.get("parent") in gone
                or inner.get("source") in gone
                or inner.get("target") in gone
            ):
                gone.add(other)
                changed = True
    for other in gone:
        outer, _ = elements[other]
        parent = outer.getparent()
        if parent is not None:
            parent.remove(outer)
        drawn = _drawn(picture, other)
        if drawn is not None and (up := drawn.getparent()) is not None:
            up.remove(drawn)


# ── Style ──


def _style_map(style: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for part in style.split(";"):
        if not part:
            continue
        key, eq, value = part.partition("=")
        out.append((key, value) if eq else (key, ""))
    return out


def _style_text(pairs: list[tuple[str, str]]) -> str:
    return "".join(f"{k}={v};" if v != "" or "=" in k else f"{k};" for k, v in pairs)


def _style(
    mxfile: SvgElement, picture: SvgElement, cell_id: str, op: dict[str, object]
) -> None:
    _, inner = _cell(mxfile, cell_id)
    key = op.get("key")
    value = op.get("value")
    if key not in STYLE_KEYS:
        raise DiagramEditError(f"cannot set {key!r} on a diagram shape")
    if key in ("fillColor", "strokeColor", "fontColor"):
        if not isinstance(value, str) or not _COLOR.match(value):
            raise DiagramEditError(f"{key} must be a #rrggbb colour or none")
    elif not isinstance(value, int | float) or value < 0:
        raise DiagramEditError(f"{key} must be a number")
    text = _fmt(value) if isinstance(value, int | float) else str(value)
    if key == "opacity":
        text = _fmt(min(100.0, float(cast("float", value)) * 100))
    pairs = [(k, v) for k, v in _style_map(inner.get("style") or "") if k != key]
    pairs.append((str(key), text))
    inner.set("style", _style_text(pairs))
    drawn = _drawn(picture, cell_id)
    if drawn is not None:
        _paint(drawn, str(key), value)


def _own(drawn: SvgElement) -> list[SvgElement]:
    """The elements drawing this shape (not the shapes inside it)."""
    out: list[SvgElement] = []
    for el in drawn.iterdescendants():
        if not is_element(el):
            continue
        holder = next(
            (a for a in el.iterancestors() if a.get("data-cell-id") is not None),
            None,
        )
        if holder is drawn and el.get("data-cell-id") is None:
            out.append(el)
    return out


def _paint(drawn: SvgElement, key: str, value: object) -> None:
    prop = STYLE_KEYS[key]
    own = _own(drawn)
    label = [
        el for el in own if any(a.tag.endswith("switch") for a in el.iterancestors())
    ]
    shapes = [el for el in own if el not in label and not el.tag.endswith("switch")]
    if prop == "opacity":
        drawn.set("opacity", _fmt(float(cast("float", value))))
        return
    if prop == "color":
        for el in label:
            if el.tag.endswith("}text"):
                _set_style(el, "fill", str(value))
            elif "color" in (el.get("style") or ""):
                _set_style(el, "color", str(value))
        return
    for el in shapes:
        if prop == "stroke-width":
            if el.get("stroke") not in (None, "none") or "stroke" in (
                el.get("style") or ""
            ):
                _set_style(el, "stroke-width", _fmt(float(cast("float", value))))
        elif el.get(prop) not in (None, "none"):
            _set_style(el, prop, str(value))


def _set_style(el: SvgElement, prop: str, value: str) -> None:
    decls = [
        d
        for d in (el.get("style") or "").split(";")
        if d.strip() and d.split(":", 1)[0].strip() != prop
    ]
    decls.append(f"{prop}: {value}")
    el.set("style", "; ".join(d.strip() for d in decls))
    if el.get(prop) is not None:
        el.set(prop, value)


# ── Label ──


def _label(mxfile: SvgElement, picture: SvgElement, cell_id: str, text: object) -> None:
    if not isinstance(text, str):
        raise DiagramEditError("a label is text")
    outer, inner = _cell(mxfile, cell_id)
    html_label = "html=1" in (inner.get("style") or "")
    value = (
        "<br>".join(html.escape(line) for line in text.split("\n"))
        if html_label
        else text
    )
    if outer is inner:
        inner.set("value", value)
    else:
        outer.set("label", value)
    drawn = _drawn(picture, cell_id)
    if drawn is None:
        return
    for el in _own(drawn):
        if el.tag.endswith("}text"):
            for kid in list(el):
                el.remove(kid)
            el.text = text.replace("\n", " ")
        elif etree.QName(el).localname == "div" and not any(
            etree.QName(k).localname == "div" for k in el
        ):
            # The innermost <div> of draw.io's HTML label holds the text.
            for kid in list(el):
                el.remove(kid)
            lines = text.split("\n")
            el.text = lines[0]
            for line in lines[1:]:
                br = etree.SubElement(el, el.tag.replace("div", "br"))
                br.tail = line
