"""Element boxes without a browser: what ``getBBox()`` and ``getScreenCTM()``
give the visual editor, computed on an lxml tree.

The editor attaches an arrow to the corners of a shape's box (its connection
sites follow the box through every transform), so ``inkflow shape`` needs the
same boxes to route an arrow where the editor would. Shapes are exact: a
rectangle, circle or ellipse, a line, polyline or polygon, a path (its tight
bounds, curve and arc extremes included), an image or foreignObject, a ``<use>``,
groups (the union of their children, each through its transform) and nested
``<svg>`` frames (a cropped picture, a drawn-in diagram: viewport, ``viewBox``
and ``preserveAspectRatio``).

``<text>`` is the exception: its box depends on the font, which only a browser
knows. It is estimated from the font size (an average glyph width of 0.55 em,
0.8 em above the baseline and 0.2 em below), which is enough for a group's
rough extent but not to route to, so ``inkflow shape`` does not attach arrows
to a plain ``<text>``.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from typing import cast

from inkflow import ns
from inkflow.content import zone_box
from inkflow.editor.geometry import (
    IDENTITY,
    Box,
    Mat,
    multiply,
    parse_transform,
    transform_box,
    translate,
)
from inkflow.editor.provenance import is_element
from inkflow.svgio import SvgElement

_SVG = f"{{{ns.SVG}}}"
_XLINK_HREF = f"{{{ns.XLINK}}}href"
TEXT_WIDTH_EM = 0.55
TEXT_ASCENT_EM = 0.8
TEXT_DESCENT_EM = 0.2
DEFAULT_FONT_SIZE = 16.0

# Never rendered themselves, nor anything inside them.
_UNRENDERED = frozenset(
    _SVG + t
    for t in (
        "defs",
        "style",
        "script",
        "metadata",
        "title",
        "desc",
        "symbol",
        "clipPath",
        "mask",
        "marker",
        "pattern",
        "linearGradient",
        "radialGradient",
        "filter",
    )
)


def local(el: SvgElement) -> str:
    tag = cast("object", el.tag)
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def style_props(el: SvgElement) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in (el.get("style") or "").split(";"):
        name, sep, value = part.partition(":")
        if sep and name.strip():
            out[name.strip().lower()] = value.strip()
    return out


def prop(el: SvgElement, name: str) -> str | None:
    """A presentation property as the element sets it (style wins)."""
    value = style_props(el).get(name)
    return value if value is not None else el.get(name)


def _length(value: str | None, reference: float = 0.0) -> float | None:
    if value is None:
        return None
    m = re.match(
        r"^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(%|px)?\s*$", value
    )
    if not m:
        return None
    number = float(m.group(1))
    return number * reference / 100 if m.group(2) == "%" else number


def _num(el: SvgElement, name: str, default: float = 0.0) -> float:
    value = _length(el.get(name))
    return default if value is None else value


def view_box(el: SvgElement) -> tuple[float, float, float, float] | None:
    parts = re.split(r"[\s,]+", (el.get("viewBox") or "").strip())
    if len(parts) != 4:
        return None
    try:
        x, y, w, h = (float(p) for p in parts)
    except ValueError:
        return None
    return (x, y, w, h) if w > 0 and h > 0 else None


def viewport_transform(
    vb: tuple[float, float, float, float] | None,
    width: float,
    height: float,
    aspect: str | None,
) -> Mat:
    """``viewBox`` coordinates → the viewport's, under ``preserveAspectRatio``."""
    if vb is None:
        return IDENTITY
    vx, vy, vw, vh = vb
    sx, sy = width / vw, height / vh
    parts = (aspect or "xMidYMid meet").split()
    align = parts[0] if parts else "xMidYMid"
    slice_ = len(parts) > 1 and parts[1] == "slice"
    if align == "none":
        return Mat(sx, 0, 0, sy, -vx * sx, -vy * sy)
    s = max(sx, sy) if slice_ else min(sx, sy)
    tx, ty = -vx * s, -vy * s
    if "xMid" in align:
        tx += (width - vw * s) / 2
    elif "xMax" in align:
        tx += width - vw * s
    if "YMid" in align:
        ty += (height - vh * s) / 2
    elif "YMax" in align:
        ty += height - vh * s
    return Mat(s, 0, 0, s, tx, ty)


