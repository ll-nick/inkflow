# pyright: reportPrivateUsage=none
from __future__ import annotations

import json
import logging
import re
import textwrap
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict, cast

import pytest

from inkflow.animations import (
    Bounce,
    Cue,
    FadeIn,
    FadeOut,
    Highlight,
    PlayVideo,
    SlideIn,
    ZoomIn,
)
from inkflow.enums import Direction, Trigger
from inkflow.logging import collect_logs
from inkflow.manifest import (
    Deck,
    Image,
    Inline,
    Slide,
    Video,
)
from inkflow.overlay import Overlay
from inkflow.pipeline import _add_layout_classes as _add_layout_classes_el
from inkflow.pipeline import (
    _deduplicate_ids,
    _infer_slide_id,
    _resolve_run_offsets,
    process_deck,
    resolve_slide_src,
    resolve_steps,
    resolve_transitions,
)
from inkflow.pipeline import annotate_svg as _annotate_svg_el
from inkflow.svgio import parse_svg, serialize_svg
from inkflow.themes import Theme
from inkflow.transitions import Crossfade, Cut, Morph


# String adapters: these pipeline DOM functions now take and return an element
# (parse once). These same-named wrappers keep the string call sites below.
# annotate_svg takes (cue, resolved-step) pairs, matching the real signature.
def annotate_svg(svg: str, cues: list[tuple[Cue, int]]) -> str:
    return serialize_svg(_annotate_svg_el(parse_svg(svg), cues))


def _add_layout_classes(
    svg: str, chain: list[Path], src: Path, overlays: list[list[Path]] | None = None
) -> str:
    return serialize_svg(
        _add_layout_classes_el(parse_svg(svg), chain, src, overlays or [])
    )


_SVG_NS = "http://www.w3.org/2000/svg"

_PLAIN_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect id="box" x="0" y="0" width="50" height="50"/>
      <circle id="dot" cx="75" cy="25" r="10"/>
    </svg>
