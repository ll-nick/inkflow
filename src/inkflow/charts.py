"""Charts plotted from a table of data, drawn as SVG at build time.

A chart's data lives in a file that diffs well in git (CSV, TSV, JSON) or is
written inline: ``Chart(data={...})`` in deck.py, or a Markdown table in a
```` ```chart ```` fence. This module reads those into one `Table`, and draws
the table as plain SVG into the slide, so ``serve``, the static build, the PDF
export, the editor's thumbnails and ``inkflow render`` all show the same chart
and no script runs in the browser.

Nothing here hard-codes a colour or a font: marks are painted with the theme's
palette tokens (``var(--inkflow-blue)``…) and text with its text tokens, so a
chart follows the deck's theme and colour mode like the rest of the slide.
Every series is a ``<g>`` with a stable id (``<chart>-series-<column>``, a pie's
slices ``<chart>-slice-<category>``) holding its marks, value labels and
legend entry, which is what lets a deck's animations reveal one at a time.
"""

from __future__ import annotations

import csv
import html
import io
import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.assets import AssetSource, is_local_ref
from inkflow.colors import SVG_TOKENS
from inkflow.enums import ChartKind
from inkflow.logging import logger
from inkflow.manifest import Chart, ChartValue
from inkflow.markdown import CHART_PLACEHOLDER_RE
from inkflow.svgio import SvgElement

Cell = float | str | None
"""A parsed table cell: a number, a label, or ``None`` (an empty cell, a gap)."""


class ChartError(ValueError):
    """Data that cannot be read or plotted; the message is drawn on the slide."""


# ── Tables ────────────────────────────────────────────────────────────────────

_NUMBER = re.compile(r"[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?")


def parse_cell(text: str) -> Cell:
    """A cell as written in a file: a number when it reads as one (``1,234.5``
    included), ``None`` when empty, else the text itself."""
    s = text.strip()
    if not s:
        return None
    if any(c.isdigit() for c in s) and _NUMBER.fullmatch(s):
        return float(s.replace(",", ""))
    return s


def _cell(value: object) -> Cell:
    """A cell from inline data or JSON, where numbers already are numbers."""
    if value is None:
        return None
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int | float):
        number = float(value)
        return number if math.isfinite(number) else None
    return parse_cell(str(value))


def cell_text(value: Cell) -> str:
    """How a cell is written back to a file, and named as a category."""
    if value is None:
        return ""
    if isinstance(value, float):
        return (
            str(int(value)) if value.is_integer() and abs(value) < 1e15 else repr(value)
        )
    return str(value)


@dataclass(frozen=True)
class Table:
    """Named columns and rows of cells; the first row of a file names the columns."""

    columns: list[str]
    rows: list[list[Cell]]

    @classmethod
    def from_text(cls, columns: Sequence[str], rows: Sequence[Sequence[str]]) -> Table:
        """A table from raw cell text (a file, a pasted grid, a Markdown table)."""
        names = _column_names(columns)
        width = len(names)
        parsed = [
            [parse_cell(row[i]) if i < len(row) else None for i in range(width)]
            for row in rows
        ]
        return cls(names, parsed)

    @classmethod
    def from_columns(cls, data: Mapping[str, Sequence[object]]) -> Table:
        """A table from ``{column: [values]}``, as ``Chart(data=...)`` takes it."""
        names = [str(k) for k in data]
        values = [list(v) for v in data.values()]
        length = max((len(v) for v in values), default=0)
        rows = [
            [_cell(column[i]) if i < len(column) else None for column in values]
            for i in range(length)
        ]
        return cls(names, rows)

    def to_columns(self) -> dict[str, list[ChartValue]]:
        out: dict[str, list[ChartValue]] = {}
        for i, name in enumerate(self.columns):
            out[name] = [_plain(row[i]) for row in self.rows]
        return out

    def text_rows(self) -> list[list[str]]:
        return [[cell_text(c) for c in row] for row in self.rows]

    def column(self, name: str) -> list[Cell]:
        i = self.columns.index(name)
        return [row[i] for row in self.rows]

    def is_numeric(self, name: str) -> bool:
        values = [v for v in self.column(name) if v is not None]
        return bool(values) and all(isinstance(v, float) for v in values)


def _plain(value: Cell) -> ChartValue:
    """A cell as deck.py or JSON writes it: whole numbers without ``.0``."""
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return int(value)
    return value


def _column_names(columns: Sequence[str]) -> list[str]:
    names: list[str] = []
    for i, raw in enumerate(columns):
        name = raw.strip() or f"column {i + 1}"
        base, n = name, 2
        while name in names:
            name = f"{base} {n}"
            n += 1
        names.append(name)
    return names


DELIMITERS = {".csv": ",", ".tsv": "\t", ".tab": "\t"}
DATA_SUFFIXES = frozenset({*DELIMITERS, ".json"})
"""The data files a chart reads."""


def _delimited(text: str, delimiter: str) -> tuple[list[str], list[list[str]]]:
    rows = [
        row
        for row in csv.reader(io.StringIO(text), delimiter=delimiter)
        if any(c.strip() for c in row)
    ]
    if not rows:
        return [], []
    return rows[0], rows[1:]


def parse_delimited(text: str, delimiter: str = ",") -> Table:
    """CSV (or TSV with ``delimiter="\\t"``): the first row names the columns."""
    header, body = _delimited(text.lstrip("﻿"), delimiter)
    if not header:
        raise ChartError("the file has no rows")
    return Table.from_text(header, body)


def parse_json(text: str) -> Table:
    """A list of records (``[{"year": 2024, "users": 3}, ...]``) or columns
    (``{"year": [...], "users": [...]}``)."""
    try:
        data = cast("object", json.loads(text))
    except json.JSONDecodeError as exc:
        raise ChartError(f"not valid JSON: {exc}") from exc
    if isinstance(data, dict):
        columns = cast("dict[str, object]", data)
        if all(isinstance(v, list) for v in columns.values()):
            return Table.from_columns(cast("dict[str, list[object]]", columns))
    if isinstance(data, list) and all(
        isinstance(r, dict) for r in cast("list[object]", data)
    ):
        records = cast("list[dict[str, object]]", data)
        names = list(dict.fromkeys(str(k) for r in records for k in r))
        rows = [[_cell(r.get(k)) for k in names] for r in records]
        return Table(_column_names(names), rows)
    raise ChartError("JSON data must be a list of records or {column: [values]}")


_TABLE_SEPARATOR = re.compile(r"^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")


def _table_cells(line: str) -> list[str]:
    inner = line.strip()
    inner = inner.removeprefix("|")
    if inner.endswith("|") and not inner.endswith("\\|"):
        inner = inner[:-1]
    cells = re.split(r"(?<!\\)\|", inner)
    return [c.strip().replace("\\|", "|") for c in cells]


