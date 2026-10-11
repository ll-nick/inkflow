"""Charts: reading tables, axis ticks, drawing each kind, the DSL and its fences."""

from __future__ import annotations

import json
import logging
import math
import textwrap
from pathlib import Path
from typing import cast

import pytest
from lxml import etree

from inkflow.animations import FadeIn
from inkflow.assets import AssetRoots, AssetSource
from inkflow.charts import (
    PALETTE,
    ChartError,
    ChartIds,
    ResolvedChart,
    Table,
    expand_fences,
    format_tick,
    format_value,
    nice_ticks,
    parse_cell,
    parse_delimited,
    parse_fence,
    parse_json,
    parse_markdown_table,
    read_table,
    read_text_rows,
    render,
    resolve,
    serialize_rows,
)
from inkflow.colors import SVG_TOKENS
from inkflow.editor.codegen import Code
from inkflow.enums import ChartKind
from inkflow.logging import collect_logs
from inkflow.manifest import Chart, Deck, Slide
from inkflow.markdown import html_fragment_to_xml, markdown_to_html
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg
from inkflow.sync import PreviewContext
from inkflow.verify import verify_slide

SVG_NS = "http://www.w3.org/2000/svg"
SALES = "quarter,revenue,cost\nQ1,120,80\nQ2,150,95\nQ3,,110\nQ4,210,130\n"


def _table() -> Table:
    return parse_delimited(SALES)


def _ids(root: etree._Element) -> set[str]:  # pyright: ignore[reportPrivateUsage]
    return {el.get("id", "") for el in root.iter() if el.get("id")}


def _text(root: etree._Element) -> str:  # pyright: ignore[reportPrivateUsage]
    return "".join(str(t) for t in root.itertext())


def _draw(chart: Chart, table: Table | None = None, **kw: float) -> etree._Element:  # pyright: ignore[reportPrivateUsage]
    data = table if table is not None else _table()
    return render(
        ResolvedChart(chart, data), kw.get("w", 960), kw.get("h", 540), "sales"
    )


# ── Tables ────────────────────────────────────────────────────────────────────


class TestTables:
    def test_cells_are_numbers_text_or_missing(self) -> None:
        assert parse_cell("12") == 12.0
        assert parse_cell(" -1,234.5 ") == -1234.5
        assert parse_cell("1e3") == 1000.0
        assert parse_cell("") is None
        assert parse_cell("Q1") == "Q1"
        assert parse_cell("2024-01") == "2024-01"
        assert parse_cell("1,23") == "1,23"

    def test_csv_first_row_names_the_columns(self) -> None:
        table = _table()
        assert table.columns == ["quarter", "revenue", "cost"]
        assert table.column("revenue") == [120.0, 150.0, None, 210.0]
        assert table.is_numeric("cost")
        assert not table.is_numeric("quarter")

    def test_tsv_short_rows_and_duplicate_headers(self) -> None:
        table = parse_delimited("a\ta\tb\n1\t2\nx\t3\t4\n", "\t")
        assert table.columns == ["a", "a 2", "b"]
        assert table.rows[0] == [1.0, 2.0, None]
        assert table.rows[1] == ["x", 3.0, 4.0]

    def test_csv_quotes_and_byte_order_mark(self) -> None:
        table = parse_delimited('﻿name,value\n"Smith, J",1\n\n')
        assert table.columns == ["name", "value"]
        assert table.rows == [["Smith, J", 1.0]]

    def test_json_records_and_columns(self) -> None:
        records = parse_json('[{"x": "a", "y": 1}, {"x": "b", "z": true}]')
        assert records.columns == ["x", "y", "z"]
        assert records.rows == [["a", 1.0, None], ["b", None, "true"]]
        columns = parse_json('{"x": ["a", "b"], "y": [1, null]}')
        assert columns.rows == [["a", 1.0], ["b", None]]
        with pytest.raises(ChartError):
            parse_json('"nope"')
        with pytest.raises(ChartError):
            parse_json("{broken")

    def test_markdown_table(self) -> None:
        table = parse_markdown_table(
            "| os | share |\n|:---|---:|\n| Linux | 48 |\n| a \\| b | |\n"
        )
        assert table.columns == ["os", "share"]
        assert table.rows == [["Linux", 48.0], ["a | b", None]]

    def test_files_by_suffix(self, tmp_path: Path) -> None:
        (tmp_path / "a.csv").write_text(SALES)
        (tmp_path / "a.tsv").write_text(SALES.replace(",", "\t"))
        (tmp_path / "a.json").write_text(json.dumps({"q": ["Q1"], "v": [3]}))
        assert read_table(tmp_path / "a.csv") == read_table(tmp_path / "a.tsv")
        assert read_table(tmp_path / "a.json").rows == [["Q1", 3.0]]
        (tmp_path / "a.txt").write_text("x")
        with pytest.raises(ChartError):
            read_table(tmp_path / "a.txt")

    def test_rows_written_back_as_typed(self, tmp_path: Path) -> None:
        text = serialize_rows(".csv", ["name", "n"], [["a, b", "1.50"], ["c"]])
        assert text == 'name,n\n"a, b",1.50\nc,\n'
        (tmp_path / "d.csv").write_text(text)
        assert read_text_rows(tmp_path / "d.csv") == (
            ["name", "n"],
            [["a, b", "1.50"], ["c", ""]],
        )
        tsv = serialize_rows(".tsv", ["a", "b"], [["1", "x"]])
        assert tsv == "a\tb\n1\tx\n"
        records = cast(
            "object", json.loads(serialize_rows(".json", ["a", "b"], [["1", "x"]]))
        )
        assert records == [{"a": 1, "b": "x"}]

    def test_inline_columns_round_trip(self) -> None:
        table = Table.from_columns({"year": [2023, 2024], "users": [1.5, None]})
        assert table.to_columns() == {"year": [2023, 2024], "users": [1.5, None]}
        assert table.text_rows() == [["2023", "1.5"], ["2024", ""]]