""")


class TestResolveSlideSource:
    def _make_slide(self, tmp_path: Path, name: str) -> Path:
        p = tmp_path / "slides" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(_PLAIN_SVG, encoding="utf-8")
        return p

    def test_bare_name_finds_slides_svg(self, tmp_path: Path) -> None:
        expected = self._make_slide(tmp_path, "title.svg")
        assert resolve_slide_src("title", tmp_path) == expected

    def test_svg_filename_finds_slides_svg(self, tmp_path: Path) -> None:
        expected = self._make_slide(tmp_path, "01-title.svg")
        assert resolve_slide_src("01-title.svg", tmp_path) == expected

    def test_explicit_slides_prefix_still_works(self, tmp_path: Path) -> None:
        expected = self._make_slide(tmp_path, "01-title.svg")
        assert resolve_slide_src("slides/01-title.svg", tmp_path) == expected

    def test_bare_name_not_in_slides_falls_through_to_layout(
        self, tmp_path: Path
    ) -> None:
        layout = tmp_path / "layouts" / "content.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_PLAIN_SVG, encoding="utf-8")
        assert resolve_slide_src("content", tmp_path) == layout


class _CueDict(TypedDict):
    step: int
    kind: str
    name: str
    offset: float
    opts: dict[str, object]
    vars: dict[str, str]


def _parse_cues(svg: str, element_id: str) -> list[_CueDict]:
    """The parsed `data-cues` list for one element (empty when absent)."""
    el = parse_svg(svg).find(f'.//*[@id="{element_id}"]')
    raw = el.get("data-cues") if el is not None else None
    return cast("list[_CueDict]", json.loads(raw)) if raw else []


class TestAnnotateSvg:
    @staticmethod
    def _cues(svg: str, element_id: str) -> list[_CueDict]:
        return _parse_cues(svg, element_id)

    @staticmethod
    def _classes(svg: str, element_id: str) -> list[str]:
        el = parse_svg(svg).find(f'.//*[@id="{element_id}"]')
        return (el.get("class") or "").split() if el is not None else []

    def test_fade_writes_enter_cue(self) -> None:
        [cue] = self._cues(annotate_svg(_PLAIN_SVG, [(FadeIn("box"), 1)]), "box")
        assert (cue["name"], cue["kind"], cue["step"]) == ("fade-in", "enter", 1)

    def test_fade_out_kind_is_exit(self) -> None:
        [cue] = self._cues(annotate_svg(_PLAIN_SVG, [(FadeOut("box"), 2)]), "box")
        assert (cue["name"], cue["kind"], cue["step"]) == ("fade-out", "exit", 2)

    def test_bounce_easing_defaults_to_spring(self) -> None:
        # Bounce overrides the base easing default with its spring curve; the pipeline
        # serializes it like any other animation's easing (no special-casing).
        [cue] = self._cues(annotate_svg(_PLAIN_SVG, [(Bounce("dot"), 3)]), "dot")
        assert cue["name"] == "bounce"
        assert str(cue["opts"]["easing"]).startswith("cubic-bezier")

    def test_emits_anim_slug_styling_hook_class(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [(ZoomIn("box"), 1)])
        assert "anim-zoom-in" in self._classes(result, "box")

    def test_multi_cue_emits_a_class_per_type(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [(FadeIn("box"), 1), (ZoomIn("box"), 2)])
        classes = self._classes(result, "box")
        assert "anim-fade-in" in classes and "anim-zoom-in" in classes

    def test_enter_first_adds_pending_class(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [(FadeIn("box"), 1)])
        assert "anim-pending" in self._classes(result, "box")

    def test_exit_first_has_no_pending_class(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [(FadeOut("box"), 1)])
        assert "anim-pending" not in self._classes(result, "box")

    def test_preserves_existing_class(self) -> None:
        svg = _PLAIN_SVG.replace('<rect id="box"', '<rect id="box" class="my-class"')
        classes = self._classes(annotate_svg(svg, [(FadeIn("box"), 1)]), "box")
        assert "my-class" in classes and "anim-pending" in classes

    def test_missing_element_warns_and_continues(self) -> None:
        with collect_logs(logging.WARNING) as warnings:
            result = annotate_svg(_PLAIN_SVG, [(FadeIn("nonexistent"), 1)])
        assert any("nonexistent" in w.message for w in warnings)
        assert 'id="box"' in result  # rest of SVG intact

    def test_multiple_cues_on_one_element_grouped_and_sorted(self) -> None:
        result = annotate_svg(
            _PLAIN_SVG,
            [(FadeOut("box"), 5), (FadeIn("box"), 1), (Highlight("box"), 2)],
        )
        cues = self._cues(result, "box")
        assert [(c["name"], c["kind"], c["step"]) for c in cues] == [
            ("fade-in", "enter", 1),
            ("highlight", "emphasis", 2),
            ("fade-out", "exit", 5),
        ]

    def test_no_animations_leaves_svg_unchanged(self) -> None:
        result = annotate_svg(_PLAIN_SVG, [])
        assert "data-cues" not in result
        assert 'id="box"' in result

    def test_name_derived_from_type(self) -> None:
        [cue] = self._cues(annotate_svg(_PLAIN_SVG, [(ZoomIn("box"), 1)]), "box")
        assert cue["name"] == "zoom-in"
        assert cue["vars"] == {"scale": "0.8"}

    def test_lone_distance_is_a_var_not_a_slide_offset(self) -> None:
        # Bounce has `distance` but no `direction`, so it passes through as a plain var
        # (the keyframe applies the unit) rather than being consumed into from-x/from-y.
        [cue] = self._cues(annotate_svg(_PLAIN_SVG, [(Bounce("dot"), 3)]), "dot")
        assert cue["vars"] == {"distance": "14.0"}

    def test_direction_resolves_to_from_offset(self) -> None:
        result = annotate_svg(
            _PLAIN_SVG, [(SlideIn("box", direction=Direction.RIGHT, distance=200), 1)]
        )
        [cue] = self._cues(result, "box")
        assert cue["vars"] == {"from-x": "200px", "from-y": "0px"}

    def test_trigger_not_serialized(self) -> None:
        [cue] = self._cues(
            annotate_svg(_PLAIN_SVG, [(FadeIn("box", Trigger.WITH_PREVIOUS), 2)]),
            "box",
        )
        assert "trigger" not in cue["vars"]
        assert cue["step"] == 2

    def test_timing_opts_from_python_defaults(self) -> None:
        # Defaults live in Python and are always serialized (no CSS fallback). The opts
        # are exactly the base Animation fields.
        [cue] = self._cues(annotate_svg(_PLAIN_SVG, [(FadeIn("box"), 1)]), "box")
        assert cue["opts"] == {
            "duration": 0.4,
            "delay": 0.0,
            "easing": "ease",
            "iterations": 1,
        }

    def test_timing_opts_overridden(self) -> None:
        [cue] = self._cues(
            annotate_svg(_PLAIN_SVG, [(FadeIn("box", duration=0.8, delay=0.2), 1)]),
            "box",
        )
        assert cue["opts"]["duration"] == 0.8
        assert cue["opts"]["delay"] == 0.2

    def test_iterations_is_an_option_color_is_a_var(self) -> None:
        [cue] = self._cues(
            annotate_svg(
                _PLAIN_SVG, [(Highlight("box", color="#ff0000", iterations=3), 1)]
            ),
            "box",
        )
        assert cue["opts"]["iterations"] == 3
        assert cue["vars"]["color"] == "#ff0000"

    def test_preserves_existing_style(self) -> None:
        svg = _PLAIN_SVG.replace('<rect id="box"', '<rect id="box" style="fill:red"')
        result = annotate_svg(svg, [(FadeIn("box"), 1)])
        assert "fill:red" in result
        assert "data-cues" in result

    def test_two_enters_on_one_element_warn(self) -> None:
        with collect_logs(logging.WARNING) as warnings:
            annotate_svg(_PLAIN_SVG, [(FadeIn("box"), 1), (SlideIn("box"), 2)])
        assert any("two enter" in w.message for w in warnings)

    def test_enter_exit_enter_does_not_warn(self) -> None:
        # Re-entry is legitimate: an opposing exit sits between the two enters.
        with collect_logs(logging.WARNING) as warnings:
            annotate_svg(
                _PLAIN_SVG,
                [(FadeIn("box"), 1), (FadeOut("box"), 3), (FadeIn("box"), 5)],
            )
        assert not any("opposing" in w.message for w in warnings)


class TestResolveSteps:
    def test_on_click_advances(self) -> None:
        pairs = resolve_steps([FadeIn("a"), FadeIn("b"), FadeIn("c")])
        assert [s for _, s in pairs] == [1, 2, 3]

    def test_with_previous_shares_step(self) -> None:
        pairs = resolve_steps(
            [FadeIn("a"), FadeIn("b", Trigger.WITH_PREVIOUS), FadeIn("c")]
        )
        assert [s for _, s in pairs] == [1, 1, 2]

    def test_first_with_previous_is_slide_entry(self) -> None:
        pairs = resolve_steps([FadeIn("a", Trigger.WITH_PREVIOUS), FadeIn("b")])
        assert [s for _, s in pairs] == [0, 1]

    def test_at_pins_and_lifts_max(self) -> None:
        pairs = resolve_steps([FadeIn("a"), FadeIn("b", Trigger.at(5)), FadeIn("c")])
        assert [s for _, s in pairs] == [1, 5, 6]

    def test_after_previous_shares_step(self) -> None:
        # Like WITH_PREVIOUS for step numbering; the two differ only in delay.
        pairs = resolve_steps(
            [FadeIn("a"), FadeIn("b", Trigger.AFTER_PREVIOUS), FadeIn("c")]
        )
        assert [s for _, s in pairs] == [1, 1, 2]

    def test_base_offsets_the_sequence(self) -> None:
        # The deck list concatenates after markdown reveals (base = reveal count).
        pairs = resolve_steps([FadeIn("a"), FadeIn("b", Trigger.WITH_PREVIOUS)], base=3)
        assert [s for _, s in pairs] == [4, 4]


class TestResolveRunOffsets:
    @staticmethod
    def _offsets(cues: list[Cue]) -> list[float]:
        return [offset for _, _, offset in _resolve_run_offsets(resolve_steps(cues))]

    def test_after_previous_starts_when_predecessor_finishes(self) -> None:
        # FadeIn footprint = delay 0 + duration 0.4, so the AFTER slot begins at 0.4.
        assert self._offsets([FadeIn("a"), FadeIn("b", Trigger.AFTER_PREVIOUS)]) == [
            0.0,
            0.4,
        ]

    def test_chain_accumulates(self) -> None:
        # Each link's slot begins where the running total of the ones before it lands.
        assert self._offsets(
            [
                FadeIn("a"),
                FadeIn("b", Trigger.AFTER_PREVIOUS),
                FadeIn("c", Trigger.AFTER_PREVIOUS),
            ]
        ) == [0.0, 0.4, 0.8]

    def test_authored_delay_stays_out_of_the_offset(self) -> None:
        # The predecessor's footprint is delay + duration (0.2 + 0.8 = 1.0), so the
        # AFTER_PREVIOUS slot begins at 1.0. The predecessor's own slot stays 0: its
        # authored delay is a pre-pause inside its slot, never folded into the offset.
        assert self._offsets(
            [FadeIn("a", duration=0.8, delay=0.2), FadeIn("b", Trigger.AFTER_PREVIOUS)]
        ) == [0.0, 1.0]

    def test_on_click_resets_the_run(self) -> None:
        # A fresh run (ON_CLICK) starts a new slot chain at offset 0.
        assert self._offsets(
            [
                FadeIn("a"),
                FadeIn("b", Trigger.AFTER_PREVIOUS),
                FadeIn("c"),  # new run
            ]
        ) == [0.0, 0.4, 0.0]

    def test_with_previous_inherits_the_offset(self) -> None:
        # A WITH_PREVIOUS after an auto-advanced cue shares its slot.
        assert self._offsets(
            [
                FadeIn("a"),
                FadeIn("b", Trigger.AFTER_PREVIOUS),
                FadeIn("c", Trigger.WITH_PREVIOUS),
            ]
        ) == [0.0, 0.4, 0.4]

    def test_play_video_passes_through_untouched(self) -> None:
        # PlayVideo carries no timing and is never rewritten (no delay attribute).
        triples = _resolve_run_offsets(
            resolve_steps([FadeIn("a"), PlayVideo("vid", Trigger.AFTER_PREVIOUS)])
        )
        video_cue, _, _ = triples[1]
        assert not hasattr(video_cue, "delay")

    def test_offset_serialized_while_authored_delay_preserved(self) -> None:
        # End to end: the run offset lands on the cue entry, and the authored delay
        # stays a first-class opts.delay (here 0.0, the AFTER cue's own default).
        pairs = resolve_steps([FadeIn("box"), FadeIn("dot", Trigger.AFTER_PREVIOUS)])
        [dot_cue] = _parse_cues(annotate_svg(_PLAIN_SVG, pairs), "dot")
        assert dot_cue["offset"] == 0.4
        assert dot_cue["opts"]["delay"] == 0.0

    def test_authored_delay_survives_into_opts(self) -> None:
        # An ON_CLICK cue with an authored delay keeps it in opts (offset stays 0).
        [box_cue] = _parse_cues(
            annotate_svg(_PLAIN_SVG, resolve_steps([FadeIn("box", delay=0.3)])), "box"
        )
        assert box_cue["offset"] == 0.0
        assert box_cue["opts"]["delay"] == 0.3


_VIDEO_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <foreignObject id="zone-media">
        <video xmlns="http://www.w3.org/1999/xhtml" src="clip.mp4"></video>
      </foreignObject>
    </svg>
""")


