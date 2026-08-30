from __future__ import annotations

import itertools
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from inkflow.animations import Animation, Bounce, FadeIn, SlideIn
from inkflow.assets import AssetRoots, AssetSource
from inkflow.enums import Align, Direction, Easing, MediaAlign, MediaFit, VAlign
from inkflow.manifest import Image, Media, TextBox, ZoneContent
from inkflow.markdown import markdown_to_html
from inkflow.steps import StepResolver
from inkflow.zones import (
    SlideContent,
    _auto_extract,  # pyright: ignore[reportPrivateUsage]
    _reroute_zones,  # pyright: ignore[reportPrivateUsage]
    _RevealSpec,  # pyright: ignore[reportPrivateUsage]
    _StepMarker,  # pyright: ignore[reportPrivateUsage]
    _StepsBlock,  # pyright: ignore[reportPrivateUsage]
    chunks_to_html,
    parse_markdown_zones,
    steps_wrap_content,
)
from inkflow.zones import build_slide_content as _build_slide_content_parsed

# Reveals become (Animation, resolved-step) pairs, routed through the annotate
# pass which stamps the fade-in class + data-step on the inkflow-step-* ids. So
# the step tests assert on those pairs and the ids.
_Reveal = tuple[Animation, int]


# Adapter: build_slide_content now takes a pre-parsed ParsedMarkdown (parse markdown
# once per rebuild). This same-named wrapper keeps the str / None call sites below.
def build_slide_content(
    content: str | None,
    extra: dict[str, ZoneContent],
    available_zones: set[str] | None = None,
    default_zone: str = "",
) -> SlideContent:
    parsed = parse_markdown_zones(content) if isinstance(content, str) else None
    source = AssetSource.for_deck(AssetRoots(Path.cwd()))
    return _build_slide_content_parsed(
        parsed,
        extra,
        source,
        source,
        available_zones=available_zones,
        default_zone=default_zone,
    )


def _c2h(
    chunks: Sequence[str | _StepMarker | _StepsBlock], base: int = 0
) -> tuple[str, int, list[_Reveal]]:
    return chunks_to_html(chunks, base, itertools.count(1))


# steps_wrap_content now takes a shared StepResolver and returns just (html,
# pairs); this adapter keeps the old (html, final-step, pairs) shape for the
# call sites below.
def _swc(
    html: str, base: int = 0, spec: _RevealSpec | None = None
) -> tuple[str, int, list[_Reveal]]:
    stepper = StepResolver(base)
    inner, anims = steps_wrap_content(
        html, stepper, itertools.count(1), spec or (FadeIn, {})
    )
    return inner, stepper.high, anims


def _steps(anims: list[_Reveal]) -> list[int]:
    return [step for _, step in anims]


def _objs(anims: list[_Reveal]) -> list[Animation]:
    return [anim for anim, _ in anims]


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
        assert any(isinstance(c, _StepMarker) for c in zones["body"])

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
        assert any(isinstance(c, _StepMarker) for c in chunks)
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
        html, step, anims = _c2h(["Hello **world**"])
        assert "<p>" in html or "Hello" in html
        assert "inkflow-step-" not in html
        assert anims == []
        assert step == 0

    def test_second_chunk_wrapped_with_reveal(self) -> None:
        html, step, anims = _c2h(["First", _StepMarker(), "Second"])
        assert _steps(anims) == [1]
        assert isinstance(_objs(anims)[0], FadeIn)
        assert f'id="{_objs(anims)[0].element}"' in html
        assert step == 1

    def test_base_step_offset_applied(self) -> None:
        _html, step, anims = _c2h(["First", _StepMarker(), "Second"], 5)
        assert _steps(anims) == [6]
        assert step == 6

    def test_multiple_steps_increment(self) -> None:
        _html, step, anims = _c2h(["A", _StepMarker(), "B", _StepMarker(), "C"])
        assert _steps(anims) == [1, 2]
        assert step == 2

    def test_stepsblock_wraps_list_items(self) -> None:
        _html, step, anims = _c2h([_StepsBlock("- One\n- Two\n")])
        assert _steps(anims) == [1, 2]
        assert step == 2

    def test_stepsblock_wraps_paragraphs(self) -> None:
        _html, step, anims = _c2h([_StepsBlock("First para.\n\nSecond para.\n")])
        assert _steps(anims) == [1, 2]
        assert step == 2

    def test_stepsblock_counter_continues_from_base(self) -> None:
        # _StepMarker increments to 1, then _StepsBlock items land at 2 and 3
        _html, step, anims = _c2h(["Intro", _StepMarker(), _StepsBlock("- A\n- B\n")])
        assert _steps(anims) == [2, 3]
        assert step == 3

    def test_stepsblock_and_step_interleave(self) -> None:
        # block item at step 1, then ::step:: → 2, "After" wrapped at 2
        _html, step, anims = _c2h([_StepsBlock("- A\n"), _StepMarker(), "After"])
        assert _steps(anims) == [1, 2]
        assert step == 2

    def test_content_after_stepsblock_is_always_visible(self) -> None:
        # Content after ::steps end:: must NOT get a reveal
        html, step, anims = _c2h([_StepsBlock("- A\n"), "Footer"])
        assert "Footer" in html
        assert len(anims) == 1  # only the block item
        assert step == 1


