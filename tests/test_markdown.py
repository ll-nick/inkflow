from __future__ import annotations

from inkflow.markdown import (
    _parse_fence_info,  # pyright: ignore[reportPrivateUsage]
    _parse_hl_spec,  # pyright: ignore[reportPrivateUsage]
    _render_codeblock,  # pyright: ignore[reportPrivateUsage]
    html_fragment_to_xml,
    markdown_to_html,
    render_md_with_steps,
)


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
        _, step = render_md_with_steps("```python\nx = 1\n```\n", 0)
        assert step == 0

    def test_spec_fence_advances_step_by_stages_minus_one(self) -> None:
        # {1|2|all} = 3 stages → 2 extra steps
        _, step = render_md_with_steps("```text {1|2|all}\na\nb\nc\n```\n", 0)
        assert step == 2

    def test_base_step_offset_applied(self) -> None:
        _, step = render_md_with_steps("```text {1|2}\na\nb\n```\n", 5)
        assert step == 6  # 5 + (2 - 1)

    def test_multiple_spec_fences_accumulate(self) -> None:
        md = "```text {1|2}\na\nb\n```\n\n```text {1|2|3}\na\nb\nc\n```\n"
        _, step = render_md_with_steps(md, 0)
        assert step == 3  # (2-1) + (3-1)

    def test_spec_fence_html_contains_data_hl_spec(self) -> None:
        html, _ = render_md_with_steps("```python {1}\nx = 1\n```\n", 0)
        assert "data-hl-spec" in html

    def test_plain_fence_html_has_no_data_hl_spec(self) -> None:
        html, _ = render_md_with_steps("```python\nx = 1\n```\n", 0)
        assert "data-hl-spec" not in html

    def test_spec_fence_base_step_matches_step_at_entry(self) -> None:
        html, _ = render_md_with_steps("```text {1|2}\na\nb\n```\n", 4)
        assert 'data-base-step="4"' in html