# ── Ticks and numbers ─────────────────────────────────────────────────────────


class TestTicks:
    @pytest.mark.parametrize(
        ("lo", "hi", "expected"),
        [
            (0, 210, [0, 50, 100, 150, 200, 250]),
            (0, 1, [0, 0.2, 0.4, 0.6, 0.8, 1]),
            (-35, 80, [-40, -20, 0, 20, 40, 60, 80]),
            (120, 180, [120, 130, 140, 150, 160, 170, 180]),
            (0, 0, [0, 0.2, 0.4, 0.6, 0.8, 1]),
            (5, 5, [2, 3, 4, 5, 6, 7, 8]),
        ],
    )
    def test_nice_round_steps(
        self, lo: float, hi: float, expected: list[float]
    ) -> None:
        assert nice_ticks(lo, hi) == expected

    def test_steps_are_one_two_or_five(self) -> None:
        for hi in (7, 13, 99, 1234, 0.37, 55555):
            ticks = nice_ticks(0, hi)
            step = ticks[1] - ticks[0]
            mantissa = step / 10.0 ** math.floor(math.log10(step))
            assert round(mantissa, 6) in (1, 2, 5)
            assert ticks[0] <= 0 and ticks[-1] >= hi

    def test_labels(self) -> None:
        assert format_tick(0.4, [0, 0.2, 0.4]) == "0.4"
        assert format_tick(2000, [0, 1000, 2000]) == "2,000"
        assert format_tick(20000, [0, 10000, 20000]) == "20K"
        assert format_tick(1_500_000, [0, 500_000, 1_500_000]) == "1.5M"
        assert format_value(1234) == "1,234"
        assert format_value(2.345) == "2.35"
        assert format_value(3_400_000) == "3.4M"


# ── Drawing ───────────────────────────────────────────────────────────────────


