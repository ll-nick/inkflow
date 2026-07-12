# pyright: reportPrivateUsage=none
from __future__ import annotations

import logging
import textwrap
from pathlib import Path

import pytest

from inkflow.animations import (
    Bounce,
    FadeIn,
    FadeOut,
    Highlight,
    SlideIn,
    ZoomIn,
)
from inkflow.enums import Direction
from inkflow.logging import collect_logs
from inkflow.manifest import (
    Animation,
    Deck,
    Image,
    Inline,
    Slide,
)
from inkflow.pipeline import _add_layout_classes as _add_layout_classes_el
from inkflow.pipeline import (
    _deduplicate_ids,
    _infer_slide_id,
    process_deck,
    resolve_slide_src,
    resolve_transitions,
)
from inkflow.pipeline import annotate_svg as _annotate_svg_el
from inkflow.svgio import parse_svg, serialize_svg
from inkflow.transitions import Crossfade, Cut, Morph


# String adapters: these pipeline DOM functions now take and return an element
# (parse once). These same-named wrappers keep the string call sites below.
def annotate_svg(svg: str, anims: list[Animation]) -> str:
    return serialize_svg(_annotate_svg_el(parse_svg(svg), anims))


def _add_layout_classes(svg: str, chain: list[Path], src: Path) -> str:
    return serialize_svg(_add_layout_classes_el(parse_svg(svg), chain, src))


_PLAIN_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect id="box" x="0" y="0" width="50" height="50"/>
      <circle id="dot" cx="75" cy="25" r="10"/>
    </svg>