class TestChunksToHtmlCodeblocks:
    def test_fence_with_spec_advances_step(self) -> None:
        html, step, _anims = _c2h(["```text {1|2}\na\nb\n```"])
        assert "data-hl-spec" in html
        assert step == 1

    def test_step_marker_after_spec_fence_accounts_for_stages(self) -> None:
        # fence consumes steps 0→1, ::step:: bumps to 2, "After" wrapped at 2
        _html, step, anims = _c2h(["```text {1|2}\na\nb\n```", _StepMarker(), "After"])
        assert _steps(anims) == [2]
        assert step == 2

    def test_spec_fence_at_nonzero_base_step(self) -> None:
        html, step, _anims = _c2h(["```text {1|2|3}\na\nb\nc\n```"], 3)
        assert 'data-base-step="3"' in html
        assert step == 5  # 3 + (3 - 1)


class TestStepsWrapContent:
    def test_raw_void_html_does_not_crash(self) -> None:
        # Regression for F-021: raw <br> in a stepped zone must not raise.
        html = markdown_to_html("Intro line<br>second line")
        result, step, anims = _swc(html)
        assert "<br/>" in result
        assert _steps(anims) == [1]
        assert f'id="{_objs(anims)[0].element}"' in result
        assert step == 1

    def test_list_items_each_wrapped(self) -> None:
        _result, step, anims = _swc("<ul><li>One</li><li>Two</li></ul>")
        assert _steps(anims) == [1, 2]
        assert step == 2

    def test_paragraphs_each_wrapped(self) -> None:
        _result, step, anims = _swc("<p>First</p><p>Second</p>")
        assert _steps(anims) == [1, 2]
        assert step == 2

    def test_mixed_list_and_paragraph(self) -> None:
        _result, step, anims = _swc("<ul><li>A</li><li>B</li></ul><p>Para</p>")
        assert _steps(anims) == [1, 2, 3]
        assert step == 3

    def test_base_step_offset(self) -> None:
        _result, step, anims = _swc("<p>Only</p>", 4)
        assert _steps(anims) == [5]
        assert step == 5

    def test_non_steppable_elements_left_alone(self) -> None:
        result, step, anims = _swc("<h2>Heading</h2>")
        assert anims == []
        assert "inkflow-step-" not in result
        assert "Heading" in result
        assert step == 0

    def test_reveal_type_from_spec(self) -> None:
        # The block's resolved type/params flow to every wrapped item.
        _result, _step, anims = _swc(
            "<ul><li>A</li><li>B</li></ul>", spec=(SlideIn, {"distance": 120.0})
        )
        objs = _objs(anims)
        assert all(isinstance(a, SlideIn) for a in objs)
        assert all(a.distance == 120.0 for a in objs if isinstance(a, SlideIn))

    def test_deflist_each_dt_dd_group_wrapped(self) -> None:
        html = "<dl><dt>Term 1</dt><dd>Def 1</dd><dt>Term 2</dt><dd>Def 2</dd></dl>"
        result, step, anims = _swc(html)
        assert _steps(anims) == [1, 2]
        assert step == 2
        assert "Term 1" in result
        assert "Def 1" in result

    def test_deflist_dt_with_multiple_dd_is_one_step(self) -> None:
        _result, step, anims = _swc(
            "<dl><dt>Term</dt><dd>First</dd><dd>Second</dd></dl>"
        )
        assert _steps(anims) == [1]
        assert step == 1

    def test_deflist_mixed_with_paragraph(self) -> None:
        _result, step, _anims = _swc(
            "<p>Intro</p><dl><dt>A</dt><dd>a</dd><dt>B</dt><dd>b</dd></dl>"
        )
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
            {"image": Image("photo.png", fit=MediaFit.COVER, align=MediaAlign.TOP)},
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
        # Reveals are Animation objects keyed to inkflow-step-* ids in the html.
        assert _steps(result.animations) == [1, 2, 3]
        assert result.max_step == 3
        for anim in _objs(result.animations):
            assert f'id="{anim.element}"' in box.text

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


