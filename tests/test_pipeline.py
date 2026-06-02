# pyright: reportPrivateUsage=none
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow.manifest import (
    Bounce,
    Crossfade,
    Cut,
    Deck,
    FadeIn,
    FadeOut,
    MarkdownSlide,
    Morph,
    Slide,
    TextBox,
)
from inkflow.pipeline import (
    _resolve_notes,
    annotate_svg,
    clean_inkscape_svg,
    compose_with_ancestors,
    process_deck,
    resolve_transitions,
)

_PLAIN_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect id="box" x="0" y="0" width="50" height="50"/>
      <circle id="dot" cx="75" cy="25" r="10"/>
    </svg>
""")

_INKSCAPE_SVG = textwrap.dedent("""\
    <?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
         inkscape:version="1.3.2"
         width="100" height="100">
      <sodipodi:namedview id="namedview1" inkscape:zoom="1.0"/>
      <rect id="box" x="0" y="0" width="50" height="50" fill="red"/>
    </svg>
""")

# SVG with inject-layout-style layer groups: structural attributes must survive clean.
_INKSCAPE_LAYER_SVG = textwrap.dedent("""\
    <?xml version="1.0" encoding="UTF-8"?>
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
         inkscape:version="1.3.2"
         width="100" height="100">
      <sodipodi:namedview id="namedview1" inkscape:zoom="2.5"/>
      <g inkscape:groupmode="layer"
         inkscape:label="__inkflow:layout:main__"
         sodipodi:insensitive="true">
        <rect id="bg" width="100" height="100" fill="blue"/>
      </g>
      <rect id="box" x="0" y="0" width="50" height="50" fill="red"/>
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


