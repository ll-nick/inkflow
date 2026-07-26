from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TypedDict, cast

from inkflow import ns
from inkflow.animations import Animation, PlayVideo
from inkflow.clean import clean_inkscape_tree
from inkflow.content import (
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
)
from inkflow.enums import AnimationKind, ColorMode, Direction
from inkflow.layout import resolve_chain, resolve_default_zone, resolve_parent_path
from inkflow.loaders import load_md, load_notes, load_style
from inkflow.logging import logger
from inkflow.manifest import (
    Cue,
    Deck,
    Inline,
    Media,
    Slide,
    TextBox,
    Transition,
    Video,
)
from inkflow.steps import StepResolver
from inkflow.svg import compose_with_ancestors
from inkflow.svgio import SvgElement, serialize_svg
from inkflow.titles import humanize
from inkflow.zones import ParsedMarkdown, build_slide_content, parse_markdown_zones

# ── Slide wire format ────────────────────────────────────────────────────────


class SlideData(TypedDict):
    id: str
    svg: str
    title: str
    notes: str


# ── Path conventions ─────────────────────────────────────────────────────────


def _infer_slide_id(slide: Slide) -> str:
    if slide.id:
        return slide.id
    if slide.md is not None and not isinstance(slide.md, Inline):
        return Path(slide.md).stem
    src = Path(slide.src)
    return src.stem if src.suffix else slide.src.replace("/", "-").replace(":", "-")