class TestRender:
    @pytest.mark.parametrize(
        "chart",
        [
            Chart(data={}),
            Chart(data={}, stacked=True, labels=True),
            Chart(data={}, horizontal=True, labels=True),
            Chart(data={}, kind=ChartKind.LINE, labels=True),
            Chart(data={}, kind=ChartKind.AREA),
            Chart(data={}, kind=ChartKind.AREA, stacked=True),
        ],
    )
    def test_cartesian_kinds(self, chart: Chart) -> None:
        root = _draw(chart)
        text = etree.tostring(root, encoding="unicode")
        parse_svg(text)  # well-formed
        assert root.tag == f"{{{SVG_NS}}}svg"
        assert root.get("viewBox") == "0 0 960 540"
        assert {"sales-series-revenue", "sales-series-cost", "sales-axes"} <= _ids(root)
        assert "var(--inkflow-blue)" in text and "var(--inkflow-orange)" in text
        assert "var(--inkflow-text-muted)" in text
        assert "font-family:var(--inkflow-body-font)" in text
        # The legend (two series) names each series inside its own group.
        series = root.find(".//*[@id='sales-series-cost']")
        assert series is not None
        assert "cost" in _text(series)

    def test_one_series_has_no_legend_unless_asked(self) -> None:
        one = _draw(Chart(data={}, y=["revenue"]))
        assert "inkflow-chart-legend" not in etree.tostring(one, encoding="unicode")
        shown = _draw(Chart(data={}, y=["revenue"], legend=True))
        assert "inkflow-chart-legend" in etree.tostring(shown, encoding="unicode")

    def test_bars_skip_missing_values_and_label_values(self) -> None:
        root = _draw(Chart(data={}, y=["revenue"], labels=True))
        series = root.find(".//*[@id='sales-series-revenue']")
        assert series is not None
        assert len(series.findall(f".//{{{SVG_NS}}}path")) == 3  # Q3 is missing
        assert {"120", "150", "210"} <= set(series.itertext())

    def test_lines_break_at_missing_values(self) -> None:
        root = _draw(Chart(data={}, kind=ChartKind.LINE, y=["revenue"]))
        series = root.find(".//*[@id='sales-series-revenue']")
        assert series is not None
        assert len(series.findall(f".//{{{SVG_NS}}}polyline")) == 2

    def test_pie_slices(self) -> None:
        table = Table.from_columns({"os": ["Linux", "Mac OS"], "n": [3, 1]})
        root = _draw(Chart(data={}, kind=ChartKind.PIE, donut=True, labels=True), table)
        ids = _ids(root)
        assert {"sales-slice-linux", "sales-slice-mac-os"} <= ids
        text = _text(root)
        assert "75%" in text and "25%" in text
        assert "inkflow-chart-legend" in etree.tostring(root, encoding="unicode")

    def test_scatter_needs_numbers(self) -> None:
        table = Table.from_columns({"x": [1, 2.5, 4], "y": [3, 1, 2]})
        root = _draw(Chart(data={}, kind=ChartKind.SCATTER), table)
        series = root.find(".//*[@id='sales-series-y']")
        assert series is not None
        assert len(series.findall(f".//{{{SVG_NS}}}circle")) == 3
        message = _text(_draw(Chart(data={}, kind=ChartKind.SCATTER)))
        assert "needs numbers" in message

    def test_text_is_escaped(self) -> None:
        table = Table.from_columns({"<b>&": ["<i>"], "v&<": [1]})
        root = _draw(Chart(data={}, title="A & <B>", legend=True), table)
        text = etree.tostring(root, encoding="unicode")
        assert "A &amp; &lt;B&gt;" in text and "<b>" not in text and "<i>" not in text
        parse_svg(text)

    def test_problems_are_drawn_in_place(self) -> None:
        missing = _draw(Chart(data={}, x="nope"))
        assert "no column 'nope'" in _text(missing)
        failed = render(ResolvedChart(Chart(data={}), None, "gone.csv"), 400, 300, "c")
        assert "gone.csv" in _text(failed)

    def test_series_cycle_through_the_chromatic_palette(self) -> None:
        chromatic = SVG_TOKENS[SVG_TOKENS.index("red") : SVG_TOKENS.index("grey")]
        assert sorted(PALETTE) == sorted(chromatic)
        many = Table.from_columns(
            {"c": ["a"], **{f"s{i}": [i + 1] for i in range(len(PALETTE) + 1)}}
        )
        text = etree.tostring(_draw(Chart(data={}), many), encoding="unicode")
        for token in PALETTE:
            assert f"var(--inkflow-{token})" in text


# ── DSL ───────────────────────────────────────────────────────────────────────


