"""The editor's chart actions: preview, insert, settings and data, each undoable."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest

from inkflow.editor.model import build_model
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import file_hash
from inkflow.enums import ChartKind
from inkflow.manifest import Chart, Deck
from inkflow.pipeline import process_deck
from inkflow.server import load_deck

DRAWING = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Chart, Deck, Slide


    def main() -> Deck:
        return Deck(
            slides=[
                Slide("drawing.svg"),
                Slide(
                    "drawing.svg",
                    id="sales",
                    zones={"sales": Chart("data/sales.csv", title="Sales")},
                ),
                Slide(
                    "drawing.svg",
                    id="inline",
                    zones={"c": Chart(data={"a": ["x"], "b": [1]})},
                ),
            ],
        )
""")

SALES = "quarter,revenue,cost\nQ1,120,80\nQ2,150,95\n"
TABLE = {"columns": ["month", "visits"], "rows": [["Jan", "1,200"], ["Feb", "1500"]]}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "data").mkdir()
    (tmp_path / "slides" / "drawing.svg").write_text(DRAWING)
    (tmp_path / "data" / "sales.csv").write_text(SALES)
    (tmp_path / "deck.py").write_text(DECK)
    return tmp_path


def _deck(project: Path) -> Deck:
    return load_deck(project / "deck.py")


def _own_slide(project: Path) -> Path:
    """Give slide 0 a drawing of its own (the others share drawing.svg)."""
    own = project / "slides" / "own.svg"
    own.write_text(DRAWING)
    deck_py = project / "deck.py"
    deck_py.write_text(
        deck_py.read_text().replace('Slide("drawing.svg"),', 'Slide("own.svg"),', 1)
    )
    return own