class TestAnnotatePlayVideo:
    def test_sets_play_on_step_on_video(self) -> None:
        result = annotate_svg(_VIDEO_SVG, [(PlayVideo("media"), 2)])
        assert 'data-play-on-step="2"' in result

    def test_missing_video_warns(self) -> None:
        with collect_logs(logging.WARNING) as warnings:
            annotate_svg(_PLAIN_SVG, [(PlayVideo("media"), 1)])
        assert any("PlayVideo" in w.message for w in warnings)


class TestResolveTransitions:
    def _deck(
        self,
        deck_t: Crossfade | Cut | Morph | None = None,
        slide_ts: list[Crossfade | Cut | Morph | None] | None = None,
    ) -> Deck:
        d = Deck(transition=deck_t)
        d.slides = [
            Slide(src=f"{i}.svg", transition=t)
            for i, t in enumerate(slide_ts or [None])
        ]
        return d

    def test_defaults_to_cut(self) -> None:
        # An unset deck/slide transition resolves to the theme default (Cut).
        d = self._deck()
        assert resolve_transitions(d) == [
            {"type": "cut", "duration": 0.0, "easing": "ease"}
        ]

    def test_deck_level_crossfade(self) -> None:
        d = self._deck(deck_t=Crossfade(0.6), slide_ts=[None, None])
        result = resolve_transitions(d)
        assert result == [
            {"type": "crossfade", "duration": 0.6, "easing": "ease"},
            {"type": "crossfade", "duration": 0.6, "easing": "ease"},
        ]

    def test_slide_overrides_deck(self) -> None:
        d = self._deck(deck_t=Crossfade(), slide_ts=[Cut(), None])
        result = resolve_transitions(d)
        # Cut is an explicit object here, so it carries the base easing default.
        assert result[0] == {"type": "cut", "duration": 0.0, "easing": "ease"}
        assert result[1] == {"type": "crossfade", "duration": 0.5, "easing": "ease"}

    def test_morph_serialized(self) -> None:
        d = self._deck(slide_ts=[Morph(0.8)])
        assert resolve_transitions(d) == [
            {"type": "morph", "duration": 0.8, "easing": "ease"}
        ]


