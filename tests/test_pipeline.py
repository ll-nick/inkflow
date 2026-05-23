from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow.manifest import Bounce, Crossfade, Cut, Deck, FadeIn, FadeOut, Morph, Slide
from inkflow.pipeline import (
    annotate_svg,
    clean_inkscape_svg,
    compose_with_ancestors,
    resolve_transitions,
    substitute_tokens,
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


_TOKEN_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg">
      <text id="num">{{slide_number}}</text>
      <text id="tot">{{slide_total}}</text>
      <tspan id="span">slide {{slide_number}} of {{slide_total}}</tspan>
    </svg>
""")

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


class TestSubstituteTokens:
    def test_slide_number_replaced(self) -> None:
        result = substitute_tokens(_TOKEN_SVG, 3, 10)
        assert ">3<" in result
        assert "{{slide_number}}" not in result

    def test_slide_total_replaced(self) -> None:
        result = substitute_tokens(_TOKEN_SVG, 1, 10)
        assert ">10<" in result
        assert "{{slide_total}}" not in result

    def test_replaced_in_tspan(self) -> None:
        result = substitute_tokens(_TOKEN_SVG, 2, 5)
        assert "slide 2 of 5" in result

    def test_no_tokens_unchanged(self) -> None:
        result = substitute_tokens(_PLAIN_SVG, 1, 1)
        assert result  # just runs without error, no tokens to replace


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