""")


class TestResolveSlideSource:
    def _make_slide(self, tmp_path: Path, name: str) -> Path:
        p = tmp_path / "slides" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(_PLAIN_SVG, encoding="utf-8")
        return p

    def test_bare_name_finds_slides_svg(self, tmp_path: Path) -> None:
        expected = self._make_slide(tmp_path, "title.svg")
        assert resolve_slide_src("title", tmp_path) == expected

    def test_svg_filename_finds_slides_svg(self, tmp_path: Path) -> None:
        expected = self._make_slide(tmp_path, "01-title.svg")
        assert resolve_slide_src("01-title.svg", tmp_path) == expected

    def test_explicit_slides_prefix_still_works(self, tmp_path: Path) -> None:
        expected = self._make_slide(tmp_path, "01-title.svg")
        assert resolve_slide_src("slides/01-title.svg", tmp_path) == expected

    def test_bare_name_not_in_slides_falls_through_to_layout(
        self, tmp_path: Path
    ) -> None:
        layout = tmp_path / "layouts" / "content.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_PLAIN_SVG, encoding="utf-8")
        assert resolve_slide_src("content", tmp_path) == layout


class TestAnnotateSvg:
    def test_fade_adds_class_and_step(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [FadeIn("#box", step=1)])
        assert 'class="anim-fade-in"' in result
        assert 'data-step="1"' in result

    def test_fade_out_adds_class(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [FadeOut("#box", step=2)])
        assert 'class="anim-fade-out"' in result
        assert 'data-step="2"' in result

    def test_bounce_adds_class(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [Bounce("#dot", step=3)])
        assert 'class="anim-bounce"' in result
        assert 'data-step="3"' in result

    def test_preserves_existing_class(self) -> None:
        svg = _PLAIN_SVG.replace('<rect id="box"', '<rect id="box" class="my-class"')
        result = annotate_svg(svg, [FadeIn("#box", step=1)])
        assert 'class="my-class anim-fade-in"' in result

    def test_missing_element_warns_and_continues(self) -> None:
        with collect_logs(logging.WARNING) as warnings:
            result = annotate_svg(_PLAIN_SVG, [FadeIn("#nonexistent", step=1)])
        assert any("nonexistent" in w.message for w in warnings)
        assert 'id="box"' in result  # rest of SVG intact

    def test_multiple_animations_applied(self) -> None:
        result = annotate_svg(
            _PLAIN_SVG, [FadeIn("#box", step=1), Bounce("#dot", step=2)]
        )
        assert "anim-fade-in" in result
        assert "anim-bounce" in result

    def test_no_animations_leaves_svg_unchanged(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [])
        assert "anim-" not in result
        assert 'id="box"' in result

    def test_class_derived_from_type_name(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [ZoomIn("#box")])
        assert "anim-zoom-in" in result

    def test_direction_becomes_modifier_class_not_prop(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [SlideIn("#box", direction=Direction.RIGHT)])
        assert "anim-slide-in" in result
        assert "anim-from-right" in result
        assert "--anim-direction" not in result

    def test_params_emit_custom_props(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [FadeIn("#box", duration=0.8, delay=0.2)])
        assert "--anim-duration: 0.8s" in result
        assert "--anim-delay: 0.2s" in result

    def test_default_params_emit_python_defaults(self) -> None:
        # Defaults live in Python and are always emitted (no CSS fallback).
        result = annotate_svg(_PLAIN_SVG, [FadeIn("#box")])
        assert "--anim-duration: 0.4s" in result
        assert "--anim-easing: ease" in result
        assert "--anim-delay: 0.0s" in result

    def test_distance_uses_px_unit(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [SlideIn("#box", distance=120)])
        assert "--anim-distance: 120px" in result

    def test_scale_and_color_emitted_raw(self) -> None:
        result = annotate_svg(
            _PLAIN_SVG,
            [Highlight("#box", color="#ff0000", passes=3)],
        )
        assert "--anim-color: #ff0000" in result
        assert "--anim-passes: 3" in result

    def test_preserves_existing_style(self) -> None:
        svg = _PLAIN_SVG.replace('<rect id="box"', '<rect id="box" style="fill:red"')
        result = annotate_svg(svg, [FadeIn("#box", duration=0.8)])
        assert "fill:red" in result
        assert "--anim-duration: 0.8s" in result


class TestResolveTransitions:
    def _deck(
        self,
        deck_t: Crossfade | Cut | Morph | None = None,
        slide_ts: list[Crossfade | Cut | Morph | None] | None = None,
    ) -> Deck:
        d = Deck(transition=deck_t)
        d.slides = [
            Slide(src=f"{i}.svg", transition=t)
            for i, t in enumerate(slide_ts or [None])
        ]
        return d

    def test_defaults_to_cut(self) -> None:
        d = self._deck()
        assert resolve_transitions(d) == [{"type": "cut", "duration": 0.0}]

    def test_deck_level_crossfade(self) -> None:
        d = self._deck(deck_t=Crossfade(0.6), slide_ts=[None, None])
        result = resolve_transitions(d)
        assert result == [
            {"type": "crossfade", "duration": 0.6, "easing": "ease"},
            {"type": "crossfade", "duration": 0.6, "easing": "ease"},
        ]

    def test_slide_overrides_deck(self) -> None:
        d = self._deck(deck_t=Crossfade(), slide_ts=[Cut(), None])
        result = resolve_transitions(d)
        # Cut is an explicit object here, so it carries the base easing default.
        assert result[0] == {"type": "cut", "duration": 0.0, "easing": "ease"}
        assert result[1] == {"type": "crossfade", "duration": 0.5, "easing": "ease"}

    def test_morph_serialized(self) -> None:
        d = self._deck(slide_ts=[Morph(0.8)])
        assert resolve_transitions(d) == [
            {"type": "morph", "duration": 0.8, "easing": "ease"}
        ]


_ZONE_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

_LAYOUT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")


class TestProcessSlideWithContent:
    def _write_slide(self, tmp_path: Path, name: str, content: str) -> Path:
        p = tmp_path / "slides" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return p

    def test_foreignobject_replaces_zone_rect(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "hello"})])
        results = process_deck(deck, tmp_path)
        assert len(results) == 1
        assert "foreignObject" in results[0]["svg"]
        assert "hello" in results[0]["svg"]

    def test_zone_rect_id_inherited_by_foreignobject(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "hi"})])
        results = process_deck(deck, tmp_path)
        assert 'id="zone-content"' in results[0]["svg"]

    def test_unreferenced_zone_rects_removed(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _LAYOUT_SVG)
        # Only supply content for zone-content, leave zone-title unconsumed
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "body"})])
        results = process_deck(deck, tmp_path)
        assert 'id="zone-title"' not in results[0]["svg"]

    def test_foreignobject_content_has_inkflow_content_class(
        self, tmp_path: Path
    ) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "x"})])
        results = process_deck(deck, tmp_path)
        assert "inkflow-content" in results[0]["svg"]


class TestLayoutBackedSlideExpansion:
    def _setup(self, tmp_path: Path) -> tuple[Path, Path]:
        layout = tmp_path / "layouts" / "layout.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_LAYOUT_SVG, encoding="utf-8")
        slides_dir = tmp_path / "slides"
        slides_dir.mkdir(parents=True, exist_ok=True)
        return layout, slides_dir

    def test_markdown_slide_expands_to_foreignobject(self, tmp_path: Path) -> None:
        _, slides_dir = self._setup(tmp_path)
        md = slides_dir / "content.md"
        md.write_text("# Hello\n\nBody text here.\n", encoding="utf-8")
        deck = Deck(slides=[Slide("layout", md="content")])
        results = process_deck(deck, tmp_path)
        assert len(results) == 1
        assert "foreignObject" in results[0]["svg"]
        assert "Body text" in results[0]["svg"]

    def test_markdown_slide_title_extracted(self, tmp_path: Path) -> None:
        _, slides_dir = self._setup(tmp_path)
        md = slides_dir / "content.md"
        md.write_text("# My Title\n\nSome content.\n", encoding="utf-8")
        deck = Deck(slides=[Slide("layout", md="content")])
        results = process_deck(deck, tmp_path)
        assert results[0]["title"] == "My Title"

    def test_markdown_slide_animations_applied(self, tmp_path: Path) -> None:
        _, slides_dir = self._setup(tmp_path)
        (slides_dir / "content.md").write_text("", encoding="utf-8")
        deck = Deck(
            slides=[
                Slide(
                    "layout", md="content", animations=[FadeIn("#zone-title", step=1)]
                )
            ]
        )
        results = process_deck(deck, tmp_path)
        assert "anim-fade-in" in results[0]["svg"]

    def test_zones_media_injected(self, tmp_path: Path) -> None:
        self._setup(tmp_path)
        deck = Deck(slides=[Slide("layout", zones={"content": Image("photo.jpg")})])
        results = process_deck(deck, tmp_path)
        assert "photo.jpg" in results[0]["svg"]

    def test_zones_inline_markdown_injected(self, tmp_path: Path) -> None:
        self._setup(tmp_path)
        deck = Deck(slides=[Slide("layout", zones={"content": "**bold text**"})])
        results = process_deck(deck, tmp_path)
        assert "bold" in results[0]["svg"]


class TestLayoutClasses:
    def test_full_chain_adds_all_classes(self, tmp_path: Path) -> None:
        base = tmp_path / "base.svg"
        cover = tmp_path / "cover.svg"
        src = tmp_path / "hero.svg"
        for p in (base, cover, src):
            p.write_text(_PLAIN_SVG, encoding="utf-8")
        result = _add_layout_classes(_PLAIN_SVG, [base, cover], src)
        assert 'class="layout-base layout-cover layout-hero"' in result

    def test_standalone_gets_src_stem_class(self, tmp_path: Path) -> None:
        src = tmp_path / "standalone.svg"
        src.write_text(_PLAIN_SVG, encoding="utf-8")
        result = _add_layout_classes(_PLAIN_SVG, [], src)
        assert 'class="layout-standalone"' in result

    def test_existing_non_layout_classes_preserved(self, tmp_path: Path) -> None:
        src = tmp_path / "slide.svg"
        svg = _PLAIN_SVG.replace("<svg ", '<svg class="my-class" ')
        result = _add_layout_classes(svg, [], src)
        assert "my-class" in result
        assert "layout-slide" in result

    def test_existing_layout_classes_replaced(self, tmp_path: Path) -> None:
        src = tmp_path / "slide.svg"
        svg = _PLAIN_SVG.replace("<svg ", '<svg class="layout-old" ')
        result = _add_layout_classes(svg, [], src)
        assert "layout-old" not in result
        assert "layout-slide" in result

    def test_layout_class_in_processed_slide(self, tmp_path: Path) -> None:
        layouts_dir = tmp_path / "layouts"
        layouts_dir.mkdir()
        (layouts_dir / "mylayout.svg").write_text(_ZONE_SLIDE_SVG, encoding="utf-8")
        (tmp_path / "slides").mkdir()
        deck = Deck(slides=[Slide("mylayout", zones={"content": "hi"})])
        results = process_deck(deck, tmp_path)
        assert "layout-mylayout" in results[0]["svg"]

    def test_scope_wraps_injected_deck_style(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        slide = tmp_path / "slides" / "plain.svg"
        slide.write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(
            style=Inline("#box { fill: red; }"), slides=[Slide("slides/plain.svg")]
        )
        results = process_deck(deck, tmp_path)
        assert "@scope" in results[0]["svg"]

    def test_no_scope_without_inline_styles(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        slide = tmp_path / "slides" / "plain.svg"
        slide.write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(slides=[Slide("slides/plain.svg")])
        results = process_deck(deck, tmp_path)
        assert "@scope" not in results[0]["svg"]


class TestSlideId:
    def test_infer_slide_id_explicit(self) -> None:
        slide = Slide("cover", id="my-cover")
        assert _infer_slide_id(slide) == "my-cover"

    def test_infer_slide_id_from_md_stem(self) -> None:
        slide = Slide("default", md="slides/08-markdown.md")
        assert _infer_slide_id(slide) == "08-markdown"

    def test_infer_slide_id_from_md_stem_no_numeric_strip(self) -> None:
        slide = Slide("default", md="slides/01-intro.md")
        assert _infer_slide_id(slide) == "01-intro"

    def test_infer_slide_id_inline_md_falls_back_to_src(self) -> None:
        slide = Slide("cover", md=Inline("# Hello"))
        assert _infer_slide_id(slide) == "cover"

    def test_infer_slide_id_from_src_stem(self) -> None:
        slide = Slide("slides/01-title.svg")
        assert _infer_slide_id(slide) == "01-title"

    def test_infer_slide_id_bare_name(self) -> None:
        slide = Slide("cover")
        assert _infer_slide_id(slide) == "cover"

    def test_deduplicate_ids_no_collision(self) -> None:
        assert _deduplicate_ids(["a", "b", "c"]) == ["a", "b", "c"]

    def test_deduplicate_ids_collision(self) -> None:
        assert _deduplicate_ids(["a", "a", "b", "a"]) == ["a", "a-2", "b", "a-3"]

    def test_process_deck_includes_id(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        slide = tmp_path / "slides" / "plain.svg"
        slide.write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(slides=[Slide("slides/plain.svg")])
        results = process_deck(deck, tmp_path)
        assert results[0]["id"] == "plain"

    def test_process_deck_id_collision_resolved(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        for name in ("plain.svg", "plain2.svg"):
            (tmp_path / "slides" / name).write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(
            slides=[
                Slide("slides/plain.svg", id="plain"),
                Slide("slides/plain2.svg", id="plain"),
            ]
        )
        results = process_deck(deck, tmp_path)
        assert results[0]["id"] == "plain"
        assert results[1]["id"] == "plain-2"


class TestParseMarkdownOnce:
    def test_markdown_parsed_once_per_md_slide(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from inkflow.zones import parse_markdown_zones as real

        (tmp_path / "slides").mkdir()
        for name in ("a.svg", "b.svg"):
            (tmp_path / "slides" / name).write_text(_LAYOUT_SVG, encoding="utf-8")

        calls: list[str] = []

        def counting(text: str) -> object:
            calls.append(text)
            return real(text)

        monkeypatch.setattr("inkflow.pipeline.parse_markdown_zones", counting)
        deck = Deck(
            slides=[
                Slide("slides/a.svg", md=Inline("# A\n\nbody")),
                Slide("slides/b.svg", md=Inline("# B\n\nbody")),
            ]
        )
        process_deck(deck, tmp_path)
        # once per md slide
        assert len(calls) == 2


class TestSlideSvg:
    def test_cleaned_round_trips(self, tmp_path: Path) -> None:
        from inkflow.pipeline import SlideSvg

        src = tmp_path / "s.svg"
        src.write_text(_ZONE_SLIDE_SVG, encoding="utf-8")
        assert "zone-content" in SlideSvg.cleaned(src).to_svg()

    def test_methods_mutate_in_place_like_list_sort(self, tmp_path: Path) -> None:
        from inkflow.pipeline import SlideSvg

        src = tmp_path / "s.svg"
        src.write_text(_LAYOUT_SVG, encoding="utf-8")
        doc = SlideSvg.cleaned(src)
        assert doc.zone_ids() == {"zone-title", "zone-content"}
        assert doc.number_slides(2, 5) is None  # returns None, mutates self
        doc.scope_styles(2)
        assert 'id="inkflow-slide-2"' in doc.to_svg()
