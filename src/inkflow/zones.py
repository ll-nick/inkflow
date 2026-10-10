from __future__ import annotations

import itertools
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field, replace
from enum import Enum
from types import UnionType
from typing import get_args, get_origin, get_type_hints

from lxml import etree

from inkflow.animations import Animation, FadeIn
from inkflow.assets import AssetSource
from inkflow.charts import (
    FENCE_FONT,
    ChartIds,
    ResolvedChart,
    expand_fences,
    resolve,
)
from inkflow.enums import Align, Trigger, VAlign
from inkflow.logging import logger
from inkflow.manifest import Chart, Media, TextBox, Video, ZoneContent
from inkflow.markdown import (
    html_fragment_to_xml,
    markdown_to_html,
    render_md_with_steps,
)
from inkflow.steps import StepResolver
from inkflow.svgio import SvgElement

# This module owns inkflow's own ``::zone::`` / ``::step::`` marker grammar and
# the assembly of parsed Markdown into per-zone slide content. It parses .md text
# into zones and chunks, then turns those into TextBox/Media for each layout zone.
# All Markdown-to-HTML rendering is delegated to ``inkflow.markdown``.

# ── Shared regex primitives ───────────────────────────────────────────────────

_WORD = r"[\w-]+"
_PARAM = rf"(?:\s+{_WORD}=\S+)*"
_NOT_STEP = r"(?!steps?\b)"

_ZONE_PATTERN = re.compile(
    rf"^::({_NOT_STEP}{_WORD})({_PARAM})::\s*$",
    re.MULTILINE,
)
_STEP_PATTERN = re.compile(rf"^::step({_PARAM})::\s*$", re.MULTILINE)
_STEPS_BLOCK_RE = re.compile(
    rf"^::steps({_PARAM})::\s*\n(.*?)(?:^::steps end::\s*$|\Z)",
    re.MULTILINE | re.DOTALL,
)


# ── Public output types ───────────────────────────────────────────────────────


ZoneFill = TextBox | Media | ResolvedChart
"""What fills a zone once its content is resolved: text, media, or a chart with
its data read."""


@dataclass
class SlideContent:
    content: dict[str, ZoneFill]  # zone-id (e.g. "zone-content") → content
    notes: str
    animations: list[tuple[Animation, int]] = field(default_factory=list)
    """Reveal animations generated for ``::step::`` markers, each paired with its
    resolved step and keyed to the ``inkflow-step-*`` id stamped on its wrapper
    div. The pipeline routes these through the same annotate pass as deck.py cues,
    then continues the step count with the ``animations=[...]`` list."""
    max_step: int = 0
    """Highest step consumed by the markdown reveals (including code-highlight
    stages), used as the base for numbering the deck ``animations=[...]`` list."""


_ParamMap = dict[str, str]


@dataclass
class _StepMarker:
    """A ``::step::`` boundary, carrying the marker's ``type=``/param overrides."""

    params: _ParamMap = field(default_factory=dict)


@dataclass
class _StepsBlock:
    text: str  # markdown content inside a ::steps:: block
    params: _ParamMap = field(default_factory=dict)


# ── Internal types ────────────────────────────────────────────────────────────

Chunk = str | _StepMarker | _StepsBlock
_ZoneChunks = dict[str, list[Chunk]]
_ZoneParams = dict[str, _ParamMap]


@dataclass
class ParsedMarkdown:
    zones: _ZoneChunks
    params: _ZoneParams
    auto_zones: frozenset[str] = field(default_factory=frozenset)


# ── Step / steps parsing ──────────────────────────────────────────────────────


def _split_on_steps(segment: str) -> list[Chunk]:
    """Split a segment into text chunks separated by ``_StepMarker`` boundaries.

    ``_STEP_PATTERN`` has a capture group (the marker's params), so ``re.split``
    interleaves the captured param string between the text parts:
    ``[text, params, text, params, …, text]``.
    """
    parts = _STEP_PATTERN.split(segment)
    chunks: list[Chunk] = [parts[0]]
    for i in range(1, len(parts), 2):
        chunks.append(_StepMarker(_parse_zone_params(parts[i] or "")))
        chunks.append(parts[i + 1])
    return chunks


