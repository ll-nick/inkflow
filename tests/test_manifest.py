from __future__ import annotations

from inkflow.animations import Bounce, FadeIn, FadeOut
from inkflow.manifest import (
    Align,
    ColorMode,
    Deck,
    Direction,
    Inline,
    Media,
    MediaAlign,
    MediaFit,
    Slide,
    TextBox,
)
from inkflow.transitions import Crossfade, Cut, Morph


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
    assert deck.slides == []
    assert deck.theme is None
    assert deck.mode == ColorMode.DARK


def test_deck_mode_default() -> None:
    assert Deck().mode == ColorMode.DARK


def test_deck_is_dataclass() -> None:
    assert "Deck(" in repr(Deck())


def test_deck_custom_theme() -> None:
    assert Deck(theme="./my-theme").theme == "./my-theme"


def test_animation_fields_stored() -> None:
    fade = FadeIn("#headline", step=2)
    assert fade.element == "#headline"
    assert fade.step == 2


def test_transition_defaults() -> None:
    # Cut is the instant special case; every other type inherits the 0.5 base.
    assert Cut().duration == 0.0
    assert Crossfade().duration == 0.5
    assert Morph().duration == 0.5


def test_transition_base_default_duration() -> None:
    # A bare custom subclass animates without overriding duration.
    from inkflow.manifest import Transition

    assert Transition().duration == 0.5


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


def test_textbox_fields() -> None:
    tb = TextBox(text="<p>hello</p>", align=Align.CENTER)
    assert tb.text == "<p>hello</p>"
    assert tb.align == Align.CENTER


def test_textbox_defaults() -> None:
    tb = TextBox()
    assert tb.text is None
    assert tb.align is None


def test_media_fields_defaults() -> None:
    m = Media("photo.png")
    assert m.src == "photo.png"
    assert m.fit == MediaFit.CONTAIN
    assert m.align == MediaAlign.CENTER
    assert m.x == 0.0
    assert m.y == 0.0


def test_media_fields_custom() -> None:
    m = Media("hero.jpg", fit=MediaFit.COVER, align=MediaAlign.TOP, x=10.0, y=-80.0)
    assert m.fit == MediaFit.COVER
    assert m.align == MediaAlign.TOP
    assert m.x == 10.0
    assert m.y == -80.0


def test_slide_zones_defaults_empty() -> None:
    assert Slide(src="x.svg").zones == {}


def test_slide_extra_style_default_none() -> None:
    assert Slide(src="x.svg").extra_style is None


def test_slide_md_defaults_none() -> None:
    assert Slide(src="x.svg").md is None


def test_deck_style_defaults_none() -> None:
    assert Deck().style is None


def test_deck_style_stored() -> None:
    assert Deck(style="styles.css").style == "styles.css"


def test_deck_style_inline() -> None:
    assert Deck(style=Inline("body { color: red; }")).style == "body { color: red; }"


def test_deck_font_size_defaults() -> None:
    assert Deck().font_size == 36


def test_deck_font_size_stored() -> None:
    assert Deck(font_size=48).font_size == 48


def test_slide_md_field() -> None:
    s = Slide("layouts/bullets.svg", md="slides/05.md")
    assert s.src == "layouts/bullets.svg"
    assert s.md == "slides/05.md"
    assert s.animations == []
    assert s.transition is None
    assert s.extra_style is None


def test_slide_animations_stored() -> None:
    anim = FadeIn("#logo", step=1)
    s = Slide("layout.svg", animations=[anim])
    assert s.animations == [anim]


def test_slide_zones_stored() -> None:
    s = Slide("layout.svg", zones={"image": Media("photo.png"), "label": "hello"})
    assert isinstance(s.zones["image"], Media)
    assert s.zones["label"] == "hello"


# ── New type tests ────────────────────────────────────────────────────────────


def test_inline_is_str() -> None:
    i = Inline("hello")
    assert isinstance(i, str)
    assert i == "hello"


def test_direction_values() -> None:
    assert Direction.LEFT == "left"
    assert Direction.RIGHT == "right"
    assert Direction.UP == "up"
    assert Direction.DOWN == "down"


def test_mediafit_values() -> None:
    assert MediaFit.CONTAIN == "contain"
    assert MediaFit.COVER == "cover"
    assert MediaFit.FILL == "fill"
    assert MediaFit.NONE == "none"
    assert MediaFit.SCALE_DOWN == "scale-down"


def test_mediaalign_values() -> None:
    assert MediaAlign.CENTER == "center"
    assert MediaAlign.TOP == "top"
    assert MediaAlign.BOTTOM == "bottom"
    assert MediaAlign.LEFT == "left"
    assert MediaAlign.RIGHT == "right"
    assert MediaAlign.TOP_LEFT == "top-left"
    assert MediaAlign.TOP_RIGHT == "top-right"
    assert MediaAlign.BOTTOM_LEFT == "bottom-left"
    assert MediaAlign.BOTTOM_RIGHT == "bottom-right"


def test_colormode_values() -> None:
    assert ColorMode.DARK == "dark"
    assert ColorMode.LIGHT == "light"


def test_slide_id_default_is_none() -> None:
    assert Slide(src="cover").id is None


def test_slide_id_explicit() -> None:
    assert Slide(src="cover", id="my-cover").id == "my-cover"
