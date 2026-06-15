# pyright: reportPrivateUsage=none
from __future__ import annotations

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
from inkflow.manifest import (
    Deck,
    Slide,
)
from inkflow.pipeline import (
    _add_layout_classes,
    _resolve_notes,
    annotate_svg,
    process_deck,
    resolve_transitions,
)
from inkflow.transitions import Crossfade, Cut, Morph

_PLAIN_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect id="box" x="0" y="0" width="50" height="50"/>
      <circle id="dot" cx="75" cy="25" r="10"/>
    </svg>
""")


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

    def test_missing_element_warns_and_continues(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        result = annotate_svg(_PLAIN_SVG, [FadeIn("#nonexistent", step=1)])
        assert "nonexistent" in capsys.readouterr().out
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
        result = annotate_svg(_PLAIN_SVG, [SlideIn("#box", direction="right")])
        assert "anim-slide-in" in result
        assert "anim-from-right" in result
        assert "--anim-direction" not in result

    def test_params_emit_custom_props(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [FadeIn("#box", duration=0.8, delay=0.2)])
        assert "--anim-duration: 0.8s" in result
        assert "--anim-delay: 0.2s" in result

    def test_none_params_emit_no_style(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [FadeIn("#box")])
        assert "--anim-" not in result

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
            {"type": "crossfade", "duration": 0.6},
            {"type": "crossfade", "duration": 0.6},
        ]

    def test_slide_overrides_deck(self) -> None:
        d = self._deck(deck_t=Crossfade(), slide_ts=[Cut(), None])
        result = resolve_transitions(d)
        assert result[0] == {"type": "cut", "duration": 0.0}
        assert result[1] == {"type": "crossfade", "duration": 0.5}

    def test_morph_serialized(self) -> None:
        d = self._deck(slide_ts=[Morph(0.8)])
        assert resolve_transitions(d) == [{"type": "morph", "duration": 0.8}]


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
        from inkflow.manifest import Media

        deck = Deck(slides=[Slide("layout", zones={"content": Media("photo.jpg")})])
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
        deck = Deck(style="#box { fill: red; }", slides=[Slide("slides/plain.svg")])
        results = process_deck(deck, tmp_path)
        assert "@scope" in results[0]["svg"]

    def test_no_scope_without_inline_styles(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        slide = tmp_path / "slides" / "plain.svg"
        slide.write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(slides=[Slide("slides/plain.svg")])
        results = process_deck(deck, tmp_path)
        assert "@scope" not in results[0]["svg"]


class TestResolveNotes:
    def test_none_returns_empty(self, tmp_path: Path) -> None:
        assert _resolve_notes(None, tmp_path) == ""

    def test_str_rendered_as_markdown(self, tmp_path: Path) -> None:
        # Plain string with paragraph break becomes two <p> elements
        result = _resolve_notes("First paragraph.\n\nSecond paragraph.", tmp_path)
        assert "<p>First paragraph.</p>" in result
        assert "<p>Second paragraph.</p>" in result

    def test_str_markdown_formatting_applied(self, tmp_path: Path) -> None:
        result = _resolve_notes("Remember **this**.", tmp_path)
        assert "<strong>this</strong>" in result

    def test_md_path_rendered_as_html(self, tmp_path: Path) -> None:
        f = tmp_path / "notes.md"
        f.write_text("Remember **this**.\n", encoding="utf-8")
        result = _resolve_notes(Path("notes.md"), tmp_path)
        assert "<strong>this</strong>" in result

    def test_non_md_path_read_as_is(self, tmp_path: Path) -> None:
        f = tmp_path / "notes.html"
        f.write_text("<p>Raw HTML</p>", encoding="utf-8")
        result = _resolve_notes(Path("notes.html"), tmp_path)
        assert result == "<p>Raw HTML</p>"

    def test_relative_path_resolved_from_project_dir(self, tmp_path: Path) -> None:
        sub = tmp_path / "notes"
        sub.mkdir()
        f = sub / "slide1.md"
        f.write_text("A note.\n", encoding="utf-8")
        result = _resolve_notes(Path("notes/slide1.md"), tmp_path)
        assert "A note." in result

    def test_absolute_path_used_directly(self, tmp_path: Path) -> None:
        f = tmp_path / "abs.md"
        f.write_text("Absolute.\n", encoding="utf-8")
        result = _resolve_notes(f, tmp_path / "other")
        assert "Absolute." in result