def _split_steps(text: str) -> list[Chunk]:
    """Split text on ::step:: markers and ::steps:: blocks.

    Returns a list of Chunk values where:
    - str values are regular text segments (may be empty)
    - _StepMarker values mark a step boundary and carry its ``type=``/params
    - _StepsBlock values carry a block whose items reveal individually
    """
    result: list[Chunk] = []
    pos = 0

    for m in _STEPS_BLOCK_RE.finditer(text):
        before = text[pos : m.start()]
        if before.strip():
            result.extend(_split_on_steps(before))
        # Inner ::step:: markers are stripped;
        # the block-level type applies to all items.
        block_text = _STEP_PATTERN.sub("", m.group(2)).strip()
        if block_text:
            result.append(_StepsBlock(block_text, _parse_zone_params(m.group(1))))
        pos = m.end()

    result.extend(_split_on_steps(text[pos:]))

    return result


def _parse_zone_params(params_str: str) -> _ParamMap:
    params: _ParamMap = {}
    for token in params_str.split():
        if "=" in token:
            key, _, value = token.partition("=")
            params[key.strip()] = value.strip()
    return params


# ── Reveal animation resolution ───────────────────────────────────────────────

_RevealSpec = tuple[type[Animation], dict[str, object]]
"""A resolved reveal: the animation type plus its coerced constructor kwargs."""

# Marker keys the resolver never forwards as constructor kwargs: ``type`` selects
# the class and ``element`` is bound by the resolver, not the author. ``trigger``
# *is* forwarded — it lands on the cue's ``trigger`` field like any other param.
_RESERVED_MARKER_KEYS = frozenset({"type", "element"})


def _all_animation_subclasses() -> Iterator[type[Animation]]:
    """Every ``Animation`` subclass currently defined — built-ins plus any custom
    types the deck declared (they register as subclasses when ``deck.py`` runs)."""
    seen: set[type[Animation]] = set()
    stack = list(Animation.__subclasses__())
    while stack:
        cls = stack.pop()
        if cls in seen:
            continue
        seen.add(cls)
        yield cls
        stack.extend(cls.__subclasses__())


def _resolve_animation_type(name: str) -> type[Animation]:
    for cls in _all_animation_subclasses():
        if cls.__name__ == name:
            return cls
    raise ValueError(f"unknown animation type {name!r}")


def _strip_optional(tp: object) -> object:
    """``X | None`` → ``X``; other types unchanged."""
    if get_origin(tp) is UnionType:
        # Contain get_args's Any at the boundary.
        args: tuple[object, ...] = get_args(tp)
        non_none = [a for a in args if a is not type(None)]
        if len(non_none) == 1:
            return non_none[0]
    return tp


def _coerce_value(tp: object, raw: str) -> object:
    """Coerce a marker's string value to the field's annotated type."""
    tp = _strip_optional(tp)
    if isinstance(tp, type):
        if issubclass(tp, Enum):  # Direction etc. resolve by member value
            return tp(raw)
        if issubclass(tp, bool):  # before int: bool is a subclass of int
            return raw.strip().lower() in ("true", "1", "yes")
        if issubclass(tp, str):  # str, Easing, Inline — wrap verbatim
            return tp(raw)
        if issubclass(tp, int):
            return int(raw)
        if issubclass(tp, float):
            return float(raw)
    return raw


def _coerce_params(cls: type[Animation], params: _ParamMap) -> dict[str, object]:
    hints: dict[str, object] = get_type_hints(cls)  # contain Any at the boundary
    out: dict[str, object] = {}
    for key, raw in params.items():
        if key not in hints:
            logger.warning(f"unknown parameter {key!r} for {cls.__name__}")
            continue
        try:
            out[key] = _coerce_value(hints[key], raw)
        except (ValueError, TypeError):
            logger.warning(f"invalid value {raw!r} for {key!r} on {cls.__name__}")
    return out


