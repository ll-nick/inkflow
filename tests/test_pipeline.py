from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow.manifest import Bounce, Fade, FadeOut
from inkflow.pipeline import annotate_svg, clean_inkscape_svg

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
        result = annotate_svg(_PLAIN_SVG, [Fade("#box", step=1)])
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
        result = annotate_svg(svg, [Fade("#box", step=1)])
        assert 'class="my-class anim-fade-in"' in result

    def test_missing_element_warns_and_continues(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        result = annotate_svg(_PLAIN_SVG, [Fade("#nonexistent", step=1)])
        assert "nonexistent" in capsys.readouterr().out
        assert 'id="box"' in result  # rest of SVG intact

    def test_multiple_animations_applied(self) -> None:
        result = annotate_svg(
            _PLAIN_SVG, [Fade("#box", step=1), Bounce("#dot", step=2)]
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