class TestChartDsl:
    def test_needs_exactly_one_source(self) -> None:
        with pytest.raises(ValueError, match="exactly one"):
            Chart()
        with pytest.raises(ValueError, match="exactly one"):
            Chart("a.csv", data={"a": [1]})

    def test_strings_are_accepted(self) -> None:
        chart = Chart("a.csv", kind="line", y="b")  # pyright: ignore[reportArgumentType]
        assert chart.kind is ChartKind.LINE
        assert chart.y == ["b"]

    def test_codegen_round_trip(self) -> None:
        chart = Chart(
            "data/sales.csv",
            kind=ChartKind.LINE,
            y=["revenue", "cost"],
            title="Sales",
            labels=True,
        )
        code = Code()
        source = code.call(chart)
        assert source == (
            'Chart("data/sales.csv", kind=ChartKind.LINE, y=["revenue", "cost"], '
            + 'title="Sales", labels=True)'
        )
        assert code.imports == {"Chart", "ChartKind"}
        assert eval(source, {"Chart": Chart, "ChartKind": ChartKind}) == chart
        inline = Chart(data={"a": ["x", "y"], "b": [1, 2.5]})
        inline_code = Code().call(inline)
        assert inline_code == 'Chart(data={"a": ["x", "y"], "b": [1, 2.5]})'
        assert eval(inline_code, {"Chart": Chart}) == inline

    def test_resolve_against_the_file_written_in(self, tmp_path: Path) -> None:
        (tmp_path / "data").mkdir()
        (tmp_path / "data" / "s.csv").write_text(SALES)
        roots = AssetRoots(tmp_path)
        resolved = resolve(Chart("data/s.csv"), AssetSource.for_deck(roots))
        assert resolved.table == _table()
        md = AssetSource.for_file(roots, tmp_path / "slides" / "a.md")
        assert resolve(Chart("../data/s.csv"), md).table == _table()
        with collect_logs(logging.WARNING) as logs:
            missing = resolve(Chart("data/none.csv"), AssetSource.for_deck(roots))
        assert missing.table is None and missing.error is not None
        assert any("none.csv" in r.message for r in logs)
        remote = resolve(Chart("https://x/a.csv"), AssetSource.for_deck(roots))
        assert remote.table is None


# ── Markdown fences ───────────────────────────────────────────────────────────

FENCE = textwrap.dedent("""\
    # Numbers

    ```chart
    kind: pie
    donut: true
    title: Where & why
    id: share
    | os | share |
    |----|-------|
    | Linux | 48 |
    | macOS | 52 |
    ```
""")


class TestFences:
    def test_options(self) -> None:
        fence = parse_fence(
            "kind: bar\nx: q\ny: a, b\nstacked: yes\nlegend: false\ndata: d.csv\n"
            + "aspect: 4:3\n"
        )
        assert fence.chart == Chart(
            "d.csv", x="q", y=["a", "b"], stacked=True, legend=False
        )
        assert fence.aspect == pytest.approx(4 / 3)
        with pytest.raises(ChartError, match="unknown chart option"):
            parse_fence("colour: red\ndata: a.csv")
        with pytest.raises(ChartError, match="needs data"):
            parse_fence("kind: bar")
        with pytest.raises(ChartError, match="unknown chart kind"):
            parse_fence("kind: radar\ndata: a.csv")

    def test_fence_renders_inline_svg(self, tmp_path: Path) -> None:
        html = markdown_to_html(FENCE)
        assert "inkflow-chart-fence" in html
        source = AssetSource.for_file(AssetRoots(tmp_path), tmp_path / "a.md")
        out = expand_fences(html, source, ChartIds())
        assert "inkflow-chart-fence" not in out
        assert 'id="share"' in out and 'id="share-slice-linux"' in out
        assert "Where &amp; why" in out
        # Through the HTML-to-XML step every zone's HTML takes, case intact.
        xml = html_fragment_to_xml(out)
        assert 'viewBox="0 0 960 540"' in xml
        assert 'xmlns="http://www.w3.org/2000/svg"' in xml

    def test_broken_fence_draws_its_error(self, tmp_path: Path) -> None:
        html = markdown_to_html("```chart\nkind: bar\n```\n")
        source = AssetSource.for_file(AssetRoots(tmp_path), tmp_path / "a.md")
        with collect_logs(logging.WARNING) as logs:
            out = expand_fences(html, source, ChartIds())
        assert "needs data" in out
        assert logs

    def test_ids_unique_per_slide(self) -> None:
        ids = ChartIds()
        assert [ids.claim("chart") for _ in range(3)] == ["chart", "chart-2", "chart-3"]