_ZONE_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

_LAYOUT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")


class TestProcessSlideWithContent:
    def _write_slide(self, tmp_path: Path, name: str, content: str) -> Path:
        p = tmp_path / "slides" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return p

    def test_foreignobject_replaces_zone_rect(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "hello"})])
        results = process_deck(deck, tmp_path)
        assert len(results) == 1
        assert "foreignObject" in results[0]["svg"]
        assert "hello" in results[0]["svg"]

    def test_zone_rect_id_inherited_by_foreignobject(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "hi"})])
        results = process_deck(deck, tmp_path)
        assert 'id="zone-content"' in results[0]["svg"]

    def test_unreferenced_zone_rects_removed(self, tmp_path: Path) -> None:
        self._write_slide(tmp_path, "slide.svg", _LAYOUT_SVG)
        # Only supply content for zone-content, leave zone-title unconsumed
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "body"})])
        results = process_deck(deck, tmp_path)
        assert 'id="zone-title"' not in results[0]["svg"]

    def test_foreignobject_content_has_inkflow_content_class(
        self, tmp_path: Path
    ) -> None:
        self._write_slide(tmp_path, "slide.svg", _ZONE_SLIDE_SVG)
        deck = Deck(slides=[Slide("slides/slide.svg", zones={"content": "x"})])
        results = process_deck(deck, tmp_path)
        assert "inkflow-content" in results[0]["svg"]