class Geometry:
    """Boxes and matrices for the elements of one composed slide tree.

    ``root`` is the slide's outermost ``<svg>``: its user units (its viewBox)
    are the slide units the editor works in.
    """

    root: SvgElement
    by_id: Callable[[str], SvgElement | None]
    width: float
    height: float

    def __init__(
        self, root: SvgElement, by_id: Callable[[str], SvgElement | None]
    ) -> None:
        self.root = root
        self.by_id = by_id
        vb = view_box(root)
        self.width = vb[2] if vb else _num(root, "width", 1920) or 1920
        self.height = vb[3] if vb else _num(root, "height", 1080) or 1080

    # ── Matrices ──

    def is_nested_svg(self, el: SvgElement) -> bool:
        return el.tag == _SVG + "svg" and el is not self.root

    def viewport(self, el: SvgElement) -> Box:
        """A nested ``<svg>``'s viewport in its parent's user space."""
        w = _length(el.get("width"), self.width)
        h = _length(el.get("height"), self.height)
        return Box(
            _num(el, "x"),
            _num(el, "y"),
            self.width if w is None else w,
            self.height if h is None else h,
        )

    def to_parent(self, el: SvgElement) -> Mat:
        """An element's own space → its parent's: its ``transform`` (and for a
        nested ``<svg>`` its viewport and ``viewBox``)."""
        m = parse_transform(el.get("transform"))
        if self.is_nested_svg(el):
            port = self.viewport(el)
            m = multiply(m, translate(port.x, port.y))
            m = multiply(
                m,
                viewport_transform(
                    view_box(el), port.width, port.height, el.get("preserveAspectRatio")
                ),
            )
        return m

    def content_ctm(self, el: SvgElement) -> Mat:
        """The user space ``el``'s children are drawn in → slide units."""
        if el is self.root:
            return IDENTITY
        parent = el.getparent()
        base = self.content_ctm(parent) if parent is not None else IDENTITY
        return multiply(base, self.to_parent(el))

    def ctm(self, el: SvgElement) -> Mat:
        """``getScreenCTM()`` relative to the slide: ``el``'s own user space
        (its transform applied) → slide units."""
        return self.content_ctm(el)

    def parent_ctm(self, el: SvgElement) -> Mat:
        parent = el.getparent()
        return IDENTITY if parent is None else self.content_ctm(parent)

    # ── Visibility ──

    def rendered(self, el: SvgElement) -> bool:
        """False inside ``<defs>`` and the like, or under ``display:none``."""
        node: SvgElement | None = el
        while node is not None and node is not self.root:
            if node.tag in _UNRENDERED or prop(node, "display") == "none":
                return False
            node = node.getparent()
        return True

    # ── Boxes ──

    def bbox(self, el: SvgElement) -> Box | None:
        """``getBBox()``: geometry in the element's own user space (before its
        transform), without stroke; None for what draws nothing."""
        tag = local(el)
        if (el.get("id") or "").startswith("zone-") and tag in (
            "rect",
            "ellipse",
            "circle",
            "path",
            "polygon",
            "polyline",
        ):
            # A zone is drawn as a foreignObject with the box content.py gives it.
            try:
                x, y, w, h = zone_box(el)
            except (ValueError, IndexError):
                return None
            return Box(x, y, w, h)
        if tag == "rect":
            w, h = _num(el, "width"), _num(el, "height")
            if w <= 0 or h <= 0:
                return None
            return Box(_num(el, "x"), _num(el, "y"), w, h)
        if tag == "circle":
            r = _num(el, "r")
            if r <= 0:
                return None
            return Box(_num(el, "cx") - r, _num(el, "cy") - r, 2 * r, 2 * r)
        if tag == "ellipse":
            rx = _length(el.get("rx"))
            ry = _length(el.get("ry"))
            rx = ry if rx is None else rx
            ry = rx if ry is None else ry
            if rx is None or ry is None or rx <= 0 or ry <= 0:
                return None
            return Box(_num(el, "cx") - rx, _num(el, "cy") - ry, 2 * rx, 2 * ry)
        if tag == "line":
            x1, y1 = _num(el, "x1"), _num(el, "y1")
            x2, y2 = _num(el, "x2"), _num(el, "y2")
            return Box(min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1))
        if tag in ("polyline", "polygon"):
            nums = [float(m.group()) for m in re.finditer(_NUM, el.get("points") or "")]
            pts = list(zip(nums[0::2], nums[1::2], strict=False))
            return _points_box(pts)
        if tag == "path":
            return path_bbox(el.get("d") or "")
        if tag in ("image", "foreignObject"):
            return Box(
                _num(el, "x"), _num(el, "y"), _num(el, "width"), _num(el, "height")
            )
        if tag == "use":
            ref = self._use_target(el)
            if ref is None or not self._renderable_ref(ref):
                return None
            inner = self.bbox(ref)
            if inner is None:
                return None
            m = multiply(translate(_num(el, "x"), _num(el, "y")), self.to_parent(ref))
            return transform_box(m, inner)
        if tag == "text":
            return self.text_box(el)
        if tag in ("g", "a", "svg", "switch"):
            return self._union(el)
        return None

    def _use_target(self, el: SvgElement) -> SvgElement | None:
        href = el.get("href") or el.get(_XLINK_HREF) or ""
        return self.by_id(href[1:]) if href.startswith("#") else None

    def _renderable_ref(self, el: SvgElement) -> bool:
        return prop(el, "display") != "none"

    def _union(self, el: SvgElement) -> Box | None:
        boxes: list[Box] = []
        for child in el:
            if not is_element(child) or child.tag in _UNRENDERED:
                continue
            if not child.tag.startswith(_SVG) or prop(child, "display") == "none":
                continue
            inner = self.bbox(child)
            if inner is None:
                continue
            boxes.append(transform_box(self.to_parent(child), inner))
            if local(el) == "switch":
                break  # only the first child a switch can show is drawn
        if not boxes:
            return None
        x = min(b.x for b in boxes)
        y = min(b.y for b in boxes)
        return Box(
            x, y, max(b.right for b in boxes) - x, max(b.bottom for b in boxes) - y
        )

    def font_size(self, el: SvgElement) -> float:
        chain: list[SvgElement] = []
        node: SvgElement | None = el
        while node is not None:
            chain.append(node)
            node = node.getparent()
        size = DEFAULT_FONT_SIZE
        for node in reversed(chain):
            value = prop(node, "font-size")
            if value is None:
                continue
            em = re.match(r"^\s*([\d.]+)\s*em\s*$", value)
            if em:
                size *= float(em.group(1))
                continue
            length = _length(value, size)
            if length is not None and length > 0:
                size = length
        return size

    def _anchor(self, el: SvgElement) -> str:
        node: SvgElement | None = el
        while node is not None:
            value = prop(node, "text-anchor")
            if value:
                return value.strip()
            node = node.getparent()
        return "start"

    def text_box(self, el: SvgElement) -> Box | None:
        """An estimate of a ``<text>``'s box (see the module docstring)."""
        size = self.font_size(el)
        anchor = self._anchor(el)

        def first(value: str | None) -> float | None:
            m = re.search(_NUM, value or "")
            return float(m.group()) if m else None

        x0 = first(el.get("x")) or 0.0
        y0 = first(el.get("y")) or 0.0
        runs: list[list[object]] = [[x0, y0, el.text or ""]]
        for span in el.iter(_SVG + "tspan"):
            x = first(span.get("x"))
            y = first(span.get("y"))
            dy_text = span.get("dy")
            if x is not None or y is not None or dy_text:
                last_y = float(str(runs[-1][1]))
                if y is None:
                    em = re.match(r"^\s*([-+\d.]+)\s*em", dy_text or "")
                    dy = float(em.group(1)) * size if em else (first(dy_text) or 0.0)
                    y = last_y + dy
                runs.append([x if x is not None else x0, y, ""])
            runs[-1][2] = f"{runs[-1][2]}{span.text or ''}"
            if span.tail:
                runs[-1][2] = f"{runs[-1][2]}{span.tail}"
        boxes: list[Box] = []
        for x, y, text in runs:
            content = str(text).strip()
            if not content:
                continue
            width = TEXT_WIDTH_EM * size * len(content)
            left = float(str(x))
            if anchor == "middle":
                left -= width / 2
            elif anchor == "end":
                left -= width
            top = float(str(y)) - TEXT_ASCENT_EM * size
            boxes.append(
                Box(left, top, width, (TEXT_ASCENT_EM + TEXT_DESCENT_EM) * size)
            )
        if not boxes:
            return None
        x = min(b.x for b in boxes)
        y = min(b.y for b in boxes)
        return Box(
            x, y, max(b.right for b in boxes) - x, max(b.bottom for b in boxes) - y
        )

    def slide_box(self, el: SvgElement) -> Box | None:
        box = self.bbox(el)
        return None if box is None else transform_box(self.ctm(el), box)


