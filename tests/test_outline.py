from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest

from inkflow.deck_source import Editability
from inkflow.outline import (
    API_VERSION,
    ContentKind,
    ContentRef,
    DeckOutline,
    SlideOutline,
    ValueOutline,
    ZonesOutline,
    build_outline,
)
from inkflow.server import load_deck

_ZONED_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="0" y="0" width="1920" height="200"/>
      <rect id="zone-content" x="0" y="200" width="1920" height="700"/>
      <rect id="zone-media" x="0" y="900" width="1920" height="180"/>
      <text id="zone-slide-number" x="1800" y="1050">0</text>
      <rect id="box" x="0" y="0" width="10" height="10"/>
    </svg>
""")

_DECK_PY = textwrap.dedent("""\
    from inkflow import Deck, Inline, Slide, transitions
    from inkflow.animations import FadeIn, Frame

    def main():
        return Deck(
            title="Outline test",
            slides=[
                Slide(
                    "zoned",
                    md="intro.md",
                    notes="notes/intro.md",
                    transition=transitions.Push(),
                    animations=[FadeIn("box"), Frame()],
                ),
                Slide("content", id="later", visible=False, notes=Inline("hi")),
                Slide("missing"),
            ],
        )
""")


@pytest.fixture
def outline(tmp_path: Path) -> DeckOutline:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "zoned.svg").write_text(_ZONED_SVG, encoding="utf-8")
    (tmp_path / "slides" / "intro.md").write_text(
        "::title::\n# Hello\n::content::\nBody\n", encoding="utf-8"
    )
    deck_path = tmp_path / "deck.py"
    deck_path.write_text(_DECK_PY, encoding="utf-8")
    return build_outline(load_deck(deck_path), tmp_path, deck_path)


def _slide(outline: DeckOutline, index: int) -> SlideOutline:
    return outline.slides[index]


class TestDeckLevel:
    def test_deck_fields(self, outline: DeckOutline, tmp_path: Path) -> None:
        assert outline.api == API_VERSION
        assert outline.project_dir == tmp_path.resolve().as_posix()
        assert outline.deck_file == "deck.py"
        assert outline.title == "Outline test"
        assert outline.theme == "inkflow"
        assert outline.mode == "dark"
        assert outline.transition is None
        assert outline.overlays is None

    def test_json_round_trips(self, outline: DeckOutline) -> None:
        document = outline.to_json()

        assert cast("object", json.loads(json.dumps(document))) == document
        assert document["api"] == API_VERSION


class TestVisibleSlide:
    def test_identity_and_position(self, outline: DeckOutline) -> None:
        slide = _slide(outline, 0)

        assert (slide.index, slide.number, slide.id) == (0, 1, "intro")
        assert slide.title == "Hello"
        assert slide.path == "slides/zoned.svg"
        assert slide.parents == []
        assert slide.errors == []

    def test_zones_exclude_numbering_and_report_fill(
        self, outline: DeckOutline
    ) -> None:
        assert _slide(outline, 0).zones == ZonesOutline(
            available=["content", "media", "title"],
            filled=["content", "title"],
            default="content",
            numbered=True,
        )

    def test_content_transition_and_cues(self, outline: DeckOutline) -> None:
        slide = _slide(outline, 0)

        assert slide.md == ContentRef(ContentKind.FILE, "slides/intro.md")
        assert slide.notes == ContentRef(ContentKind.FILE, "notes/intro.md")
        assert slide.transition == ValueOutline(
            type="Push",
            fields={"duration": 0.5, "easing": "ease-in-out", "direction": "left"},
        )
        fade, frame = slide.cues
        assert (fade.type, fade.element, fade.trigger) == ("FadeIn", "box", "on-click")
        assert frame.element is None
        assert fade.defined_at is not None
        assert (fade.defined_at.path, fade.defined_at.line) == ("deck.py", 13)

    def test_location_and_editability(self, outline: DeckOutline) -> None:
        slide = _slide(outline, 0)

        assert slide.defined_at is not None
        assert (slide.defined_at.line, slide.defined_at.end_line) == (8, 14)
        assert slide.editability.level == Editability.LITERAL
        assert slide.editability.element == slide.defined_at


class TestHiddenAndBrokenSlides:
    def test_hidden_slide_keeps_its_explicit_id_but_no_number(
        self, outline: DeckOutline
    ) -> None:
        slide = _slide(outline, 1)

        assert (slide.index, slide.number, slide.id) == (1, None, "later")
        assert slide.visible is False
        assert slide.notes == ContentRef(ContentKind.INLINE, None)

    def test_layout_outside_the_project_is_named_by_reference(
        self, outline: DeckOutline
    ) -> None:
        slide = _slide(outline, 1)

        assert slide.path == "builtin:content"
        assert slide.parents == ["builtin:base", "builtin:numbered", "builtin:title"]

    def test_unresolvable_slide_reports_an_error_instead_of_failing(
        self, outline: DeckOutline
    ) -> None:
        slide = _slide(outline, 2)

        assert slide.zones is None
        assert len(slide.errors) == 1
        assert slide.number == 2