class TestCleanInkscapeSvg:
    def test_removes_inkscape_attributes(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert "inkscape:version" not in result
        assert "inkscape:zoom" not in result

    def test_removes_sodipodi_elements(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert "namedview" not in result
        assert "sodipodi" not in result

    def test_preserves_content_elements(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert 'id="box"' in result
        assert 'fill="red"' in result

    def test_removes_inkscape_namespace_declarations(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert "http://www.inkscape.org/namespaces/inkscape" not in result
        assert "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" not in result

    def test_preserves_layer_structural_attributes(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_LAYER_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert 'inkscape:groupmode="layer"' in result
        assert 'inkscape:label="__inkflow:layout:main__"' in result
        assert 'sodipodi:insensitive="true"' in result

    def test_still_strips_editor_noise_when_layers_present(
        self, tmp_path: Path
    ) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_LAYER_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert "namedview" not in result
        assert "inkscape:version" not in result
        assert "inkscape:zoom" not in result


class TestCleanCheckFlag:
    def test_exits_nonzero_for_dirty_file(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        result = CliRunner().invoke(main, ["clean", "--check", str(svg_file)])
        assert result.exit_code != 0

    def test_exits_zero_for_already_clean_file(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main
        from inkflow.pipeline import clean_inkscape_svg

        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        svg_file.write_text(clean_inkscape_svg(svg_file), encoding="utf-8")
        result = CliRunner().invoke(main, ["clean", "--check", str(svg_file)])
        assert result.exit_code == 0

    def test_does_not_modify_file(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        original = svg_file.read_text(encoding="utf-8")
        CliRunner().invoke(main, ["clean", "--check", str(svg_file)])
        assert svg_file.read_text(encoding="utf-8") == original

    def test_check_and_stdout_are_mutually_exclusive(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        result = CliRunner().invoke(
            main, ["clean", "--check", "--stdout", str(svg_file)]
        )
        assert result.exit_code != 0


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
        assert result[1] == {"type": "crossfade", "duration": 0.4}

    def test_morph_serialized(self) -> None:
        d = self._deck(slide_ts=[Morph(0.8)])
        assert resolve_transitions(d) == [{"type": "morph", "duration": 0.8}]


_ANCESTOR_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <defs><style>.anc{fill:red}</style></defs>
      <rect id="anc-bg" class="anc" width="1920" height="1080"/>
    </svg>
""")

_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="slide-content" width="100" height="100"/>
    </svg>
""")


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
        deck = Deck()
        deck.slides = [
            Slide(
                src="slide.svg", content=[TextBox("#zone-content", text="<p>hello</p>")]
            )
        ]
        results = process_deck(deck, tmp_path)
        assert len(results) == 1
        assert "foreignObject" in results[0]["svg"]
        assert "hello" in results[0]["svg"]

    def test_zone_rect_id_inherited_by_foreignobject(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck()
        deck.slides = [
            Slide(src="slide.svg", content=[TextBox("#zone-content", text="hi")])
        ]
        results = process_deck(deck, tmp_path)
        assert 'id="zone-content"' in results[0]["svg"]

    def test_unreferenced_zone_rects_removed(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _LAYOUT_SVG)
        deck = Deck()
        # Only supply content for zone-content, leave zone-title unconsumed
        deck.slides = [
            Slide(src="slide.svg", content=[TextBox("#zone-content", text="body")])
        ]
        results = process_deck(deck, tmp_path)
        assert 'id="zone-title"' not in results[0]["svg"]

    def test_foreignobject_content_has_inkflow_content_class(
        self, tmp_path: Path
    ) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck()
        deck.slides = [
            Slide(src="slide.svg", content=[TextBox("#zone-content", text="x")])
        ]
        results = process_deck(deck, tmp_path)
        assert "inkflow-content" in results[0]["svg"]


class TestMarkdownSlideExpansion:
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
        deck = Deck()
        deck.slides = [MarkdownSlide("layout", content="content")]
        results = process_deck(deck, tmp_path)
        assert len(results) == 1
        assert "foreignObject" in results[0]["svg"]
        assert "Body text" in results[0]["svg"]

    def test_markdown_slide_title_extracted(self, tmp_path: Path) -> None:
        _, slides_dir = self._setup(tmp_path)
        md = slides_dir / "content.md"
        md.write_text("# My Title\n\nSome content.\n", encoding="utf-8")
        deck = Deck()
        deck.slides = [MarkdownSlide("layout", content="content")]
        results = process_deck(deck, tmp_path)
        assert results[0]["title"] == "My Title"

    def test_markdown_slide_animations_applied(self, tmp_path: Path) -> None:
        self._setup(tmp_path)
        deck = Deck()
        deck.slides = [
            MarkdownSlide("layout", animations=[FadeIn("#zone-title", step=1)])
        ]
        results = process_deck(deck, tmp_path)
        assert "anim-fade-in" in results[0]["svg"]


class TestComposeWithAncestors:
    def test_ancestor_content_prepended(self, tmp_path: Path) -> None:
        anc = tmp_path / "main.svg"
        anc.write_text(_ANCESTOR_SVG, encoding="utf-8")
        result = compose_with_ancestors(_SLIDE_SVG, [anc])
        # ancestor rect appears before slide content
        assert result.index("anc-bg") < result.index("slide-content")

    def test_ancestor_defs_merged(self, tmp_path: Path) -> None:
        anc = tmp_path / "main.svg"
        anc.write_text(_ANCESTOR_SVG, encoding="utf-8")
        result = compose_with_ancestors(_SLIDE_SVG, [anc])
        assert ".anc{fill:red}" in result or ".anc" in result

    def test_existing_layout_layers_stripped_from_slide(self, tmp_path: Path) -> None:
        anc = tmp_path / "main.svg"
        anc.write_text(_ANCESTOR_SVG, encoding="utf-8")
        slide_with_layer = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
              <g xmlns:inkflow="urn:inkflow"
                 inkflow:layout-src="/stale/layer.svg"
                 inkflow:layout-hash="000000"/>
              <rect id="slide-content" width="100" height="100"/>
            </svg>
        """)
        result = compose_with_ancestors(slide_with_layer, [anc])
        assert "stale/layer.svg" not in result
        assert "slide-content" in result


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
