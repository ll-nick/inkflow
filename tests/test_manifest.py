from __future__ import annotations

from inkflow.animations import Animation, Bounce, Cue, FadeIn, PlayVideo, SlideIn
from inkflow.enums import (
    Align,
    ColorMode,
    Direction,
    Easing,
    MediaAlign,
    MediaFit,
    Muted,
    Trigger,
    camel_to_kebab,
)
from inkflow.manifest import (
    Deck,
    Image,
    Inline,
    Media,
    Slide,
    TextBox,
    Video,
)
from inkflow.themes import Builtin
from inkflow.transitions import Crossfade, Cut, Morph, Push, Transition


def test_camel_to_kebab() -> None:
    assert camel_to_kebab("FadeIn") == "fade-in"
    assert camel_to_kebab("Highlight") == "highlight"


def test_animation_slug() -> None:
    assert FadeIn("x").slug() == "fade-in"
    assert SlideIn("x").slug() == "slide-in"
    assert Bounce("x").slug() == "bounce"


def test_transition_slug() -> None:
    assert Crossfade().slug() == "crossfade"
    assert Cut().slug() == "cut"
    assert Morph().slug() == "morph"


def test_animation_is_a_cue() -> None:
    assert isinstance(FadeIn("x"), Cue)


def test_play_video_is_a_cue_without_timing() -> None:
    pv = PlayVideo("media", Trigger.WITH_PREVIOUS)
    assert isinstance(pv, Cue)
    assert not isinstance(pv, Animation)
    assert pv.element == "media"
    assert pv.trigger == Trigger.WITH_PREVIOUS


def test_trigger_presets_and_pin() -> None:
    assert Trigger.ON_CLICK == "on-click"
    assert Trigger.WITH_PREVIOUS == "with-previous"
    assert Trigger.ON_CLICK.explicit_step is None
    assert Trigger.WITH_PREVIOUS.explicit_step is None
    assert Trigger.at(3).explicit_step == 3
    assert isinstance(Trigger.at(3), Trigger)


def test_slide_animations_default_empty() -> None:
    assert Slide(src="test.svg").animations == []


def test_deck_defaults() -> None:
    deck = Deck()
    assert deck.slides == []
    assert isinstance(deck.theme, Builtin)
    assert deck.mode == ColorMode.DARK


def test_deck_mode_default() -> None:
    assert Deck().mode == ColorMode.DARK


def test_deck_is_dataclass() -> None:
    assert "Deck(" in repr(Deck())


def test_deck_custom_theme() -> None:
    theme = Builtin()
    assert Deck(theme=theme).theme is theme


def test_animation_fields_stored() -> None:
    fade = FadeIn("headline", Trigger.WITH_PREVIOUS)
    assert fade.element == "headline"
    assert fade.trigger == Trigger.WITH_PREVIOUS


def test_transition_defaults() -> None:
    # Cut is the instant special case; every other type inherits the 0.5 base.
    assert Cut().duration == 0.0
    assert Crossfade().duration == 0.5
    assert Morph().duration == 0.5


def test_transition_base_default_duration() -> None:
    # A bare custom subclass animates without overriding duration.
    assert Transition().duration == 0.5


def test_transition_easing_defaults() -> None:
    # Easing defaults live in Python now (no JS-side fallback). Crossfade/Fade
    # inherit the base "ease"; Push/Cover/Zoom/Wipe override to "ease-in-out".

    assert Transition().easing == "ease"
    assert Crossfade().easing == "ease"
    assert Push().easing == "ease-in-out"


def test_transition_custom_duration() -> None:
    assert Crossfade(duration=0.8).duration == 0.8


def test_easing_value_object() -> None:
    import json

    # presets equal their CSS token
    assert Easing.EASE == "ease"
    assert Easing.EASE_IN_OUT == "ease-in-out"
    assert Easing.LINEAR == "linear"
    # factories build the CSS string
    assert (
        Easing.cubic_bezier(0.34, 1.56, 0.64, 1) == "cubic-bezier(0.34, 1.56, 0.64, 1)"
    )
    assert Easing.raw("steps(4, end)") == "steps(4, end)"
    # str subclass → JSON-serialises as its string (the transitions payload relies
    # on this) and is a real str
    assert json.loads(json.dumps({"easing": Easing.EASE_IN_OUT})) == {
        "easing": "ease-in-out"
    }
    assert isinstance(Easing.EASE, str)


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


def test_image_fields_defaults() -> None:
    m = Image("photo.png")
    assert m.src == "photo.png"
    assert m.fit == MediaFit.CONTAIN
    assert m.align == MediaAlign.CENTER
    assert m.x == 0.0
    assert m.y == 0.0


def test_image_fields_custom() -> None:
    m = Image("hero.jpg", fit=MediaFit.COVER, align=MediaAlign.TOP, x=10.0, y=-80.0)
    assert m.fit == MediaFit.COVER
    assert m.align == MediaAlign.TOP
    assert m.x == 10.0
    assert m.y == -80.0


def test_video_playback_defaults() -> None:
    v = Video("clip.mp4")
    assert v.src == "clip.mp4"
    assert v.fit == MediaFit.CONTAIN  # shares the media geometry fields
    assert v.controls is True
    assert v.autoplay is False
    assert v.muted is Muted.AUTO
    assert v.loop is False
    assert v.poster is None
    assert v.start is None
    assert v.end is None


def test_video_playback_custom() -> None:
    v = Video(
        "clip.mp4",
        controls=False,
        autoplay=True,
        muted=Muted.OFF,
        loop=True,
        poster="thumb.png",
        start=1.0,
        end=4.5,
    )
    assert v.controls is False
    assert v.autoplay is True
    assert v.muted is Muted.OFF
    assert v.loop is True
    assert v.poster == "thumb.png"
    assert v.start == 1.0
    assert v.end == 4.5


def test_media_alias_is_image_or_video() -> None:
    assert isinstance(Image("photo.png"), Media)
    assert isinstance(Video("clip.mp4"), Media)
    assert not isinstance(TextBox(text="x"), Media)


def test_muted_members() -> None:
    assert {m.name for m in Muted} == {"AUTO", "ON", "OFF"}


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
    anim = FadeIn("logo")
    s = Slide("layout.svg", animations=[anim])
    assert s.animations == [anim]


def test_slide_zones_stored() -> None:
    s = Slide("layout.svg", zones={"image": Image("photo.png"), "label": "hello"})
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