class TestLayoutBackedSlideExpansion:
    def _setup(self, tmp_path: Path) -> tuple[Path, Path]:
        layout = tmp_path / "layouts" / "layout.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_LAYOUT_SVG, encoding="utf-8")
        slides_dir = tmp_path / "slides"
        slides_dir.mkdir(parents=True, exist_ok=True)
        return layout, slides_dir

    def test_markdown_slide_expands_to_foreignobject(self, tmp_path: Path) -> None:
        _, slides_dir = self._setup(tmp_path)
        md = slides_dir / "content.md"
        md.write_text("# Hello\n\nBody text here.\n", encoding="utf-8")
        deck = Deck(slides=[Slide("layout", md="content")])
        results = process_deck(deck, tmp_path)
        assert len(results) == 1
        assert "foreignObject" in results[0]["svg"]
        assert "Body text" in results[0]["svg"]

    def test_markdown_slide_title_extracted(self, tmp_path: Path) -> None:
        _, slides_dir = self._setup(tmp_path)
        md = slides_dir / "content.md"
        md.write_text("# My Title\n\nSome content.\n", encoding="utf-8")
        deck = Deck(slides=[Slide("layout", md="content")])
        results = process_deck(deck, tmp_path)
        assert results[0]["title"] == "My Title"

    def test_markdown_slide_animations_applied(self, tmp_path: Path) -> None:
        _, slides_dir = self._setup(tmp_path)
        (slides_dir / "content.md").write_text("", encoding="utf-8")
        deck = Deck(
            slides=[Slide("layout", md="content", animations=[FadeIn("zone-title")])]
        )
        results = process_deck(deck, tmp_path)
        cues = self._title_cues(results[0]["svg"])
        assert [c["name"] for c in cues] == ["fade-in"]

    @staticmethod
    def _title_cues(svg: str) -> list[_CueDict]:
        return _parse_cues(svg, "zone-title")

    def test_zones_media_injected(self, tmp_path: Path) -> None:
        self._setup(tmp_path)
        deck = Deck(slides=[Slide("layout", zones={"content": Image("photo.jpg")})])
        results = process_deck(deck, tmp_path)
        assert "photo.jpg" in results[0]["svg"]

    def test_deck_animations_concatenate_after_reveals(self, tmp_path: Path) -> None:
        # A markdown reveal takes step 1, then the deck animation continues at 2.
        _, slides_dir = self._setup(tmp_path)
        (slides_dir / "content.md").write_text(
            "::content::\n::step::\nReveal.\n", encoding="utf-8"
        )
        deck = Deck(
            slides=[Slide("layout", md="content", animations=[FadeIn("zone-title")])]
        )
        svg = process_deck(deck, tmp_path)[0]["svg"]
        root = parse_svg(svg)
        reveal = next(
            el for el in root.iter() if (el.get("id") or "").startswith("inkflow-step-")
        )
        raw = reveal.get("data-cues")
        assert raw is not None
        reveal_cues = cast("list[_CueDict]", json.loads(raw))
        assert [c["step"] for c in reveal_cues] == [1]
        assert [c["step"] for c in self._title_cues(svg)] == [2]

    def test_autoplay_overridden_by_play_video_cue(self, tmp_path: Path) -> None:
        self._setup(tmp_path)
        deck = Deck(
            slides=[
                Slide(
                    "layout",
                    zones={"content": Video("clip.mp4", autoplay=True)},
                    animations=[PlayVideo("content")],
                )
            ]
        )
        with collect_logs(logging.WARNING) as warnings:
            svg = process_deck(deck, tmp_path)[0]["svg"]
        assert any("autoplay overridden" in w.message for w in warnings)
        assert "data-autoplay" not in svg  # the cue wins, autoplay stripped
        assert not re.search(r"<video[^>]*\bmuted\b", svg)  # Muted.AUTO -> audible
        assert 'data-play-on-step="1"' in svg

    def test_zones_inline_markdown_injected(self, tmp_path: Path) -> None:
        self._setup(tmp_path)
        deck = Deck(slides=[Slide("layout", zones={"content": "**bold text**"})])
        results = process_deck(deck, tmp_path)
        assert "bold" in results[0]["svg"]


