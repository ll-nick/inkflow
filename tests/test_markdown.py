from __future__ import annotations

from pathlib import Path

from inkflow.manifest import Align, Media, TextBox, VAlign
from inkflow.markdown import (
    _STEP,  # pyright: ignore[reportPrivateUsage]
    SlideContent,
    _auto_extract,  # pyright: ignore[reportPrivateUsage]
    _parse_markdown_zones_full,  # pyright: ignore[reportPrivateUsage]
    build_slide_content,
    chunks_to_html,
    parse_markdown_zones,
    steps_wrap_list_items,
)


class TestParseMarkdownZones:
    def test_no_markers_triggers_auto_extract(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# My Title\n\nBody content.\n", encoding="utf-8")
        zones = parse_markdown_zones(md)
        assert "title" in zones
        assert "content" in zones

    def test_explicit_markers_route_to_zones(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "::left::\nLeft side.\n::right::\nRight side.\n", encoding="utf-8"
        )
        zones = parse_markdown_zones(md)
        assert "left" in zones
        assert "right" in zones
        assert "Left side" in "".join(zones["left"])
        assert "Right side" in "".join(zones["right"])

    def test_content_before_first_marker_goes_to_content_zone(
        self, tmp_path: Path
    ) -> None:
        md = tmp_path / "slide.md"
        md.write_text("Intro text.\n::extra::\nExtra content.\n", encoding="utf-8")
        zones = parse_markdown_zones(md)
        assert "content" in zones
        assert "extra" in zones

    def test_h1_before_first_marker_extracted_to_title_zone(
        self, tmp_path: Path
    ) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "# My Title\n\n::left::\nLeft content.\n::right::\nRight content.\n",
            encoding="utf-8",
        )
        zones = parse_markdown_zones(md)
        assert "title" in zones
        assert "left" in zones
        assert "right" in zones
        assert "content" not in zones

    def test_step_marker_creates_chunk_boundary(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::body::\nFirst.\n::step::\nSecond.\n", encoding="utf-8")
        zones = parse_markdown_zones(md)
        assert _STEP in zones["body"]

    def test_empty_zone_section_excluded(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::left::\n\n::right::\nRight content.\n", encoding="utf-8")
        zones = parse_markdown_zones(md)
        assert "left" not in zones
        assert "right" in zones


class TestAutoExtract:
    def test_h1_goes_to_title(self) -> None:
        zones = _auto_extract("# My Heading\n\nSome body.\n")
        assert zones.get("title") == ["# My Heading"]

    def test_h2_immediately_after_h1_goes_to_subtitle(self) -> None:
        zones = _auto_extract("# Title\n## Subtitle\n\nBody.\n")
        assert zones.get("subtitle") == ["## Subtitle"]

    def test_h2_after_body_stays_in_content(self) -> None:
        zones = _auto_extract("# Title\n\nBody text.\n\n## Not a subtitle\n")
        assert "subtitle" not in zones
        content_text = "".join(c for c in zones.get("content", []) if c != _STEP)
        assert "Not a subtitle" in content_text

    def test_no_heading_all_to_content(self) -> None:
        zones = _auto_extract("Just plain text.\n")
        assert "title" not in zones
        assert "content" in zones

    def test_title_zone_contains_markdown_heading(self) -> None:
        zones = _auto_extract("# My Title\n\nBody.\n")
        assert zones["title"] == ["# My Title"]


class TestChunksToHtml:
    def test_single_chunk_rendered_without_wrapper(self) -> None:
        html, step = chunks_to_html(["Hello **world**"], 0)
        assert "<p>" in html or "Hello" in html
        assert "anim-fade-in" not in html
        assert step == 0

    def test_second_chunk_wrapped_with_data_step(self) -> None:
        html, step = chunks_to_html(["First", _STEP, "Second"], 0)
        assert 'class="anim-fade-in"' in html
        assert 'data-step="1"' in html
        assert step == 1

    def test_base_step_offset_applied(self) -> None:
        html, step = chunks_to_html(["First", _STEP, "Second"], 5)
        assert 'data-step="6"' in html
        assert step == 6

    def test_multiple_steps_increment(self) -> None:
        chunks = ["A", _STEP, "B", _STEP, "C"]
        html, step = chunks_to_html(chunks, 0)
        assert 'data-step="1"' in html
        assert 'data-step="2"' in html
        assert step == 2


class TestStepsWrapListItems:
    def test_each_li_wrapped_with_data_step(self) -> None:
        html = "<ul><li>One</li><li>Two</li></ul>"
        result, step = steps_wrap_list_items(html, 0)
        assert 'data-step="1"' in result
        assert 'data-step="2"' in result
        assert step == 2

    def test_base_step_offset(self) -> None:
        html = "<ul><li>Item</li></ul>"
        result, step = steps_wrap_list_items(html, 3)
        assert 'data-step="4"' in result
        assert step == 4

    def test_non_list_content_unwrapped(self) -> None:
        html = "<p>Paragraph</p>"
        result, step = steps_wrap_list_items(html, 0)
        assert "data-step" not in result
        assert "Paragraph" in result
        assert step == 0

    def test_nested_li_not_separately_wrapped(self) -> None:
        html = "<ul><li>Parent<ul><li>Child</li></ul></li></ul>"
        result, _step = steps_wrap_list_items(html, 0)
        # Only one top-level li → one data-step
        assert result.count("data-step") == 1


class TestBuildSlideContent:
    def test_plain_markdown_becomes_textbox(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("Body content here.\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        assert isinstance(result, SlideContent)
        assert "zone-content" in result.content
        assert isinstance(result.content["zone-content"], TextBox)

    def test_h1_creates_title_textbox(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# My Title\n\nBody.\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        assert "zone-title" in result.content
        tb = result.content["zone-title"]
        assert isinstance(tb, TextBox)
        assert tb.text is not None
        assert "My Title" in tb.text
        assert "<h1>" in tb.text

    def test_str_zone_creates_textbox(self) -> None:
        result = build_slide_content(None, False, {"content": "**bold**"})
        assert "zone-content" in result.content
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert "bold" in (tb.text or "")

    def test_str_zone_rendered_as_markdown(self) -> None:
        result = build_slide_content(None, False, {"title": "# Hello"})
        tb = result.content["zone-title"]
        assert isinstance(tb, TextBox)
        assert "<h1>" in (tb.text or "")

    def test_media_kwarg_accepts_media_object_with_tuning(self) -> None:
        result = build_slide_content(
            None, False, {"image": Media("photo.png", fit="cover", align="top")}
        )
        assert "zone-image" in result.content
        m = result.content["zone-image"]
        assert isinstance(m, Media)
        assert m.src == "photo.png"
        assert m.fit == "cover"
        assert m.align == "top"

    def test_textbox_zone_preserves_alignment_fields(self) -> None:
        result = build_slide_content(
            None,
            False,
            {"content": TextBox(text="<p>hello</p>", align=Align.CENTER, padding=30)},
        )
        assert "zone-content" in result.content
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align == Align.CENTER
        assert tb.padding == 30

    def test_steps_true_wraps_list_items(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("- One\n- Two\n- Three\n", encoding="utf-8")
        result = build_slide_content(md, True, {})
        box = next(v for v in result.content.values() if isinstance(v, TextBox))
        assert box.text is not None
        assert "data-step" in box.text

    def test_no_content_no_extra_returns_empty(self) -> None:
        result = build_slide_content(None, False, {})
        assert result.content == {}
        assert result.notes == ""

    def test_notes_zone_returned_as_html(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "Body text.\n\n::notes::\n\nRemember **this**.\n", encoding="utf-8"
        )
        result = build_slide_content(md, False, {})
        assert "<strong>this</strong>" in result.notes
        assert "zone-notes" not in result.content

    def test_notes_zone_not_injected_into_slide(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::notes::\n\nPrivate note.\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        assert result.content == {}
        assert "Private note." in result.notes

    def test_no_notes_zone_returns_empty_notes(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# Title\n\nSome content.\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        assert result.notes == ""


class TestZoneParams:
    def test_parse_zone_params_extracted(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::title align=center::\n\n# Hello\n", encoding="utf-8")
        parsed = _parse_markdown_zones_full(md)
        assert parsed.params.get("title") == {"align": "center"}

    def test_parse_zone_multiple_params(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "::content align=right valign=center padding=20::\n\nBody\n",
            encoding="utf-8",
        )
        parsed = _parse_markdown_zones_full(md)
        assert parsed.params["content"] == {
            "align": "right",
            "valign": "center",
            "padding": "20",
        }

    def test_zone_without_params_has_no_entry(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content::\n\nBody\n", encoding="utf-8")
        parsed = _parse_markdown_zones_full(md)
        assert "content" not in parsed.params

    def test_parse_zones_public_api_unchanged(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::title align=center::\n\n# Hello\n", encoding="utf-8")
        zones = parse_markdown_zones(md)
        assert "title" in zones
        assert isinstance(zones["title"], list)

    def test_build_slide_content_align_param(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content align=center::\n\nBody text\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align == Align.CENTER

    def test_build_slide_content_valign_param(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content valign=center::\n\nBody text\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.valign == VAlign.CENTER

    def test_build_slide_content_padding_param(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content padding=40::\n\nBody text\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.padding == 40.0

    def test_unknown_params_ignored(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content unknown=foo align=left::\n\nBody\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align == Align.LEFT

    def test_no_params_textbox_fields_are_none(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content::\n\nBody\n", encoding="utf-8")
        result = build_slide_content(md, False, {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align is None
        assert tb.valign is None
        assert tb.padding is None