def _resolve_reveal(params: _ParamMap) -> _RevealSpec:
    """Turn a marker's params into a ``(type, kwargs)`` reveal spec.

    ``type=`` selects the animation class (default ``FadeIn``); the remaining
    params become coerced constructor kwargs. Both ``::step::`` and ``::steps::``
    resolve through here, so their grammar is identical.
    """
    type_name = params.get("type")
    try:
        cls: type[Animation] = (
            _resolve_animation_type(type_name) if type_name else FadeIn
        )
    except ValueError:
        logger.warning(f"unknown animation type {type_name!r}; using FadeIn")
        cls = FadeIn
    kwargs = _coerce_params(
        cls, {k: v for k, v in params.items() if k not in _RESERVED_MARKER_KEYS}
    )
    return cls, kwargs


def _spec_trigger(spec: _RevealSpec) -> Trigger:
    """The reveal's `Trigger` — the coerced ``trigger=`` param, else ``ON_CLICK``."""
    trigger = spec[1].get("trigger")
    return trigger if isinstance(trigger, Trigger) else Trigger.ON_CLICK


# ── Zone parsing ──────────────────────────────────────────────────────────────


def _auto_extract(text: str) -> _ZoneChunks:
    zones: _ZoneChunks = {}
    lines = text.splitlines(keepends=True)
    i = 0
    n = len(lines)

    # Extract leading # H1
    while i < n and not lines[i].strip():
        i += 1
    if i < n and lines[i].startswith("# "):
        zones["title"] = [lines[i].rstrip()]
        i += 1

        # Check for ## H2 immediately following (only blank lines between)
        j = i
        while j < n and not lines[j].strip():
            j += 1
        if j < n and lines[j].startswith("## "):
            zones["subtitle"] = [lines[j].rstrip()]
            i = j + 1

    rest = "".join(lines[i:]).strip()
    if rest:
        zones["content"] = _split_steps(rest)

    return zones


def parse_markdown_zones(source: str) -> ParsedMarkdown:
    text = source

    markers = list(_ZONE_PATTERN.finditer(text))
    if not markers:
        extracted = _auto_extract(text)
        return ParsedMarkdown(
            zones=extracted,
            params={},
            auto_zones=frozenset(extracted.keys()),
        )

    zones: _ZoneChunks = {}
    params: _ZoneParams = {}

    # Content before the first marker:
    # auto-extract title/subtitle, remainder → "content"
    before = text[: markers[0].start()].strip()
    auto_zones: frozenset[str] = frozenset()
    if before:
        extracted_before = _auto_extract(before)
        zones.update(extracted_before)
        auto_zones = frozenset(extracted_before.keys())

    for idx, m in enumerate(markers):
        zone_name = m.group(1)
        raw_params = m.group(2)
        start = m.end()
        end = markers[idx + 1].start() if idx + 1 < len(markers) else len(text)
        section = text[start:end].strip()
        if section:
            zones[zone_name] = _split_steps(section)
        if raw_params.strip():
            params[zone_name] = _parse_zone_params(raw_params)

    return ParsedMarkdown(zones=zones, params=params, auto_zones=auto_zones)


# ── HTML rendering from chunks ────────────────────────────────────────────────


_REVEAL_ID_PREFIX = "inkflow-step-"