def parse_markdown_table(text: str) -> Table:
    """A Markdown pipe table: a header row, the ``|---|`` row, then the rows."""
    lines = [ln for ln in text.splitlines() if ln.strip().startswith("|")]
    rows = [_table_cells(ln) for ln in lines if not _TABLE_SEPARATOR.match(ln)]
    if not rows:
        raise ChartError("the table has no rows")
    return Table.from_text(rows[0], rows[1:])


def read_text_rows(path: Path) -> tuple[list[str], list[list[str]]]:
    """A data file's columns and rows as text, as the editor's grid shows them."""
    suffix = path.suffix.lower()
    text = path.read_text(encoding="utf-8")
    if suffix in DELIMITERS:
        header, body = _delimited(text.lstrip("﻿"), DELIMITERS[suffix])
        width = len(header)
        return header, [[*row[:width], *[""] * (width - len(row))] for row in body]
    if suffix == ".json":
        table = parse_json(text)
        return table.columns, table.text_rows()
    raise ChartError(f"charts read .csv, .tsv and .json files, not {path.name}")


def read_table(path: Path) -> Table:
    suffix = path.suffix.lower()
    if suffix in DELIMITERS:
        return parse_delimited(path.read_text(encoding="utf-8"), DELIMITERS[suffix])
    if suffix == ".json":
        return parse_json(path.read_text(encoding="utf-8"))
    raise ChartError(f"charts read .csv, .tsv and .json files, not {path.name}")


def serialize_rows(
    suffix: str, columns: Sequence[str], rows: Sequence[Sequence[str]]
) -> str:
    """Columns and rows of cell text as a data file of the given kind.

    CSV and TSV keep each cell exactly as typed (quoted only where the format
    needs it), so an edit in the grid changes only the lines it touched.
    """
    suffix = suffix.lower()
    if suffix in DELIMITERS:
        out = io.StringIO()
        writer = csv.writer(out, delimiter=DELIMITERS[suffix], lineterminator="\n")
        writer.writerow(columns)
        width = len(columns)
        for row in rows:
            writer.writerow([*row[:width], *[""] * (width - len(row))])
        return out.getvalue()
    if suffix == ".json":
        table = Table.from_text(columns, rows)
        records = [
            {name: _plain(row[i]) for i, name in enumerate(table.columns)}
            for row in table.rows
        ]
        return json.dumps(records, indent=2, ensure_ascii=False) + "\n"
    raise ChartError(f"cannot write chart data as {suffix or 'a file without suffix'}")


# ── Resolving a chart's data ──────────────────────────────────────────────────


@dataclass(frozen=True)
class ResolvedChart:
    """A chart with its data read, ready to draw into a zone. ``error`` (a missing
    file, a column that is not there) is drawn in the chart's place."""

    chart: Chart
    table: Table | None
    error: str | None = None


def resolve(chart: Chart, source: AssetSource) -> ResolvedChart:
    """Read a chart's data; a file name resolves against the file it is written in."""
    if chart.data is not None:
        return ResolvedChart(chart, Table.from_columns(chart.data))
    src = chart.src or ""
    if not is_local_ref(src):
        return _failed(chart, source, f"charts read local files only: {src}")
    path = source.roots.locate(source.ref(src))
    if path is None or not path.is_file():
        return _failed(chart, source, f"chart data not found: {src}")
    try:
        return ResolvedChart(chart, read_table(path))
    except (ChartError, OSError, UnicodeDecodeError, csv.Error) as exc:
        return _failed(chart, source, f"{src}: {exc}")


def _failed(chart: Chart, source: AssetSource, message: str) -> ResolvedChart:
    logger.warning(f"{source.label}: {message}")
    return ResolvedChart(chart, None, message)


# ── Number formatting and axis ticks ──────────────────────────────────────────


def nice_ticks(lo: float, hi: float, count: int = 5) -> list[float]:
    """Round tick values spanning ``lo``..``hi``: about ``count`` steps of 1, 2 or
    5 times a power of ten, the first at or below ``lo``, the last at or above
    ``hi``."""
    if not (math.isfinite(lo) and math.isfinite(hi)):
        return [0.0, 1.0]
    if hi < lo:
        lo, hi = hi, lo
    if hi == lo:
        pad = abs(lo) * 0.5 or 1.0
        lo, hi = (lo - pad, hi + pad) if lo != 0 else (0.0, 1.0)
    step = nice_step((hi - lo) / max(1, count))
    start = math.floor(lo / step + 1e-9) * step
    end = math.ceil(hi / step - 1e-9) * step
    n = round((end - start) / step)
    return [_clean(start + i * step) for i in range(n + 1)]


def nice_step(raw: float) -> float:
    """The round step nearest ``raw``: 1, 2 or 5 times a power of ten."""
    magnitude = 10.0 ** math.floor(math.log10(raw))
    norm = raw / magnitude
    for limit, m in ((1.5, 1.0), (3.0, 2.0), (7.0, 5.0)):
        if norm < limit:
            return m * magnitude
    return 10.0 * magnitude


def _clean(value: float) -> float:
    """Drop floating-point noise (``0.30000000000000004``) from a tick."""
    cleaned = float(f"{value:.12g}")
    return 0.0 if cleaned == 0 else cleaned


_UNITS = ((1e9, "B"), (1e6, "M"), (1e3, "K"))


def _trim(text: str) -> str:
    return text.rstrip("0").rstrip(".") if "." in text else text


def format_tick(value: float, ticks: Sequence[float]) -> str:
    """A tick label: as many decimals as the step needs, ``20K``/``1.5M`` once the
    axis reaches ten thousand."""
    step = abs(ticks[1] - ticks[0]) if len(ticks) > 1 else abs(value) or 1.0
    top = max(abs(t) for t in ticks)
    unit, suffix = 1.0, ""
    for limit, name in _UNITS:
        if top >= max(limit, 1e4):
            unit, suffix = limit, name
            break
    decimals = max(0, -math.floor(math.log10(step / unit) + 1e-9))
    return _trim(f"{value / unit:,.{decimals}f}") + suffix


def format_value(value: float) -> str:
    """A value written at its mark: compact from a million, else in full."""
    for limit, suffix in _UNITS[:2]:
        if abs(value) >= limit:
            return _trim(f"{value / limit:.1f}") + suffix
    if float(value).is_integer():
        return f"{value:,.0f}"
    return _trim(f"{value:,.2f}")


def _category(value: Cell) -> str:
    return cell_text(value) if value is not None else ""


# ── Drawing ───────────────────────────────────────────────────────────────────