class TestLayoutClasses:
    def test_full_chain_adds_all_classes(self, tmp_path: Path) -> None:
        base = tmp_path / "base.svg"
        cover = tmp_path / "cover.svg"
        src = tmp_path / "hero.svg"
        for p in (base, cover, src):
            p.write_text(_PLAIN_SVG, encoding="utf-8")
        result = _add_layout_classes(_PLAIN_SVG, [base, cover], src)
        assert 'class="layout-base layout-cover layout-hero"' in result

    def test_standalone_gets_src_stem_class(self, tmp_path: Path) -> None:
        src = tmp_path / "standalone.svg"
        src.write_text(_PLAIN_SVG, encoding="utf-8")
        result = _add_layout_classes(_PLAIN_SVG, [], src)
        assert 'class="layout-standalone"' in result

    def test_existing_non_layout_classes_preserved(self, tmp_path: Path) -> None:
        src = tmp_path / "slide.svg"
        svg = _PLAIN_SVG.replace("<svg ", '<svg class="my-class" ')
        result = _add_layout_classes(svg, [], src)
        assert "my-class" in result
        assert "layout-slide" in result

    def test_existing_layout_classes_replaced(self, tmp_path: Path) -> None:
        src = tmp_path / "slide.svg"
        svg = _PLAIN_SVG.replace("<svg ", '<svg class="layout-old" ')
        result = _add_layout_classes(svg, [], src)
        assert "layout-old" not in result
        assert "layout-slide" in result

    def test_layout_class_in_processed_slide(self, tmp_path: Path) -> None:
        layouts_dir = tmp_path / "layouts"
        layouts_dir.mkdir()
        (layouts_dir / "mylayout.svg").write_text(_ZONE_SLIDE_SVG, encoding="utf-8")
        (tmp_path / "slides").mkdir()
        deck = Deck(slides=[Slide("mylayout", zones={"content": "hi"})])
        results = process_deck(deck, tmp_path)
        assert "layout-mylayout" in results[0]["svg"]

    def test_scope_wraps_injected_deck_style(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        slide = tmp_path / "slides" / "plain.svg"
        slide.write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(
            style=Inline("#box { fill: red; }"), slides=[Slide("slides/plain.svg")]
        )
        results = process_deck(deck, tmp_path)
        assert "@scope" in results[0]["svg"]

    def test_no_scope_without_inline_styles(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        slide = tmp_path / "slides" / "plain.svg"
        slide.write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(slides=[Slide("slides/plain.svg")])
        results = process_deck(deck, tmp_path)
        assert "@scope" not in results[0]["svg"]


class TestSlideId:
    def test_infer_slide_id_explicit(self) -> None:
        slide = Slide("cover", id="my-cover")
        assert _infer_slide_id(slide) == "my-cover"

    def test_infer_slide_id_from_md_stem(self) -> None:
        slide = Slide("content", md="slides/08-markdown.md")
        assert _infer_slide_id(slide) == "08-markdown"

    def test_infer_slide_id_from_md_stem_no_numeric_strip(self) -> None:
        slide = Slide("content", md="slides/01-intro.md")
        assert _infer_slide_id(slide) == "01-intro"

    def test_infer_slide_id_inline_md_falls_back_to_src(self) -> None:
        slide = Slide("cover", md=Inline("# Hello"))
        assert _infer_slide_id(slide) == "cover"

    def test_infer_slide_id_from_src_stem(self) -> None:
        slide = Slide("slides/01-title.svg")
        assert _infer_slide_id(slide) == "01-title"

    def test_infer_slide_id_bare_name(self) -> None:
        slide = Slide("cover")
        assert _infer_slide_id(slide) == "cover"

    def test_deduplicate_ids_no_collision(self) -> None:
        assert _deduplicate_ids(["a", "b", "c"]) == ["a", "b", "c"]

    def test_deduplicate_ids_collision(self) -> None:
        assert _deduplicate_ids(["a", "a", "b", "a"]) == ["a", "a-2", "b", "a-3"]

    def test_process_deck_includes_id(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        slide = tmp_path / "slides" / "plain.svg"
        slide.write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(slides=[Slide("slides/plain.svg")])
        results = process_deck(deck, tmp_path)
        assert results[0]["id"] == "plain"

    def test_process_deck_id_collision_resolved(self, tmp_path: Path) -> None:
        (tmp_path / "slides").mkdir()
        for name in ("plain.svg", "plain2.svg"):
            (tmp_path / "slides" / name).write_text(_PLAIN_SVG, encoding="utf-8")
        deck = Deck(
            slides=[
                Slide("slides/plain.svg", id="plain"),
                Slide("slides/plain2.svg", id="plain"),
            ]
        )
        results = process_deck(deck, tmp_path)
        assert results[0]["id"] == "plain"
        assert results[1]["id"] == "plain-2"


class TestParseMarkdownOnce:
    def test_markdown_parsed_once_per_md_slide(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from inkflow.zones import parse_markdown_zones as real

        (tmp_path / "slides").mkdir()
        for name in ("a.svg", "b.svg"):
            (tmp_path / "slides" / name).write_text(_LAYOUT_SVG, encoding="utf-8")

        calls: list[str] = []

        def counting(text: str) -> object:
            calls.append(text)
            return real(text)

        monkeypatch.setattr("inkflow.pipeline.parse_markdown_zones", counting)
        deck = Deck(
            slides=[
                Slide("slides/a.svg", md=Inline("# A\n\nbody")),
                Slide("slides/b.svg", md=Inline("# B\n\nbody")),
            ]
        )
        process_deck(deck, tmp_path)
        # once per md slide
        assert len(calls) == 2


class TestSlideSvg:
    def test_cleaned_round_trips(self, tmp_path: Path) -> None:
        from inkflow.clean import clean_inkscape_tree
        from inkflow.pipeline import SlideSvg

        src = tmp_path / "s.svg"
        src.write_text(_ZONE_SLIDE_SVG, encoding="utf-8")
        assert "zone-content" in SlideSvg(clean_inkscape_tree(src), src).to_svg()

    def test_methods_mutate_in_place_like_list_sort(self, tmp_path: Path) -> None:
        from inkflow.clean import clean_inkscape_tree
        from inkflow.pipeline import SlideSvg

        src = tmp_path / "s.svg"
        src.write_text(_LAYOUT_SVG, encoding="utf-8")
        doc = SlideSvg(clean_inkscape_tree(src), src)
        assert doc.zone_ids() == {"zone-title", "zone-content"}
        assert doc.number_slides(2, 5) is None  # returns None, mutates self
        doc.scope_styles(2)
        assert 'id="inkflow-slide-2"' in doc.to_svg()


class TestOverlayClasses:
    def test_every_entry_in_an_overlay_chain_gets_a_class(self, tmp_path: Path) -> None:
        src = tmp_path / "hero.svg"
        brand = tmp_path / "brand.svg"
        footer = tmp_path / "footer.svg"
        for p in (src, brand, footer):
            p.write_text(_PLAIN_SVG, encoding="utf-8")
        result = _add_layout_classes(_PLAIN_SVG, [], src, [[brand, footer]])
        assert 'class="layout-hero overlay-brand overlay-footer"' in result

    def test_stale_overlay_classes_replaced(self, tmp_path: Path) -> None:
        src = tmp_path / "hero.svg"
        src.write_text(_PLAIN_SVG, encoding="utf-8")
        svg = _PLAIN_SVG.replace("<svg ", '<svg class="keep overlay-old" ')
        result = _add_layout_classes(svg, [], src, [])
        assert "overlay-old" not in result
        assert 'class="keep layout-hero"' in result


class TestOverlayPrecedence:
    """Slide → Deck → Theme, each an override rather than a merge."""

    def _project(self, tmp_path: Path) -> Path:
        overlays = tmp_path / "overlays"
        overlays.mkdir(parents=True, exist_ok=True)
        for name, mark in (("footer", "ovl-footer"), ("logo", "ovl-logo")):
            rect = f'<rect id="{mark}" width="10" height="10"/>'
            (overlays / f"{name}.svg").write_text(
                f'<svg xmlns="{_SVG_NS}" viewBox="0 0 100 100">{rect}</svg>',
                encoding="utf-8",
            )
        slides = tmp_path / "slides"
        slides.mkdir(parents=True, exist_ok=True)
        (slides / "s.svg").write_text(_PLAIN_SVG, encoding="utf-8")
        return tmp_path

    def _svg_for(self, tmp_path: Path, deck: Deck) -> str:
        return process_deck(deck, tmp_path)[0]["svg"]

    def test_deck_overlays_apply(self, tmp_path: Path) -> None:
        self._project(tmp_path)
        deck = Deck(overlays=[Overlay("footer")], slides=[Slide("s")])
        assert "ovl-footer" in self._svg_for(tmp_path, deck)

    def test_slide_empty_list_opts_out(self, tmp_path: Path) -> None:
        self._project(tmp_path)
        deck = Deck(overlays=[Overlay("footer")], slides=[Slide("s", overlays=[])])
        assert "ovl-footer" not in self._svg_for(tmp_path, deck)

    def test_slide_overlays_replace_rather_than_extend(self, tmp_path: Path) -> None:
        self._project(tmp_path)
        deck = Deck(
            overlays=[Overlay("footer")],
            slides=[Slide("s", overlays=[Overlay("logo")])],
        )
        svg = self._svg_for(tmp_path, deck)
        assert "ovl-logo" in svg
        assert "ovl-footer" not in svg

    def test_deck_none_falls_through_to_theme(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        self._project(tmp_path)
        theme = dir_theme(tmp_path)
        theme.overlays = [Overlay("theme:logo")]
        assert "ovl-logo" in self._svg_for(
            tmp_path, Deck(theme=theme, slides=[Slide("s")])
        )

    def test_deck_empty_list_beats_theme(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        self._project(tmp_path)
        theme = dir_theme(tmp_path)
        theme.overlays = [Overlay("theme:logo")]
        deck = Deck(theme=theme, overlays=[], slides=[Slide("s")])
        assert "ovl-logo" not in self._svg_for(tmp_path, deck)

    def test_overlay_paints_over_slide_content(self, tmp_path: Path) -> None:
        self._project(tmp_path)
        deck = Deck(overlays=[Overlay("footer")], slides=[Slide("s")])
        svg = self._svg_for(tmp_path, deck)
        assert svg.index('id="box"') < svg.index("ovl-footer")