def steps_wrap_content(
    html: str, stepper: StepResolver, ids: Iterator[int], spec: _RevealSpec
) -> tuple[str, list[tuple[Animation, int]]]:
    """Wrap each top-level <p>, <li>, and <dt>+<dd> group in a stepped reveal div.

    Each wrapped item gets a unique ``inkflow-step-*`` id and a matching reveal
    ``Animation`` of the block's resolved type (``spec``, default ``FadeIn``),
    paired with the step the shared ``stepper`` assigns it under the block's
    trigger (default ``ON_CLICK`` → one item per click). The caller routes those
    through the annotate pass.
    """

    cls, kwargs = spec
    trigger = _spec_trigger(spec)
    wrapped = f"<div>{html_fragment_to_xml(html)}</div>"
    root = etree.fromstring(wrapped.encode())

    anims: list[tuple[Animation, int]] = []

    def new_wrapper() -> SvgElement:
        step = stepper.resolve(trigger)
        rid = f"{_REVEAL_ID_PREFIX}{next(ids)}"
        wrapper = etree.Element("div")
        wrapper.set("id", rid)
        # kwargs was coerced to each field's type at resolution time, but the
        # class is only known dynamically, so the unpack cannot be proven typed.
        anims.append((cls(element=rid, **kwargs), step))  # pyright: ignore[reportArgumentType]
        return wrapper

    for child in list(root):
        tag = child.tag
        if tag in ("ul", "ol"):
            for li in list(child):
                if li.tag != "li":
                    continue
                wrapper = new_wrapper()
                idx = list(child).index(li)
                child.remove(li)
                wrapper.append(li)
                child.insert(idx, wrapper)
        elif tag == "dl":
            # Group each <dt> with its following <dd> elements as one step unit.
            groups: list[list[SvgElement]] = []
            current: list[SvgElement] = []
            for el in list(child):
                if el.tag == "dt":
                    if current:
                        groups.append(current)
                    current = [el]
                elif el.tag == "dd":
                    current.append(el)
            if current:
                groups.append(current)
            for el in list(child):
                child.remove(el)
            for group in groups:
                wrapper = new_wrapper()
                for el in group:
                    wrapper.append(el)
                child.append(wrapper)
        elif tag == "p":
            wrapper = new_wrapper()
            idx = list(root).index(child)
            root.remove(child)
            wrapper.append(child)
            root.insert(idx, wrapper)

    inner = etree.tostring(root, encoding="unicode")
    inner = inner[len("<div>") : -len("</div>")]
    return inner, anims


def chunks_to_html(
    chunks: Sequence[Chunk], base_step: int, ids: Iterator[int]
) -> tuple[str, int, list[tuple[Animation, int]]]:
    parts: list[str] = []
    stepper = StepResolver(base_step)
    anims: list[tuple[Animation, int]] = []
    pending: _RevealSpec | None = None  # set by a ::step:: marker, used next chunk

    for item in chunks:
        if isinstance(item, _StepMarker):
            pending = _resolve_reveal(item.params)
            stepper.resolve(_spec_trigger(pending))
            continue

        if isinstance(item, _StepsBlock):
            html = markdown_to_html(item.text)
            html, block_anims = steps_wrap_content(
                html, stepper, ids, _resolve_reveal(item.params)
            )
            anims.extend(block_anims)
            parts.append(html)
            pending = None
            continue

        # Regular string chunk: wrap only when an explicit ::step:: preceded it.
        reveal_step = stepper.current
        html, reached = render_md_with_steps(item, reveal_step)
        stepper.bump(reached)  # fold in code-highlight stages
        if pending is not None:
            cls, kwargs = pending
            rid = f"{_REVEAL_ID_PREFIX}{next(ids)}"
            # See steps_wrap_content: dynamic class, kwargs coerced per field.
            anims.append((cls(element=rid, **kwargs), reveal_step))  # pyright: ignore[reportArgumentType]
            parts.append(f'<div id="{rid}">{html}</div>')
        else:
            parts.append(html)
        pending = None

    return "".join(parts), stepper.high, anims


# ── Zone routing ─────────────────────────────────────────────────────────────


def _reroute_zones(
    zones: _ZoneChunks,
    auto_zones: frozenset[str],
    available_zones: set[str],
    default_zone: str,
) -> _ZoneChunks:
    """Reroute auto-extracted zones to the layout's declared default zone.

    Auto-extracted zones ("title", "subtitle", "content") are displaced when
    their corresponding SVG zone (zone-title etc.) is absent from the layout.
    Displaced chunks are prepended to the default zone in order.

    Raises ValueError when displaced or unrouted content exists but no
    inkflow:default-zone was declared on the layout SVG root.
    """
    result = dict(zones)
    displaced: list[Chunk] = []

    for name in ("title", "subtitle", "content"):
        if name in auto_zones and f"zone-{name}" not in available_zones:
            chunks = result.pop(name, None)
            if chunks:
                displaced.extend(chunks)

    if displaced:
        if not default_zone:
            msg = (
                "No inkflow:default-zone declared on this layout. "
                + "Unrouted content has nowhere to go.\n"
                + 'Add inkflow:default-zone="<zone>" to the SVG root element.'
            )
            raise ValueError(msg)
        result[default_zone] = displaced + result.get(default_zone, [])

    return result


