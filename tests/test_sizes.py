"""Deck sizes: PageSize parsing and presets, and every place a size is used."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow import PageSize
from inkflow.editor.model import build_model
from inkflow.editor.outline import build_outline, format_outline
from inkflow.editor.session import EditorSession
from inkflow.enums import ColorMode
from inkflow.layout import create_slide, discover_layouts, layouts_for
from inkflow.manifest import Deck, Slide
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.sizes import parse_view_box, physical_length_pt, same_aspect
from inkflow.svgio import parse_svg_file
from inkflow.sync import PreviewContext
from inkflow.themes import Builtin
from inkflow.verify import verify_slide


class TestPageSize:
    @pytest.mark.parametrize(
        ("name", "canvas"),
        [
            ("16:9", (1920, 1080)),
            ("4:3", (1440, 1080)),
            ("16:10", (1728, 1080)),
            ("9:16", (1080, 1920)),
            ("phone", (1080, 1920)),
            ("1:1", (1080, 1080)),
        ],
    )
    def test_screen_ratios_keep_1080_on_the_short_side(
        self, name: str, canvas: tuple[float, float]
    ) -> None:
        size = PageSize(name)
        assert size.canvas == canvas
        assert not size.is_print
        # A screen page is its canvas at 1 unit = 1 CSS px.
        assert size.page_pt == (canvas[0] * 0.75, canvas[1] * 0.75)
        assert size.page_css == (f"{canvas[0]:g}px", f"{canvas[1]:g}px")

    def test_a0_is_exact(self) -> None:
        a0 = PageSize("a0")
        assert a0.canvas == (3179, 4494)
        assert a0.page_css == ("841mm", "1189mm")
        assert a0.page_pt == pytest.approx((2383.937, 3370.394), abs=1e-3)
        assert a0.is_print
        assert a0.label == "A0 portrait (841 x 1189 mm)"

    def test_a_sizes_share_the_a0_canvas(self) -> None:
        for n in range(6):
            assert PageSize(f"a{n}").canvas == (3179, 4494)
            assert PageSize(f"a{n}-landscape").canvas == (4494, 3179)
        assert PageSize("a1").page_css == ("594mm", "841mm")
        assert PageSize("a3-landscape").page_css == ("420mm", "297mm")
        # The sheets differ by rounding only: the same shape.
        assert same_aspect(PageSize("a4").canvas, (210, 297))

    def test_names_are_normalized(self) -> None:
        assert PageSize("A0") == "a0"
        assert PageSize(" A1 Landscape ") == "a1-landscape"
        assert PageSize("a2_landscape") == "a2-landscape"
        assert PageSize("a3-portrait") == "a3"
        assert PageSize("1920 x 1080") == "1920x1080"
        assert PageSize("1280x720px") == "1280x720"
        assert PageSize("841 \u00d7 1189mm") == "841x1189mm"
        assert PageSize("Widescreen") == "16:9"
        assert PageSize(PageSize.A0) is PageSize.A0

    def test_constructors(self) -> None:
        assert PageSize.mm(600, 900) == "600x900mm"
        assert PageSize.cm(60, 90.5) == "60x90.5cm"
        assert PageSize.inches(36, 48) == "36x48in"
        assert PageSize.px(1280, 720) == "1280x720"
        assert PageSize.mm(841, 1189).canvas == PageSize.A0.canvas
        assert PageSize.inches(36, 48).canvas == (3456, 4608)
        assert PageSize.inches(36, 48).page_pt == (2592, 3456)
        assert PageSize.cm(60, 90).page_css == ("60cm", "90cm")
        assert not PageSize.px(1280, 720).is_print

    def test_paper_sizes(self) -> None:
        letter = PageSize("letter")
        assert letter.canvas == (816, 1056)
        assert letter.page_pt == (612, 792)
        assert PageSize("letter-landscape").page_css == ("11in", "8.5in")
        assert PageSize("tabloid").page_pt == (792, 1224)

    def test_turning(self) -> None:
        assert PageSize.A0.landscape() == "a0-landscape"
        assert PageSize("a0-landscape").portrait() == "a0"
        assert PageSize.A0.portrait() is PageSize.A0
        assert PageSize("9:16").landscape() == "16:9"
        assert PageSize("16:10").rotated().canvas == (1080, 1728)
        assert PageSize.inches(36, 48).rotated() == "48x36in"
        assert PageSize("letter").rotated() == "letter-landscape"

    @pytest.mark.parametrize(
        "bad",
        ["", "a9", "b1", "16:9-landscape", "0x100mm", "10x10mm", "1x1", "huge", "a0x"],
    )
    def test_unknown_sizes_are_refused(self, bad: str) -> None:
        with pytest.raises(ValueError, match="page size"):
            PageSize(bad)

    def test_base_font(self) -> None:
        # Screens: the theme's size for a 1080-high slide.
        assert PageSize("16:9").base_font(36) == 36
        assert PageSize("9:16").base_font(36) == 36
        assert PageSize.px(1280, 720).base_font(36) == 24
        # Paper: the shorter side over 80, 30 pt on A0.
        a0 = PageSize.A0
        assert a0.base_font(36) == 40
        assert a0.base_font(36) * a0.pt_per_unit == pytest.approx(30, abs=0.5)
        # A1 is A0 scaled down, its text too.
        a1 = PageSize.A1
        assert a1.base_font(36) == 40
        assert a1.base_font(36) * a1.pt_per_unit == pytest.approx(21.2, abs=0.5)
        # A4 and letter have a 10 pt floor.
        assert PageSize.A4.base_font(36) * PageSize.A4.pt_per_unit >= 9.9
        assert PageSize.LETTER.base_font(36) * PageSize.LETTER.pt_per_unit >= 9.7
        # A theme with a larger type scale keeps its proportion.
        assert a0.base_font(48) > a0.base_font(36)

    def test_chart_text_is_larger_on_paper(self) -> None:
        assert PageSize.A0.chart_text_scale > PageSize.WIDESCREEN.chart_text_scale

    def test_helpers(self) -> None:
        assert parse_view_box("0 0 3179 4494") == (0, 0, 3179, 4494)
        assert parse_view_box("0,0,10,10") == (0, 0, 10, 10)
        assert parse_view_box("0 0 0 10") is None
        assert parse_view_box(None) is None
        assert physical_length_pt("841mm") == pytest.approx(2383.937, abs=1e-3)
        assert physical_length_pt("11in") == 792
        assert physical_length_pt("2pc") == 24
        assert physical_length_pt("1920") is None
        assert physical_length_pt("100%") is None


class TestDeckSize:
    def test_default_is_unset_and_16_9(self) -> None:
        deck = Deck()
        assert deck.size is None
        assert deck.effective_size == "16:9"
        assert deck.effective_font_size == 36
        assert deck.effective_mode == ColorMode.DARK
        assert not deck.is_print

    def test_a_string_becomes_a_page_size(self) -> None:
        deck = Deck(size="A1-Landscape")
        assert isinstance(deck.size, PageSize)
        assert deck.size == "a1-landscape"
        with pytest.raises(ValueError, match="page size"):
            Deck(size="a7")

    def test_print_decks_are_light_with_a_print_type_scale(self) -> None:
        deck = Deck(size="a0")
        assert deck.is_print
        assert deck.effective_mode == ColorMode.LIGHT
        assert deck.effective_font_size == 40
        # The deck's own choices win.
        assert Deck(size="a0", mode=ColorMode.DARK).effective_mode == ColorMode.DARK
        assert Deck(size="a0", font_size=32).effective_font_size == 32

    def test_a_theme_that_chose_its_mode_keeps_it(self) -> None:
        class Night(Builtin):
            mode: ColorMode = ColorMode.DARK

        assert Deck(size="a0", theme=Night()).effective_mode == ColorMode.DARK
        assert Deck(size="a0", theme=Builtin()).effective_mode == ColorMode.LIGHT

    def test_a_screen_size_keeps_the_theme_mode(self) -> None:
        assert Deck(size="9:16").effective_mode == ColorMode.DARK


# ── Where the size is used ────────────────────────────────────────────────────

POSTER_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(size="a0", slides=[Slide("poster.svg")])
""")

