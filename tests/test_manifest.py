from __future__ import annotations

from inkflow.manifest import (
    Bounce,
    Crossfade,
    Cut,
    Deck,
    FadeIn,
    FadeOut,
    MarkdownSlide,
    Media,
    Morph,
    Slide,
    TextBox,
)


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
    assert deck.themes == {}


def test_deck_custom_themes() -> None:
    themes = {"my-theme": "./themes/my-theme"}
    assert Deck(themes=themes).themes == themes


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


def test_textbox_fields() -> None:
    tb = TextBox("#zone-content", text="<p>hello</p>", steps=True)
    assert tb.element == "#zone-content"
    assert tb.text == "<p>hello</p>"
    assert tb.steps is True
    assert tb.src is None


def test_textbox_defaults() -> None:
    tb = TextBox("#zone-content")
    assert tb.src is None
    assert tb.text is None
    assert tb.steps is False


def test_media_fields_defaults() -> None:
    m = Media("#zone-photo", src="photo.png")
    assert m.element == "#zone-photo"
    assert m.src == "photo.png"
    assert m.fit == "contain"
    assert m.align == "center"
    assert m.x == 0.0
    assert m.y == 0.0


def test_media_fields_custom() -> None:
    m = Media("#zone-hero", src="hero.jpg", fit="cover", align="top", x=10.0, y=-80.0)
    assert m.fit == "cover"
    assert m.align == "top"
    assert m.x == 10.0
    assert m.y == -80.0


def test_slide_content_defaults_empty() -> None:
    assert Slide(src="x.svg").content == []


def test_slide_style_defaults_empty() -> None:
    assert Slide(src="x.svg").style == ""


def test_slide_content_stored() -> None:
    slide = Slide(src="x.svg", content=[TextBox("#zone-content", text="hi")])
    assert len(slide.content) == 1


def test_deck_style_defaults_empty() -> None:
    assert Deck().style == ""


def test_deck_style_stored() -> None:
    assert Deck(style="body { color: red; }").style == "body { color: red; }"


def test_deck_font_size_defaults() -> None:
    assert Deck().font_size == 36


def test_deck_font_size_stored() -> None:
    assert Deck(font_size=48).font_size == 48


def test_markdownslide_fields() -> None:
    ms = MarkdownSlide("layouts/bullets.svg", src="slides/05.md", steps=True)
    assert ms.layout == "layouts/bullets.svg"
    assert ms.src == "slides/05.md"
    assert ms.steps is True
    assert ms.animations == []
    assert ms.transition is None
    assert ms.style == ""


def test_markdownslide_animations_stored() -> None:
    anim = FadeIn("#logo", step=1)
    ms = MarkdownSlide("layout.svg", animations=[anim])
    assert ms.animations == [anim]


def test_markdownslide_kwargs_captured() -> None:
    ms = MarkdownSlide("layout.svg", image="photo.png", video="clip.mp4")
    assert ms._extra == {"image": "photo.png", "video": "clip.mp4"}  # pyright: ignore[reportPrivateUsage]
