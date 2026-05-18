from __future__ import annotations

from inkflow.manifest import Bounce, Deck, Fade, FadeOut, Morph, Slide


def test_slide_step_count_no_animations() -> None:
    assert Slide(src="test.svg").step_count == 0


def test_slide_step_count_returns_max() -> None:
    slide = Slide(
        src="test.svg",
        animations=[
            Fade("#a", step=1),
            Bounce("#b", step=3),
            FadeOut("#c", step=2),
        ],
    )
    assert slide.step_count == 3


def test_slide_step_count_single_animation() -> None:
    assert Slide(src="test.svg", animations=[FadeOut("#x", step=5)]).step_count == 5


def test_slide_animations_default_empty() -> None:
    assert Slide(src="test.svg").animations == []


def test_deck_defaults() -> None:
    deck = Deck()
    assert deck.main is None
    assert deck.slides == []


def test_deck_custom_main() -> None:
    assert Deck(main="main.svg").main == "main.svg"


def test_animation_fields_stored() -> None:
    fade = Fade("#headline", step=2)
    assert fade.element == "#headline"
    assert fade.step == 2


def test_morph_fields_stored() -> None:
    morph = Morph("#box", from_state="hidden", to_state="visible", step=1)
    assert morph.element == "#box"
    assert morph.from_state == "hidden"
    assert morph.to_state == "visible"
    assert morph.step == 1