# ── Public API ────────────────────────────────────────────────────────────────


def _resolve_zone_assets(
    item: TextBox | Media | Chart, source: AssetSource
) -> ZoneFill:
    """Canonicalise the asset references a deck.py zone value carries (a chart:
    read its data)."""
    if isinstance(item, Chart):
        return resolve(item, source)
    if isinstance(item, TextBox):
        if item.text is None:
            return item
        return replace(item, text=source.html(item.text))
    resolved = replace(
        item,
        src=source.ref(item.src),
        alt_src=None if item.alt_src is None else source.ref(item.alt_src),
    )
    if isinstance(resolved, Video) and resolved.poster is not None:
        resolved = replace(resolved, poster=source.ref(resolved.poster))
    return resolved


def build_slide_content(
    parsed: ParsedMarkdown | None,
    extra: dict[str, ZoneContent],
    md_source: AssetSource,
    deck_source: AssetSource,
    available_zones: set[str] | None = None,
    default_zone: str = "",
    chart_font: float = FENCE_FONT,
) -> SlideContent:
    """Assemble per-zone content from a parsed .md file and the deck's own zones.

    The two carry references written in different files, so each gets its own
    ``AssetSource``: this is the last point where which is which is still known.
    ``chart_font`` is the text size Markdown charts are drawn with
    (`charts.fence_font`).
    """
    zones: _ZoneChunks = {}
    zone_params: _ZoneParams = {}
    auto_zones: frozenset[str] = frozenset()
    if parsed is not None:
        # copy: the notes pop below must not mutate the shared parsed object
        zones = dict(parsed.zones)
        zone_params = parsed.params
        auto_zones = parsed.auto_zones

    # Chart ids are unique per slide; a chart zone's id is its zone's name.
    chart_ids = ChartIds()
    chart_ids.taken.update(k for k, v in extra.items() if isinstance(v, Chart))

    def finish(html: str, source: AssetSource, ids: ChartIds = chart_ids) -> str:
        return expand_fences(source.html(html), source, ids, chart_font)

    notes_chunks = zones.pop("notes", None)
    notes_html = ""
    if notes_chunks:
        # Notes render to static HTML in the presenter panel, never into the slide
        # SVG, so their reveal animations are discarded (own throwaway id space).
        notes_html, _, _ = chunks_to_html(notes_chunks, 0, itertools.count(1))
        notes_html = finish(notes_html, md_source, ChartIds())

    if available_zones is not None:
        zones = _reroute_zones(zones, auto_zones, available_zones, default_zone)

    result: dict[str, ZoneFill] = {}
    animations: list[tuple[Animation, int]] = []
    base_step = 0
    ids = itertools.count(1)

    for zone_name, chunks in zones.items():
        html, base_step, zone_anims = chunks_to_html(chunks, base_step, ids)
        animations.extend(zone_anims)
        p = zone_params.get(zone_name, {})
        result[f"zone-{zone_name}"] = TextBox(
            text=finish(html, md_source),
            align=Align(p["align"]) if "align" in p else None,
            valign=VAlign(p["valign"]) if "valign" in p else None,
            padding=float(p["padding"]) if "padding" in p else None,
        )

    for key, val in extra.items():
        if isinstance(val, str):
            # A zones={...} string is Markdown like a .md section, reveals
            # included; its steps continue the slide's count.
            html, base_step, zone_anims = chunks_to_html(
                _split_steps(val), base_step, ids
            )
            animations.extend(zone_anims)
            result[f"zone-{key}"] = TextBox(text=finish(html, deck_source))
        else:
            result[f"zone-{key}"] = _resolve_zone_assets(val, deck_source)

    # base_step now holds the running max across all reveal zones (incl.
    # code-highlight stages); the deck animations=[...] list numbers on from here.
    return SlideContent(
        content=result, notes=notes_html, animations=animations, max_step=base_step
    )


# ── Source spans (for the visual editor) ──────────────────────────────────────


