"""Compare two builds of a deck: which slides differ, and how.

Pure functions over `DeckFacts` (what `editor/comparesrc.py` reads off a build
of each side), shared by the editor's compare view (`editor/comparehub.py`) and
`inkflow compare`:

- `normalize_svg` makes two builds of the same slide byte-equal: it drops the
  editor's provenance (``data-ink*``), the served version stamps (``?v=…``) and
  what depends on the slide's position (the root's ``inkflow-slide-N`` id and its
  ``@scope``, the slide number and total), so a slide that only moved does not
  read as changed.
- `pair_slides` pairs the slides of both decks: by id, then by the file the
  slide is written in, then ids that only exist because of numbering
  (``content-2``), then identical content, and what is left by order between
  those anchors. A pair whose position changed relative to the others is
  ``moved`` (the longest run kept in order stays put).
- `compare_decks` says for each pair whether it is ``same``, ``changed``,
  ``added`` or ``removed`` and, for a changed one, what changed: the source
  files, the speaker notes, the slide's settings in deck.py and the elements
  (`element_changes`: matched by id, else by their place among their siblings),
  each with its box in slide units so a view can outline it.
"""

from __future__ import annotations

import difflib
import html
import itertools
import math
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal, cast

from lxml import etree

from inkflow import ns
from inkflow.svgio import SvgElement, parse_svg

Status = Literal["same", "changed", "added", "removed"]
Change = Literal["changed", "added", "removed"]

# ── Normalization ─────────────────────────────────────────────────────────────

_EDITOR_ATTR = re.compile(r"^data-(?:ink(?:-[a-z-]+)?|cell-geometry|drawn-geometry)$")
_STAMP = re.compile(r"\?v=[0-9a-f]+$")
_SLIDE_ROOT_ID = re.compile(r"inkflow-slide-\d+")
_NUMBER_ZONES = ("zone-slide-number", "zone-slide-total")
_DISPLAY_ATTR = re.compile(
    r'\sdata-(?:ink(?:-[a-z-]+)?|cell-geometry|drawn-geometry)="[^"]*"'
)


def _is_element(el: SvgElement) -> bool:
    """Not a comment or processing instruction (whose ``tag`` is a function)."""
    return isinstance(cast("object", el.tag), str)


def _text_of(el: SvgElement) -> str:
    return "".join(cast("list[str]", list(el.itertext())))


def _floats(text: str) -> list[float]:
    return [float(v) for v in cast("list[str]", _NUMBERS.findall(text))]


def strip_editor_attrs(svg: str) -> str:
    """An editor build's slide without the editor's attributes, for showing it."""
    return _DISPLAY_ATTR.sub("", svg)


def normalize_tree(root: SvgElement) -> SvgElement:
    """Drop what differs between two builds of the same slide (in place)."""
    for el in root.iter():
        if not _is_element(el):
            continue
        for name in list(el.attrib):
            key = str(name)
            if _EDITOR_ATTR.match(key):
                del el.attrib[key]
                continue
            value = str(el.attrib[key])
            if "?v=" in value:
                el.set(key, _STAMP.sub("", value))
        if el.get("id") in _NUMBER_ZONES:
            el.text = "#"
            for child in el:
                el.remove(child)
        if etree.QName(el).localname == "style" and el.text:
            el.text = _SLIDE_ROOT_ID.sub("inkflow-slide", el.text)
    root_id = root.get("id")
    if root_id and _SLIDE_ROOT_ID.fullmatch(root_id):
        root.set("id", "inkflow-slide")
    return root


def normalize_svg(svg: str) -> str:
    """`normalize_tree` over a serialized slide."""
    try:
        root = parse_svg(svg)
    except etree.XMLSyntaxError:
        return _DISPLAY_ATTR.sub("", svg)
    return etree.tostring(normalize_tree(root), encoding="unicode")


_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


