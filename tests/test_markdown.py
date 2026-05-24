from __future__ import annotations

from pathlib import Path

from inkflow.manifest import Image, MarkdownSlide, TextBox, Video
from inkflow.markdown import (
    _STEP,  # pyright: ignore[reportPrivateUsage]
    _auto_extract,  # pyright: ignore[reportPrivateUsage]
    chunks_to_html,
    expand_markdown_slide,
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


class TestExpandMarkdownSlide:
    def test_plain_markdown_becomes_textbox(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("Body content here.\n", encoding="utf-8")
        ms = MarkdownSlide("layout.svg", src="slide.md")
        content = expand_markdown_slide(ms, tmp_path)
        assert any(
            isinstance(c, TextBox) and "#zone-content" in c.element for c in content
        )

    def test_h1_creates_title_textbox(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# My Title\n\nBody.\n", encoding="utf-8")
        ms = MarkdownSlide("layout.svg", src="slide.md")
        content = expand_markdown_slide(ms, tmp_path)
        titles = [
            c for c in content if isinstance(c, TextBox) and "#zone-title" in c.element
        ]
        assert len(titles) == 1
        assert titles[0].text is not None
        assert "My Title" in titles[0].text
        assert "<h1>" in titles[0].text

    def test_image_kwarg_creates_image(self, tmp_path: Path) -> None:
        ms = MarkdownSlide("layout.svg", image="photo.png")
        content = expand_markdown_slide(ms, tmp_path)
        images = [c for c in content if isinstance(c, Image)]
        assert len(images) == 1
        assert images[0].element == "#zone-image"
        assert images[0].src == "photo.png"

    def test_video_kwarg_creates_video(self, tmp_path: Path) -> None:
        ms = MarkdownSlide("layout.svg", video="clip.mp4")
        content = expand_markdown_slide(ms, tmp_path)
        videos = [c for c in content if isinstance(c, Video)]
        assert len(videos) == 1
        assert videos[0].element == "#zone-video"
        assert videos[0].src == "clip.mp4"

    def test_steps_true_wraps_list_items(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("- One\n- Two\n- Three\n", encoding="utf-8")
        ms = MarkdownSlide("layout.svg", src="slide.md", steps=True)
        content = expand_markdown_slide(ms, tmp_path)
        box = next(c for c in content if isinstance(c, TextBox))
        assert box.text is not None
        assert "data-step" in box.text

    def test_no_src_returns_empty_content_for_no_kwargs(self, tmp_path: Path) -> None:
        ms = MarkdownSlide("layout.svg")
        content = expand_markdown_slide(ms, tmp_path)
        assert content == []