_SERIES_ORDER = ("blue", "orange", "green", "purple", "red", "teal", "yellow", "pink")
PALETTE = [
    token
    for token in _SERIES_ORDER
    if token in SVG_TOKENS[SVG_TOKENS.index("red") : SVG_TOKENS.index("grey")]
]
"""The theme's chromatic tokens in the order series take them: neighbours far
apart in hue, so adjacent series stay distinct."""

TEXT = "var(--inkflow-text)"
MUTED = "var(--inkflow-text-muted)"
GRID = "var(--inkflow-border)"
SURFACE = "var(--inkflow-bg)"
ON_COLOUR = "var(--inkflow-accent-fg)"

ZONE_TEXT_SCALE = 0.6
"""A chart's text size in a zone, relative to the slide's body text size."""

FENCE_WIDTH = 960.0
"""The width a Markdown chart is drawn at; it then scales to its zone's width."""
FENCE_FONT = 22.0
"""Its text size: about a chart zone's with the default body size, once drawn in
a zone about as wide as ``FENCE_WIDTH``."""


def colour(index: int) -> str:
    return f"var(--inkflow-{PALETTE[index % len(PALETTE)]})"


def slug(name: str) -> str:
    return re.sub(r"[^\w]+", "-", name.lower()).strip("-_") or "item"


def _n(value: float) -> str:
    return _trim(f"{value:.2f}")


def _text_width(text: str, size: float) -> float:
    """A rough rendered width: no font metrics at build time, so wide enough
    for the theme's sans fonts and only used to keep labels apart."""
    wide = sum(1 for c in text if c.isupper() or c in "MWmw@%")
    narrow = sum(1 for c in text if c in "il.,:;|!'1 ")
    return size * (0.56 * len(text) + 0.14 * wide - 0.24 * narrow)


def _style(**props: str | float) -> str:
    return ";".join(f"{k.replace('_', '-')}:{v}" for k, v in props.items())


class _Svg:
    """Builds the chart's elements; every number is written rounded."""

    root: SvgElement

    def __init__(self, root: SvgElement) -> None:
        self.root = root

    def el(self, parent: SvgElement, tag: str, **attrs: str | float) -> SvgElement:
        node = etree.SubElement(parent, f"{{{ns.SVG}}}{tag}")
        for key, value in attrs.items():
            name = key.rstrip("_").replace("_", "-")
            node.set(name, _n(value) if isinstance(value, float | int) else value)
        return node

    def group(self, parent: SvgElement, cls: str, gid: str | None = None) -> SvgElement:
        g = self.el(parent, "g", class_=cls)
        if gid is not None:
            g.set("id", gid)
        return g

    def text(
        self,
        parent: SvgElement,
        x: float,
        y: float,
        content: str,
        size: float,
        fill: str = MUTED,
        anchor: str = "middle",
        weight: str | None = None,
    ) -> SvgElement:
        node = self.el(parent, "text", x=x, y=y, font_size=size, text_anchor=anchor)
        node.set(
            "style", _style(fill=fill, **({"font_weight": weight} if weight else {}))
        )
        node.text = content
        return node


@dataclass
class _Series:
    name: str
    values: list[float | None]
    colour: str
    gid: str
    group: SvgElement | None = None
    axis: int = 1
    """1: the value axis on the left; 2: the second one, on the right."""
    label: str = ""
    """The legend's text (the name, marked when on the right axis)."""


@dataclass
class _Frame:
    """The space left for the plot once title and legend are placed."""

    left: float
    top: float
    right: float
    bottom: float
    font: float
    labels: list[str] = field(default_factory=list)

    @property
    def width(self) -> float:
        return self.right - self.left

    @property
    def height(self) -> float:
        return self.bottom - self.top


def default_font_size(width: float, height: float) -> float:
    return max(10.0, min(40.0, width / 55, height / 28))


def render(
    resolved: ResolvedChart,
    width: float,
    height: float,
    chart_id: str,
    font_size: float | None = None,
) -> SvgElement:
    """The chart as an ``<svg>`` whose user units are ``width`` by ``height``."""
    width = max(width, 1.0)
    height = max(height, 1.0)
    f = font_size if font_size is not None else default_font_size(width, height)
    root = etree.Element(
        f"{{{ns.SVG}}}svg",
        nsmap={None: ns.SVG},  # pyright: ignore[reportArgumentType]
    )
    root.set("viewBox", f"0 0 {_n(width)} {_n(height)}")
    root.set("class", "inkflow-chart")
    root.set("overflow", "visible")
    root.set("role", "img")
    chart = resolved.chart
    root.set("aria-label", chart.title or "Chart")
    root.set("style", "font-family:var(--inkflow-body-font)")
    svg = _Svg(root)
    try:
        if resolved.table is None:
            raise ChartError(resolved.error or "no data")
        _draw(svg, chart, resolved.table, width, height, f, chart_id)
    except ChartError as exc:
        for child in list(root):
            root.remove(child)
        _message(svg, width, height, f, str(exc))
    return root


def _message(svg: _Svg, width: float, height: float, f: float, text: str) -> None:
    inset = min(2.0, width / 4, height / 4)
    box = svg.el(
        svg.root,
        "rect",
        x=inset,
        y=inset,
        width=width - 2 * inset,
        height=height - 2 * inset,
        rx=f * 0.4,
    )
    box.set(
        "style",
        _style(fill="none", stroke=GRID, stroke_width=2, stroke_dasharray="8 6"),
    )
    svg.text(svg.root, width / 2, height / 2 + f * 0.35, text, f * 0.8)