def plain_text(fragment: str) -> str:
    """The words of an HTML fragment (speaker notes), whitespace collapsed."""
    text = _TAG.sub(" ", re.sub(r"<(?:/p|br\s*/?|/li|/h\d)>", "\n", fragment))
    lines = [_SPACE.sub(" ", html.unescape(line)).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


# ── Facts about each deck ─────────────────────────────────────────────────────


@dataclass
class SlideFacts:
    """One slide of one side, as much as comparing needs."""

    index: int
    """Position in deck.py's slide list (hidden slides count)."""
    number: int | None
    """1-based presentation number; None for a hidden slide."""
    id: str
    raw_id: str = ""
    """The id before numbering repeats (``content`` for ``content-2``)."""
    explicit: bool = False
    """The id is written in deck.py (``Slide(id=…)``)."""
    title: str = ""
    visible: bool = True
    svg: str | None = None
    """Normalized built SVG (`normalize_svg`); None for a hidden slide."""
    notes: str = ""
    """Speaker notes as plain text."""
    settings: dict[str, object] = field(default_factory=dict)
    """The slide's deck.py settings by name (``transition``, ``animations``…)."""
    files: dict[str, tuple[str, str]] = field(default_factory=dict)
    """Source files: path relative to the deck's folder → (role, content hash)."""
    key_file: str | None = None
    """The file only this slide is written in (its Markdown, or its own SVG)."""


@dataclass
class DeckFacts:
    slides: list[SlideFacts]
    settings: dict[str, object] = field(default_factory=dict)
    """Deck-wide settings by name (``theme``, ``styles``, ``mode``…)."""


# ── Pairing ───────────────────────────────────────────────────────────────────


def _strong(slide: SlideFacts, deck: list[SlideFacts]) -> bool:
    """An id that names this slide whatever its position: written in deck.py,
    or inferred from a name no other slide shares."""
    if slide.explicit:
        return True
    raw = slide.raw_id or slide.id
    return sum(1 for s in deck if (s.raw_id or s.id) == raw) == 1


def _match(
    left: list[SlideFacts],
    right: list[SlideFacts],
    pairs: dict[int, int],
    key: Callable[[SlideFacts], str | None],
    right_key: Callable[[SlideFacts], str | None] | None = None,
) -> None:
    """Pair still-unpaired slides whose ``key`` is equal and unique on both sides."""
    taken = set(pairs.values())

    def index(
        slides: list[SlideFacts],
        skip: set[int],
        key: Callable[[SlideFacts], str | None],
    ) -> dict[str, int]:
        seen: dict[str, int] = {}
        dup: set[str] = set()
        for i, s in enumerate(slides):
            if i in skip:
                continue
            k = key(s)
            if k is None:
                continue
            if k in seen:
                dup.add(k)
            seen[k] = i
        return {k: i for k, i in seen.items() if k not in dup}

    lk = index(left, set(pairs), key)
    rk = index(right, taken, right_key or key)
    for k, i in lk.items():
        j = rk.get(k)
        if j is not None:
            pairs[i] = j


def _related(a: SlideFacts, b: SlideFacts) -> bool:
    """Two slides that may be versions of each other: built on the same
    layout or file (an edited slide whose id and file both changed)."""
    layout = a.settings.get("layout")
    return (layout is not None and layout == b.settings.get("layout")) or (
        a.key_file is not None and a.key_file == b.key_file
    )


def _gaps(
    left: list[SlideFacts], right: list[SlideFacts], pairs: dict[int, int]
) -> None:
    """Pair what is left by order, between anchors already paired in order:
    each left slide with the next related right slide (`_related`), so a
    deleted slide and an unrelated new one in its place stay apart."""
    anchors = sorted((i, j) for i, j in pairs.items())
    kept = _increasing(anchors)
    bounds = [(-1, -1), *kept, (len(left), len(right))]
    taken = set(pairs.values())
    for (i0, j0), (i1, j1) in itertools.pairwise(bounds):
        ls = [i for i in range(i0 + 1, i1) if i not in pairs]
        rs = [j for j in range(j0 + 1, j1) if j not in taken]
        start = 0
        for i in ls:
            for k in range(start, len(rs)):
                if _related(left[i], right[rs[k]]):
                    pairs[i] = rs[k]
                    taken.add(rs[k])
                    start = k + 1
                    break


def _increasing(pairs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """The longest run of ``pairs`` (sorted by left) whose right side increases."""
    if not pairs:
        return []
    tails: list[int] = []
    tails_at: list[int] = []
    prev: list[int] = [-1] * len(pairs)
    for k, (_, j) in enumerate(pairs):
        lo, hi = 0, len(tails)
        while lo < hi:
            mid = (lo + hi) // 2
            if tails[mid] < j:
                lo = mid + 1
            else:
                hi = mid
        if lo == len(tails):
            tails.append(j)
            tails_at.append(k)
        else:
            tails[lo] = j
            tails_at[lo] = k
        prev[k] = tails_at[lo - 1] if lo > 0 else -1
    out: list[tuple[int, int]] = []
    k = tails_at[-1]
    while k >= 0:
        out.append(pairs[k])
        k = prev[k]
    return out[::-1]


def pair_slides(
    left: list[SlideFacts], right: list[SlideFacts]
) -> list[tuple[int | None, int | None]]:
    """Rows of (left index, right index) in the right deck's order, a slide
    only on the left placed after the row of the slide before it."""
    pairs: dict[int, int] = {}
    _match(left, right, pairs, lambda s: s.id if _strong(s, left + right) else None)
    _match(left, right, pairs, lambda s: s.key_file)
    _match(
        left,
        right,
        pairs,
        lambda s: f"{s.svg}\0{s.notes}" if s.svg is not None else None,
    )
    _match(left, right, pairs, lambda s: s.id)
    _gaps(left, right, pairs)

    by_right = {j: i for i, j in pairs.items()}
    rows: list[tuple[int | None, int | None]] = []
    emitted: set[int] = set()

    def flush(upto: int) -> None:
        for i in range(upto):
            if i not in pairs and i not in emitted:
                rows.append((i, None))
                emitted.add(i)

    # Where the next paired slide sits on the left, for each right slide: a
    # slide only on the left comes before what was added in its place.
    upcoming: list[int] = [len(left)] * (len(right) + 1)
    for j in range(len(right) - 1, -1, -1):
        i = by_right.get(j)
        upcoming[j] = i if i is not None else upcoming[j + 1]
    for j in range(len(right)):
        i = by_right.get(j)
        flush(i if i is not None else upcoming[j])
        if i is not None:
            emitted.add(i)
        rows.append((i, j))
    flush(len(left))
    return rows


def moved_rows(rows: list[tuple[int | None, int | None]]) -> set[int]:
    """Rows (by position in ``rows``) whose pair left its neighbours' order."""
    paired = [(i, j) for i, j in rows if i is not None and j is not None]
    kept = set(_increasing(sorted(paired)))
    return {
        k
        for k, (i, j) in enumerate(rows)
        if i is not None and j is not None and (i, j) not in kept
    }


# ── Element differences ───────────────────────────────────────────────────────

Box = tuple[float, float, float, float]
"""x, y, width, height in slide units."""
Matrix = tuple[float, float, float, float, float, float]
_IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

_SKIP = frozenset(
    {
        "defs",
        "style",
        "script",
        "title",
        "desc",
        "metadata",
        "clipPath",
        "mask",
        "pattern",
        "linearGradient",
        "radialGradient",
        "filter",
        "marker",
        "symbol",
    }
)
_SHAPES = frozenset(
    {
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "path",
        "image",
        "use",
        "text",
    }
)
_HTML_BLOCKS = frozenset(
    {
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "pre",
        "blockquote",
        "td",
        "th",
        "img",
        "video",
        "hr",
        "dt",
        "dd",
        "figcaption",
        "caption",
    }
)
_MATHML = "http://www.w3.org/1998/Math/MathML"


@dataclass(frozen=True)
class Location:
    """Where an element is in one side's slide."""

    path: tuple[int, ...]
    """Element-child indices from the slide's root ``<svg>``."""
    tag: str
    box: Box | None


@dataclass(frozen=True)
class ElementChange:
    change: Change
    left: Location | None
    right: Location | None
    id: str | None = None
    text: str = ""
    """A few words of the element's text, to name it."""


@dataclass
class _Unit:
    id: str | None
    anchor: str
    tag: str
    sig: str
    path: tuple[int, ...]
    box: Box | None
    text: str


def _num(value: str | None) -> float | None:
    if value is None:
        return None
    m = re.match(r"\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)\s*(px)?\s*$", value)
    return float(m.group(1)) if m else None


def _multiply(m: Matrix, n: Matrix) -> Matrix:
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (
        a * a2 + c * b2,
        b * a2 + d * b2,
        a * c2 + c * d2,
        b * c2 + d * d2,
        a * e2 + c * f2 + e,
        b * e2 + d * f2 + f,
    )


_TRANSFORM = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")
_NUMBERS = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")


def parse_transform(text: str | None) -> Matrix:
    """An SVG ``transform`` attribute as one matrix (unknown parts ignored)."""
    m = _IDENTITY
    for name, args in cast("list[tuple[str, str]]", _TRANSFORM.findall(text or "")):
        v = _floats(args)
        step: Matrix = _IDENTITY
        if name == "matrix" and len(v) == 6:
            step = (v[0], v[1], v[2], v[3], v[4], v[5])
        elif name == "translate" and v:
            step = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale" and v:
            step = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate" and v:
            r = math.radians(v[0])
            cos, sin = math.cos(r), math.sin(r)
            step = (cos, sin, -sin, cos, 0, 0)
            if len(v) == 3:
                step = _multiply(
                    _multiply((1, 0, 0, 1, v[1], v[2]), step),
                    (1, 0, 0, 1, -v[1], -v[2]),
                )
        elif name == "skewX" and v:
            step = (1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        elif name == "skewY" and v:
            step = (1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        m = _multiply(m, step)
    return m


def _apply(m: Matrix, box: Box) -> Box:
    x, y, w, h = box
    a, b, c, d, e, f = m
    xs: list[float] = []
    ys: list[float] = []
    for px, py in ((x, y), (x + w, y), (x, y + h), (x + w, y + h)):
        xs.append(a * px + c * py + e)
        ys.append(b * px + d * py + f)
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


def _union(boxes: Iterable[Box | None]) -> Box | None:
    real = [b for b in boxes if b is not None]
    if not real:
        return None
    x0 = min(b[0] for b in real)
    y0 = min(b[1] for b in real)
    x1 = max(b[0] + b[2] for b in real)
    y1 = max(b[1] + b[3] for b in real)
    return (x0, y0, x1 - x0, y1 - y0)


def _points_box(values: list[float]) -> Box | None:
    xs, ys = values[0::2], values[1::2]
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


_PATH_TOKEN = re.compile(
    r"([MmZzLlHhVvCcSsQqTtAa])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)"
)
_PATH_ARGS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}


def path_box(d: str) -> Box | None:
    """The box of a path's points (end and control points: a little generous
    around curves, which is what an outline wants)."""
    pts: list[float] = []
    x = y = sx = sy = 0.0
    cmd = ""
    args: list[float] = []

    def run(c: str, a: list[float]) -> None:
        nonlocal x, y, sx, sy
        rel = c.islower()
        up = c.upper()
        bx, by = (x, y) if rel else (0.0, 0.0)
        if up in ("M", "L", "T"):
            x, y = bx + a[0], by + a[1]
            pts.extend((x, y))
            if up == "M":
                sx, sy = x, y
        elif up == "H":
            x = (x if rel else 0.0) + a[0]
            pts.extend((x, y))
        elif up == "V":
            y = (y if rel else 0.0) + a[0]
            pts.extend((x, y))
        elif up in ("C", "S", "Q"):
            for k in range(0, len(a), 2):
                pts.extend((bx + a[k], by + a[k + 1]))
            x, y = bx + a[-2], by + a[-1]
        elif up == "A":
            x, y = bx + a[5], by + a[6]
            pts.extend((x, y))

    for token in _PATH_TOKEN.finditer(d):
        letter, number = token.group(1), token.group(2)
        if letter:
            if letter in "Zz":
                x, y = sx, sy
                cmd = ""
                continue
            cmd = letter
            args = []
            continue
        if not cmd:
            continue
        args.append(float(number))
        need = _PATH_ARGS[cmd.upper()]
        if len(args) == need:
            run(cmd, args)
            args = []
            # Coordinates after a moveto are implicit linetos.
            if cmd == "M":
                cmd = "L"
            elif cmd == "m":
                cmd = "l"
    return _points_box(pts)


def _font_size(el: SvgElement) -> float:
    probe: SvgElement | None = el
    while probe is not None:
        size = _num(probe.get("font-size"))
        if size is None:
            m = re.search(r"font-size\s*:\s*([\d.]+)", probe.get("style") or "")
            size = float(m.group(1)) if m else None
        if size is not None:
            return size
        probe = probe.getparent()
    return 16.0


def _local_box(el: SvgElement, local: str) -> Box | None:
    """An element's box in its own user units (no transform), roughly."""
    g = el.get
    if local in ("rect", "image", "foreignObject", "use", "svg"):
        w, h = _num(g("width")), _num(g("height"))
        if w is None or h is None:
            return None
        return (_num(g("x")) or 0.0, _num(g("y")) or 0.0, w, h)
    if local == "circle":
        cx, cy, r = _num(g("cx")) or 0.0, _num(g("cy")) or 0.0, _num(g("r")) or 0.0
        return (cx - r, cy - r, 2 * r, 2 * r)
    if local == "ellipse":
        cx, cy = _num(g("cx")) or 0.0, _num(g("cy")) or 0.0
        rx, ry = _num(g("rx")) or 0.0, _num(g("ry")) or 0.0
        return (cx - rx, cy - ry, 2 * rx, 2 * ry)
    if local == "line":
        return _points_box(
            [_num(g(k)) or 0.0 for k in ("x1", "y1", "x2", "y2")],
        )
    if local in ("polyline", "polygon"):
        return _points_box(_floats(g("points") or ""))
    if local == "path":
        return path_box(g("d") or "")
    if local == "text":
        first = el if el.get("x") is not None else el.find(f"{{{ns.SVG}}}tspan")
        if first is None:
            first = el
        xs = _floats(first.get("x") or "0")
        ys = _floats(first.get("y") or "0")
        x = xs[0] if xs else 0.0
        y = ys[0] if ys else 0.0
        size = _font_size(el)
        words = _SPACE.sub(" ", _text_of(el)).strip()
        width = max(size, 0.55 * size * len(words))
        anchor = el.get("text-anchor") or ""
        if anchor == "middle":
            x -= width / 2
        elif anchor == "end":
            x -= width
        return (x, y - size * 0.85, width, size * 1.1)
    return None


def _kind(el: SvgElement) -> tuple[str, str]:
    """(namespace kind, local name): ``svg``, ``html`` or ``math``."""
    q = etree.QName(el)
    if q.namespace == ns.XHTML:
        return "html", q.localname
    if q.namespace == _MATHML:
        return "math", q.localname
    return "svg", q.localname


def _children(el: SvgElement) -> list[SvgElement]:
    return [c for c in el if _is_element(c)]


def _has_block(el: SvgElement) -> bool:
    for d in el.iterdescendants():
        if not _is_element(d):
            continue
        kind, local = _kind(d)
        if (kind == "html" and local in _HTML_BLOCKS) or kind in ("svg", "math"):
            return True
    return False


def _own_text(el: SvgElement) -> bool:
    if (el.text or "").strip():
        return True
    return any((c.tail or "").strip() for c in el)


def _shallow(el: SvgElement) -> str:
    attrs = ";".join(
        f"{k}={v}" for k, v in sorted((str(k), str(v)) for k, v in el.attrib.items())
    )
    return f"{el.tag}|{attrs}"


def _deep(el: SvgElement) -> str:
    return etree.tostring(el, method="c14n").decode("utf-8", "replace")


def _snippet(el: SvgElement) -> str:
    text = _SPACE.sub(" ", _text_of(el)).strip()
    return text[:60]


def _rounded(box: Box | None) -> Box | None:
    if box is None or not all(math.isfinite(v) for v in box):
        return None
    return (round(box[0], 1), round(box[1], 1), round(box[2], 1), round(box[3], 1))


def _units(root: SvgElement) -> list[_Unit]:
    units: list[_Unit] = []

    def walk(
        el: SvgElement,
        path: tuple[int, ...],
        matrix: Matrix,
        anchor: str,
        context: str,
        frame: Box | None,
    ) -> Box | None:
        """Collect the units under ``el``; returns the union of their boxes."""
        boxes: list[Box | None] = []
        for i, child in enumerate(_children(el)):
            kind, local = _kind(child)
            if kind == "svg" and local in _SKIP:
                continue
            cpath = (*path, i)
            m = matrix
            if kind == "svg":
                m = _multiply(matrix, parse_transform(child.get("transform")))
            own_id = child.get("id") or None
            leaf = (
                (kind == "svg" and local in _SHAPES)
                or (
                    kind == "html"
                    and (local in _HTML_BLOCKS or _own_text(child))
                    and not _has_block(child)
                )
                or (kind == "math" and local == "math")
            )
            if leaf:
                local_box = _local_box(child, local) if kind == "svg" else None
                box = (
                    frame
                    if frame is not None
                    else (_apply(m, local_box) if local_box else None)
                )
                units.append(
                    _Unit(
                        own_id,
                        anchor,
                        local,
                        context + _deep(child),
                        cpath,
                        _rounded(box),
                        _snippet(child),
                    )
                )
                boxes.append(box)
                continue
            # A container: its children are walked in its coordinates.
            inner = m
            inner_frame = frame
            if kind == "svg" and local in ("svg", "foreignObject"):
                own = _local_box(child, local)
                if own is not None and frame is None:
                    inner_frame = _apply(m, own) if local == "foreignObject" else None
                if local == "svg" and own is not None:
                    vb = _floats(child.get("viewBox") or "")
                    inner = _multiply(m, (1, 0, 0, 1, own[0], own[1]))
                    if len(vb) == 4 and vb[2] and vb[3]:
                        inner = _multiply(
                            inner,
                            (own[2] / vb[2], 0, 0, own[3] / vb[3], -vb[0], -vb[1]),
                        )
                    if frame is not None:
                        inner_frame = frame
            if own_id:
                at = len(units)
                units.append(
                    _Unit(
                        own_id,
                        anchor,
                        local,
                        context + _shallow(child),
                        cpath,
                        None,
                        "",
                    )
                )
                box = walk(child, cpath, inner, own_id, "", inner_frame)
                if local == "foreignObject" and inner_frame is not None:
                    box = inner_frame
                unit = units[at]
                unit.box = _rounded(box)
                unit.text = _snippet(child)
                boxes.append(box)
            else:
                box = walk(
                    child,
                    cpath,
                    inner,
                    anchor,
                    context + _shallow(child) + "/",
                    inner_frame,
                )
                boxes.append(box)
        return _union(boxes)

    walk(root, (), _IDENTITY, "", "", None)
    return units


def _location(unit: _Unit) -> Location:
    return Location(unit.path, unit.tag, unit.box)


def element_changes(
    left_svg: str, right_svg: str, limit: int = 200
) -> list[ElementChange]:
    """What differs between two (normalized) slide SVGs, element by element.

    Elements with an id are matched by it. The others are compared among the
    unnamed elements under the same named ancestor, as two sequences: equal
    runs match, a replaced run pairs elements of the same tag in order as
    ``changed``, and the rest are ``added`` or ``removed``. An element counts
    as changed when it, or the unnamed groups between it and its named
    ancestor, differ: a moved group shows as its shapes moving.
    """
    try:
        left = _units(parse_svg(left_svg))
        right = _units(parse_svg(right_svg))
    except etree.XMLSyntaxError:
        return []
    out: list[ElementChange] = []
    lid = {u.id: u for u in left if u.id}
    rid = {u.id: u for u in right if u.id}
    for u in left:
        if u.id and u.id in rid:
            other = rid[u.id]
            if u.sig != other.sig:
                out.append(
                    ElementChange(
                        "changed",
                        _location(u),
                        _location(other),
                        u.id,
                        other.text or u.text,
                    )
                )
        elif u.id:
            out.append(ElementChange("removed", _location(u), None, u.id, u.text))
    for u in right:
        if u.id and u.id not in lid:
            out.append(ElementChange("added", None, _location(u), u.id, u.text))

    groups: dict[str, tuple[list[_Unit], list[_Unit]]] = {}
    for u in left:
        if not u.id:
            groups.setdefault(u.anchor, ([], []))[0].append(u)
    for u in right:
        if not u.id:
            groups.setdefault(u.anchor, ([], []))[1].append(u)
    for ls, rs in groups.values():
        matcher = difflib.SequenceMatcher(
            None, [u.sig for u in ls], [u.sig for u in rs], autojunk=False
        )
        for op, i1, i2, j1, j2 in matcher.get_opcodes():
            if op == "equal":
                continue
            olds, news = ls[i1:i2], rs[j1:j2]
            used: set[int] = set()
            for old in olds:
                match = next(
                    (
                        k
                        for k, new in enumerate(news)
                        if k not in used and new.tag == old.tag
                    ),
                    None,
                )
                if match is None:
                    out.append(
                        ElementChange("removed", _location(old), None, None, old.text)
                    )
                    continue
                used.add(match)
                new = news[match]
                out.append(
                    ElementChange(
                        "changed",
                        _location(old),
                        _location(new),
                        None,
                        new.text or old.text,
                    )
                )
            for k, new in enumerate(news):
                if k not in used:
                    out.append(
                        ElementChange("added", None, _location(new), None, new.text)
                    )
    return out[:limit]


# ── Comparing two decks ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class FileChange:
    path: str
    role: str
    change: Change


@dataclass
class PairDiff:
    left: int | None
    right: int | None
    status: Status
    moved: bool = False
    visual: bool = False
    """The built slides differ."""
    notes: bool = False
    settings: list[str] = field(default_factory=list)
    files: list[FileChange] = field(default_factory=list)
    elements: list[ElementChange] = field(default_factory=list)


@dataclass
class Comparison:
    pairs: list[PairDiff]
    deck: list[str]
    """Deck-wide settings that differ."""

    def changes(self) -> list[PairDiff]:
        return [p for p in self.pairs if p.status != "same" or p.moved]


def file_changes(left: SlideFacts, right: SlideFacts) -> list[FileChange]:
    out: list[FileChange] = []
    for path in sorted(set(left.files) | set(right.files)):
        a, b = left.files.get(path), right.files.get(path)
        if a is None and b is not None:
            out.append(FileChange(path, b[0], "added"))
        elif b is None and a is not None:
            out.append(FileChange(path, a[0], "removed"))
        elif a is not None and b is not None and a[1] != b[1]:
            out.append(FileChange(path, b[0], "changed"))
    return out


def _differing(left: dict[str, object], right: dict[str, object]) -> list[str]:
    return [k for k in sorted(set(left) | set(right)) if left.get(k) != right.get(k)]


def diff_pair(
    left: SlideFacts, right: SlideFacts, *, elements: bool = True
) -> PairDiff:
    visual = left.svg != right.svg
    diff = PairDiff(
        left.index,
        right.index,
        "same",
        visual=visual,
        notes=left.notes != right.notes,
        settings=_differing(left.settings, right.settings),
        files=file_changes(left, right),
    )
    if visual and elements and left.svg is not None and right.svg is not None:
        diff.elements = element_changes(left.svg, right.svg)
    if diff.visual or diff.notes or diff.settings or diff.files:
        diff.status = "changed"
    return diff


def compare_decks(
    left: DeckFacts, right: DeckFacts, *, elements: bool = True
) -> Comparison:
    rows = pair_slides(left.slides, right.slides)
    moved = moved_rows(rows)
    pairs: list[PairDiff] = []
    for k, (i, j) in enumerate(rows):
        if i is not None and j is not None:
            diff = diff_pair(left.slides[i], right.slides[j], elements=elements)
            diff.moved = k in moved
        elif i is not None:
            diff = PairDiff(i, None, "removed")
        else:
            diff = PairDiff(None, j, "added")
        pairs.append(diff)
    return Comparison(pairs, _differing(left.settings, right.settings))


# ── Output ────────────────────────────────────────────────────────────────────


def _location_json(loc: Location | None) -> dict[str, object] | None:
    if loc is None:
        return None
    return {
        "path": list(loc.path),
        "tag": loc.tag,
        "box": list(loc.box) if loc.box else None,
    }


def pair_json(pair: PairDiff) -> dict[str, object]:
    return {
        "left": pair.left,
        "right": pair.right,
        "status": pair.status,
        "moved": pair.moved,
        "visual": pair.visual,
        "notes": pair.notes,
        "settings": pair.settings,
        "files": [
            {"path": f.path, "role": f.role, "change": f.change} for f in pair.files
        ],
        "elements": [
            {
                "change": e.change,
                "id": e.id,
                "text": e.text,
                "left": _location_json(e.left),
                "right": _location_json(e.right),
            }
            for e in pair.elements
        ],
    }


def slide_json(slide: SlideFacts) -> dict[str, object]:
    return {
        "index": slide.index,
        "number": slide.number,
        "id": slide.id,
        "title": slide.title,
        "visible": slide.visible,
    }


def what_changed(pair: PairDiff) -> list[str]:
    """Short names for what differs in a changed pair: its files (but notes),
    "notes", then its deck.py settings; "look" when only the result differs
    (a deck-wide change such as the theme)."""
    parts = [f.path for f in pair.files if f.role != "notes"]
    if pair.notes or any(f.role == "notes" for f in pair.files):
        parts.append("notes")
    parts += [s.replace("_", " ") for s in pair.settings]
    if not parts and pair.visual:
        parts.append("look")
    return parts


def _ranges(numbers: list[int]) -> str:
    out: list[str] = []
    start = prev = None
    for n in sorted(numbers):
        if start is None:
            start = prev = n
        elif prev is not None and n == prev + 1:
            prev = n
        else:
            out.append(f"{start}" if start == prev else f"{start}-{prev}")
            start = prev = n
    if start is not None:
        out.append(f"{start}" if start == prev else f"{start}-{prev}")
    return ", ".join(out)


def _num_text(slide: SlideFacts) -> str:
    return str(slide.number) if slide.number is not None else "·"


def format_comparison(
    result: Comparison,
    left: DeckFacts,
    right: DeckFacts,
    left_label: str,
    right_label: str,
) -> str:
    """One line per slide that differs; the unchanged ones in one line."""
    lines = [f"{left_label} ⟷ {right_label}"]
    if result.deck:
        lines.append(f"! deck: {', '.join(s.replace('_', ' ') for s in result.deck)}")
    same: list[int] = []
    same_hidden = 0
    for pair in result.pairs:
        ls = left.slides[pair.left] if pair.left is not None else None
        rs = right.slides[pair.right] if pair.right is not None else None
        if pair.status == "added" and rs is not None:
            lines.append(f"+ {_num_text(rs)} {rs.id}")
        elif pair.status == "removed" and ls is not None:
            lines.append(f"- {_num_text(ls)} {ls.id}")
        elif ls is not None and rs is not None:
            what = what_changed(pair) if pair.status == "changed" else []
            tail = f": {', '.join(what)}" if what else ""
            if pair.moved:
                lines.append(f"↕ {_num_text(ls)} → {_num_text(rs)} {rs.id}{tail}")
            elif pair.status == "changed":
                lines.append(f"~ {_num_text(rs)} {rs.id}{tail}")
            elif rs.number is not None:
                same.append(rs.number)
            else:
                same_hidden += 1
    if same or same_hidden:
        n = len(same) + same_hidden
        where = f": {_ranges(same)}" if same else ""
        hidden = f" ({same_hidden} hidden)" if same_hidden else ""
        lines.append(f"= {n} unchanged{hidden}{where}")
    elif not result.changes():
        lines.append("= no slides")
    return "\n".join(lines)


def comparison_json(
    result: Comparison, left: DeckFacts, right: DeckFacts
) -> dict[str, object]:
    return {
        "deck": result.deck,
        "left": [slide_json(s) for s in left.slides],
        "right": [slide_json(s) for s in right.slides],
        "pairs": [pair_json(p) for p in result.pairs],
    }