POSTER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3179 4494">'
    '<rect id="box" x="100" y="100" width="400" height="300"/></svg>'
)


@pytest.fixture
def poster(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "poster.svg").write_text(POSTER_SVG, encoding="utf-8")
    (tmp_path / "deck.py").write_text(POSTER_DECK, encoding="utf-8")
    return tmp_path


def test_blank_slide_takes_the_canvas(tmp_path: Path) -> None:
    out = tmp_path / "blank.svg"
    create_slide(None, out, None, None, PageSize.A0.canvas)
    root = parse_svg_file(out)
    assert root.get("viewBox") == "0 0 3179 4494"
    assert root.get("width") == "3179"
    default = tmp_path / "default.svg"
    create_slide(None, default, None, None)
    assert parse_svg_file(default).get("viewBox") == "0 0 1920 1080"


def test_editor_new_slide_is_poster_sized(poster: Path) -> None:
    session = EditorSession(poster / "deck.py")
    session.apply(
        {"action": "slide", "op": "new", "after": 0}, load_deck(poster / "deck.py")
    )
    deck = load_deck(poster / "deck.py")
    assert len(deck.slides) == 2
    new = parse_svg_file(poster / "slides" / deck.slides[1].src)
    assert new.get("viewBox") == "0 0 3179 4494"