_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def _points_box(pts: list[tuple[float, float]]) -> Box | None:
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return Box(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


# ── Path data ───────────────────────────────────────────────────────────────────


class _PathReader:
    """Reads path data one number or arc flag at a time (``0110`` after an
    arc's rotation is two flags and a number, which a regex cannot split)."""

    _number: re.Pattern[str] = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
    _gap: re.Pattern[str] = re.compile(r"[\s,]*")

    d: str
    i: int

    def __init__(self, d: str) -> None:
        self.d = d
        self.i = 0

    def skip(self) -> None:
        m = self._gap.match(self.d, self.i)
        if m:
            self.i = m.end()

    def command(self) -> str | None:
        self.skip()
        if self.i < len(self.d) and self.d[self.i].isalpha():
            self.i += 1
            return self.d[self.i - 1]
        return None

    def at_number(self) -> bool:
        self.skip()
        return bool(self._number.match(self.d, self.i))

    def number(self) -> float:
        self.skip()
        m = self._number.match(self.d, self.i)
        if not m:
            raise ValueError("number expected")
        self.i = m.end()
        return float(m.group())

    def flag(self) -> bool:
        self.skip()
        if self.i < len(self.d) and self.d[self.i] in "01":
            self.i += 1
            return self.d[self.i - 1] == "1"
        raise ValueError("arc flag expected")

    def done(self) -> bool:
        self.skip()
        return self.i >= len(self.d)


def _cubic_extremes(p0: float, p1: float, p2: float, p3: float) -> list[float]:
    a = -p0 + 3 * p1 - 3 * p2 + p3
    b = 2 * (p0 - 2 * p1 + p2)
    c = p1 - p0
    ts: list[float] = []
    if abs(a) < 1e-12:
        if abs(b) > 1e-12:
            ts.append(-c / b)
    else:
        disc = b * b - 4 * a * c
        if disc >= 0:
            root = math.sqrt(disc)
            ts += [(-b + root) / (2 * a), (-b - root) / (2 * a)]
    out: list[float] = []
    for t in ts:
        if 0 < t < 1:
            mt = 1 - t
            out.append(
                mt**3 * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t**3 * p3
            )
    return out


def _quad_extremes(p0: float, p1: float, p2: float) -> list[float]:
    den = p0 - 2 * p1 + p2
    if abs(den) < 1e-12:
        return []
    t = (p0 - p1) / den
    if 0 < t < 1:
        mt = 1 - t
        return [mt * mt * p0 + 2 * mt * t * p1 + t * t * p2]
    return []


def _arc_points(
    x1: float,
    y1: float,
    rx: float,
    ry: float,
    phi_deg: float,
    large: bool,
    sweep: bool,
    x2: float,
    y2: float,
) -> list[tuple[float, float]]:
    """The extreme points of an elliptical arc (SVG implementation notes F.6.5)."""
    if (x1, y1) == (x2, y2):
        return []
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0:
        return []
    phi = math.radians(phi_deg % 360)
    cos, sin = math.cos(phi), math.sin(phi)
    dx2, dy2 = (x1 - x2) / 2, (y1 - y2) / 2
    x1p = cos * dx2 + sin * dy2
    y1p = -sin * dx2 + cos * dy2
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1:
        k = math.sqrt(lam)
        rx, ry = rx * k, ry * k
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        co = -co
    cxp = co * rx * y1p / ry
    cyp = -co * ry * x1p / rx
    cx = cos * cxp - sin * cyp + (x1 + x2) / 2
    cy = sin * cxp + cos * cyp + (y1 + y2) / 2

    def angle(ux: float, uy: float, vx: float, vy: float) -> float:
        a = math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        return a

    theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    delta = angle(
        (x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry
    )
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    elif sweep and delta < 0:
        delta += 2 * math.pi

    def point(t: float) -> tuple[float, float]:
        return (
            cx + rx * cos * math.cos(t) - ry * sin * math.sin(t),
            cy + rx * sin * math.cos(t) + ry * cos * math.sin(t),
        )

    candidates = [
        math.atan2(-ry * sin, rx * cos),
        math.atan2(ry * cos, rx * sin),
    ]
    out: list[tuple[float, float]] = []
    for base in candidates:
        for t in (base, base + math.pi):
            # Is t within the swept range [theta1, theta1 + delta]?
            rel = (
                (t - theta1) % (2 * math.pi)
                if delta > 0
                else (theta1 - t) % (2 * math.pi)
            )
            if rel <= abs(delta):
                out.append(point(t))
    return out


def path_bbox(d: str) -> Box | None:
    """The tight bounds of path data (curve and arc extremes included)."""
    reader = _PathReader(d)
    pts: list[tuple[float, float]] = []
    cx: float = 0.0
    cy: float = 0.0
    sx: float = 0.0
    sy: float = 0.0
    last_ctrl: tuple[float, float] | None = None
    last_cmd = ""
    cmd: str | None = None
    try:
        while not reader.done():
            new = reader.command()
            if new is not None:
                cmd = new
            elif cmd is None or not reader.at_number():
                break
            assert cmd is not None
            rel = cmd.islower()
            upper = cmd.upper()
            ox, oy = (cx, cy) if rel else (0.0, 0.0)
            if upper == "Z":
                cx, cy = sx, sy
                last_ctrl = None
                last_cmd = "Z"
                continue
            if upper == "M":
                cx, cy = ox + reader.number(), oy + reader.number()
                sx, sy = cx, cy
                pts.append((cx, cy))
                cmd = "l" if rel else "L"  # further pairs are lines
                last_ctrl = None
            elif upper == "L":
                cx, cy = ox + reader.number(), oy + reader.number()
                pts.append((cx, cy))
                last_ctrl = None
            elif upper == "H":
                cx = ox + reader.number()
                pts.append((cx, cy))
                last_ctrl = None
            elif upper == "V":
                cy = oy + reader.number()
                pts.append((cx, cy))
                last_ctrl = None
            elif upper in ("C", "S"):
                if upper == "C":
                    x1, y1 = ox + reader.number(), oy + reader.number()
                elif last_ctrl is not None and last_cmd in ("C", "S"):
                    x1, y1 = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
                else:
                    x1, y1 = cx, cy
                x2, y2 = ox + reader.number(), oy + reader.number()
                x, y = ox + reader.number(), oy + reader.number()
                # An extreme's other coordinate only needs to lie inside the
                # box: the start point's does.
                pts += [(v, cy) for v in _cubic_extremes(cx, x1, x2, x)]
                pts += [(cx, v) for v in _cubic_extremes(cy, y1, y2, y)]
                pts.append((x, y))
                last_ctrl = (x2, y2)
                cx, cy = x, y
            elif upper in ("Q", "T"):
                if upper == "Q":
                    x1, y1 = ox + reader.number(), oy + reader.number()
                elif last_ctrl is not None and last_cmd in ("Q", "T"):
                    x1, y1 = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
                else:
                    x1, y1 = cx, cy
                x, y = ox + reader.number(), oy + reader.number()
                pts += [(v, cy) for v in _quad_extremes(cx, x1, x)]
                pts += [(cx, v) for v in _quad_extremes(cy, y1, y)]
                pts.append((x, y))
                last_ctrl = (x1, y1)
                cx, cy = x, y
            elif upper == "A":
                rx, ry = reader.number(), reader.number()
                phi = reader.number()
                large, sweep = reader.flag(), reader.flag()
                x, y = ox + reader.number(), oy + reader.number()
                pts += _arc_points(cx, cy, rx, ry, phi, large, sweep, x, y)
                pts.append((x, y))
                last_ctrl = None
                cx, cy = x, y
            else:
                break
            last_cmd = upper
    except ValueError:
        pass  # a path stops being drawn at its first error
    return _points_box(pts)
