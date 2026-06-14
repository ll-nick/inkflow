from __future__ import annotations

import textwrap
from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.clean import clean_inkscape_svg, strip_layout_layers

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

# Layer group without inkflow:layout-src — structural attributes must survive clean.
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

# SVG with an injected layout layer group and an inkflow-preview style block.
_PREVIEW_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
         xmlns:inkflow="urn:inkflow"
         inkscape:version="1.3.2"
         width="100" height="100">
      <defs>
        <style id="inkflow-preview">.inkflow-fill-bg { fill: #1e1e2e; }</style>
      </defs>
      <sodipodi:namedview id="namedview1" inkscape:zoom="1.0"/>
      <g inkscape:groupmode="layer"
         inkscape:label="__inkflow:layout:base__"
         sodipodi:insensitive="true"
         inkflow:layout-src="./base"
         inkflow:layout-hash="abcd1234">
        <rect id="bg" width="100" height="100" class="inkflow-fill-bg"/>
      </g>
      <rect id="zone-content" x="10" y="10" width="80" height="80"/>
    </svg>
""")


class TestStripLayoutLayers:
    def _root_with_layers(self) -> etree._Element:  # pyright: ignore[reportPrivateUsage]
        return etree.fromstring(
            b"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow">
              <g inkflow:layout-src="/some/file.svg" inkflow:layout-hash="abc123"/>
              <g id="content"/>
              <rect id="bg"/>
            </svg>"""
        )

    def test_removes_marked_direct_children(self) -> None:
        root = self._root_with_layers()
        strip_layout_layers(root)
        ids = [el.get("id") or el.get(ns.INKFLOW_LAYOUT_SRC) for el in root]
        assert "/some/file.svg" not in ids
        assert "content" in ids
        assert "bg" in ids

    def test_leaves_unmarked_groups(self) -> None:
        root = self._root_with_layers()
        strip_layout_layers(root)
        assert root.find('.//{http://www.w3.org/2000/svg}g[@id="content"]') is not None

    def test_does_not_descend_into_nested(self) -> None:
        root = etree.fromstring(
            b"""<svg xmlns="http://www.w3.org/2000/svg">
              <g id="outer">
                <g inkflow:layout-src="/nested.svg" xmlns:inkflow="urn:inkflow"/>
              </g>
            </svg>"""
        )
        strip_layout_layers(root)
        # The outer group remains; the nested marked group is NOT removed
        # (only direct children are stripped).
        outer = root.find('.//{http://www.w3.org/2000/svg}g[@id="outer"]')
        assert outer is not None
        assert len(outer) == 1


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


class TestCleanKeepPreview:
    def test_strips_layout_layers_by_default(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_PREVIEW_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert "inkflow:layout-src" not in result
        assert "__inkflow:layout:base__" not in result

    def test_strips_preview_style_by_default(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_PREVIEW_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file)
        assert "inkflow-preview" not in result

    def test_preserves_layout_layers_when_keep_preview(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_PREVIEW_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file, keep_preview=True)
        assert "inkflow:layout-src" in result
        assert "__inkflow:layout:base__" in result

    def test_preserves_preview_style_when_keep_preview(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_PREVIEW_SVG, encoding="utf-8")
        result = clean_inkscape_svg(svg_file, keep_preview=True)
        assert "inkflow-preview" in result
        assert "#1e1e2e" in result

    def test_always_strips_inkscape_editor_noise(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_PREVIEW_SVG, encoding="utf-8")
        for keep in (False, True):
            result = clean_inkscape_svg(svg_file, keep_preview=keep)
            assert "namedview" not in result
            assert "inkscape:version" not in result

    def test_preserves_slide_content_regardless(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_PREVIEW_SVG, encoding="utf-8")
        for keep in (False, True):
            result = clean_inkscape_svg(svg_file, keep_preview=keep)
            assert 'id="zone-content"' in result


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

        svg_file = tmp_path / "test.svg"
        svg_file.write_text(_INKSCAPE_SVG, encoding="utf-8")
        svg_file.write_text(
            clean_inkscape_svg(svg_file, keep_preview=True), encoding="utf-8"
        )
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