def _draw(
    svg: _Svg,
    chart: Chart,
    table: Table,
    width: float,
    height: float,
    f: float,
    chart_id: str,
) -> None:
    if not table.columns:
        raise ChartError("the data has no columns")
    x = chart.x if chart.x is not None else table.columns[0]
    if x not in table.columns:
        raise ChartError(f"no column {x!r} in the data")
    ys = list(
        chart.y
        if chart.y is not None
        else [c for c in table.columns if c != x and table.is_numeric(c)]
    )
    right = list(chart.y2 or []) if chart.kind != ChartKind.PIE else []
    # A column on the right axis is plotted whether or not y names it.
    ys += [c for c in right if c not in ys]
    if right and chart.stacked and chart.kind in (ChartKind.BAR, ChartKind.AREA):
        raise ChartError("a second axis needs the series side by side, not stacked")
    if right and chart.horizontal and chart.kind == ChartKind.BAR:
        raise ChartError("a second axis needs upright bars, not horizontal ones")
    if right and len(right) == len(ys):
        raise ChartError("y2 takes some of the series, not all of them")
    for name in ys:
        if name not in table.columns:
            raise ChartError(f"no column {name!r} in the data")
    if not ys:
        raise ChartError("no numeric column to plot")
    if not table.rows:
        raise ChartError("the data has no rows")
    categories = [_category(v) for v in table.column(x)]
    taken: set[str] = set()

    def unique(base: str) -> str:
        gid, n = base, 2
        while gid in taken:
            gid = f"{base}-{n}"
            n += 1
        taken.add(gid)
        return gid

    if chart.kind == ChartKind.PIE:
        values = [v if isinstance(v, float) else None for v in table.column(ys[0])]
        slices = [
            _Series(
                cat,
                [value],
                colour(i),
                unique(f"{chart_id}-slice-{slug(cat)}"),
            )
            for i, (cat, value) in enumerate(zip(categories, values, strict=True))
        ]
        frame = _layout(svg, chart, slices, width, height, f, legend_default=True)
        _pie(svg, chart, slices, frame)
        return
    series = [
        _Series(
            name,
            [v if isinstance(v, float) else None for v in table.column(name)],
            colour(i),
            unique(f"{chart_id}-series-{slug(name)}"),
            axis=2 if name in right else 1,
            label=f"{name} (right)" if name in right else name,
        )
        for i, name in enumerate(ys)
    ]
    frame = _layout(
        svg, chart, series, width, height, f, legend_default=len(series) > 1
    )
    if chart.kind == ChartKind.SCATTER:
        xs = table.column(x)
        if not all(isinstance(v, float) or v is None for v in xs):
            raise ChartError(f"a scatter chart needs numbers in {x!r}")
        _scatter(
            svg, chart, series, [v if isinstance(v, float) else None for v in xs], frame
        )
    elif chart.kind == ChartKind.BAR:
        _bars(svg, chart, series, categories, frame)
    else:
        _lines(svg, chart, series, categories, frame)


def _layout(
    svg: _Svg,
    chart: Chart,
    series: list[_Series],
    width: float,
    height: float,
    f: float,
    legend_default: bool,
) -> _Frame:
    """Draw the title and the legend, and give each series its group."""
    pad = f * 0.5
    top = pad
    if chart.title:
        size = f * 1.25
        svg.text(svg.root, width / 2, top + size, chart.title, size, TEXT, weight="600")
        top += size * 1.7
    plots = svg.group(svg.root, "inkflow-chart-plot")
    for s in series:
        s.group = svg.group(plots, "inkflow-chart-series", s.gid)
    show = chart.legend if chart.legend is not None else legend_default
    if show:
        top = _legend(svg, chart, series, width, top, f) + f * 0.4
    return _Frame(pad, top, width - pad, height - pad, f)


def _legend(
    svg: _Svg, chart: Chart, series: list[_Series], width: float, top: float, f: float
) -> float:
    """Swatch-and-name entries centred in rows; returns where they end."""
    size = f * 0.85
    swatch = f * 0.8
    gap = f * 1.2
    entries = [
        (s, swatch + f * 0.4 + _text_width(s.label or s.name, size)) for s in series
    ]
    rows: list[list[tuple[_Series, float]]] = [[]]
    used = 0.0
    for entry in entries:
        need = entry[1] + (gap if rows[-1] else 0)
        if rows[-1] and used + need > width - f:
            rows.append([])
            used, need = 0.0, entry[1]
        rows[-1].append(entry)
        used += need
    line = f * 1.5
    for r, row in enumerate(rows):
        total = sum(w for _, w in row) + gap * (len(row) - 1)
        x = (width - total) / 2
        cy = top + line * r + line / 2
        for s, w in row:
            assert s.group is not None
            g = svg.group(s.group, "inkflow-chart-legend")
            if chart.kind in (ChartKind.LINE, ChartKind.SCATTER):
                mark = svg.el(g, "circle", cx=x + swatch / 2, cy=cy, r=swatch * 0.32)
            else:
                mark = svg.el(
                    g,
                    "rect",
                    x=x,
                    y=cy - swatch / 2,
                    width=swatch,
                    height=swatch,
                    rx=swatch * 0.2,
                )
            mark.set("style", _style(fill=s.colour))
            if chart.kind == ChartKind.LINE:
                stroke = svg.el(g, "line", x1=x, y1=cy, x2=x + swatch, y2=cy)
                stroke.set("style", _style(stroke=s.colour, stroke_width=f * 0.12))
            svg.text(
                g,
                x + swatch + f * 0.4,
                cy + size * 0.35,
                s.label or s.name,
                size,
                TEXT,
                "start",
            )
            x += w + gap
    return top + line * len(rows)


# ── Cartesian charts ──


def _domain(
    chart: Chart, every: list[_Series], categories: int, axis: int = 1
) -> list[float]:
    """The value axis ticks: bars and areas always include zero (their marks
    grow from it), lines and dots span their data. ``y_min``/``y_max`` (or
    ``y2_min``/``y2_max`` for the right axis) fix the ends instead: they are
    the first and last ticks, the round steps between kept."""
    series = [s for s in every if s.axis == axis]
    stacked = chart.stacked and chart.kind in (ChartKind.BAR, ChartKind.AREA)
    if stacked:
        highs = [
            sum(max(0.0, s.values[i] or 0.0) for s in series) for i in range(categories)
        ]
        lows = [
            sum(min(0.0, s.values[i] or 0.0) for s in series) for i in range(categories)
        ]
        lo, hi = min(lows, default=0.0), max(highs, default=0.0)
    else:
        values = [v for s in series for v in s.values if v is not None]
        if not values:
            raise ChartError("no numbers to plot")
        lo, hi = min(values), max(values)
    if chart.kind in (ChartKind.BAR, ChartKind.AREA):
        lo, hi = min(lo, 0.0), max(hi, 0.0)
    fixed_lo, fixed_hi = (
        (chart.y_min, chart.y_max) if axis == 1 else (chart.y2_min, chart.y2_max)
    )
    return _bounded(lo, hi, fixed_lo, fixed_hi)


def _bounded(
    lo: float, hi: float, fixed_lo: float | None, fixed_hi: float | None
) -> list[float]:
    """Round ticks from ``lo`` to ``hi``, with either end fixed where given."""
    if fixed_lo is not None:
        lo = fixed_lo
    if fixed_hi is not None:
        hi = fixed_hi
    if hi <= lo:  # one end fixed beyond all the data
        if fixed_hi is None:
            hi = lo + (abs(lo) or 1.0)
        else:
            lo = hi - (abs(hi) or 1.0)
    ticks = nice_ticks(lo, hi)
    step = ticks[1] - ticks[0] if len(ticks) > 1 else hi - lo
    # An end's own label, the round ticks too close to it dropped.
    if fixed_lo is not None:
        ticks = [fixed_lo] + [t for t in ticks if t > fixed_lo + step * 0.35]
    if fixed_hi is not None:
        ticks = [t for t in ticks if t < fixed_hi - step * 0.35] + [fixed_hi]
    return ticks


