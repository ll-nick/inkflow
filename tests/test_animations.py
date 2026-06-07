from __future__ import annotations

from inkflow.animations import (
    Bounce,
    FadeIn,
    FadeOut,
    Highlight,
    SlideIn,
    SlideOut,
    ZoomIn,
    ZoomOut,
)
from inkflow.manifest import Animation


def test_shared_params_default_none() -> None:
    fade = FadeIn("#a")
    assert fade.element == "#a"
    assert fade.step == 1
    assert fade.duration is None
    assert fade.easing is None
    assert fade.delay is None


def test_shared_params_are_keyword_only() -> None:
    # duration/easing/delay are kw_only, so the second positional is `step`,
    # never a timing param.
    fade = FadeIn("#a", 3)
    assert fade.step == 3
    assert fade.duration is None


def test_shared_params_stored() -> None:
    fade = FadeIn("#a", duration=0.8, easing="ease-in", delay=0.2)
    assert (fade.duration, fade.easing, fade.delay) == (0.8, "ease-in", 0.2)


def test_slide_in_defaults_and_fields() -> None:
    s = SlideIn("#a")
    assert s.direction == "left"
    assert s.distance is None
    s2 = SlideIn("#a", direction="right", distance=120)
    assert (s2.direction, s2.distance) == ("right", 120)


def test_slide_out_defaults() -> None:
    assert SlideOut("#a").direction == "left"


def test_zoom_scale_field() -> None:
    assert ZoomIn("#a").scale is None
    assert ZoomOut("#a", scale=0.5).scale == 0.5


def test_highlight_fields() -> None:
    h = Highlight("#a", color="#f00", passes=3)
    assert (h.color, h.passes) == ("#f00", 3)


def test_all_types_are_animations() -> None:
    for cls in (FadeIn, FadeOut, Bounce, SlideIn, SlideOut, ZoomIn, ZoomOut, Highlight):
        assert isinstance(cls("#a"), Animation)