def test_preview_draws_what_the_build_draws(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    result = session.apply(
        {
            "action": "chart-preview",
            "chart": {"kind": "line", "title": "Visits"},
            "table": TABLE,
            "width": 800,
            "height": 450,
        },
        _deck(project),
    )
    svg = cast("str", result["svg"])
    assert svg.startswith("<svg") and 'viewBox="0 0 800 450"' in svg
    assert 'id="chart-series-visits"' in svg and "Visits" in svg
    # A placed chart previews from its own file when no table is sent.
    placed = session.apply(
        {"action": "chart-preview", "slide": 1, "zone": "sales", "chart": {}},
        _deck(project),
    )
    assert 'id="sales-series-revenue"' in cast("str", placed["svg"])
    # Nothing was written.
    assert session.history.done == []


def test_preview_of_unreadable_data_shows_the_problem(project: Path) -> None:
    (project / "data" / "sales.csv").unlink()
    result = EditorSession(project / "deck.py").apply(
        {"action": "chart-preview", "slide": 1, "zone": "sales", "chart": {}},
        _deck(project),
    )
    assert "not found" in cast("str", result["svg"])


def test_insert_writes_data_zone_and_deck_in_one_step(project: Path) -> None:
    own = _own_slide(project)
    session = EditorSession(project / "deck.py")
    result = session.apply(
        {
            "action": "insert-chart",
            "slide": 0,
            "file": str(own),
            "hash": file_hash(own.read_bytes()),
            "x": 100,
            "y": 200,
            "width": 960,
            "height": 540,
            "chart": {"kind": "line", "y": ["visits"], "title": "Visits"},
            "table": TABLE,
        },
        _deck(project),
    )
    assert result["ids"] == {"new": "zone-chart"}
    data = project / "data" / "chart-1.csv"
    assert data.read_text() == 'month,visits\nJan,"1,200"\nFeb,1500\n'
    assert 'id="zone-chart" x="100" y="200" width="960" height="540"' in own.read_text()
    chart = _deck(project).slides[0].zones["chart"]
    assert chart == Chart(
        "data/chart-1.csv", kind=ChartKind.LINE, y=["visits"], title="Visits"
    )
    svg = process_deck(_deck(project), project, project / "deck.py")[0]["svg"]
    assert 'id="chart-series-visits"' in svg
    # One undo removes the zone, the deck entry and the data file.
    session.apply({"action": "undo"}, _deck(project))
    assert not data.exists()
    assert "zone-chart" not in own.read_text()
    assert _deck(project).slides[0].zones == {}


def test_insert_refuses_a_shared_drawing(project: Path) -> None:
    drawing = project / "slides" / "drawing.svg"
    with pytest.raises(EditError):
        EditorSession(project / "deck.py").apply(
            {
                "action": "insert-chart",
                "slide": 0,
                "file": str(drawing),
                "hash": file_hash(drawing.read_bytes()),
                "x": 0,
                "y": 0,
                "width": 100,
                "height": 100,
                "chart": {},
                "table": TABLE,
            },
            _deck(project),
        )
    assert not (project / "data" / "chart-1.csv").exists()


def test_settings_rewrite_the_chart_call(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    session.apply(
        {
            "action": "chart-props",
            "slide": 1,
            "zone": "sales",
            "fields": {"kind": "bar", "stacked": True, "title": "", "y": ["cost"]},
        },
        _deck(project),
    )
    assert _deck(project).slides[1].zones["sales"] == Chart(
        "data/sales.csv", stacked=True, y=["cost"]
    )
    with pytest.raises(EditError):
        session.apply(
            {"action": "chart-props", "slide": 1, "zone": "sales", "fields": {"y": 3}},
            _deck(project),
        )
    with pytest.raises(EditError, match="no chart"):
        session.apply(
            {"action": "chart-props", "slide": 0, "zone": "x", "fields": {}},
            _deck(project),
        )


def test_data_is_edited_in_its_file(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    got = session.apply(
        {"action": "chart-data", "slide": 1, "zone": "sales"}, _deck(project)
    )
    assert got["columns"] == ["quarter", "revenue", "cost"]
    assert got["rows"] == [["Q1", "120", "80"], ["Q2", "150", "95"]]
    assert got["src"] == "data/sales.csv"
    table = {
        "columns": ["quarter", "revenue", "cost"],
        "rows": [["Q1", "125", "80"], ["Q2", "150", "95"], ["Q3", "170", "99"]],
    }
    session.apply(
        {
            "action": "chart-save-data",
            "slide": 1,
            "zone": "sales",
            "table": table,
            "chart": {"title": "Sales"},
        },
        _deck(project),
    )
    csv = project / "data" / "sales.csv"
    assert csv.read_text() == "quarter,revenue,cost\nQ1,125,80\nQ2,150,95\nQ3,170,99\n"
    # The settings did not change, so deck.py was left alone.
    assert session.history.done[-1].changes[0].path == csv.resolve()
    assert len(session.history.done[-1].changes) == 1
    session.apply({"action": "undo"}, _deck(project))
    assert csv.read_text() == SALES


def test_json_data_stays_json(project: Path) -> None:
    deck_py = project / "deck.py"
    deck_py.write_text(deck_py.read_text().replace("sales.csv", "sales.json"))
    data = project / "data" / "sales.json"
    data.write_text(json.dumps([{"q": "Q1", "v": 1}]))
    EditorSession(deck_py).apply(
        {
            "action": "chart-save-data",
            "slide": 1,
            "zone": "sales",
            "table": {"columns": ["q", "v"], "rows": [["Q1", "2"], ["Q2", "x"]]},
        },
        _deck(project),
    )
    assert json.loads(data.read_text()) == [{"q": "Q1", "v": 2}, {"q": "Q2", "v": "x"}]


def test_inline_data_is_rewritten_in_deck_py(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    session.apply(
        {
            "action": "chart-save-data",
            "slide": 2,
            "zone": "c",
            "table": {"columns": ["a", "b"], "rows": [["x", "1"], ["y", "2.5"]]},
        },
        _deck(project),
    )
    chart = _deck(project).slides[2].zones["c"]
    assert chart == Chart(data={"a": ["x", "y"], "b": [1, 2.5]})


def test_bad_tables_are_refused(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    tables: list[object] = [
        {"columns": [], "rows": []},
        {"columns": ["a"], "rows": "x"},
        None,
    ]
    for table in tables:
        with pytest.raises(EditError):
            session.apply(
                {
                    "action": "chart-save-data",
                    "slide": 1,
                    "zone": "sales",
                    "table": table,
                },
                _deck(project),
            )
    assert (project / "data" / "sales.csv").read_text() == SALES


def test_model_lists_a_chart_zone(project: Path) -> None:
    deck = _deck(project)
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    model = build_model(deck, project / "deck.py", slides)
    entries = cast("list[dict[str, object]]", model["slides"])
    zone = cast("dict[str, dict[str, object]]", entries[1]["zones"])["sales"]
    assert zone["kind"] == "chart"
    assert zone["src"] == "data/sales.csv"
    assert zone["path"] == str((project / "data" / "sales.csv").resolve())
    assert zone["columns"] == ["quarter", "revenue", "cost"]
    assert zone["numeric"] == ["revenue", "cost"]
    fields = cast("dict[str, object]", zone["fields"])
    assert fields["kind"] == "bar" and fields["title"] == "Sales"
    assert fields["y"] is None
    inline = cast("dict[str, dict[str, object]]", entries[2]["zones"])["c"]
    assert inline["inline"] is True and inline["columns"] == ["a", "b"]


def test_a_copied_slide_brings_its_data(project: Path) -> None:
    from inkflow.editor.transfer import check_slide_code, export_slides

    bundle = export_slides(_deck(project), project / "deck.py", [1])
    files = cast("dict[str, dict[str, str]]", bundle["files"])
    assert files["data/sales.csv"]["role"] == "asset"
    check_slide_code(
        'Slide("a.svg", zones={"c": Chart("d.csv", kind=ChartKind.PIE, y=["n"])})'
    )


def test_data_files_open_in_a_spreadsheet(monkeypatch: pytest.MonkeyPatch) -> None:
    from inkflow import edit
    from inkflow.edit import EditCommands

    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("localc", "code") else None

    monkeypatch.setattr("inkflow.edit.shutil.which", which)
    choices = edit.open_choices(Path("a.csv"), EditCommands(default=None, svg=None))
    assert [c.id for c in choices] == ["localc", "code", "system"]
    assert edit.KINDS["tsv"] == "DATA"
