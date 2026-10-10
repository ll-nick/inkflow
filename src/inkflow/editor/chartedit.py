"""The editor's side of charts: settings and data from the browser, checked.

The browser never writes a data file or deck.py. It sends a chart's settings
(the ``Chart`` fields its panel edits) and its table as plain cell text, and the
session turns them into a real ``Chart`` (so the dataclass validates them) and
into file bytes written through ``inkflow.charts.serialize_rows``, which keeps
each cell as typed. A preview is drawn by the same renderer as the build.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import cast

from inkflow.charts import (
    DATA_SUFFIXES,
    ChartError,
    Table,
    read_table,
    read_text_rows,
)
from inkflow.editor.codegen import to_json
from inkflow.enums import ChartKind
from inkflow.manifest import Chart

SETTINGS = (
    "kind",
    "x",
    "y",
    "title",
    "stacked",
    "horizontal",
    "legend",
    "labels",
    "donut",
    "y_min",
    "y_max",
    "y2",
    "y2_min",
    "y2_max",
)
"""The ``Chart`` fields the editor's chart panel and dialog set."""

MAX_ROWS = 5000
MAX_COLUMNS = 100
DATA_DIR = "data"
"""Where the editor writes a new chart's data, in the project."""


def settings(raw: object) -> dict[str, object]:
    """Chart fields from a request, each checked; unknown names are dropped.

    An emptied text box means "the default" (``None``) for ``x`` and ``title``.
    """
    if not isinstance(raw, dict):
        return {}
    fields = cast("dict[str, object]", raw)
    out: dict[str, object] = {}
    for name, value in fields.items():
        if name not in SETTINGS:
            continue
        if name == "kind":
            out[name] = ChartKind(str(value))
        elif name in ("x", "title"):
            out[name] = str(value) if value not in (None, "") else None
        elif name in ("y_min", "y_max", "y2_min", "y2_max"):
            if value in (None, ""):
                out[name] = None
            elif isinstance(value, int | float) and not isinstance(value, bool):
                out[name] = float(value)
            else:
                raise ValueError(f"{name} must be a number")
        elif name in ("y", "y2"):
            if value is None:
                out[name] = None
            elif isinstance(value, list) and all(
                isinstance(v, str) for v in cast("list[object]", value)
            ):
                out[name] = list(cast("list[str]", value)) or None
            else:
                raise ValueError(f"{name} must be a list of column names")
        elif name == "legend":
            out[name] = None if value is None else bool(value)
        else:
            out[name] = bool(value)
    return out


def apply_settings(chart: Chart, raw: object) -> Chart:
    return dataclasses.replace(chart, **settings(raw))


def grid(raw: object) -> tuple[list[str], list[list[str]]]:
    """A table from the grid editor: ``{"columns": [...], "rows": [[...]]}``,
    every cell text."""
    if not isinstance(raw, dict):
        raise ValueError("no table")
    table = cast("dict[str, object]", raw)
    columns = table.get("columns")
    rows = table.get("rows")
    if not isinstance(columns, list) or not isinstance(rows, list):
        raise ValueError("no table")
    names = [str(c) for c in cast("list[object]", columns)]
    if not names:
        raise ValueError("the table needs at least one column")
    if len(names) > MAX_COLUMNS or len(cast("list[object]", rows)) > MAX_ROWS:
        raise ValueError(f"at most {MAX_COLUMNS} columns and {MAX_ROWS} rows")
    cells: list[list[str]] = []
    for row in cast("list[object]", rows):
        if not isinstance(row, list):
            raise ValueError("each row is a list of cells")
        cells.append(
            ["" if c is None else str(c) for c in cast("list[object]", row)][
                : len(names)
            ]
        )
    return names, cells


def data_path(chart: Chart, project_dir: Path) -> Path | None:
    """The data file a deck.py chart reads (``src`` is relative to deck.py)."""
    if chart.src is None:
        return None
    path = Path(chart.src)
    return (path if path.is_absolute() else project_dir / path).resolve()


def text_table(chart: Chart, project_dir: Path) -> tuple[list[str], list[list[str]]]:
    """A chart's data as the grid shows it: the file's cells as written."""
    if chart.data is not None:
        table = Table.from_columns(chart.data)
        return table.columns, table.text_rows()
    path = data_path(chart, project_dir)
    if path is None or not path.is_file():
        raise ChartError(f"chart data not found: {chart.src}")
    return read_text_rows(path)


def load(chart: Chart, project_dir: Path) -> Table:
    if chart.data is not None:
        return Table.from_columns(chart.data)
    path = data_path(chart, project_dir)
    if path is None or not path.is_file():
        raise ChartError(f"chart data not found: {chart.src}")
    return read_table(path)


def new_data_file(project_dir: Path) -> Path:
    """``data/chart-N.csv``, the first N no file takes."""
    n = 1
    while True:
        path = project_dir / DATA_DIR / f"chart-{n}.csv"
        if not path.exists():
            return path
        n += 1


def is_data_file(path: Path) -> bool:
    return path.suffix.lower() in DATA_SUFFIXES


def chart_json(chart: Chart, project_dir: Path) -> dict[str, object]:
    """A chart zone in the editor model: its settings, its file, its columns."""
    fields: dict[str, object] = {
        name: to_json(cast("object", getattr(chart, name)))
        for name in SETTINGS
        if name not in ("y", "y2")
    }
    fields["y"] = list(chart.y) if chart.y is not None else None
    fields["y2"] = list(chart.y2) if chart.y2 is not None else None
    out: dict[str, object] = {
        "kind": "chart",
        "src": chart.src,
        "inline": chart.data is not None,
        "fields": fields,
        "columns": [],
        "numeric": [],
    }
    path = data_path(chart, project_dir)
    if path is not None:
        out["path"] = str(path)
    try:
        table = load(chart, project_dir)
    except (ChartError, OSError, UnicodeDecodeError, ValueError) as exc:
        out["error"] = str(exc)
        return out
    out["columns"] = table.columns
    out["numeric"] = [c for c in table.columns if table.is_numeric(c)]
    return out
