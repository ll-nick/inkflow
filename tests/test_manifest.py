from __future__ import annotations

from inkflow.manifest import Bounce, Crossfade, Cut, Deck, FadeIn, FadeOut, Morph, Slide


def test_slide_step_count_no_animations() -> None:
    assert Slide(src="test.svg").step_count == 0


def test_slide_step_count_returns_max() -> None:
    slide = Slide(
        src="test.svg",
        animations=[
            FadeIn("#a", step=1),
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
    fade = FadeIn("#headline", step=2)
    assert fade.element == "#headline"
    assert fade.step == 2


def test_transition_defaults() -> None:
    assert Cut().duration == 0.0
    assert Crossfade().duration == 0.4
    assert Morph().duration == 0.5


def test_transition_custom_duration() -> None:
    assert Crossfade(duration=0.8).duration == 0.8


def test_deck_transition_default_none() -> None:
    assert Deck().transition is None


def test_deck_transition_stored() -> None:
    assert isinstance(Deck(transition=Crossfade()).transition, Crossfade)


def test_slide_transition_default_none() -> None:
    assert Slide(src="x.svg").transition is None


def test_slide_transition_stored() -> None:
    slide = Slide(src="x.svg", transition=Cut())
    assert isinstance(slide.transition, Cut)
