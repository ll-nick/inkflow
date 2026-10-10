"""`inkflow render`: layout findings, the contact sheet and the CLI around them."""

from __future__ import annotations

import struct
import textwrap
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.export import find_chromium
from inkflow.render import (
    SHEET_WIDTH,
    Finding,
    RenderResult,
    parse_findings,
    render_slides,
    sheet_columns,
    sheet_html,
    sheet_layout,
    sheet_pages,
    sheet_paths,
    summary,
)

# ── findings ──────────────────────────────────────────────────────────────────


def _finding(kind: str, **kw: object) -> Finding:
    raw = parse_findings(3, "intro", [{"kind": kind, "target": "#zone-content", **kw}])
    assert len(raw) == 1
    return raw[0]


class TestFindingMessages:
    def test_overflow_names_slide_zone_and_side(self) -> None:
        f = _finding("overflow", bottom=120.4)
        assert f.message() == (
            "slide 3 (intro): #zone-content: text overflows its zone by 120px (bottom)"
        )
        assert f.is_problem

    def test_overflow_on_two_sides(self) -> None:
        f = _finding("overflow", top=60, bottom=61)
        assert f.message().endswith("by 60px (top), 61px (bottom)")

    def test_clipped_code_block(self) -> None:
        f = _finding("clipped", right=528, what="code block")
        assert f.message().endswith(
            "#zone-content: code block is cut off by 528px (right)"
        )

    def test_outside_one_side(self) -> None:
        f = parse_findings(
            5, "", [{"kind": "outside", "target": "#logo", "right": 40}]
        )[0]
        assert f.message() == "slide 5: #logo: lies 40px outside the slide (right)"

    def test_outside_two_sides(self) -> None:
        f = _finding("outside", right=40, bottom=12)
        assert f.message().endswith(
            "lies outside the slide by 40px (right), 12px (bottom)"
        )

    def test_entirely_outside(self) -> None:
        f = _finding("outside", left=300, entirely=True)
        assert f.message().endswith(
            "lies entirely outside the slide (left), so it is not shown"
        )

    def test_small_text_is_a_hint(self) -> None:
        f = _finding("small-text", size=10, min=13.5, text="tiny footnote")
        assert not f.is_problem
        assert f.message().endswith(
            'text 10px tall is likely too small to read (below 13.5px): "tiny footnote"'
        )

    def test_unknown_and_malformed_entries_are_dropped(self) -> None:
        raw = [
            {"kind": "sparkles", "target": "#a"},
            {"kind": "overflow"},
            "nonsense",
            {"kind": "overflow", "target": "#b", "bottom": "lots"},
        ]
        found = parse_findings(1, "a", raw)
        assert [(f.target, f.bottom) for f in found] == [("#b", 0)]
        assert parse_findings(1, "a", None) == []


def test_summary_counts_problems_and_hints() -> None:
    over = _finding("overflow", bottom=10)
    small = _finding("small-text", size=9)
    assert summary([], 12) == "no layout problems in 12 slides"
    assert summary([over], 1) == "1 layout problem in 1 slide"
    assert summary([over, over, small], 4) == "2 layout problems and 1 hint in 4 slides"
    assert summary([small], 2) == "1 hint in 2 slides"


# ── contact sheet ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("count", "columns"), [(1, 1), (2, 2), (4, 2), (5, 3), (9, 3), (10, 4), (16, 4)]
)
def test_sheet_columns(count: int, columns: int) -> None:
    assert sheet_columns(count) == columns


def test_sheet_layout_fits_the_width_and_keeps_the_aspect() -> None:
    layout = sheet_layout(12, 1920, 1080)
    assert (layout.columns, layout.rows) == (4, 3)
    assert layout.width == SHEET_WIDTH
    right = layout.cell(3)[0] + layout.thumb_width
    assert right <= SHEET_WIDTH
    assert abs(layout.thumb_height / layout.thumb_width - 1080 / 1920) < 0.01
    bottom = layout.cell(11)[1] + 30 + layout.thumb_height
    assert bottom <= layout.height
    assert layout.height < 1100  # one readable image


