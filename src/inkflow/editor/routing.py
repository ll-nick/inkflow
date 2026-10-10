"""Connector geometry: a line-for-line port of ``src/ts/editor/connectors.ts``.

Where a shape's connection sites are and which path an arrow takes between two
points (straight, elbow or curved), so ``inkflow shape`` attaches and re-routes
arrows exactly as the visual editor does, without a browser. The two
implementations are held together by one fixture of cases with the editor's
answers (``tests/data/connector_routes.json``), which both test suites check:
change one and the other's tests fail until it follows.

JavaScript's number semantics are kept where they show in the output:
``Math.round`` rounds halves up (``js_round``) and numbers print the way
``String(n)`` prints them (``js_str``), so path data comes out byte for byte the
same.

A connector is a ``<path>`` carrying ``inkflow:connector="straight|elbow|curved"``
and, for each connected end, ``inkflow:connect-start`` / ``-end`` =
``"<id>:<site>"``, a site being a side (``top``) or a point along one
(``top@0.25``); a shape's ``inkflow:sites="3"`` offers that many points per side.
An elbow moved off its default shape carries ``inkflow:bend="x:640"``.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Literal

Side = Literal["top", "right", "bottom", "left"]
Style = Literal["straight", "elbow", "curved"]
Axis = Literal["x", "y"]

SIDES: tuple[Side, ...] = ("top", "right", "bottom", "left")
STYLES: tuple[Style, ...] = ("straight", "elbow", "curved")
MAX_SITES = 9
"""Connection points per side a shape offers, at most."""
STUB = 30
"""How far an elbow runs straight out of a side before it may turn."""


# ── JavaScript numbers ──────────────────────────────────────────────────────────


def js_round(v: float) -> float:
    """``Math.round``: halves round up (towards +infinity), unlike ``round``."""
    if not math.isfinite(v):
        return v
    floor = math.floor(v)
    out = float(floor + 1 if v - floor >= 0.5 else floor)
    # Math.round keeps the sign of a zero result (-0.4 → -0).
    return math.copysign(0.0, v) if out == 0 else out


def js_sign(v: float) -> float:
    """``Math.sign``: -1, 1, or the zero itself (-0 stays -0)."""
    if v > 0:
        return 1.0
    if v < 0:
        return -1.0
    return v


def js_str(v: float) -> str:
    """``String(v)`` for a number: the shortest digits that read back as ``v``,
    in JavaScript's layout (no ``.0``, exponents only past 1e21 or below 1e-6)."""
    if math.isnan(v):
        return "NaN"
    if math.isinf(v):
        return "Infinity" if v > 0 else "-Infinity"
    if v == 0:
        return "0"
    sign = "-" if v < 0 else ""
    mantissa, _, exp = repr(abs(v)).partition("e")
    whole, _, frac = mantissa.partition(".")
    significant = (whole + frac).lstrip("0")
    # v = 0.<digits> * 10**n (ECMAScript's Number::toString calls it n).
    n = len(significant) + (int(exp) if exp else 0) - len(frac)
    digits = significant.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    exp_text = f"e{'+' if e >= 0 else '-'}{abs(e)}"
    if k == 1:
        return sign + digits + exp_text
    return sign + digits[0] + "." + digits[1:] + exp_text


_JS_NUMBER = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")


def js_number(text: str) -> float:
    """``Number(text)`` for decimal text: ``""`` is 0, anything else NaN."""
    s = text.strip()
    if not s:
        return 0.0
    if s in ("Infinity", "+Infinity"):
        return math.inf
    if s == "-Infinity":
        return -math.inf
    return float(s) if _JS_NUMBER.match(s) else math.nan


# ── Points and sites ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Pt:
    x: float
    y: float


@dataclass(frozen=True)
class End:
    """A connector end: a point, facing ``(dx, dy)`` when at a connected site."""

    x: float
    y: float
    dx: float | None = None
    dy: float | None = None


@dataclass(frozen=True)
class Site:
    """A connection site: ``name`` is ``"<side>"`` for the middle of a side or
    ``"<side>@<fraction>"`` anywhere along it (clockwise from its first
    corner); ``(dx, dy)`` is the outward direction, where a line leaves."""

    name: str
    x: float
    y: float
    dx: float
    dy: float

    def end(self) -> End:
        return End(self.x, self.y, self.dx, self.dy)


def site_name(side: Side, t: float) -> str:
    if abs(t - 0.5) < 1e-9:
        return side
    return f"{side}@{js_str(js_round(t * 1000) / 1000)}"


def parse_site(name: str) -> tuple[Side, float] | None:
    parts = name.split("@")
    side = parts[0]
    if side not in SIDES:
        return None
    t = 0.5 if len(parts) < 2 else js_number(parts[1])
    if math.isfinite(t) and 0 <= t <= 1:
        return side, t
    return None


