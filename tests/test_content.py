from __future__ import annotations

import textwrap

import pytest
from lxml import etree

from inkflow import ns
from inkflow.content import (
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
)
from inkflow.manifest import Align, Media, MediaAlign, MediaFit, TextBox, VAlign

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

_POLYGON_ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg">
      <polygon id="zone-image" points="100,0 500,0 400,300 0,300"/>
    </svg>
""")

# Same shape as _POLYGON_ZONE_SVG but as a <path>
_PATH_ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg">
      <path id="zone-image" d="M 100,0 L 500,0 400,300 0,300 Z"/>
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
    def test_textbox_replaced_with_foreignobject(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="<p>hello</p>")}
        )
        assert "foreignObject" in result
        assert "hello" in result

    def test_foreignobject_inherits_zone_id(self) -> None:
        result = substitute_content(_ZONE_SVG, {"zone-content": TextBox(text="hi")})
        assert 'id="zone-content"' in result

    def test_foreignobject_has_correct_geometry(self) -> None:
        result = substitute_content(_ZONE_SVG, {"zone-content": TextBox(text="x")})
        assert 'x="80"' in result
        assert 'y="200"' in result
        assert 'width="1760"' in result
        assert 'height="780"' in result

    def test_image_replaced_with_foreignobject(self) -> None:
        result = substitute_content(_ZONE_SVG, {"zone-image": Media("photo.png")})
        assert "foreignObject" in result
        assert "photo.png" in result

    def test_video_replaced_with_foreignobject(self) -> None:
        result = substitute_content(_ZONE_SVG, {"zone-video": Media("video.mp4")})
        assert "foreignObject" in result
        assert "video.mp4" in result

    def test_media_default_fit_is_contain(self) -> None:
        result = substitute_content(_ZONE_SVG, {"zone-image": Media("photo.png")})
        assert "object-fit:contain" in result

    def test_media_cover_fit(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-image": Media("photo.png", fit=MediaFit.COVER)}
        )
        assert "object-fit:cover" in result

    def test_media_default_align_is_center(self) -> None:
        result = substitute_content(_ZONE_SVG, {"zone-image": Media("photo.png")})
        assert "object-position:50% 50%" in result

    def test_media_align_top(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-image": Media("photo.png", align=MediaAlign.TOP)}
        )
        assert "object-position:50% 0%" in result

    def test_media_y_offset_produces_calc(self) -> None:
        # zone-image height=300; y=-60 → -20%
        result = substitute_content(
            _ZONE_SVG, {"zone-image": Media("photo.png", y=-60.0)}
        )
        assert "calc(50% - 20%" in result

    def test_media_x_offset_produces_calc(self) -> None:
        # zone-image width=400; x=100 → +25%
        result = substitute_content(
            _ZONE_SVG, {"zone-image": Media("photo.png", x=100.0)}
        )
        assert "calc(50% + 25%" in result

    def test_missing_zone_warns_and_continues(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        result = substitute_content(
            _ZONE_SVG,
            {
                "zone-nonexistent": TextBox(text="x"),
                "zone-content": TextBox(text="kept"),
            },
        )
        assert "zone-nonexistent" in capsys.readouterr().out
        assert "kept" in result

    def test_returns_valid_svg_string(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="<p>ok</p>")}
        )
        etree.fromstring(result.encode())  # should not raise


class TestContentRobustness:
    """Regressions for F-021 (raw HTML) and F-028 (degenerate geometry)."""

    def test_raw_void_html_renders_not_escaped(self) -> None:
        # F-021: raw <br> in a plain zone must render as a real element,
        # not escape the whole zone to literal &lt;br&gt; text.
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="one<br>two")}
        )
        assert "&lt;br&gt;" not in result
        root = etree.fromstring(result.encode())
        fo = root.find('.//*[@id="zone-content"]')
        assert fo is not None
        assert fo.find(f".//{{{ns.XHTML}}}br") is not None

    def test_zero_dimension_media_no_crash(self) -> None:
        # F-028: zero-width zone must not raise ZeroDivisionError.
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg">'
            '<rect id="zone-image" x="0" y="0" width="0" height="300"/></svg>'
        )
        result = substitute_content(svg, {"zone-image": Media("photo.png", x=5.0)})
        # Offset is skipped for the degenerate axis: base position only, no calc().
        assert "object-position:50% 50%" in result

    def test_unit_bearing_dimension_media_no_crash(self) -> None:
        # F-028: a unit-bearing dimension must not raise ValueError. The offset
        # is declined (not reinterpreted), degrading to base alignment.
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg">'
            '<rect id="zone-image" x="0" y="0" width="400px" height="300px"/></svg>'
        )
        result = substitute_content(svg, {"zone-image": Media("photo.png", x=100.0)})
        assert "calc(" not in result
        assert "object-position:50% 50%" in result


class TestTextBoxAlignment:
    def test_wrapper_div_always_present(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="<p>hi</p>")}
        )
        assert "inkflow-wrapper" in result
        assert "inkflow-content" in result

    def test_no_inline_style_when_params_absent(self) -> None:
        result = substitute_content(_ZONE_SVG, {"zone-content": TextBox(text="hi")})
        root = etree.fromstring(result.encode())
        fo = root.find('.//*[@id="zone-content"]')
        assert fo is not None
        wrapper = fo[0]
        assert wrapper.get("style") is None
        content = wrapper[0]
        assert content.get("style") is None

    def test_align_sets_text_align_on_content(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="hi", align=Align.CENTER)}
        )
        assert "text-align:center" in result

    def test_valign_center_sets_justify_content(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="hi", valign=VAlign.CENTER)}
        )
        assert "justify-content:center" in result

    def test_valign_top_sets_flex_start(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="hi", valign=VAlign.TOP)}
        )
        assert "justify-content:start" in result

    def test_valign_bottom_sets_flex_end(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="hi", valign=VAlign.BOTTOM)}
        )
        assert "justify-content:end" in result

    def test_padding_sets_inline_style_on_wrapper(self) -> None:
        result = substitute_content(
            _ZONE_SVG, {"zone-content": TextBox(text="hi", padding=40)}
        )
        assert "padding:40px" in result

    def test_inline_style_on_wrapper_not_content(self) -> None:
        result = substitute_content(
            _ZONE_SVG,
            {"zone-content": TextBox(text="hi", valign=VAlign.CENTER, padding=20)},
        )
        root = etree.fromstring(result.encode())
        fo = root.find('.//*[@id="zone-content"]')
        assert fo is not None
        wrapper = fo[0]
        assert "justify-content" in (wrapper.get("style") or "")
        assert "padding" in (wrapper.get("style") or "")
        content = wrapper[0]
        assert content.get("style") is None


class TestNonRectZones:
    def test_polygon_zone_bounding_box(self) -> None:
        # polygon points="100,0 500,0 400,300 0,300" → bbox x=0,y=0,w=500,h=300
        result = substitute_content(
            _POLYGON_ZONE_SVG, {"zone-image": Media("photo.png")}
        )
        assert 'width="500"' in result or 'width="500.0"' in result
        assert 'height="300"' in result or 'height="300.0"' in result

    def test_polygon_media_zone_gets_clip_path(self) -> None:
        result = substitute_content(
            _POLYGON_ZONE_SVG, {"zone-image": Media("photo.png")}
        )
        assert "clipPath" in result
        assert "inkflow-clip-zone-image" in result
        assert 'clip-path="url(#inkflow-clip-zone-image)"' in result

    def test_polygon_textbox_zone_no_clip(self) -> None:
        result = substitute_content(
            _POLYGON_ZONE_SVG, {"zone-image": TextBox(text="<p>hello</p>")}
        )
        assert "clipPath" not in result
        assert "clip-path" not in result

    def test_polygon_media_clip_shape_in_defs(self) -> None:
        result = substitute_content(
            _POLYGON_ZONE_SVG, {"zone-image": Media("photo.png")}
        )
        root = etree.fromstring(result.encode())
        defs = root.find("{http://www.w3.org/2000/svg}defs")
        assert defs is not None
        clip = defs.find("{http://www.w3.org/2000/svg}clipPath")
        assert clip is not None
        polygon = clip.find("{http://www.w3.org/2000/svg}polygon")
        assert polygon is not None
        assert polygon.get("id") is None  # id stripped from copy


class TestPathZones:
    def test_path_zone_bounding_box(self) -> None:
        # M 100,0 L 500,0 400,300 0,300 Z → bbox x=0,y=0,w=500,h=300
        result = substitute_content(_PATH_ZONE_SVG, {"zone-image": Media("photo.png")})
        assert 'width="500"' in result or 'width="500.0"' in result
        assert 'height="300"' in result or 'height="300.0"' in result

    def test_path_media_zone_gets_clip_path(self) -> None:
        result = substitute_content(_PATH_ZONE_SVG, {"zone-image": Media("photo.png")})
        assert "clipPath" in result
        assert "inkflow-clip-zone-image" in result
        assert 'clip-path="url(#inkflow-clip-zone-image)"' in result

    def test_path_textbox_zone_no_clip(self) -> None:
        result = substitute_content(
            _PATH_ZONE_SVG, {"zone-image": TextBox(text="<p>hello</p>")}
        )
        assert "clipPath" not in result
        assert "clip-path" not in result

    def test_path_clip_shape_is_path_element(self) -> None:
        result = substitute_content(_PATH_ZONE_SVG, {"zone-image": Media("photo.png")})
        root = etree.fromstring(result.encode())
        defs = root.find("{http://www.w3.org/2000/svg}defs")
        assert defs is not None
        clip = defs.find("{http://www.w3.org/2000/svg}clipPath")
        assert clip is not None
        path_el = clip.find("{http://www.w3.org/2000/svg}path")
        assert path_el is not None
        assert path_el.get("id") is None  # id stripped from copy

    def test_relative_path_bbox(self) -> None:
        # Relative commands: m/l — same shape as absolute version
        svg = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg">
              <path id="zone-image" d="m 100,0 l 400,0 -100,300 -400,0 z"/>
            </svg>
        """)
        result = substitute_content(svg, {"zone-image": Media("photo.png")})
        assert 'width="500"' in result or 'width="500.0"' in result
        assert 'height="300"' in result or 'height="300.0"' in result


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