def _scale(
    ticks: list[float], frame: _Frame, horizontal: bool
) -> Callable[[float], float]:
    """A value's position along the value axis these ticks span."""
    lo, hi = ticks[0], ticks[-1]

    def pos(v: float) -> float:
        t = (v - lo) / (hi - lo)
        return (
            frame.left + t * frame.width
            if horizontal
            else frame.bottom - t * frame.height
        )

    return pos


def _right_axis(svg: _Svg, axes: SvgElement, ticks: list[float], frame: _Frame) -> None:
    """The second value axis: tick labels along the plot's right edge (the
    gridlines are the left axis's)."""
    f = frame.font
    size = f * 0.8
    pos = _scale(ticks, frame, False)
    hair = max(1.0, f * 0.05)
    edge = svg.el(
        axes, "line", x1=frame.right, y1=frame.top, x2=frame.right, y2=frame.bottom
    )
    edge.set("style", _style(stroke=GRID, stroke_width=hair))
    for t in ticks:
        p = pos(t)
        mark = svg.el(
            axes, "line", x1=frame.right, y1=p, x2=frame.right + f * 0.25, y2=p
        )
        mark.set("style", _style(stroke=MUTED, stroke_width=hair))
        svg.text(
            axes,
            frame.right + f * 0.4,
            p + size * 0.35,
            format_tick(t, ticks),
            size,
            anchor="start",
        )


def _clipped(chart: Chart) -> bool:
    """Whether a fixed axis end can leave values outside the plot."""
    return any(
        v is not None for v in (chart.y_min, chart.y_max, chart.y2_min, chart.y2_max)
    )


def _marks(
    svg: _Svg, s: _Series, chart: Chart, frame: _Frame, horizontal: bool = False
) -> SvgElement:
    """A series' marks; cut off at the plot when an axis end is fixed (a value
    past it would otherwise be drawn over the labels)."""
    assert s.group is not None
    marks = svg.group(s.group, "inkflow-chart-marks")
    if not _clipped(chart):
        return marks
    clip_id = f"{_chart_id([s])}-clip"
    if svg.root.find(f".//*[@id='{clip_id}']") is None:
        defs = svg.root.find(f"{{{ns.SVG}}}defs")
        if defs is None:
            defs = etree.Element(f"{{{ns.SVG}}}defs")
            svg.root.insert(0, defs)
        clip = svg.el(defs, "clipPath", id=clip_id)
        # Room along the categories (end dots); the value axis cut exactly
        # but for a mark's own width.
        f = frame.font
        pad_v, pad_c = f * 0.3, f * 1.5
        if horizontal:
            svg.el(
                clip,
                "rect",
                x=frame.left - pad_v,
                y=frame.top - pad_c,
                width=frame.width + 2 * pad_v,
                height=frame.height + 2 * pad_c,
            )
        else:
            svg.el(
                clip,
                "rect",
                x=frame.left - pad_c,
                y=frame.top - pad_v,
                width=frame.width + 2 * pad_c,
                height=frame.height + 2 * pad_v,
            )
    marks.set("clip-path", f"url(#{clip_id})")
    return marks


def _value_axis(
    svg: _Svg,
    ticks: list[float],
    frame: _Frame,
    horizontal: bool,
    chart_id: str,
) -> tuple[SvgElement, float]:
    """Gridlines and tick labels; returns the axes group and the zero position."""
    f = frame.font
    axes = svg.group(svg.root, "inkflow-chart-axes", f"{chart_id}-axes")
    svg.root.insert(0, axes)  # beneath the marks
    axes.set("style", "font-variant-numeric:tabular-nums")
    lo, hi = ticks[0], ticks[-1]
    size = f * 0.8
    hair = max(1.0, f * 0.05)

    def pos(v: float) -> float:
        t = (v - lo) / (hi - lo)
        return (
            frame.left + t * frame.width
            if horizontal
            else frame.bottom - t * frame.height
        )

    for t in ticks:
        p = pos(t)
        zero = t == 0
        if horizontal:
            line = svg.el(axes, "line", x1=p, y1=frame.top, x2=p, y2=frame.bottom)
            svg.text(axes, p, frame.bottom + size * 1.3, format_tick(t, ticks), size)
        else:
            line = svg.el(axes, "line", x1=frame.left, y1=p, x2=frame.right, y2=p)
            svg.text(
                axes,
                frame.left - f * 0.4,
                p + size * 0.35,
                format_tick(t, ticks),
                size,
                anchor="end",
            )
        line.set(
            "style",
            _style(
                stroke=MUTED if zero else GRID, stroke_width=hair * (1.5 if zero else 1)
            ),
        )
    zero = pos(min(max(0.0, lo), hi))
    return axes, zero


def _plot_frame(
    frame: _Frame,
    ticks: list[float],
    categories: list[str],
    horizontal: bool,
    ticks2: list[float] | None = None,
) -> None:
    """Make room for tick labels (left, and right for a second axis) and
    category labels (below or left)."""
    f = frame.font
    size = f * 0.8
    if ticks2:
        frame.right -= (
            max(_text_width(format_tick(t, ticks2), size) for t in ticks2) + f * 0.6
        )
    if horizontal:
        widest = max((_text_width(c, size) for c in categories), default=0.0)
        frame.left += min(widest, frame.width * 0.35) + f * 0.5
        frame.bottom -= size * 1.6
        # The last tick's label is centred on the plot's right edge.
        frame.right -= _text_width(format_tick(ticks[-1], ticks), size) / 2
    else:
        widest = max(_text_width(format_tick(t, ticks), size) for t in ticks)
        frame.left += widest + f * 0.5
        frame.bottom -= size * 1.7
        # The last category's label is centred on its band, inside the frame.
        frame.right -= f * 0.2
    if frame.width <= f or frame.height <= f:
        raise ChartError("too small to draw")


def _category_labels(
    svg: _Svg,
    axes: SvgElement,
    categories: list[str],
    frame: _Frame,
    horizontal: bool,
    points: bool,
) -> None:
    """Category names along the band axis, thinned out where they would collide."""
    f = frame.font
    size = f * 0.8
    n = len(categories)
    span = frame.height if horizontal else frame.width
    band = span / max(1, n - 1 if points and n > 1 else n)
    need = (
        size * 1.4
        if horizontal
        else max(_text_width(c, size) for c in categories) + f * 0.6
    )
    every = max(1, math.ceil(need / band)) if band > 0 else n
    for i in range(0, n, every):
        c = _band_centre(i, n, span, points) + (frame.top if horizontal else frame.left)
        if horizontal:
            svg.text(
                axes,
                frame.left - f * 0.4,
                c + size * 0.35,
                categories[i],
                size,
                anchor="end",
            )
        else:
            svg.text(axes, c, frame.bottom + size * 1.3, categories[i], size)