def _clean(v: float) -> float:
    return 0.0 if abs(v) < 1e-12 else v


def site_on_corners(c: list[Pt], side: Side, t: float, round_: bool = False) -> Site:
    """The site a fraction ``t`` along one side of a shape whose corners are
    ``c`` (top-left, top-right, bottom-right, bottom-left, as transformed),
    facing out of it; on a round shape moved in onto the enclosed ellipse."""
    along: dict[Side, tuple[float, float]] = {
        "top": (t, 0),
        "right": (1, t),
        "bottom": (1 - t, 1),
        "left": (0, 1 - t),
    }
    u, v = along[side]
    if round_:
        off = math.sqrt(max(0.0, 0.25 - (t - 0.5) ** 2))
        if side == "top":
            v = 0.5 - off
        elif side == "bottom":
            v = 0.5 + off
        elif side == "right":
            u = 0.5 + off
        else:
            u = 0.5 - off
    ex = Pt(c[1].x - c[0].x, c[1].y - c[0].y)
    ey = Pt(c[3].x - c[0].x, c[3].y - c[0].y)
    x = c[0].x + u * ex.x + v * ey.x
    y = c[0].y + u * ex.y + v * ey.y
    i = SIDES.index(side)
    a = c[i]
    b = c[(i + 1) % 4]
    nx = b.y - a.y
    ny = -(b.x - a.x)
    centre = Pt(
        (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
        (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
    )
    mid = Pt((a.x + b.x) / 2, (a.y + b.y) / 2)
    if nx * (mid.x - centre.x) + ny * (mid.y - centre.y) < 0:
        nx = -nx
        ny = -ny
    length = math.hypot(nx, ny) or 1
    return Site(site_name(side, t), x, y, _clean(nx / length), _clean(ny / length))


def per_side(n: float) -> int:
    return max(1, min(MAX_SITES, int(js_round(n))))


def sites_from_corners(c: list[Pt], per: float = 1, round_: bool = False) -> list[Site]:
    """The ``per`` evenly spaced sites on each side of a shape."""
    n = per_side(per)
    return [
        site_on_corners(c, side, (k + 1) / (n + 1), round_)
        for side in SIDES
        for k in range(n)
    ]


def site_by_name(c: list[Pt], name: str, round_: bool = False) -> Site | None:
    """A named site, whether or not the shape currently offers it."""
    s = parse_site(name)
    return site_on_corners(c, s[0], s[1], round_) if s else None


def nearest_site(sites: list[Site], p: Pt, within: float) -> Site | None:
    best: Site | None = None
    best_d = within
    for s in sites:
        d = math.hypot(s.x - p.x, s.y - p.y)
        if d <= best_d:
            best = s
            best_d = d
    return best


# ── Routes ──────────────────────────────────────────────────────────────────────


def _direction(end: End, other: End) -> Pt:
    """An end's direction: its site's, or (a free end) back toward the other
    end, along the main axis."""
    if end.dx is not None and end.dy is not None:
        return Pt(end.dx, end.dy)
    dx = other.x - end.x
    dy = other.y - end.y
    if abs(dx) >= abs(dy):
        return Pt(js_sign(dx) or 1, 0)
    return Pt(0, js_sign(dy) or 1)


def _horizontal(d: Pt) -> bool:
    return abs(d.x) >= abs(d.y)


@dataclass(frozen=True)
class Bend:
    """Where an elbow's adjustable segment runs: the x of a vertical segment
    or the y of a horizontal one (stored as ``inkflow:bend="x:640"``)."""

    axis: str
    at: float


_BEND = re.compile(r"^([xy]):(-?\d*\.?\d+(?:e[-+]?\d+)?)$", re.IGNORECASE)


def parse_bend(value: str | None) -> Bend | None:
    m = _BEND.match(value or "")
    if not m:
        return None
    at = float(m.group(2))
    return Bend(m.group(1), at) if math.isfinite(at) else None


def format_bend(b: Bend) -> str:
    return f"{b.axis}:{js_str(js_round(b.at * 100) / 100)}"


@dataclass(frozen=True)
class Route:
    points: list[Pt]
    """A polyline's points, or ``[start, c1, c2, end]`` of one cubic curve."""
    curve: bool = False
    bend: Bend | None = None
    """An elbow's adjustable segment."""
    mid: Pt | None = field(default=None, compare=False)
    """The middle of that segment (the editor's drag handle)."""


def route(style: str, a: End, b: End, bend: Bend | None = None) -> Route:
    """The route between two ends, in the coordinates the ends are given in."""
    if style == "curved":
        da = _direction(a, b)
        db = _direction(b, a)
        k = max(30.0, math.hypot(b.x - a.x, b.y - a.y) * 0.4)
        return Route(
            [
                Pt(a.x, a.y),
                Pt(a.x + da.x * k, a.y + da.y * k),
                Pt(b.x + db.x * k, b.y + db.y * k),
                Pt(b.x, b.y),
            ],
            curve=True,
        )
    if style == "straight":
        return Route([Pt(a.x, a.y), Pt(b.x, b.y)])
    return _elbow(a, b, bend)


def _elbow(a: End, b: End, bend: Bend | None) -> Route:
    """Leave and enter along each end's direction, turning at right angles.
    One segment is adjustable (the bend): between parallel ends the middle
    one, from a side to a top or bottom the one before the last turn."""
    da = _direction(a, b)
    db = _direction(b, a)
    ha = _horizontal(da)
    hb = _horizontal(db)
    pa_ = Pt(a.x, a.y)
    pb_ = Pt(b.x, b.y)
    if ha == hb:
        axis = "x" if ha else "y"
        pa = a.x if ha else a.y
        pb = b.x if ha else b.y
        sa = js_sign(da.x if ha else da.y)
        sb = js_sign(db.x if ha else db.y)
        # Both ends facing the same way: go round, past the further one.
        if sa == sb:
            fallback = max(pa, pb) + STUB if sa > 0 else min(pa, pb) - STUB
        else:
            fallback = (pa + pb) / 2

        def build(m: float) -> tuple[list[Pt], Pt]:
            if ha:
                return [pa_, Pt(m, a.y), Pt(m, b.y), pb_], Pt(m, (a.y + b.y) / 2)
            return [pa_, Pt(a.x, m), Pt(b.x, m), pb_], Pt((a.x + b.x) / 2, m)

    elif ha:
        axis = "x"
        fallback = b.x
        k = b.y + js_sign(db.y or 1) * STUB

        def build(m: float) -> tuple[list[Pt], Pt]:
            return (
                [pa_, Pt(m, a.y), Pt(m, k), Pt(b.x, k), pb_],
                Pt(m, (a.y + k) / 2),
            )

    else:
        axis = "y"
        fallback = b.y
        k = b.x + js_sign(db.x or 1) * STUB

        def build(m: float) -> tuple[list[Pt], Pt]:
            return (
                [pa_, Pt(a.x, m), Pt(k, m), Pt(k, b.y), pb_],
                Pt((a.x + k) / 2, m),
            )

    at = bend.at if bend is not None and bend.axis == axis else fallback
    pts, mid = build(at)
    return Route(_simplify(pts), curve=False, bend=Bend(axis, at), mid=mid)


def _simplify(pts: list[Pt]) -> list[Pt]:
    """Drop repeated points and bends that are not bends (a straight run
    through them); a turn back along the same line is kept."""
    out: list[Pt] = []
    for p in pts:
        if out and math.hypot(p.x - out[-1].x, p.y - out[-1].y) < 1e-6:
            continue
        out.append(p)
        while len(out) >= 3:
            p0, p1, p2 = out[-3:]
            ux = p1.x - p0.x
            uy = p1.y - p0.y
            vx = p2.x - p1.x
            vy = p2.y - p1.y
            if abs(ux * vy - uy * vx) < 1e-6 and ux * vx + uy * vy > 0:
                del out[-2]
            else:
                break
    return out


def _n(v: float) -> str:
    return js_str(js_round(v * 100) / 100)


def path_data(r: Route) -> str:
    first, *rest = r.points
    head = f"M{_n(first.x)},{_n(first.y)}"
    if r.curve:
        return f"{head} C{' '.join(f'{_n(p.x)},{_n(p.y)}' for p in rest)}"
    return f"{head} {' '.join(f'L{_n(p.x)},{_n(p.y)}' for p in rest)}"


_NUMBER = re.compile(r"-?\d*\.?\d+(?:e[-+]?\d+)?", re.IGNORECASE)


def endpoints_of(d: str) -> tuple[Pt, Pt] | None:
    """First and last point of a path's data (a connector's two ends)."""
    nums = [float(m.group()) for m in _NUMBER.finditer(d)]
    if len(nums) < 4 or any(not math.isfinite(v) for v in nums):
        return None
    return Pt(nums[0], nums[1]), Pt(nums[-2], nums[-1])


@dataclass(frozen=True)
class Connection:
    id: str
    site: str


def parse_connection(value: str | None) -> Connection | None:
    if not value:
        return None
    i = value.rfind(":")
    site = value[i + 1 :]
    if i <= 0 or not parse_site(site):
        return None
    return Connection(value[:i], site)
