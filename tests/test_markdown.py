from __future__ import annotations

from pathlib import Path

import pytest

from inkflow.manifest import Align, Media, MediaAlign, MediaFit, TextBox, VAlign
from inkflow.markdown import (
    _STEP,  # pyright: ignore[reportPrivateUsage]
    SlideContent,
    _auto_extract,  # pyright: ignore[reportPrivateUsage]
    _parse_fence_info,  # pyright: ignore[reportPrivateUsage]
    _parse_hl_spec,  # pyright: ignore[reportPrivateUsage]
    _render_codeblock,  # pyright: ignore[reportPrivateUsage]
    _render_md_with_steps,  # pyright: ignore[reportPrivateUsage]
    _reroute_zones,  # pyright: ignore[reportPrivateUsage]
    _StepsBlock,  # pyright: ignore[reportPrivateUsage]
    build_slide_content,
    chunks_to_html,
    html_fragment_to_xml,
    markdown_to_html,
    parse_markdown_zones,
    steps_wrap_content,
)


class TestParseMarkdownZones:
    def test_no_markers_triggers_auto_extract(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# My Title\n\nBody content.\n", encoding="utf-8")
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        assert "title" in zones
        assert "content" in zones

    def test_explicit_markers_route_to_zones(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "::left::\nLeft side.\n::right::\nRight side.\n", encoding="utf-8"
        )
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        assert "left" in zones
        assert "right" in zones
        left_text = "".join(c for c in zones["left"] if isinstance(c, str))
        right_text = "".join(c for c in zones["right"] if isinstance(c, str))
        assert "Left side" in left_text
        assert "Right side" in right_text

    def test_content_before_first_marker_goes_to_content_zone(
        self, tmp_path: Path
    ) -> None:
        md = tmp_path / "slide.md"
        md.write_text("Intro text.\n::extra::\nExtra content.\n", encoding="utf-8")
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
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
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        assert "title" in zones
        assert "left" in zones
        assert "right" in zones
        assert "content" not in zones

    def test_step_marker_creates_chunk_boundary(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::body::\nFirst.\n::step::\nSecond.\n", encoding="utf-8")
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        assert _STEP in zones["body"]

    def test_empty_zone_section_excluded(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::left::\n\n::right::\nRight content.\n", encoding="utf-8")
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        assert "left" not in zones
        assert "right" in zones

    def test_steps_block_not_parsed_as_zone(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::steps::\n- Item\n::steps end::\n", encoding="utf-8")
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        assert "steps" not in zones

    def test_steps_block_produces_stepsblock(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "::content::\n::steps::\n- A\n- B\n::steps end::\n", encoding="utf-8"
        )
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        assert "content" in zones
        blocks = [c for c in zones["content"] if isinstance(c, _StepsBlock)]
        assert len(blocks) == 1
        assert "- A" in blocks[0].text

    def test_steps_block_strips_inner_step_markers(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "::content::\n::steps::\n- A\n::step::\n- B\n::steps end::\n",
            encoding="utf-8",
        )
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        blocks = [c for c in zones["content"] if isinstance(c, _StepsBlock)]
        assert len(blocks) == 1
        assert "::step::" not in blocks[0].text

    def test_steps_block_optional_end(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content::\n::steps::\n- A\n- B\n", encoding="utf-8")
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        blocks = [c for c in zones["content"] if isinstance(c, _StepsBlock)]
        assert len(blocks) == 1

    def test_steps_block_interleaves_with_step(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "::content::\nIntro.\n::step::\n::steps::\n- A\n- B\n::steps end::\n",
            encoding="utf-8",
        )
        zones = parse_markdown_zones(md.read_text(encoding="utf-8")).zones
        chunks = zones["content"]
        assert _STEP in chunks
        blocks = [c for c in chunks if isinstance(c, _StepsBlock)]
        assert len(blocks) == 1


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
        content_text = "".join(
            c for c in zones.get("content", []) if isinstance(c, str)
        )
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

    def test_stepsblock_wraps_list_items(self) -> None:
        chunks = [_StepsBlock("- One\n- Two\n")]
        html, step = chunks_to_html(chunks, 0)
        assert 'data-step="1"' in html
        assert 'data-step="2"' in html
        assert step == 2

    def test_stepsblock_wraps_paragraphs(self) -> None:
        chunks = [_StepsBlock("First para.\n\nSecond para.\n")]
        html, step = chunks_to_html(chunks, 0)
        assert 'data-step="1"' in html
        assert 'data-step="2"' in html
        assert step == 2

    def test_stepsblock_counter_continues_from_base(self) -> None:
        chunks = ["Intro", _STEP, _StepsBlock("- A\n- B\n")]
        html, step = chunks_to_html(chunks, 0)
        # _STEP increments to 1, then _StepsBlock items land at 2 and 3
        assert 'data-step="2"' in html
        assert 'data-step="3"' in html
        assert step == 3

    def test_stepsblock_and_step_interleave(self) -> None:
        chunks = [_StepsBlock("- A\n"), _STEP, "After"]
        html, step = chunks_to_html(chunks, 0)
        # block item at step 1, then _STEP → 2, "After" wrapped at 2
        assert 'data-step="1"' in html
        assert 'data-step="2"' in html
        assert step == 2

    def test_content_after_stepsblock_is_always_visible(self) -> None:
        # Content after ::steps end:: must NOT get a data-step wrapper
        chunks = [_StepsBlock("- A\n"), "Footer"]
        html, step = chunks_to_html(chunks, 0)
        assert "Footer" in html
        assert html.count("data-step") == 1  # only the block item
        assert step == 1


class TestHtmlFragmentToXml:
    def test_closes_raw_void_element(self) -> None:
        assert html_fragment_to_xml("a<br>b") == "a<br/>b"

    def test_leaves_wellformed_unchanged(self) -> None:
        assert html_fragment_to_xml("<p>ok</p>") == "<p>ok</p>"

    def test_empty_returns_empty(self) -> None:
        assert html_fragment_to_xml("") == ""

    def test_preserves_embedded_mathml(self) -> None:
        html = markdown_to_html(r"$e^{i\pi}$")
        assert "Math/MathML" in html_fragment_to_xml(html)


class TestStepsWrapContent:
    def test_raw_void_html_does_not_crash(self) -> None:
        # Regression for F-021: raw <br> in a stepped zone must not raise.
        html = markdown_to_html("Intro line<br>second line")
        result, step = steps_wrap_content(html, 0)
        assert "<br/>" in result
        assert 'data-step="1"' in result
        assert step == 1

    def test_list_items_each_wrapped(self) -> None:
        html = "<ul><li>One</li><li>Two</li></ul>"
        result, step = steps_wrap_content(html, 0)
        assert 'data-step="1"' in result
        assert 'data-step="2"' in result
        assert step == 2

    def test_paragraphs_each_wrapped(self) -> None:
        html = "<p>First</p><p>Second</p>"
        result, step = steps_wrap_content(html, 0)
        assert 'data-step="1"' in result
        assert 'data-step="2"' in result
        assert step == 2

    def test_mixed_list_and_paragraph(self) -> None:
        html = "<ul><li>A</li><li>B</li></ul><p>Para</p>"
        result, step = steps_wrap_content(html, 0)
        assert 'data-step="1"' in result
        assert 'data-step="2"' in result
        assert 'data-step="3"' in result
        assert step == 3

    def test_base_step_offset(self) -> None:
        html = "<p>Only</p>"
        result, step = steps_wrap_content(html, 4)
        assert 'data-step="5"' in result
        assert step == 5

    def test_non_steppable_elements_left_alone(self) -> None:
        html = "<h2>Heading</h2>"
        result, step = steps_wrap_content(html, 0)
        assert "data-step" not in result
        assert "Heading" in result
        assert step == 0

    def test_deflist_each_dt_dd_group_wrapped(self) -> None:
        html = "<dl><dt>Term 1</dt><dd>Def 1</dd><dt>Term 2</dt><dd>Def 2</dd></dl>"
        result, step = steps_wrap_content(html, 0)
        assert 'data-step="1"' in result
        assert 'data-step="2"' in result
        assert step == 2
        assert "Term 1" in result
        assert "Def 1" in result

    def test_deflist_dt_with_multiple_dd_is_one_step(self) -> None:
        html = "<dl><dt>Term</dt><dd>First</dd><dd>Second</dd></dl>"
        result, step = steps_wrap_content(html, 0)
        assert 'data-step="1"' in result
        assert 'data-step="2"' not in result
        assert step == 1

    def test_deflist_mixed_with_paragraph(self) -> None:
        html = "<p>Intro</p><dl><dt>A</dt><dd>a</dd><dt>B</dt><dd>b</dd></dl>"
        _, step = steps_wrap_content(html, 0)
        assert step == 3


class TestBuildSlideContent:
    def test_plain_markdown_becomes_textbox(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("Body content here.\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        assert isinstance(result, SlideContent)
        assert "zone-content" in result.content
        assert isinstance(result.content["zone-content"], TextBox)

    def test_h1_creates_title_textbox(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# My Title\n\nBody.\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        assert "zone-title" in result.content
        tb = result.content["zone-title"]
        assert isinstance(tb, TextBox)
        assert tb.text is not None
        assert "My Title" in tb.text
        assert "<h1>" in tb.text

    def test_str_zone_creates_textbox(self) -> None:
        result = build_slide_content(None, {"content": "**bold**"})
        assert "zone-content" in result.content
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert "bold" in (tb.text or "")

    def test_str_zone_rendered_as_markdown(self) -> None:
        result = build_slide_content(None, {"title": "# Hello"})
        tb = result.content["zone-title"]
        assert isinstance(tb, TextBox)
        assert "<h1>" in (tb.text or "")

    def test_media_kwarg_accepts_media_object_with_tuning(self) -> None:
        result = build_slide_content(
            None,
            {"image": Media("photo.png", fit=MediaFit.COVER, align=MediaAlign.TOP)},
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
            {"content": TextBox(text="<p>hello</p>", align=Align.CENTER, padding=30)},
        )
        assert "zone-content" in result.content
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align == Align.CENTER
        assert tb.padding == 30

    def test_steps_block_wraps_bullets(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::steps::\n- One\n- Two\n- Three\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        box = next(v for v in result.content.values() if isinstance(v, TextBox))
        assert box.text is not None
        assert "data-step" in box.text

    def test_no_content_no_extra_returns_empty(self) -> None:
        result = build_slide_content(None, {})
        assert result.content == {}
        assert result.notes == ""

    def test_notes_zone_returned_as_html(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "Body text.\n\n::notes::\n\nRemember **this**.\n", encoding="utf-8"
        )
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        assert "<strong>this</strong>" in result.notes
        assert "zone-notes" not in result.content

    def test_notes_zone_not_injected_into_slide(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::notes::\n\nPrivate note.\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        assert result.content == {}
        assert "Private note." in result.notes

    def test_no_notes_zone_returns_empty_notes(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# Title\n\nSome content.\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        assert result.notes == ""


class TestZoneParams:
    def test_parse_zone_params_extracted(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::title align=center::\n\n# Hello\n", encoding="utf-8")
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert parsed.params.get("title") == {"align": "center"}

    def test_parse_zone_multiple_params(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text(
            "::content align=right valign=center padding=20::\n\nBody\n",
            encoding="utf-8",
        )
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert parsed.params["content"] == {
            "align": "right",
            "valign": "center",
            "padding": "20",
        }

    def test_zone_without_params_has_no_entry(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content::\n\nBody\n", encoding="utf-8")
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert "content" not in parsed.params

    def test_parse_zones_returns_parsed_markdown(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::title align=center::\n\n# Hello\n", encoding="utf-8")
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert "title" in parsed.zones
        assert isinstance(parsed.zones["title"], list)

    def test_build_slide_content_align_param(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content align=center::\n\nBody text\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align == Align.CENTER

    def test_build_slide_content_valign_param(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content valign=center::\n\nBody text\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.valign == VAlign.CENTER

    def test_build_slide_content_padding_param(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content padding=40::\n\nBody text\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.padding == 40.0

    def test_unknown_params_ignored(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content unknown=foo align=left::\n\nBody\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align == Align.LEFT

    def test_no_params_textbox_fields_are_none(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::content::\n\nBody\n", encoding="utf-8")
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        tb = result.content["zone-content"]
        assert isinstance(tb, TextBox)
        assert tb.align is None
        assert tb.valign is None
        assert tb.padding is None


class TestMath:
    def test_inline_math_renders_to_mathml(self) -> None:
        out = markdown_to_html("This is $x^2 + y^2 = z^2$ inline.")
        assert "<math" in out
        assert "$" not in out

    def test_block_math_renders_to_mathml(self) -> None:
        out = markdown_to_html("$$E = mc^2$$")
        assert "<math" in out
        assert 'class="math block"' in out
        assert "$" not in out

    def test_math_does_not_raise_on_unknown_commands(self) -> None:
        # latex2mathml is lenient and renders unknown commands rather than raising.
        # Verify no exception propagates and the output is non-empty.
        out = markdown_to_html(r"$\zzznonsense$")
        assert isinstance(out, str)
        assert len(out) > 0


class TestParseHlSpec:
    def test_single_line(self) -> None:
        assert _parse_hl_spec("1") == [[1]]

    def test_comma_separated_lines(self) -> None:
        assert _parse_hl_spec("1,3,5") == [[1, 3, 5]]

    def test_range(self) -> None:
        assert _parse_hl_spec("2-4") == [[2, 3, 4]]

    def test_multiple_stages(self) -> None:
        assert _parse_hl_spec("1|2-3") == [[1], [2, 3]]

    def test_all_keyword(self) -> None:
        assert _parse_hl_spec("all") == [None]

    def test_star_keyword(self) -> None:
        assert _parse_hl_spec("*") == [None]

    def test_none_keyword(self) -> None:
        assert _parse_hl_spec("none") == [[]]

    def test_empty_stage_treated_as_all(self) -> None:
        assert _parse_hl_spec("1||2") == [[1], None, [2]]

    def test_full_three_stage_spec(self) -> None:
        assert _parse_hl_spec("1|2-3|all") == [[1], [2, 3], None]

    def test_mixed_comma_and_range(self) -> None:
        assert _parse_hl_spec("1,3|2-4") == [[1, 3], [2, 3, 4]]

    def test_malformed_range_yields_empty_stage(self) -> None:
        assert _parse_hl_spec("a-b") == [[]]

    def test_whitespace_around_values_trimmed(self) -> None:
        assert _parse_hl_spec(" 1 | 2-3 | all ") == [[1], [2, 3], None]


class TestParseFenceInfo:
    def test_plain_lang(self) -> None:
        assert _parse_fence_info("python") == ("python", None)

    def test_lang_with_spec(self) -> None:
        lang, spec = _parse_fence_info("python {1|2-3}")
        assert lang == "python"
        assert spec == [[1], [2, 3]]

    def test_spec_without_lang_defaults_to_text(self) -> None:
        lang, spec = _parse_fence_info("{1|2}")
        assert lang == "text"
        assert spec == [[1], [2]]

    def test_empty_info_defaults_to_text_no_spec(self) -> None:
        assert _parse_fence_info("") == ("text", None)

    def test_spec_with_all_stage(self) -> None:
        lang, spec = _parse_fence_info("rust {1|all}")
        assert lang == "rust"
        assert spec == [[1], None]

    def test_whitespace_around_lang_and_spec(self) -> None:
        lang, spec = _parse_fence_info("  python  {1}  ")
        assert lang == "python"
        assert spec == [[1]]


class TestRenderCodeblock:
    def test_plain_block_has_no_spec_attrs(self) -> None:
        html = _render_codeblock("x = 1\n", "python", None, 0)
        assert "data-hl-spec" not in html
        assert "data-base-step" not in html
        assert "inkflow-codeblock" in html

    def test_spec_block_embeds_spec_and_base_step(self) -> None:
        import json

        spec = [[1], [2], None]
        html = _render_codeblock("a\nb\nc\n", "text", spec, 3)
        assert json.dumps(spec) in html
        assert 'data-base-step="3"' in html

    def test_each_line_gets_code_line_span(self) -> None:
        html = _render_codeblock("a\nb\n", "text", None, 0)
        assert 'class="code-line" data-line="1"' in html
        assert 'class="code-line" data-line="2"' in html

    def test_blank_line_gets_nbsp_entity(self) -> None:
        html = _render_codeblock("a\n\nb\n", "text", None, 0)
        assert "&#160;" in html

    def test_no_bare_newlines_between_spans(self) -> None:
        import re

        html = _render_codeblock("a\nb\nc\n", "text", None, 0)
        inner = re.search(r"<code>(.*?)</code>", html, re.DOTALL)
        assert inner is not None
        assert "\n" not in inner.group(1)


class TestRenderMdWithSteps:
    def test_plain_fence_does_not_advance_step(self) -> None:
        _, step = _render_md_with_steps("```python\nx = 1\n```\n", 0)
        assert step == 0

    def test_spec_fence_advances_step_by_stages_minus_one(self) -> None:
        # {1|2|all} = 3 stages → 2 extra steps
        _, step = _render_md_with_steps("```text {1|2|all}\na\nb\nc\n```\n", 0)
        assert step == 2

    def test_base_step_offset_applied(self) -> None:
        _, step = _render_md_with_steps("```text {1|2}\na\nb\n```\n", 5)
        assert step == 6  # 5 + (2 - 1)

    def test_multiple_spec_fences_accumulate(self) -> None:
        md = "```text {1|2}\na\nb\n```\n\n```text {1|2|3}\na\nb\nc\n```\n"
        _, step = _render_md_with_steps(md, 0)
        assert step == 3  # (2-1) + (3-1)

    def test_spec_fence_html_contains_data_hl_spec(self) -> None:
        html, _ = _render_md_with_steps("```python {1}\nx = 1\n```\n", 0)
        assert "data-hl-spec" in html

    def test_plain_fence_html_has_no_data_hl_spec(self) -> None:
        html, _ = _render_md_with_steps("```python\nx = 1\n```\n", 0)
        assert "data-hl-spec" not in html

    def test_spec_fence_base_step_matches_step_at_entry(self) -> None:
        html, _ = _render_md_with_steps("```text {1|2}\na\nb\n```\n", 4)
        assert 'data-base-step="4"' in html


class TestChunksToHtmlCodeblocks:
    def test_fence_with_spec_advances_step(self) -> None:
        html, step = chunks_to_html(["```text {1|2}\na\nb\n```"], 0)
        assert "data-hl-spec" in html
        assert step == 1

    def test_step_marker_after_spec_fence_accounts_for_stages(self) -> None:
        # fence consumes steps 0→1, ::step:: bumps to 2, "After" wrapped at 2
        chunks = ["```text {1|2}\na\nb\n```", _STEP, "After"]
        html, step = chunks_to_html(chunks, 0)
        assert 'data-step="2"' in html
        assert step == 2

    def test_spec_fence_at_nonzero_base_step(self) -> None:
        html, step = chunks_to_html(["```text {1|2|3}\na\nb\nc\n```"], 3)
        assert 'data-base-step="3"' in html
        assert step == 5  # 3 + (3 - 1)


# ── auto_zones tracking ───────────────────────────────────────────────────────


class TestAutoZones:
    def test_auto_zones_no_markers(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# H1\n\nbody text\n", encoding="utf-8")
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert parsed.auto_zones == frozenset({"title", "content"})

    def test_auto_zones_with_marker(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# H1\n::quote::\nbody\n", encoding="utf-8")
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert parsed.auto_zones == frozenset({"title"})

    def test_auto_zones_empty_when_only_markers(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("::quote::\nThis is a quote\n", encoding="utf-8")
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert parsed.auto_zones == frozenset()

    def test_auto_zones_title_and_subtitle(self, tmp_path: Path) -> None:
        md = tmp_path / "slide.md"
        md.write_text("# Title\n## Subtitle\n", encoding="utf-8")
        parsed = parse_markdown_zones(md.read_text(encoding="utf-8"))
        assert parsed.auto_zones == frozenset({"title", "subtitle"})


# ── _reroute_zones ────────────────────────────────────────────────────────────


class TestRerouteZones:
    def test_title_displaced_to_default(self) -> None:
        zones = {"title": ["# A Quote"], "content": ["body text"]}
        auto_zones = frozenset({"title", "content"})
        available = {"zone-quote"}
        result = _reroute_zones(zones, auto_zones, available, "quote")  # pyright: ignore[reportArgumentType]
        assert "title" not in result
        assert "content" not in result
        assert "quote" in result
        assert result["quote"][0] == "# A Quote"

    def test_content_displaced_and_merged_with_title(self) -> None:
        zones = {"title": ["# Title"], "content": ["body"]}
        auto_zones = frozenset({"title", "content"})
        available = {"zone-quote"}
        result = _reroute_zones(zones, auto_zones, available, "quote")  # pyright: ignore[reportArgumentType]
        assert result["quote"] == ["# Title", "body"]

    def test_content_displaced_when_zone_absent(self) -> None:
        zones = {"content": ["body text"]}
        auto_zones = frozenset({"content"})
        available = {"zone-fact"}
        result = _reroute_zones(zones, auto_zones, available, "fact")  # pyright: ignore[reportArgumentType]
        assert "content" not in result
        assert "fact" in result

    def test_content_stays_when_zone_content_exists(self) -> None:
        zones = {"content": ["body text"]}
        auto_zones = frozenset({"content"})
        available = {"zone-content", "zone-fact"}
        result = _reroute_zones(zones, auto_zones, available, "fact")  # pyright: ignore[reportArgumentType]
        assert "content" in result
        assert "fact" not in result

    def test_title_stays_when_zone_exists(self) -> None:
        zones = {"title": ["# Title"], "content": ["body"]}
        auto_zones = frozenset({"title", "content"})
        available = {"zone-title", "zone-content"}
        result = _reroute_zones(zones, auto_zones, available, "content")  # pyright: ignore[reportArgumentType]
        assert "title" in result
        assert "content" in result

    def test_explicit_marker_not_displaced(self) -> None:
        # ::quote:: is an explicit marker — not in auto_zones, should stay
        zones = {"quote": ["explicit quote"], "content": ["body"]}
        auto_zones = frozenset({"content"})
        available = {"zone-quote"}
        result = _reroute_zones(zones, auto_zones, available, "quote")  # pyright: ignore[reportArgumentType]
        assert "quote" in result
        # body (auto, no zone-content) prepended to default "quote"
        assert result["quote"][0] == "body"

    def test_no_default_zone_raises(self) -> None:
        zones = {"content": ["body"]}
        auto_zones = frozenset({"content"})
        available = {"zone-media"}
        with pytest.raises(ValueError, match="inkflow:default-zone"):
            _reroute_zones(zones, auto_zones, available, "")  # pyright: ignore[reportArgumentType]

    def test_no_displacement_no_error_without_default(self) -> None:
        zones = {"quote": ["explicit"]}
        auto_zones: frozenset[str] = frozenset()
        available = {"zone-quote"}
        result = _reroute_zones(zones, auto_zones, available, "")  # pyright: ignore[reportArgumentType]
        assert result == {"quote": ["explicit"]}

    def test_build_slide_content_skips_reroute_without_available_zones(
        self, tmp_path: Path
    ) -> None:
        md = tmp_path / "slide.md"
        md.write_text("body text\n", encoding="utf-8")
        # Without available_zones, no rerouting — no ValueError even without default
        result = build_slide_content(md.read_text(encoding="utf-8"), {})
        assert "zone-content" in result.content