def _band_centre(i: int, n: int, span: float, points: bool) -> float:
    """Where category ``i`` of ``n`` sits along ``span``: band centres for bars,
    evenly spread end to end for lines."""
    if points:
        return span / 2 if n == 1 else span * i / (n - 1)
    return span * (i + 0.5) / n


def _bar_path(
    along: float, thick: float, base: float, end: float, r: float, horizontal: bool
) -> str:
    """A bar from ``base`` to ``end`` with its data end rounded, square at the base."""
    r = min(r, thick / 2, abs(end - base))
    d = 1.0 if end > base else -1.0
    if horizontal:
        y, h = along, thick
        return (
            f"M{_n(base)} {_n(y)}H{_n(end - d * r)}"
            + f"Q{_n(end)} {_n(y)} {_n(end)} {_n(y + r)}"
            + f"V{_n(y + h - r)}Q{_n(end)} {_n(y + h)} {_n(end - d * r)} {_n(y + h)}"
            + f"H{_n(base)}Z"
        )
    x, w = along, thick
    return (
        f"M{_n(x)} {_n(base)}V{_n(end - d * r)}Q{_n(x)} {_n(end)} {_n(x + r)} {_n(end)}"
        + f"H{_n(x + w - r)}Q{_n(x + w)} {_n(end)} {_n(x + w)} {_n(end - d * r)}"
        + f"V{_n(base)}Z"
    )


def _bars(
    svg: _Svg, chart: Chart, series: list[_Series], categories: list[str], frame: _Frame
) -> None:
    horizontal = chart.horizontal
    n = len(categories)
    ticks = _domain(chart, series, n)
    ticks2 = _domain(chart, series, n, 2) if any(s.axis == 2 for s in series) else None
    _plot_frame(frame, ticks, categories, horizontal, ticks2)
    axes, zero = _value_axis(svg, ticks, frame, horizontal, _chart_id(series))
    if ticks2:
        _right_axis(svg, axes, ticks2, frame)
    _category_labels(svg, axes, categories, frame, horizontal, points=False)
    f = frame.font
    span = frame.height if horizontal else frame.width
    band = span / n
    gap = max(2.0, f * 0.1)
    cap = f * 4
    k = 1 if chart.stacked else len(series)
    thick = min((band * 0.72 - gap * (k - 1)) / k, cap)
    if thick <= 0:
        raise ChartError("too many bars for the space")
    group = thick * k + gap * (k - 1)
    radius = f * 0.25
    size = f * 0.75
    scales = {1: _scale(ticks, frame, horizontal)}
    zeros = {1: zero}
    if ticks2:
        scales[2] = _scale(ticks2, frame, horizontal)
        zeros[2] = scales[2](min(max(0.0, ticks2[0]), ticks2[-1]))

    up = [0.0] * n
    down = [0.0] * n
    for si, s in enumerate(series):
        pos = scales[s.axis]
        marks = _marks(svg, s, chart, frame, horizontal)
        for i, value in enumerate(s.values):
            if value is None:
                continue
            start = (
                (frame.top if horizontal else frame.left)
                + band * i
                + (band - group) / 2
            )
            along = start if chart.stacked else start + si * (thick + gap)
            if chart.stacked:
                stack = up if value >= 0 else down
                v0, v1 = stack[i], stack[i] + value
                stack[i] = v1
                base, end = pos(v0), pos(v1)
                if v0 != 0:  # the surface gap between segments
                    base += gap if (end > base) else -gap
                    if (end - base) * (1 if value >= 0 else -1) * (
                        1 if horizontal else -1
                    ) < 0:
                        continue
                top_segment = all(
                    (o.values[i] or 0) == 0 or (o.values[i] or 0) * value < 0
                    for o in series[si + 1 :]
                )
                r = radius if top_segment else 0.0
            else:
                base, end = zeros[s.axis], pos(value)
                r = radius
            bar = svg.el(
                marks, "path", d=_bar_path(along, thick, base, end, r, horizontal)
            )
            bar.set("style", _style(fill=s.colour))
            if not chart.labels:
                continue
            text = format_value(value)
            mid = along + thick / 2
            if chart.stacked:
                length = abs(end - base)
                fits = length > (
                    _text_width(text, size) + f * 0.6 if horizontal else size * 1.5
                )
                if not fits:
                    continue
                c = (base + end) / 2
                if horizontal:
                    svg.text(marks, c, mid + size * 0.35, text, size, ON_COLOUR)
                else:
                    svg.text(marks, mid, c + size * 0.35, text, size, ON_COLOUR)
            elif horizontal:
                ahead = f * 0.3 if end >= base else -f * 0.3
                svg.text(
                    marks,
                    end + ahead,
                    mid + size * 0.35,
                    text,
                    size,
                    TEXT,
                    "start" if end >= base else "end",
                )
            else:
                y = end - f * 0.35 if end <= base else end + size * 1.1
                svg.text(marks, mid, y, text, size, TEXT)


def _chart_id(series: list[_Series]) -> str:
    gid = series[0].gid if series else "chart"
    for marker in ("-series-", "-slice-"):
        if marker in gid:
            return gid.rsplit(marker, 1)[0]
    return gid


