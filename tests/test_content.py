from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from lxml import etree

from inkflow.content import (
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
)
from inkflow.manifest import Image, TextBox, Video

_NUMBER_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg">
      <text id="zone-slide-number" x="100" y="50" font-size="20">99</text>
      <text id="zone-slide-total" x="120" y="50" font-size="20">99</text>
      <text id="other" x="10" y="10">unchanged</text>
    </svg>
""")

_ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg">
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
      <rect id="zone-image" x="10" y="10" width="400" height="300"/>
      <rect id="zone-video" x="10" y="350" width="400" height="300"/>
      <rect id="plain-rect" x="0" y="0" width="10" height="10"/>
    </svg>
""")


class TestSubstituteZoneNumbers:
    def test_replaces_slide_number(self) -> None:
        result = substitute_zone_numbers(_NUMBER_SVG, 3, 10)
        root = etree.fromstring(result.encode())
        el = root.find('.//*[@id="zone-slide-number"]')
        assert el is not None and el.text == "3"

    def test_replaces_slide_total(self) -> None:
        result = substitute_zone_numbers(_NUMBER_SVG, 1, 10)
        root = etree.fromstring(result.encode())
        el = root.find('.//*[@id="zone-slide-total"]')
        assert el is not None and el.text == "10"

    def test_leaves_other_text_untouched(self) -> None:
        result = substitute_zone_numbers(_NUMBER_SVG, 5, 20)
        root = etree.fromstring(result.encode())
        el = root.find('.//*[@id="other"]')
        assert el is not None and el.text == "unchanged"

    def test_preserves_svg_attributes(self) -> None:
        result = substitute_zone_numbers(_NUMBER_SVG, 2, 8)
        assert 'font-size="20"' in result
        assert 'x="100"' in result


class TestSubstituteContent:
    def test_textbox_replaced_with_foreignobject(self, tmp_path: Path) -> None:
        result = substitute_content(
            _ZONE_SVG, [TextBox("#zone-content", text="<p>hello</p>")], tmp_path
        )
        assert "foreignObject" in result
        assert "hello" in result

    def test_foreignobject_inherits_zone_id(self, tmp_path: Path) -> None:
        result = substitute_content(
            _ZONE_SVG, [TextBox("#zone-content", text="hi")], tmp_path
        )
        assert 'id="zone-content"' in result

    def test_foreignobject_has_correct_geometry(self, tmp_path: Path) -> None:
        result = substitute_content(
            _ZONE_SVG, [TextBox("#zone-content", text="x")], tmp_path
        )
        assert 'x="80"' in result
        assert 'y="200"' in result
        assert 'width="1760"' in result
        assert 'height="780"' in result

    def test_image_replaced_with_image_element(self, tmp_path: Path) -> None:
        img = tmp_path / "photo.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8)
        result = substitute_content(
            _ZONE_SVG, [Image("#zone-image", src="photo.png")], tmp_path
        )
        assert "<image" in result or "image" in result
        assert "data:image/png;base64," in result

    def test_video_replaced_with_foreignobject_video(self, tmp_path: Path) -> None:
        result = substitute_content(
            _ZONE_SVG, [Video("#zone-video", src="video.mp4")], tmp_path
        )
        assert "foreignObject" in result
        assert "video" in result
        assert "/video.mp4" in result

    def test_missing_zone_warns_and_continues(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        result = substitute_content(
            _ZONE_SVG,
            [
                TextBox("#zone-nonexistent", text="x"),
                TextBox("#zone-content", text="kept"),
            ],
            tmp_path,
        )
        assert "zone-nonexistent" in capsys.readouterr().out
        assert "kept" in result

    def test_returns_valid_svg_string(self, tmp_path: Path) -> None:
        result = substitute_content(
            _ZONE_SVG, [TextBox("#zone-content", text="<p>ok</p>")], tmp_path
        )
        etree.fromstring(result.encode())  # should not raise


class TestRemoveUnreferencedZones:
    def test_zone_rects_removed(self) -> None:
        result = remove_unreferenced_zones(_ZONE_SVG)
        assert 'id="zone-content"' not in result
        assert 'id="zone-image"' not in result

    def test_non_zone_rects_kept(self) -> None:
        result = remove_unreferenced_zones(_ZONE_SVG)
        assert 'id="plain-rect"' in result

    def test_annotated_zone_rect_kept(self) -> None:
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg">'
            '<rect id="zone-title" class="anim-fade-in" data-step="1"'
            ' x="0" y="0" width="100" height="50"/>'
            "</svg>"
        )
        result = remove_unreferenced_zones(svg)
        assert 'id="zone-title"' in result


class TestInjectStyle:
    def test_style_inserted_into_existing_defs(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs/><rect/></svg>'
        result = inject_style(svg, "body { color: red; }")
        assert "body { color: red; }" in result
        assert "<style" in result

    def test_defs_created_if_absent(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
        result = inject_style(svg, ".x { display: none; }")
        assert "defs" in result
        assert ".x { display: none; }" in result

    def test_empty_css_leaves_svg_unchanged(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
        result = inject_style(svg, "")
        assert result == svg