def _deduplicate_ids(raw_ids: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    result: list[str] = []
    for raw in raw_ids:
        if raw not in seen:
            seen[raw] = 1
            result.append(raw)
        else:
            seen[raw] += 1
            result.append(f"{raw}-{seen[raw]}")
    return result


def _infer_slide_title(
    slide: Slide, slide_id: str, parsed: ParsedMarkdown | None
) -> str:
    if slide.title:
        return slide.title
    if parsed is not None:
        chunks = parsed.zones.get("title", [])
        if chunks and isinstance(chunks[0], str):
            return chunks[0].lstrip("#").strip()
    stem = re.sub(r"^\d+-", "", slide_id)
    return humanize(stem)


def resolve_slide_src(src: str, project_dir: Path, theme: str | None = None) -> Path:
    """Resolve a Slide.src string to an absolute Path.

    Single-part names (no directory separator, no scheme prefix) are checked
    against slides/ first: bare names get .svg appended, names that already
    carry an extension are tried as-is. If the slides/ candidate does not
    exist, the 3-level layout search runs (project layouts/ → theme layouts/
    → builtin layouts/). Everything else delegates directly to resolve_parent_path.
    """
    p = Path(src)
    if (
        not p.is_absolute()
        and len(p.parts) == 1
        and not src.startswith(("local:", "theme:", "builtin:", "./", "../"))
    ):
        name = src if p.suffix else src + ".svg"
        slides_candidate = project_dir / "slides" / name
        if slides_candidate.exists():
            return slides_candidate
    return resolve_parent_path(src, project_dir, project_dir, theme)


# ── Animation / transition serialization ──────────────────────────────────────


def _set_fields(obj: object) -> dict[str, object]:
    """Dataclass fields whose value is not None (None means 'defer to the default')."""
    fields = cast("dict[str, object]", vars(obj))
    return {k: v for k, v in fields.items() if v is not None}


def resolve_steps(cues: list[Cue], base: int = 0) -> list[tuple[Cue, int]]:
    """Pair each cue with its resolved step, walking the sequence in order.

    ``base`` is the starting step — 0, or the markdown-reveal count when this
    list is concatenated after the reveals.
    """
    resolver = StepResolver(base)
    return [(cue, resolver.resolve(cue.trigger)) for cue in cues]


# ── Animation cue serialization (`data-cues`) ─────────────────────────────────
# Each animated element carries a `data-cues` JSON array. Each entry pairs a step
# and kind with the keyframe name and the params the step engine needs: `opts` are
# element.animate() playback options (seconds; the engine converts to ms), `vars`
# are ready-to-inject strings the engine substitutes for `var(--anim-<key>)` in the
# keyframes.


def _offset_vector(direction: Direction, distance: float) -> tuple[str, str]:
    """The (x, y) translate offset an element enters from / exits toward, as
    keyframe-ready strings. Left and up are negative; ``px`` == SVG user units."""
    if direction == Direction.LEFT:
        return f"{-distance}px", "0px"
    if direction == Direction.RIGHT:
        return f"{distance}px", "0px"
    if direction == Direction.UP:
        return "0px", f"{-distance}px"
    return "0px", f"{distance}px"  # DOWN


def _cue_entry(anim: Animation, step: int) -> dict[str, object]:
    """Serialize one animation cue to a `data-cues` entry.

    The base `Animation` fields are element.animate() ``opts``; slide direction/distance
    resolve to a translate offset; every other (subclass) field passes through as a
    ``var`` keyed by its field name, injected into the keyframes' ``var(--anim-<key>)``.
    """
    fields: dict[str, object] = {
        k: v
        for k, v in cast("dict[str, object]", vars(anim)).items()
        if k not in ("element", "trigger") and v is not None
    }
    # element.animate() options (durations in seconds; the engine scales to ms).
    opts: dict[str, object] = {
        "duration": fields.pop("duration"),
        "delay": fields.pop("delay"),
        "easing": fields.pop("easing"),
        "iterations": fields.pop("iterations"),
    }

    # Substitution values injected into the keyframes' `var(--anim-<key>)`. A slide's
    # direction+distance together resolve to a translate offset (the per-direction sign
    # is geometry CSS can't derive from an enum). Every other field, including a lone
    # `distance` like Bounce's rise, passes through as a plain var; a keyframe applies
    # any unit it needs, e.g. `calc(var(--anim-distance) * 1px)`.
    substitutions: dict[str, str] = {}
    if "direction" in fields and "distance" in fields:
        substitutions["from-x"], substitutions["from-y"] = _offset_vector(
            cast("Direction", fields.pop("direction")),
            cast("float", fields.pop("distance")),
        )
    for name, value in fields.items():
        substitutions[name] = str(value)

    return {
        "step": step,
        "kind": anim.kind.value,
        "name": anim.slug(),
        "opts": opts,
        "vars": substitutions,
    }


def _add_class(el: SvgElement, cls: str) -> None:
    existing = [c for c in el.get("class", "").split() if c]
    if cls not in existing:
        el.set("class", " ".join([*existing, cls]))


def _starts_hidden(entries: list[dict[str, object]]) -> bool:
    """True when the element's first visibility cue (lowest step) is an enter, so it
    is hidden before that cue fires. Drives the initial-hidden guard that prevents a
    flash of the element before the engine attaches."""
    for e in entries:  # pre-sorted by step
        if e["kind"] == AnimationKind.ENTER.value:
            return True
        if e["kind"] == AnimationKind.EXIT.value:
            return False
    return False


def _warn_duplicate_kinds(element_id: str, entries: list[dict[str, object]]) -> None:
    """Warn on two enters (or two exits) with no opposing cue between them: the second
    re-plays a state the element is already in, almost always a mistake. Emphasis cues
    may repeat freely and are ignored."""
    last: object = None
    for e in entries:
        kind = e["kind"]
        if kind == AnimationKind.EMPHASIS.value:
            continue
        if kind == last:
            logger.warning(
                f"element #{element_id}: two {kind} animations with no opposing "
                + "cue between them"
            )
        last = kind


def _annotate_play_video(root: SvgElement, cue: PlayVideo, step: int) -> None:
    zone_id = f"zone-{cue.element}"
    zone = root.find(f'.//*[@id="{zone_id}"]')
    video = zone.find(f".//{{{ns.XHTML}}}video") if zone is not None else None
    if video is None:
        logger.warning(f"PlayVideo target #{zone_id} has no video in SVG")
        return
    video.set("data-play-on-step", str(step))


def annotate_svg(root: SvgElement, cues: list[tuple[Cue, int]]) -> SvgElement:
    """Annotate the SVG for the step engine: `PlayVideo` cues stamp
    `data-play-on-step`; animation cues are grouped per target element into one
    `data-cues` JSON list (sorted by step)."""
    entries_by_element: dict[str, list[dict[str, object]]] = {}
    for cue, step in cues:
        if isinstance(cue, PlayVideo):
            _annotate_play_video(root, cue, step)
        elif isinstance(cue, Animation):
            entries_by_element.setdefault(cue.element, []).append(_cue_entry(cue, step))
        else:
            logger.warning(f"cue with no annotation handler: {type(cue).__name__}")

    for element_id, entries in entries_by_element.items():
        el = root.find(f'.//*[@id="{element_id}"]')
        if el is None:
            logger.warning(f"element #{element_id} not found in SVG")
            continue
        entries.sort(key=lambda e: cast("int", e["step"]))
        _warn_duplicate_kinds(element_id, entries)
        el.set("data-cues", json.dumps(entries, separators=(",", ":")))
        # An `anim-<slug>` class per cue type: a pure styling hook (the engine drives
        # animation from `data-cues`). Built-in CSS uses it only for constant styles a
        # keyframe cannot hold at the right cascade origin (zoom's transform-box);
        # custom animations can hook their own static styles the same way.
        for name in dict.fromkeys(cast("str", e["name"]) for e in entries):
            _add_class(el, f"anim-{name}")
        if _starts_hidden(entries):
            _add_class(el, "anim-pending")
    return root


def _serialize_transition(t: Transition | None) -> dict[str, object]:
    if t is None:
        return {"type": "cut", "duration": 0.0}
    return {"type": t.slug(), **_set_fields(t)}


def resolve_transitions(deck: Deck) -> list[dict[str, object]]:
    return [
        _serialize_transition(
            slide.transition if slide.transition is not None else deck.transition
        )
        for slide in deck.slides
        if slide.visible
    ]


_KEYFRAMES_RE = re.compile(r"@(?:-webkit-)?keyframes\b")


def _extract_keyframes(css: str) -> tuple[str, str]:
    """Split top-level ``@keyframes`` blocks out of ``css``.

    Returns ``(keyframes_css, remaining_css)``. Animation names are document-global,
    and the step engine discovers custom ``@keyframes`` (from ``Deck(style=...)``) by
    name, so they must stay unscoped — wrapping them in ``@scope`` would hide or
    invalidate them. The rest of the CSS is still scoped by the caller.
    """
    keyframes: list[str] = []
    rest: list[str] = []
    pos = 0
    for m in _KEYFRAMES_RE.finditer(css):
        brace = css.find("{", m.end())
        if brace == -1:
            continue
        depth, j = 0, brace
        while j < len(css):
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        end = j + 1
        rest.append(css[pos : m.start()])
        keyframes.append(css[m.start() : end])
        pos = end
    rest.append(css[pos:])
    return "\n".join(keyframes), "".join(rest)


def _scope_slide_styles(root: SvgElement, slide_number: int) -> SvgElement:
    """Assign a unique ID to the SVG root and wrap any inline <style> in @scope.

    SVG style blocks would bleed onto adjacent slides during CSS transitions without
    this guard. ``@keyframes`` are lifted out first and kept global so the step engine
    can still find them by name.
    """
    slide_id = f"inkflow-slide-{slide_number}"
    root.set("id", slide_id)
    for style_el in root.findall(f".//{{{ns.SVG}}}style"):
        css = style_el.text
        if not css or not css.strip():
            continue
        keyframes_css, rest = _extract_keyframes(css)
        scoped = f"@scope(#{slide_id}) {{\n{rest}\n}}" if rest.strip() else ""
        style_el.text = "\n".join(filter(None, [keyframes_css, scoped]))
    return root


def _add_layout_classes(root: SvgElement, chain: list[Path], src: Path) -> SvgElement:
    """Add layout-<stem> classes to the SVG root for every entry in [*chain, src].

    This scopes CSS rules in styles.css to a slide type
    (e.g. `.layout-cover #zone-title`)
    """
    existing = [c for c in root.get("class", "").split() if not c.startswith("layout-")]
    new_classes = [f"layout-{p.stem}" for p in [*chain, src]]
    root.set("class", " ".join(existing + new_classes))
    return root


# ── Per-slide pipeline ────────────────────────────────────────────────────────


@dataclass
class SlideSvg:
    """A slide's SVG tree as it moves through the per-slide pipeline.

    Each method mutates the tree in place (like ``list.sort()``) and returns ``None``;
    the DOM work is delegated to the content/svg modules, which take and return the root
    element. This keeps the pipeline a single parse and a single serialize with a
    readable sequence of commands in ``process_slide``.
    """

    root: SvgElement

    @classmethod
    def cleaned(cls, src: Path) -> SlideSvg:
        return cls(clean_inkscape_tree(src))

    def compose_ancestors(self, chain: list[Path]) -> None:
        if chain:
            self.root = compose_with_ancestors(self.root, chain)

    def tag_layout(self, chain: list[Path], src: Path) -> None:
        self.root = _add_layout_classes(self.root, chain, src)

    def number_slides(self, slide_number: int, total: int) -> None:
        self.root = substitute_zone_numbers(self.root, slide_number, total)

    def zone_ids(self) -> set[str]:
        return {
            eid
            for el in self.root.iter()
            if (eid := el.get("id")) is not None and eid.startswith("zone-")
        }

    def inject_content(
        self, content: dict[str, TextBox | Media], font_size: int, dark_mode: bool
    ) -> None:
        self.root = substitute_content(self.root, content, font_size, dark_mode)

    def annotate(self, cues: list[tuple[Cue, int]]) -> None:
        self.root = annotate_svg(self.root, cues)

    def add_style(self, css: str) -> None:
        self.root = inject_style(self.root, css)

    def prune_zones(self) -> None:
        self.root = remove_unreferenced_zones(self.root)

    def scope_styles(self, slide_number: int) -> None:
        self.root = _scope_slide_styles(self.root, slide_number)

    def to_svg(self) -> str:
        return serialize_svg(self.root)


@dataclass(frozen=True)
class DeckContext:
    """Loop-invariant deck params, built once per rebuild and shared by every slide."""

    project_dir: Path
    theme: str | None
    deck_style: str
    font_size: int  # deck default; a slide may override via Slide.font_size
    mode: ColorMode
    total_slides: int


def _resolve_autoplay_conflicts(
    content: dict[str, TextBox | Media], cues: list[Cue]
) -> dict[str, TextBox | Media]:
    """Drop ``autoplay`` from a video that a ``PlayVideo`` cue also targets.

    Autoplay and a step cue are contradictory playback triggers; the cue wins.
    Suppressing autoplay here (before injection) rather than stripping the DOM
    attribute later also makes ``Muted.AUTO`` resolve to *unmuted*, so the
    gesture-triggered clip is audible.
    """
    play_targets = {f"zone-{c.element}" for c in cues if isinstance(c, PlayVideo)}
    if not play_targets:
        return content
    result = dict(content)
    for zone_id in play_targets:
        item = result.get(zone_id)
        if isinstance(item, Video) and item.autoplay:
            key = zone_id.removeprefix("zone-")
            logger.warning(f"video in zone {key}: autoplay overridden by PlayVideo cue")
            result[zone_id] = replace(item, autoplay=False)
    return result


def process_slide(
    slide: Slide,
    ctx: DeckContext,
    slide_number: int,
    parsed: ParsedMarkdown | None,
) -> tuple[str, str]:
    """Return the processed SVG string and the slide's markdown-derived notes."""
    src = resolve_slide_src(slide.src, ctx.project_dir, ctx.theme)
    chain = resolve_chain(src, ctx.project_dir, ctx.theme)

    doc = SlideSvg.cleaned(src)
    doc.compose_ancestors(chain)
    doc.tag_layout(chain, src)
    doc.number_slides(slide_number, ctx.total_slides)

    md_notes = ""
    reveal_pairs: list[tuple[Cue, int]] = []
    reveal_max = 0
    if parsed is not None or slide.zones:
        zone_ids = doc.zone_ids()
        default_zone = resolve_default_zone(doc.root, zone_ids)
        result = build_slide_content(
            parsed,
            slide.zones,
            available_zones=zone_ids,
            default_zone=default_zone,
        )
        md_notes = result.notes
        reveal_pairs = [(anim, step) for anim, step in result.animations]
        reveal_max = result.max_step
        if result.content:
            font_size = (
                slide.font_size if slide.font_size is not None else ctx.font_size
            )
            content = _resolve_autoplay_conflicts(result.content, slide.animations)
            doc.inject_content(content, font_size, ctx.mode == ColorMode.DARK)

    # The deck animations=[...] list continues the timeline after the markdown
    # reveals (steps 1..reveal_max), so the two form one continuous count.
    deck_pairs = resolve_steps(slide.animations, base=reveal_max)
    cue_pairs = reveal_pairs + deck_pairs
    if cue_pairs:
        doc.annotate(cue_pairs)

    slide_style_css = load_style(slide.extra_style, ctx.project_dir)
    combined_css = "\n".join(filter(None, [ctx.deck_style, slide_style_css]))
    if combined_css:
        doc.add_style(combined_css)

    doc.prune_zones()
    doc.scope_styles(slide_number)
    return doc.to_svg(), md_notes


def process_deck(deck: Deck, project_dir: Path) -> list[SlideData]:
    visible_slides = [s for s in deck.slides if s.visible]
    ctx = DeckContext(
        project_dir=project_dir,
        theme=deck.theme,
        deck_style=load_style(deck.style, project_dir),
        font_size=deck.font_size,
        mode=deck.mode,
        total_slides=len(visible_slides),
    )
    raw_ids = [_infer_slide_id(s) for s in visible_slides]
    slide_ids = _deduplicate_ids(raw_ids)
    results: list[SlideData] = []
    for i, (slide, slide_id) in enumerate(zip(visible_slides, slide_ids, strict=True)):
        logger.debug(f"processing slide {i + 1}/{len(visible_slides)}: {slide_id}")
        md_text = load_md(slide.md, project_dir) if slide.md is not None else None
        parsed = parse_markdown_zones(md_text) if md_text is not None else None
        title = _infer_slide_title(slide, slide_id, parsed)
        explicit_notes = load_notes(slide.notes, project_dir)
        svg, md_notes = process_slide(slide, ctx, i + 1, parsed)
        notes = "\n".join(filter(None, [explicit_notes, md_notes]))
        results.append({"id": slide_id, "svg": svg, "title": title, "notes": notes})
    logger.info(f"processed {len(results)} slide(s)")
    return results