def _lines(
    svg: _Svg, chart: Chart, series: list[_Series], categories: list[str], frame: _Frame
) -> None:
    n = len(categories)
    ticks = _domain(chart, series, n)
    ticks2 = _domain(chart, series, n, 2) if any(s.axis == 2 for s in series) else None
    _plot_frame(frame, ticks, categories, horizontal=False, ticks2=ticks2)
    # Lines run end to end: room for the first and last labels' halves.
    edge = min(
        frame.width * 0.15,
        max(
            _text_width(categories[0], frame.font * 0.8),
            _text_width(categories[-1], frame.font * 0.8),
        )
        / 2,
    )
    frame.left += edge
    frame.right -= edge
    axes, _ = _value_axis(svg, ticks, frame, False, _chart_id(series))
    if ticks2:
        _right_axis(svg, axes, ticks2, frame)
    _category_labels(svg, axes, categories, frame, False, points=True)
    f = frame.font
    all_ticks = {1: ticks, 2: ticks2 or ticks}
    area = chart.kind == ChartKind.AREA
    stacked = area and chart.stacked
    stroke = max(2.0, f * 0.12)
    dot = max(4.0, f * 0.22)
    size = f * 0.75

    xs = [frame.left + _band_centre(i, n, frame.width, True) for i in range(n)]
    below = [0.0] * n
    for s in series:
        y_of = _scale(all_ticks[s.axis], frame, False)
        lo, hi = all_ticks[s.axis][0], all_ticks[s.axis][-1]
        marks = _marks(svg, s, chart, frame)
        if stacked:
            tops = [below[i] + (s.values[i] or 0.0) for i in range(n)]
            runs = [list(range(n))]
            bases = list(below)
            below = tops
            points = [(xs[i], y_of(tops[i])) for i in range(n)]
        else:
            runs = _runs(s.values)
            bases = [min(max(0.0, lo), hi)] * n
            points = [
                (xs[i], y_of(v)) if v is not None else (xs[i], 0.0)
                for i, v in enumerate(s.values)
            ]
        for run in runs:
            line = " ".join(f"{_n(points[i][0])},{_n(points[i][1])}" for i in run)
            if area:
                floor = " ".join(
                    f"{_n(xs[i])},{_n(y_of(bases[i]))}" for i in reversed(run)
                )
                fill = svg.el(marks, "polygon", points=f"{line} {floor}")
                fill.set(
                    "style",
                    _style(fill=s.colour, fill_opacity=0.22 if not stacked else 0.55),
                )
            path = svg.el(marks, "polyline", points=line)
            path.set(
                "style",
                _style(
                    fill="none",
                    stroke=s.colour,
                    stroke_width=stroke,
                    stroke_linejoin="round",
                    stroke_linecap="round",
                ),
            )
        shown = [i for i in range(n) if stacked or s.values[i] is not None]
        if not area and len(shown) <= 24:
            for i in shown:
                marker = svg.el(
                    marks, "circle", cx=points[i][0], cy=points[i][1], r=dot
                )
                marker.set(
                    "style", _style(fill=s.colour, stroke=SURFACE, stroke_width=stroke)
                )
        if chart.labels:
            for i in shown:
                value = s.values[i]
                if value is None:
                    continue
                svg.text(
                    marks,
                    points[i][0],
                    points[i][1] - dot - f * 0.35,
                    format_value(value),
                    size,
                    TEXT,
                )


def _runs(values: list[float | None]) -> list[list[int]]:
    """Indices of the unbroken stretches between missing values."""
    runs: list[list[int]] = []
    current: list[int] = []
    for i, v in enumerate(values):
        if v is None:
            if current:
                runs.append(current)
            current = []
        else:
            current.append(i)
    if current:
        runs.append(current)
    return runs


def _scatter(
    svg: _Svg,
    chart: Chart,
    series: list[_Series],
    xs: list[float | None],
    frame: _Frame,
) -> None:
    present = [v for v in xs if v is not None]
    if not present:
        raise ChartError("no numbers to plot")
    xticks = nice_ticks(min(present), max(present))
    yticks = _domain(chart, series, len(xs))
    yticks2 = (
        _domain(chart, series, len(xs), 2) if any(s.axis == 2 for s in series) else None
    )
    f = frame.font
    size = f * 0.8
    _plot_frame(frame, yticks, [], horizontal=False, ticks2=yticks2)
    if not yticks2:
        frame.right -= _text_width(format_tick(xticks[-1], xticks), size) / 2
    axes, _ = _value_axis(svg, yticks, frame, False, _chart_id(series))
    if yticks2:
        _right_axis(svg, axes, yticks2, frame)
    x0, x1 = xticks[0], xticks[-1]
    scales = {1: _scale(yticks, frame, False)}
    if yticks2:
        scales[2] = _scale(yticks2, frame, False)

    def px(v: float) -> float:
        return frame.left + (v - x0) / (x1 - x0) * frame.width

    hair = max(1.0, f * 0.05)
    for t in xticks:
        line = svg.el(axes, "line", x1=px(t), y1=frame.top, x2=px(t), y2=frame.bottom)
        line.set("style", _style(stroke=GRID, stroke_width=hair))
        svg.text(axes, px(t), frame.bottom + size * 1.3, format_tick(t, xticks), size)
    r = max(4.0, f * 0.3)
    for s in series:
        py = scales[s.axis]
        marks = _marks(svg, s, chart, frame)
        for xv, yv in zip(xs, s.values, strict=True):
            if xv is None or yv is None:
                continue
            dot = svg.el(marks, "circle", cx=px(xv), cy=py(yv), r=r)
            dot.set(
                "style",
                _style(
                    fill=s.colour,
                    fill_opacity=0.85,
                    stroke=SURFACE,
                    stroke_width=max(1.5, f * 0.08),
                ),
            )
            if chart.labels:
                svg.text(
                    marks, px(xv), py(yv) - r - f * 0.3, format_value(yv), f * 0.7, TEXT
                )


# ── Pie ──


def _pie(svg: _Svg, chart: Chart, slices: list[_Series], frame: _Frame) -> None:
    values = [s.values[0] for s in slices]
    total = sum(v for v in values if v is not None and v > 0)
    if total <= 0:
        raise ChartError("a pie needs positive numbers")
    f = frame.font
    r = min(frame.width, frame.height) / 2
    if r <= f:
        raise ChartError("too small to draw")
    cx = frame.left + frame.width / 2
    cy = frame.top + frame.height / 2
    inner = r * 0.58 if chart.donut else 0.0
    angle = -math.pi / 2
    size = f * 0.8
    for s, value in zip(slices, values, strict=True):
        assert s.group is not None
        if value is None or value <= 0:
            continue
        sweep = value / total * 2 * math.pi
        marks = svg.group(s.group, "inkflow-chart-marks")
        wedge = svg.el(marks, "path", d=_wedge(cx, cy, r, inner, angle, sweep))
        wedge.set(
            "style",
            _style(
                fill=s.colour,
                stroke=SURFACE,
                stroke_width=max(2.0, f * 0.1),
                stroke_linejoin="round",
            ),
        )
        if chart.labels and sweep > 0.3:
            mid = angle + sweep / 2
            at = (r + inner) / 2 if inner else r * 0.62
            share = value / total * 100
            text = f"{share:.0f}%" if share >= 1 else "<1%"
            svg.text(
                marks,
                cx + at * math.cos(mid),
                cy + at * math.sin(mid) + size * 0.35,
                text,
                size,
                ON_COLOUR,
                weight="600",
            )
        angle += sweep


