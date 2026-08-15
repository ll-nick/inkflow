from __future__ import annotations

import textwrap
from pathlib import Path

from inkflow.svg import compose_overlays as _compose_overlays_el
from inkflow.svg import compose_with_ancestors as _compose_with_ancestors_el
from inkflow.svg import duplicate_zone_ids, is_full_canvas_fill
from inkflow.svgio import SvgElement, parse_svg, serialize_svg


# String adapters: these take and return an element (parse once); the wrappers keep
# the string call sites below readable.
def compose_with_ancestors(svg: str, chain: list[Path]) -> str:
    return serialize_svg(_compose_with_ancestors_el(parse_svg(svg), chain))


def compose_overlays(svg: str, overlay_chains: list[list[Path]]) -> str:
    return serialize_svg(_compose_overlays_el(parse_svg(svg), overlay_chains))


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


_OVERLAY_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <defs><style>.ovl{fill:blue}</style></defs>
      <rect id="ovl-mark" class="ovl" width="80" height="80"/>
    </svg>
""")

_OVERLAY_PARENT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="ovl-brand" width="1760" height="4"/>
    </svg>
""")


class TestComposeOverlays:
    def _overlay(self, tmp_path: Path, name: str, content: str) -> Path:
        path = tmp_path / name
        path.write_text(content, encoding="utf-8")
        return path

    def test_overlay_content_appended(self, tmp_path: Path) -> None:
        ovl = self._overlay(tmp_path, "logo.svg", _OVERLAY_SVG)
        result = compose_overlays(_SLIDE_SVG, [[ovl]])
        # overlay paints after (on top of) the slide's own content
        assert result.index("slide-content") < result.index("ovl-mark")

    def test_overlay_defs_merged(self, tmp_path: Path) -> None:
        ovl = self._overlay(tmp_path, "logo.svg", _OVERLAY_SVG)
        assert ".ovl" in compose_overlays(_SLIDE_SVG, [[ovl]])

    def test_overlay_chain_paints_ancestor_first(self, tmp_path: Path) -> None:
        brand = self._overlay(tmp_path, "brand.svg", _OVERLAY_PARENT_SVG)
        footer = self._overlay(tmp_path, "footer.svg", _OVERLAY_SVG)
        result = compose_overlays(_SLIDE_SVG, [[brand, footer]])
        # within one overlay's stack the parent is behind, but both sit on the slide
        assert result.index("slide-content") < result.index("ovl-brand")
        assert result.index("ovl-brand") < result.index("ovl-mark")

    def test_paint_order_follows_list_order(self, tmp_path: Path) -> None:
        first = self._overlay(tmp_path, "brand.svg", _OVERLAY_PARENT_SVG)
        second = self._overlay(tmp_path, "logo.svg", _OVERLAY_SVG)
        result = compose_overlays(_SLIDE_SVG, [[second], [first]])
        assert result.index("ovl-mark") < result.index("ovl-brand")

    def test_no_overlays_leaves_slide_untouched(self) -> None:
        assert "ovl-" not in compose_overlays(_SLIDE_SVG, [])


def _wrap(body: str, view_box: str = "0 0 100 100") -> SvgElement:
    ns_attr = 'xmlns="http://www.w3.org/2000/svg"'
    return parse_svg(f'<svg {ns_attr} viewBox="{view_box}">{body}</svg>')


class TestDuplicateZoneIds:
    def _svg(self, body: str) -> SvgElement:
        return _wrap(body)

    def test_no_duplicates(self) -> None:
        root = self._svg('<rect id="zone-content"/><rect id="zone-title"/>')
        assert duplicate_zone_ids(root) == []

    def test_duplicate_reported(self) -> None:
        root = self._svg('<rect id="zone-content"/><rect id="zone-content"/>')
        assert duplicate_zone_ids(root) == ["zone-content"]

    def test_slide_number_reported(self) -> None:
        # Worth reporting more than a content-zone duplicate, not less:
        # substitute_zone_numbers fills every match, so both get drawn.
        root = self._svg('<text id="zone-slide-number"/><text id="zone-slide-number"/>')
        assert duplicate_zone_ids(root) == ["zone-slide-number"]

    def test_non_zone_ids_ignored(self) -> None:
        root = self._svg('<rect id="box"/><rect id="box"/>')
        assert duplicate_zone_ids(root) == []


class TestIsFullCanvasFill:
    def _svg(self, body: str) -> SvgElement:
        return _wrap(body, "0 0 1920 1080")

    def test_full_bleed_rect_detected(self) -> None:
        assert is_full_canvas_fill(self._svg('<rect width="1920" height="1080"/>'))

    def test_partial_rect_not_detected(self) -> None:
        assert not is_full_canvas_fill(self._svg('<rect width="200" height="80"/>'))

    def test_offset_rect_not_detected(self) -> None:
        root = self._svg('<rect x="40" y="0" width="1920" height="1080"/>')
        assert not is_full_canvas_fill(root)

    def test_fill_none_not_detected(self) -> None:
        root = self._svg('<rect width="1920" height="1080" fill="none"/>')
        assert not is_full_canvas_fill(root)

    def test_translucent_watermark_not_detected(self) -> None:
        root = self._svg('<rect width="1920" height="1080" opacity="0.08"/>')
        assert not is_full_canvas_fill(root)