def zone_spans(source: str) -> dict[str, tuple[int, int]]:
    """Where each zone's text sits in ``source``, as ``(start, end)`` offsets.

    Mirrors ``parse_markdown_zones`` exactly (the same markers, the same
    auto-extraction of a leading ``#``/``##``), but keeps positions instead of
    content, so the editor can replace one zone's section and leave every other
    byte of the file alone. A span covers the section's stripped text; an empty
    zone has no span.
    """
    spans: dict[str, tuple[int, int]] = {}
    markers = list(_ZONE_PATTERN.finditer(source))
    head_end = markers[0].start() if markers else len(source)
    spans.update(_auto_spans(source, 0, head_end))
    for idx, m in enumerate(markers):
        start = m.end()
        end = markers[idx + 1].start() if idx + 1 < len(markers) else len(source)
        span = _strip_span(source, start, end)
        if span is not None:
            spans[m.group(1)] = span
    return spans


def _strip_span(text: str, start: int, end: int) -> tuple[int, int] | None:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return (start, end) if end > start else None


def _auto_spans(text: str, start: int, end: int) -> dict[str, tuple[int, int]]:
    """``_auto_extract``'s title/subtitle/content split, as spans."""
    spans: dict[str, tuple[int, int]] = {}
    pos = start

    def next_nonblank(p: int) -> int:
        while p < end:
            line_end = text.find("\n", p, end)
            line_end = end if line_end == -1 else line_end + 1
            if text[p:line_end].strip():
                return p
            p = line_end
        return end

    def line_end(p: int) -> int:
        e = text.find("\n", p, end)
        return end if e == -1 else e

    i = next_nonblank(pos)
    if i < end and text.startswith("# ", i):
        e = line_end(i)
        spans["title"] = (i, len(text[:e].rstrip()))
        pos = min(end, e + 1)
        j = next_nonblank(pos)
        if j < end and text.startswith("## ", j):
            e2 = line_end(j)
            spans["subtitle"] = (j, len(text[:e2].rstrip()))
            pos = min(end, e2 + 1)
    rest = _strip_span(text, pos, end)
    if rest is not None:
        spans["content"] = rest
    return spans


def replace_zone_text(source: str, zone: str, text: str) -> str:
    """``source`` with zone ``zone``'s section replaced by ``text``.

    A zone the file does not mention yet is added: a title as a leading ``#``
    heading when the file has none, anything else as a new ``::zone::`` section
    at the end. Empty ``text`` clears the section but keeps its marker.
    """
    text = text.strip()
    spans = zone_spans(source)
    if zone in spans:
        start, end = spans[zone]
        if zone in ("title", "subtitle") and not _ZONE_PATTERN.search(source[:start]):
            # An auto-extracted heading: keep it a heading of the same level.
            prefix = "# " if zone == "title" else "## "
            if text and not text.startswith("#"):
                text = prefix + text
        return source[:start] + text + source[end:]
    if not text:
        return source
    has_markers = _ZONE_PATTERN.search(source) is not None
    if zone == "title" and "title" not in spans and not has_markers:
        heading = text if text.startswith("#") else f"# {text}"
        body = source.lstrip("\n")
        return f"{heading}\n\n{body}" if body.strip() else f"{heading}\n"
    gap = "\n\n" if source.strip() else ""
    if zone == "content" and not has_markers and "content" not in spans:
        return source.rstrip() + gap + text + "\n"
    return source.rstrip() + gap + f"::{zone}::\n{text}\n"


def remove_zone_section(source: str, zone: str) -> str:
    """``source`` without zone ``zone``'s ``::zone::`` marker and section.

    Only an explicit marker is removed; an auto-extracted heading or leading
    content has no marker of its own and is cleared instead.
    """
    markers = list(_ZONE_PATTERN.finditer(source))
    for idx, m in enumerate(markers):
        if m.group(1) != zone:
            continue
        end = markers[idx + 1].start() if idx + 1 < len(markers) else len(source)
        before = source[: m.start()].rstrip()
        after = source[end:].lstrip("\n")
        if not after:
            return before + "\n" if before else ""
        return (before + "\n\n" if before else "") + after
    return replace_zone_text(source, zone, "")