def _wedge(
    cx: float, cy: float, r: float, inner: float, start: float, sweep: float
) -> str:
    """A pie slice (or a donut's ring segment) as path data."""
    if sweep >= 2 * math.pi - 1e-9:
        # A whole circle: two half arcs (one arc cannot end where it starts).
        outer = (
            f"M{_n(cx)} {_n(cy - r)}A{_n(r)} {_n(r)} 0 1 1 {_n(cx)} {_n(cy + r)}"
            + f"A{_n(r)} {_n(r)} 0 1 1 {_n(cx)} {_n(cy - r)}Z"
        )
        if not inner:
            return outer
        return (
            outer
            + f"M{_n(cx)} {_n(cy - inner)}"
            + f"A{_n(inner)} {_n(inner)} 0 1 0 {_n(cx)} {_n(cy + inner)}"
            + f"A{_n(inner)} {_n(inner)} 0 1 0 {_n(cx)} {_n(cy - inner)}Z"
        )
    end = start + sweep
    large = 1 if sweep > math.pi else 0

    def at(radius: float, a: float) -> str:
        return f"{_n(cx + radius * math.cos(a))} {_n(cy + radius * math.sin(a))}"

    outer = f"M{at(r, start)}A{_n(r)} {_n(r)} 0 {large} 1 {at(r, end)}"
    if not inner:
        return f"{outer}L{_n(cx)} {_n(cy)}Z"
    back = f"A{_n(inner)} {_n(inner)} 0 {large} 0 {at(inner, start)}"
    return f"{outer}L{at(inner, end)}{back}Z"


# ── Markdown ``chart`` fences ─────────────────────────────────────────────────

_TRUE = frozenset({"true", "yes", "on", "1"})
_FENCE_KEYS = frozenset(
    {
        "kind",
        "x",
        "y",
        "title",
        "stacked",
        "horizontal",
        "labels",
        "legend",
        "donut",
        "data",
        "id",
        "aspect",
        "y_min",
        "y_max",
        "y2",
        "y2_min",
        "y2_max",
    }
)


def _float_option(options: dict[str, str], key: str) -> float | None:
    text = options.get(key, "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        raise ChartError(f"{key} {text!r} is not a number") from None


def _list_option(options: dict[str, str], key: str) -> list[str] | None:
    text = options.get(key)
    return [c.strip() for c in text.split(",") if c.strip()] if text else None


@dataclass(frozen=True)
class FenceChart:
    chart: Chart
    id: str | None
    aspect: float


def parse_fence(body: str) -> FenceChart:
    """A fence's ``key: value`` option lines, and its Markdown table if any."""
    options: dict[str, str] = {}
    table_lines: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("|"):
            table_lines.append(stripped)
            continue
        key, sep, value = stripped.partition(":")
        key = key.strip().lower().replace("-", "_")
        if not sep or key not in _FENCE_KEYS:
            raise ChartError(f"unknown chart option {stripped!r}")
        options[key] = value.strip()
    try:
        kind = ChartKind(options.get("kind", "bar").lower())
    except ValueError:
        raise ChartError(f"unknown chart kind {options['kind']!r}") from None
    legend = options.get("legend")
    table = parse_markdown_table("\n".join(table_lines)) if table_lines else None
    if table is None and not options.get("data"):
        raise ChartError("a chart needs data: <file> or a Markdown table")
    chart = Chart(
        src=None if table is not None else options["data"],
        data=table.to_columns() if table is not None else None,
        kind=kind,
        x=options.get("x") or None,
        y=_list_option(options, "y"),
        title=options.get("title") or None,
        stacked=options.get("stacked", "").lower() in _TRUE,
        horizontal=options.get("horizontal", "").lower() in _TRUE,
        labels=options.get("labels", "").lower() in _TRUE,
        legend=None if legend is None else legend.lower() in _TRUE,
        donut=options.get("donut", "").lower() in _TRUE,
        y_min=_float_option(options, "y_min"),
        y_max=_float_option(options, "y_max"),
        y2=_list_option(options, "y2"),
        y2_min=_float_option(options, "y2_min"),
        y2_max=_float_option(options, "y2_max"),
    )
    return FenceChart(chart, options.get("id") or None, _aspect(options.get("aspect")))


def _aspect(text: str | None) -> float:
    """``16:9``, ``4/3`` or ``1.5``: the drawn width over its height."""
    if not text:
        return 16 / 9
    a, _, b = text.strip().replace("/", ":").partition(":")
    try:
        value = float(a) / float(b) if b else float(a)
    except (ValueError, ZeroDivisionError):
        raise ChartError(f"aspect {text!r} is not a ratio such as 16:9") from None
    if not 0.2 <= value <= 5:
        raise ChartError(f"aspect {text!r} is out of range")
    return value


class ChartIds:
    """Hands out chart ids unique within one slide (``chart``, ``chart-2``…)."""

    def __init__(self) -> None:
        self.taken: set[str] = set()

    def claim(self, base: str) -> str:
        gid, n = base, 2
        while gid in self.taken:
            gid = f"{base}-{n}"
            n += 1
        self.taken.add(gid)
        return gid


def fence_font(font_size: float, chart_scale: float = ZONE_TEXT_SCALE) -> float:
    """The text size a Markdown chart is drawn with (at ``FENCE_WIDTH``), for a
    zone whose body text is ``font_size`` in a deck whose charts are
    ``chart_scale`` of it: ``FENCE_FONT`` on a 16:9 slide, in proportion
    elsewhere (larger on a poster)."""
    return FENCE_FONT * (font_size / 36) * (chart_scale / ZONE_TEXT_SCALE)


def expand_fences(
    text: str, source: AssetSource, ids: ChartIds, font: float = FENCE_FONT
) -> str:
    """Draw every chart fence placeholder in rendered HTML, its ``data:`` file
    resolved against ``source`` (the Markdown file it was written in), its text
    ``font`` in the chart's own units (`fence_font`)."""

    def draw(match: re.Match[str]) -> str:
        try:
            fence = parse_fence(html.unescape(match.group(1)))
        except ChartError as exc:
            logger.warning(f"{source.label}: {exc}")
            chart_id = ids.claim("chart")
            resolved = ResolvedChart(Chart(data={}), None, f"chart: {exc}")
            aspect = 16 / 9
        else:
            chart_id = ids.claim(slug(fence.id) if fence.id else "chart")
            resolved = resolve(fence.chart, source)
            aspect = fence.aspect
        root = render(resolved, FENCE_WIDTH, FENCE_WIDTH / aspect, chart_id, font)
        root.set("id", chart_id)
        root.set("width", "100%")
        root.set("style", root.get("style", "") + ";display:block;height:auto")
        markup = etree.tostring(root, encoding="unicode")
        return f'<div class="inkflow-chart-block">{markup}</div>'

    return CHART_PLACEHOLDER_RE.sub(draw, text)