# ── Through the pipeline ──────────────────────────────────────────────────────

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="800" height="700"/>
      <rect id="zone-sales" x="1000" y="200" width="840" height="700"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Chart, Deck, Slide, animations


    def main() -> Deck:
        return Deck(
            slides=[
                Slide(
                    "two",
                    md="slides/a.md",
                    zones={"sales": Chart("data/sales.csv", title="Sales")},
                    animations=[animations.FadeIn("sales-series-revenue")],
                ),
            ],
        )
""")


class TestPipeline:
    @pytest.fixture
    def project(self, tmp_path: Path) -> Path:
        for d in ("layouts", "slides", "data"):
            (tmp_path / d).mkdir()
        (tmp_path / "layouts" / "two.svg").write_text(LAYOUT)
        (tmp_path / "slides" / "a.md").write_text(
            FENCE.replace(
                "| os | share |\n|----|-------|\n| Linux | 48 |\n| macOS | 52 |\n",
                "data: ../data/share.csv\n",
            )
        )
        (tmp_path / "data" / "sales.csv").write_text(SALES)
        (tmp_path / "data" / "share.csv").write_text("os,share\nLinux,48\nmacOS,52\n")
        (tmp_path / "deck.py").write_text(DECK)
        return tmp_path

    def test_zone_and_fence_charts(self, project: Path) -> None:
        deck = load_deck(project / "deck.py")
        slide = process_deck(deck, project, project / "deck.py")[0]
        root = parse_svg(slide["svg"])
        zone = root.find(".//*[@id='zone-sales']")
        assert zone is not None and zone.tag == f"{{{SVG_NS}}}svg"
        assert zone.get("x") == "1000" and zone.get("width") == "840"
        assert zone.get("viewBox") == "0 0 840 700"
        revenue = root.find(".//*[@id='sales-series-revenue']")
        assert revenue is not None and "fade-in" in revenue.get("data-cues", "")
        # The fence's chart is inline SVG inside the content zone's HTML, in
        # the SVG namespace (lxml must not drop its xmlns on the way).
        share = root.find(f".//{{{SVG_NS}}}svg[@id='share']")
        assert share is not None
        assert share.find(".//*[@id='share-slice-linux']") is not None

    def test_editor_build_keeps_provenance(self, project: Path) -> None:
        deck = load_deck(project / "deck.py")
        slide = process_deck(deck, project, project / "deck.py", editor=True)[0]
        root = parse_svg(slide["svg"])
        zone = root.find(".//*[@id='zone-sales']")
        assert zone is not None
        assert zone.get("data-ink") and zone.get("data-ink-tag") == "rect"
        assert slide.get("edit", {}).get("zoneOrigins", {}).get("sales") == "deck"

    def test_deck_built_in_python(self, tmp_path: Path) -> None:
        (tmp_path / "layouts").mkdir()
        (tmp_path / "layouts" / "two.svg").write_text(LAYOUT)
        deck = Deck(
            slides=[
                Slide(
                    "two",
                    zones={"sales": Chart(data={"q": ["a", "b"], "v": [1, 2]})},
                )
            ]
        )
        svg = process_deck(deck, tmp_path, tmp_path / "deck.py")[0]["svg"]
        assert 'id="sales-series-v"' in svg


class TestVerify:
    def _verify(self, project: Path, slide: Slide) -> list[tuple[str, str]]:
        preview = PreviewContext(deck=Deck(slides=[]), project_dir=project, theme=None)
        return verify_slide(slide, project, None, preview)

    def test_series_are_animation_targets(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        (tmp_path / "slides" / "s.svg").write_text(LAYOUT)
        (tmp_path / "slides" / "a.md").write_text(FENCE)
        slide = Slide(
            "slides/s.svg",
            md="slides/a.md",
            zones={"sales": Chart(data={"q": ["a"], "revenue": [1]})},
            animations=[FadeIn("sales-series-revenue"), FadeIn("share-slice-linux")],
        )
        assert self._verify(tmp_path, slide) == []
        missing = Slide(
            "slides/s.svg",
            zones={"sales": Chart("data/none.csv")},
            animations=[FadeIn("sales-series-nope")],
        )
        messages = [m for _, m in self._verify(tmp_path, missing)]
        assert any("none.csv" in m for m in messages)
        assert any("sales-series-nope" in m for m in messages)


# ── Axis range and a second axis ──


def _axis_labels(root: etree._Element, anchor: str) -> list[str]:  # pyright: ignore[reportPrivateUsage]
    """The value axis's tick labels on one side (end: left, start: right)."""
    axes = next(el for el in root.iter() if el.get("class") == "inkflow-chart-axes")
    return [
        "".join(str(s) for s in t.itertext())
        for t in axes.iter(f"{{{SVG_NS}}}text")
        if t.get("text-anchor") == anchor
    ]