def test_sheet_layout_cells_do_not_overlap() -> None:
    layout = sheet_layout(5, 1920, 1080)
    (x0, y0), (x1, _), (_, y3) = layout.cell(0), layout.cell(1), layout.cell(3)
    assert x1 >= x0 + layout.thumb_width
    assert y3 >= y0 + layout.thumb_height


def test_sheet_pages_split_evenly() -> None:
    assert sheet_pages(list(range(1, 13))) == [list(range(1, 13))]
    pages = sheet_pages(list(range(1, 18)))
    assert [len(p) for p in pages] == [9, 8]
    assert [n for page in pages for n in page] == list(range(1, 18))
    assert sheet_pages([]) == []


def test_sheet_paths() -> None:
    assert sheet_paths(Path("out/deck.png"), 1) == [Path("out/deck.png")]
    assert sheet_paths(Path("out/deck.png"), 2) == [
        Path("out/deck-1.png"),
        Path("out/deck-2.png"),
    ]
    assert sheet_paths(Path("out"), 1) == [Path("out/sheet.png")]
    assert sheet_paths(Path("out"), 2)[1] == Path("out/sheet-2.png")


def test_sheet_html_labels_each_slide() -> None:
    layout = sheet_layout(2, 1920, 1080)
    html = sheet_html(layout, [(1, "intro", "thumb-1.png", 0), (2, "a<b", "t.png", 2)])
    assert "<b>1</b> intro" in html
    assert "a&lt;b" in html
    assert "2 problems" in html
    assert html.count("<img") == 2


# ── the command ───────────────────────────────────────────────────────────────

_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"/>'
_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(slides=[Slide("a.svg"), Slide("a.svg", id="b")])
""")


@pytest.fixture
def tiny(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "a.svg").write_text(_SVG)
    (tmp_path / "deck.py").write_text(_DECK)
    return tmp_path


class _Spy:
    def __init__(self, findings: list[Finding]) -> None:
        self.calls: list[dict[str, object]] = []
        self.findings: list[Finding] = findings

    def __call__(
        self,
        deck_path: Path,
        numbers: list[int] | None,
        output: Path | None,
        **kw: object,
    ) -> RenderResult:
        self.calls.append({"numbers": numbers, "output": output, **kw})
        return RenderResult(findings=self.findings, slides=numbers or [1, 2])


def _run(
    monkeypatch: pytest.MonkeyPatch,
    tiny: Path,
    args: list[str],
    findings: list[Finding],
) -> tuple[_Spy, int, str]:
    spy = _Spy(findings)
    monkeypatch.setattr("inkflow.cli.agent.render_slides", spy)
    result = CliRunner().invoke(
        main, ["render", "--deck", str(tiny / "deck.py"), *args]
    )
    return spy, result.exit_code, result.output


def test_check_writes_nothing_and_fails_on_a_problem(
    monkeypatch: pytest.MonkeyPatch, tiny: Path
) -> None:
    spy, code, out = _run(
        monkeypatch, tiny, ["--check"], [_finding("overflow", bottom=9)]
    )
    assert code == 1
    assert spy.calls[0]["output"] is None
    assert spy.calls[0]["numbers"] is None  # every slide
    assert "text overflows its zone by 9px (bottom)" in out
    assert out.strip().endswith("1 layout problem in 2 slides")


def test_check_passes_with_hints_only(
    monkeypatch: pytest.MonkeyPatch, tiny: Path
) -> None:
    _, code, out = _run(
        monkeypatch, tiny, ["--check"], [_finding("small-text", size=9)]
    )
    assert code == 0
    assert "1 hint in 2 slides" in out


def test_render_defaults_to_the_current_slide(
    monkeypatch: pytest.MonkeyPatch, tiny: Path
) -> None:
    spy, code, _ = _run(monkeypatch, tiny, [], [_finding("overflow", bottom=9)])
    assert code == 0  # images were written; problems are reported, not failed on
    assert spy.calls[0]["numbers"] == [1]
    assert spy.calls[0]["sheet"] is False


def test_sheet_defaults_to_every_slide(
    monkeypatch: pytest.MonkeyPatch, tiny: Path
) -> None:
    spy, _, _ = _run(monkeypatch, tiny, ["--sheet"], [])
    assert spy.calls[0]["numbers"] is None
    assert spy.calls[0]["sheet"] is True
    spy, _, _ = _run(monkeypatch, tiny, ["--sheet", "-s", "2", "-s", "1"], [])
    assert spy.calls[0]["numbers"] == [2, 1]


def test_check_and_sheet_exclude_each_other(
    monkeypatch: pytest.MonkeyPatch, tiny: Path
) -> None:
    _, code, out = _run(monkeypatch, tiny, ["--check", "--sheet"], [])
    assert code == 2
    assert "--check writes no images" in out


# ── in Chromium ───────────────────────────────────────────────────────────────

_LAYOUT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#fff"/>
      <rect id="zone-content" x="100" y="100" width="800" height="200"/>
      <rect id="zone-side" x="1000" y="100" width="800" height="600"/>
      <rect id="logo" x="1800" y="900" width="160" height="100" fill="red"/>
      <circle id="gone" cx="2500" cy="300" r="40" fill="blue"/>
      <g clip-path="url(#c)">
        <rect id="cropped" x="1850" y="0" width="300" height="50"/>
      </g>
      <clipPath id="c"><rect width="1920" height="1080"/></clipPath>
    </svg>
""")
_CHROMIUM_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "slide.svg",
                    zones={
                        "content": "\\n\\n".join(["A paragraph of text."] * 12),
                        "side": "Fits easily.",
                    },
                ),
                Slide("slide.svg", id="second", zones={"content": "Short."}),
            ],
        )