def test_cli_add_uses_the_deck_size(poster: Path) -> None:
    from click.testing import CliRunner

    from inkflow.cli import main

    result = CliRunner().invoke(
        main,
        ["add", str(poster / "slides" / "new.svg"), "--deck", str(poster / "deck.py")],
    )
    assert result.exit_code == 0, result.output
    root = parse_svg_file(poster / "slides" / "new.svg")
    assert root.get("viewBox") == "0 0 3179 4494"


def test_model_and_outline_report_the_size(poster: Path) -> None:
    deck = load_deck(poster / "deck.py")
    slides = process_deck(deck, poster, poster / "deck.py", editor=True)
    model = build_model(deck, poster / "deck.py", slides)
    size = model["deckSize"]
    assert size == {
        "name": "a0",
        "label": "A0 portrait (841 x 1189 mm)",
        "canvas": [3179, 4494],
        "page": [2383.94, 3370.39],
        "print": True,
        "fontSize": 40,
    }
    text = format_outline(build_outline(deck, poster / "deck.py", slides))
    head = text.splitlines()[0]
    assert "size a0: A0 portrait (841 x 1189 mm), canvas 3179x4494" in head
    assert "mode light" in head


def test_project_layouts_are_offered_whatever_their_shape(tmp_path: Path) -> None:
    (tmp_path / "layouts").mkdir()
    (tmp_path / "layouts" / "mine.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 768"/>'
    )
    found = discover_layouts(tmp_path, Builtin())
    names = {p.stem for _, p in layouts_for(found, PageSize.A0)}
    assert "mine" in names


def test_verify_warns_about_a_slide_of_another_shape(poster: Path) -> None:
    (poster / "slides" / "wide.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"/>'
    )
    deck = Deck(size="a0", slides=[])
    preview = PreviewContext(deck=deck, project_dir=poster, theme=None)
    issues = verify_slide(Slide("slides/wide.svg"), poster, None, preview)
    assert any("letterboxed" in msg for _, msg in issues)
    ok = verify_slide(Slide("slides/poster.svg"), poster, None, preview)
    assert not any("letterboxed" in msg for _, msg in ok)
    # A deck without a size has no shape to compare against.
    unsized = PreviewContext(deck=Deck(slides=[]), project_dir=poster, theme=None)
    issues = verify_slide(Slide("slides/wide.svg"), poster, None, unsized)
    assert not any("letterboxed" in msg for _, msg in issues)