def test_y_min_and_max_are_the_axis_ends() -> None:
    root = _draw(Chart(data={}, kind=ChartKind.LINE, y_min=50, y_max=250))
    assert _axis_labels(root, "end") == ["50", "100", "150", "200", "250"]
    # Values beyond a fixed end are cut off at the plot.
    clip = next(el for el in root.iter() if el.tag == f"{{{SVG_NS}}}clipPath")
    marks = [el for el in root.iter() if el.get("class") == "inkflow-chart-marks"]
    assert marks and all(m.get("clip-path") == f"url(#{clip.get('id')})" for m in marks)


def test_an_end_that_is_not_round_keeps_its_label() -> None:
    root = _draw(Chart(data={}, kind=ChartKind.BAR, y_max=230))
    labels = _axis_labels(root, "end")
    assert labels[0] == "0" and labels[-1] == "230"
    assert "200" in labels  # the round ticks below it stay


def test_without_a_range_nothing_is_clipped() -> None:
    root = _draw(Chart(data={}))
    assert not any(el.tag == f"{{{SVG_NS}}}clipPath" for el in root.iter())


def test_a_second_axis_on_the_right() -> None:
    table = parse_delimited("month,visitors,rate\nJan,1200,0.5\nFeb,1800,0.7\n")
    root = _draw(Chart(data={}, kind=ChartKind.LINE, y2=["rate"], y2_max=1), table)
    right = _axis_labels(root, "start")
    left = _axis_labels(root, "end")
    assert right[-1] == "1" and "0.5" in right
    assert left[-1] == "1,800"
    text = _text(root)
    assert "rate (right)" in text and "visitors (right)" not in text
    # Each series still has its own group, ids as before.
    assert {"sales-series-visitors", "sales-series-rate"} <= _ids(root)


def test_y2_columns_are_plotted_even_if_y_leaves_them_out() -> None:
    root = _draw(Chart(data={}, y=["revenue"], y2=["cost"]))
    assert {"sales-series-revenue", "sales-series-cost"} <= _ids(root)


@pytest.mark.parametrize(
    ("chart", "message"),
    [
        (Chart(data={}, y2=["cost"], stacked=True), "side by side"),
        (Chart(data={}, y2=["cost"], horizontal=True), "upright bars"),
        (Chart(data={}, y=["cost"], y2=["cost"]), "not all of them"),
    ],
)
def test_a_second_axis_it_cannot_draw(chart: Chart, message: str) -> None:
    assert message in _text(_draw(chart))


def test_a_range_upside_down_is_refused() -> None:
    with pytest.raises(ValueError, match="y_min must be below y_max"):
        Chart(data={}, y_min=10, y_max=5)


def test_range_and_second_axis_in_a_fence_and_in_deck_source() -> None:
    fence = parse_fence(
        "kind: line\ndata: x.csv\ny-min: 0\ny_max: 300\ny2: rate\ny2_max: 1"
    )
    chart = fence.chart
    assert (chart.y_min, chart.y_max, chart.y2, chart.y2_max) == (0, 300, ["rate"], 1)
    with pytest.raises(ChartError, match="not a number"):
        parse_fence("data: x.csv\ny_min: low")
    assert (
        Code().call(Chart("data/x.csv", y_min=0.0, y2=["rate"]))
        == 'Chart("data/x.csv", y_min=0.0, y2=["rate"])'
    )