""")

needs_chromium = pytest.mark.skipif(
    find_chromium() is None, reason="no Chromium available"
)


@pytest.fixture
def broken(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "slide.svg").write_text(_LAYOUT_SVG)
    (tmp_path / "deck.py").write_text(_CHROMIUM_DECK)
    return tmp_path


def _size(png: Path) -> tuple[int, int]:
    width, height = struct.unpack(">II", png.read_bytes()[16:24])
    return width, height


@needs_chromium
def test_render_measures_and_writes_pngs(broken: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    result = render_slides(
        broken / "deck.py", None, out, scale=0.5, no_sandbox=True, contrast=False
    )
    assert [p.name for p in result.images] == ["slide-1.png", "slide-2.png"]
    assert _size(result.images[0]) == (960, 540)
    by_slide = {(f.slide, f.kind, f.target) for f in result.findings}
    assert (1, "overflow", "#zone-content") in by_slide
    assert (1, "outside", "#logo") in by_slide
    assert (1, "outside", "#gone") in by_slide
    assert not any(f.target in ("#zone-side", "#cropped") for f in result.findings)
    assert not any(f.slide == 2 and f.kind == "overflow" for f in result.findings)
    logo = next(f for f in result.findings if f.target == "#logo")
    assert (logo.right, logo.bottom, logo.entirely) == (40, 0, False)
    gone = next(f for f in result.findings if f.target == "#gone")
    assert gone.entirely


@needs_chromium
def test_render_single_png_and_sheet(broken: Path, tmp_path: Path) -> None:
    one = render_slides(
        broken / "deck.py", [2], tmp_path / "one.png", scale=0.25, no_sandbox=True
    )
    assert one.images == [(tmp_path / "one.png").resolve()]
    assert _size(one.images[0]) == (480, 270)

    sheet = render_slides(
        broken / "deck.py", None, tmp_path / "sheet", sheet=True, no_sandbox=True
    )
    assert [p.name for p in sheet.images] == ["sheet.png"]
    layout = sheet_layout(2, 1920, 1080)
    assert _size(sheet.images[0]) == (layout.width, layout.height)


@needs_chromium
def test_check_measures_without_writing(broken: Path) -> None:
    result = render_slides(broken / "deck.py", None, None, no_sandbox=True)
    assert result.images == []
    assert result.slides == [1, 2]
    assert any(f.kind == "overflow" for f in result.findings)
