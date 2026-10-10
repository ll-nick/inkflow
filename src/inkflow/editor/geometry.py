"""Affine matrices, boxes and move/resize plans: a port of ``src/ts/editor/geom.ts``.

The visual editor turns a drag into the attribute changes it writes back to the
SVG file (``x``/``y`` for a rectangle, ``cx``/``cy`` for an ellipse, a merged
leading ``translate`` for anything else, a matrix for a rotated element).
``inkflow shape`` makes the same changes from the command line, so a shape moved
by an agent reads exactly as one moved in the editor. Numbers are formatted as
the editor formats them (``fmt``: at most three decimals). The shared fixture
``tests/data/connector_routes.json`` holds cases both implementations check.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace

from inkflow.editor.routing import Pt, js_round, js_str

EPS = 1e-6


@dataclass(frozen=True)
class Mat:
    a: float = 1.0
    b: float = 0.0
    c: float = 0.0
    d: float = 1.0
    e: float = 0.0
    f: float = 0.0


IDENTITY = Mat()


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height


def multiply(p: Mat, q: Mat) -> Mat:
    """``p ∘ q``: apply ``q`` first, then ``p``."""
    return Mat(
        p.a * q.a + p.c * q.b,
        p.b * q.a + p.d * q.b,
        p.a * q.c + p.c * q.d,
        p.b * q.c + p.d * q.d,
        p.a * q.e + p.c * q.f + p.e,
        p.b * q.e + p.d * q.f + p.f,
    )


def invert(m: Mat) -> Mat:
    det = m.a * m.d - m.b * m.c
    if abs(det) < 1e-12:
        return IDENTITY
    return Mat(
        m.d / det,
        -m.b / det,
        -m.c / det,
        m.a / det,
        (m.c * m.f - m.d * m.e) / det,
        (m.b * m.e - m.a * m.f) / det,
    )


def apply(m: Mat, p: Pt) -> Pt:
    return Pt(m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f)


def apply_vector(m: Mat, p: Pt) -> Pt:
    return Pt(m.a * p.x + m.c * p.y, m.b * p.x + m.d * p.y)


def translate(x: float, y: float) -> Mat:
    return Mat(1, 0, 0, 1, x, y)


def scale_about(sx: float, sy: float, origin: Pt) -> Mat:
    return Mat(sx, 0, 0, sy, origin.x - sx * origin.x, origin.y - sy * origin.y)


def rotate_about(degrees: float, origin: Pt) -> Mat:
    r = degrees * math.pi / 180
    cos, sin = math.cos(r), math.sin(r)
    return multiply(
        translate(origin.x, origin.y),
        multiply(Mat(cos, sin, -sin, cos, 0, 0), translate(-origin.x, -origin.y)),
    )


def is_translate_only(m: Mat) -> bool:
    return (
        abs(m.a - 1) < EPS and abs(m.d - 1) < EPS and abs(m.b) < EPS and abs(m.c) < EPS
    )


def is_axis_aligned(m: Mat) -> bool:
    return abs(m.b) < EPS and abs(m.c) < EPS


def transform_box(m: Mat, box: Box) -> Box:
    """The bounding box of a box's four corners under ``m``."""
    pts = [
        apply(m, Pt(box.x, box.y)),
        apply(m, Pt(box.x + box.width, box.y)),
        apply(m, Pt(box.x, box.y + box.height)),
        apply(m, Pt(box.x + box.width, box.y + box.height)),
    ]
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    return Box(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


def union_boxes(boxes: list[Box]) -> Box | None:
    if not boxes:
        return None
    x = min(b.x for b in boxes)
    y = min(b.y for b in boxes)
    right = max(b.x + b.width for b in boxes)
    bottom = max(b.y + b.height for b in boxes)
    return Box(x, y, right - x, bottom - y)


# ── Number + transform formatting ──


def fmt(n: float) -> str:
    """At most three decimals, as the editor writes coordinates."""
    return js_str(js_round(n * 1000) / 1000)


def format_transform(m: Mat) -> str | None:
    if is_translate_only(m):
        if abs(m.e) < EPS and abs(m.f) < EPS:
            return None
        return f"translate({fmt(m.e)},{fmt(m.f)})"

    def r(n: float) -> str:
        return js_str(js_round(n * 1e6) / 1e6)

    return f"matrix({r(m.a)},{r(m.b)},{r(m.c)},{r(m.d)},{fmt(m.e)},{fmt(m.f)})"


_TRANSFORM = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")


def _numbers(text: str) -> list[float]:
    out: list[float] = []
    for part in re.split(r"[\s,]+", text):
        if part:
            try:
                out.append(float(part))
            except ValueError:
                out.append(math.nan)
    return out


def parse_transform(value: str | None) -> Mat:
    """A transform attribute (the subset SVG allows) as one matrix."""
    if not value:
        return IDENTITY
    m = IDENTITY
    for match in _TRANSFORM.finditer(value):
        args = _numbers(match.group(2))

        def arg(i: int, default: float, args: list[float] = args) -> float:
            return args[i] if len(args) > i else default

        t = IDENTITY
        kind = match.group(1)
        if kind == "matrix":
            if len(args) == 6:
                t = Mat(*args)
        elif kind == "translate":
            t = translate(arg(0, 0), arg(1, 0))
        elif kind == "scale":
            t = scale_about(arg(0, 1), arg(1, arg(0, 1)), Pt(0, 0))
        elif kind == "rotate":
            t = rotate_about(arg(0, 0), Pt(arg(1, 0), arg(2, 0)))
        elif kind == "skewX":
            t = replace(IDENTITY, c=math.tan(arg(0, 0) * math.pi / 180))
        elif kind == "skewY":
            t = replace(IDENTITY, b=math.tan(arg(0, 0) * math.pi / 180))
        m = multiply(m, t)
    return m


# ── Attribute plans ──

AttrPlan = dict[str, str | None]
"""What the editor writes for one element: attribute values (None removes)."""


@dataclass
class ElementGeom:
    """The facts a plan is computed from (``elementGeom`` in canvas.ts)."""

    tag: str
    source_tag: str
    attrs: dict[str, str | None]
    own: Mat
    """The element's transform attribute, consolidated."""
    parent_to_slide: Mat
    local_box: Box = field(default_factory=lambda: Box(0, 0, 0, 0))


# "svg" is a cropped image's frame (a nested <svg> with a viewBox).
_BOX_TAGS = frozenset({"rect", "image", "foreignObject", "use", "svg"})


def _num(v: str | None, fallback: float = 0) -> float:
    m = re.match(r"^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)", v or "")
    return float(m.group(1)) if m else fallback


def _uses_box_attrs(g: ElementGeom) -> bool:
    return (
        g.source_tag in _BOX_TAGS
        and g.source_tag != "use"
        and g.attrs.get("width") is not None
        and g.attrs.get("height") is not None
        and is_translate_only(g.own)
    )


def _shift_list(value: str | None, delta: float) -> str | None:
    if value is None:
        return None
    parts = re.split(r"[\s,]+", value.strip())
    if not parts or any(not re.match(r"^\s*[-+]?(\d|\.\d)", p) for p in parts):
        return None
    return " ".join(fmt(_num(p) + delta) for p in parts)


@dataclass
class MovePlan:
    attrs: AttrPlan
    children: list[AttrPlan] | None = None


def plan_move(
    g: ElementGeom,
    dx: float,
    dy: float,
    text_children: list[dict[str, str | None]] | None = None,
) -> MovePlan:
    """A move by ``(dx, dy)`` in slide units."""
    delta = apply_vector(invert(g.parent_to_slide), Pt(dx, dy))
    a = g.attrs
    if is_translate_only(g.own):
        if _uses_box_attrs(g):
            return MovePlan(
                {
                    "x": fmt(_num(a.get("x")) + delta.x),
                    "y": fmt(_num(a.get("y")) + delta.y),
                }
            )
        if g.source_tag in ("circle", "ellipse"):
            return MovePlan(
                {
                    "cx": fmt(_num(a.get("cx")) + delta.x),
                    "cy": fmt(_num(a.get("cy")) + delta.y),
                }
            )
        if g.source_tag == "line":
            return MovePlan(
                {
                    "x1": fmt(_num(a.get("x1")) + delta.x),
                    "y1": fmt(_num(a.get("y1")) + delta.y),
                    "x2": fmt(_num(a.get("x2")) + delta.x),
                    "y2": fmt(_num(a.get("y2")) + delta.y),
                }
            )
        if g.source_tag == "text":
            # Inkscape writes absolute x/y on the text and on each line's tspan.
            xs = _shift_list(a.get("x") or "0", delta.x)
            ys = _shift_list(a.get("y") or "0", delta.y)
            kids: list[AttrPlan] = []
            for child in text_children or []:
                plan: AttrPlan = {}
                cx = _shift_list(child.get("x"), delta.x)
                cy = _shift_list(child.get("y"), delta.y)
                if cx is not None:
                    plan["x"] = cx
                if cy is not None:
                    plan["y"] = cy
                kids.append(plan)
            if xs is not None and ys is not None:
                return MovePlan({"x": xs, "y": ys}, kids)
    return MovePlan({"transform": prepend_translate(a.get("transform"), delta)})


_LEADING_TRANSLATE = re.compile(
    r"^\s*translate\(\s*([-+.\deE]+)(?:[\s,]+([-+.\deE]+))?\s*\)\s*(.*)$", re.S
)


def prepend_translate(transform: str | None, d: Pt) -> str | None:
    """A move keeps the author's transform as written (a ``rotate(…)`` stays a
    rotate) and only adds to, or merges into, a leading translate."""
    original = (transform or "").strip()
    m = _LEADING_TRANSLATE.match(original)
    x, y = d.x, d.y
    rest = original
    if m:
        x += _num(m.group(1))
        y += _num(m.group(2) or "0")
        rest = m.group(3).strip()
    mm = re.match(r"^matrix\(([^)]*)\)$", rest)
    nums = _numbers(mm.group(1)) if mm else []
    if not m and len(nums) == 6 and all(math.isfinite(v) for v in nums):
        a, b, c, dd, e, f = nums
        return (
            f"matrix({js_str(a)},{js_str(b)},{js_str(c)},{js_str(dd)},"
            + f"{fmt(e + x)},{fmt(f + y)})"
        )
    if abs(x) < EPS and abs(y) < EPS:
        return rest or None
    t = f"translate({fmt(x)},{fmt(y)})"
    return f"{t} {rest}" if rest else t


def plan_resize(g: ElementGeom, frm: Box, to: Box) -> AttrPlan:
    """Resize the element's slide-space bounding box ``frm`` to ``to``."""
    sx = to.width / frm.width if frm.width > EPS else 1
    sy = to.height / frm.height if frm.height > EPS else 1
    change = multiply(
        translate(to.x, to.y),
        multiply(scale_about(sx, sy, Pt(0, 0)), translate(-frm.x, -frm.y)),
    )
    p = g.parent_to_slide
    in_parent = multiply(invert(p), multiply(change, p))
    a = g.attrs
    if is_translate_only(g.own) and is_axis_aligned(in_parent):
        t = Pt(g.own.e, g.own.f)

        def map_box(b: Box) -> Box:
            out = transform_box(in_parent, Box(b.x + t.x, b.y + t.y, b.width, b.height))
            return Box(out.x - t.x, out.y - t.y, out.width, out.height)

        if _uses_box_attrs(g):
            b = map_box(
                Box(
                    _num(a.get("x")),
                    _num(a.get("y")),
                    _num(a.get("width")),
                    _num(a.get("height")),
                )
            )
            return {
                "x": fmt(b.x),
                "y": fmt(b.y),
                "width": fmt(b.width),
                "height": fmt(b.height),
            }
        if g.source_tag in ("ellipse", "circle"):
            rx = _num(a.get("rx") if a.get("rx") is not None else a.get("r"))
            ry = _num(a.get("ry") if a.get("ry") is not None else a.get("r"))
            b = map_box(
                Box(_num(a.get("cx")) - rx, _num(a.get("cy")) - ry, 2 * rx, 2 * ry)
            )
            cx = fmt(b.x + b.width / 2)
            cy = fmt(b.y + b.height / 2)
            if g.source_tag == "circle":
                return {"cx": cx, "cy": cy, "r": fmt((b.width + b.height) / 4)}
            return {"cx": cx, "cy": cy, "rx": fmt(b.width / 2), "ry": fmt(b.height / 2)}
        if g.source_tag == "line":
            tt = translate(t.x, t.y)
            m = multiply(invert(tt), multiply(in_parent, tt))
            p1 = apply(m, Pt(_num(a.get("x1")), _num(a.get("y1"))))
            p2 = apply(m, Pt(_num(a.get("x2")), _num(a.get("y2"))))
            return {"x1": fmt(p1.x), "y1": fmt(p1.y), "x2": fmt(p2.x), "y2": fmt(p2.y)}
    return {"transform": format_transform(multiply(in_parent, g.own))}


def distribute(boxes: list[Box], axis: str) -> list[float]:
    """Positions that spread boxes evenly between the outermost two along an
    axis (``snap.ts``)."""

    def pos(b: Box) -> float:
        return b.x if axis == "x" else b.y

    def size(b: Box) -> float:
        return b.width if axis == "x" else b.height

    order = sorted(range(len(boxes)), key=lambda i: pos(boxes[i]))
    out = [pos(b) for b in boxes]
    if len(order) < 3:
        return out
    first = boxes[order[0]]
    last = boxes[order[-1]]
    total = sum(size(boxes[i]) for i in order)
    span = pos(last) + size(last) - pos(first)
    gap = (span - total) / (len(order) - 1)
    at = pos(first)
    for i in order:
        out[i] = at
        at += size(boxes[i]) + gap
    return out