@dataclass
class _CustomGlow(Animation):
    intensity: float = 1.0


class TestMarkerGrammar:
    def test_default_reveal_is_fade_in(self) -> None:
        result = build_slide_content("::content::\n::step::\nX.\n", {})
        assert [type(a) for a in _objs(result.animations)] == [FadeIn]

    def test_step_type_and_params(self) -> None:
        md = (
            "::content::\nIntro.\n\n"
            + "::step type=SlideIn distance=120 direction=right::\nX.\n"
        )
        result = build_slide_content(md, {})
        ((a, _),) = result.animations
        assert isinstance(a, SlideIn)
        assert a.distance == 120.0
        assert a.direction == Direction.RIGHT

    def test_step_trigger_param_coerced(self) -> None:
        # trigger= flows through to the cue and drives the resolved step: the
        # with-previous reveal shares the step of the ON_CLICK reveal before it.
        md = (
            "::content::\n::step::\nFirst.\n\n"
            + "::step trigger=with-previous::\nTogether.\n"
        )
        result = build_slide_content(md, {})
        assert _steps(result.animations) == [1, 1]

    def test_steps_block_type_applies_to_all_items(self) -> None:
        md = (
            "::content::\n::steps type=Bounce duration=0.5::\n"
            + "- one\n- two\n::steps end::\n"
        )
        result = build_slide_content(md, {})
        objs = _objs(result.animations)
        assert all(isinstance(a, Bounce) for a in objs)
        assert [a.duration for a in objs] == [0.5, 0.5]
        assert _steps(result.animations) == [1, 2]

    def test_easing_param_coerced_to_easing(self) -> None:
        result = build_slide_content(
            "::content::\n::step type=FadeIn easing=ease-in-out::\nX.\n", {}
        )
        ((a, _),) = result.animations
        assert a.easing == Easing.EASE_IN_OUT
        assert isinstance(a.easing, Easing)

    def test_unknown_type_falls_back_to_fade_in(self) -> None:
        result = build_slide_content("::content::\n::step type=Nope::\nX.\n", {})
        assert [type(a) for a in _objs(result.animations)] == [FadeIn]

    def test_custom_type_resolved_by_name(self) -> None:
        result = build_slide_content(
            "::content::\n::step type=_CustomGlow intensity=3::\nX.\n", {}
        )
        ((a, _),) = result.animations
        assert isinstance(a, _CustomGlow)
        assert a.intensity == 3.0

    def test_reserved_keys_not_forwarded(self) -> None:
        # element in a marker must not collide with the resolver-injected id; a
        # bogus step= param is just an unknown param and must not affect the step.
        result = build_slide_content(
            "::content::\n::step type=FadeIn element=x step=9::\nX.\n", {}
        )
        ((a, step),) = result.animations
        assert a.element.startswith("inkflow-step-")
        assert step == 1


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
