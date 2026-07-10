from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

from lxml import etree

from inkflow.enums import Align, VAlign
from inkflow.manifest import Media, TextBox, ZoneContent
from inkflow.markdown import (
    html_fragment_to_xml,
    markdown_to_html,
    render_md_with_steps,
)
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
_STEP_PATTERN = re.compile(r"^::step::\s*$", re.MULTILINE)
_STEPS_BLOCK_RE = re.compile(
    r"^::steps::\s*\n(.*?)(?:^::steps end::\s*$|\Z)",
    re.MULTILINE | re.DOTALL,
)

_STEP = "\x00step\x00"


# ── Public output types ───────────────────────────────────────────────────────


@dataclass
class SlideContent:
    content: dict[str, TextBox | Media]  # zone-id (e.g. "zone-content") → content
    notes: str


@dataclass
class _StepsBlock:
    text: str  # markdown content inside as ::steps:: block


# ── Internal types ────────────────────────────────────────────────────────────

Chunk = str | _StepsBlock
_ZoneChunks = dict[str, list[Chunk]]
_ParamMap = dict[str, str]
_ZoneParams = dict[str, _ParamMap]


@dataclass
class ParsedMarkdown:
    zones: _ZoneChunks
    params: _ZoneParams
    auto_zones: frozenset[str] = field(default_factory=frozenset)


# ── Step / steps parsing ──────────────────────────────────────────────────────


def _split_steps(text: str) -> list[Chunk]:
    """Split text on ::step:: markers and ::steps:: blocks.

    Returns a list of Chunk values where:
    - str values are regular text segments (may be empty)
    - _STEP sentinel strings mark step boundaries
    - _StepsBlock values carry a block whose items reveal individually
    """
    result: list[Chunk] = []
    pos = 0

    for m in _STEPS_BLOCK_RE.finditer(text):
        before = text[pos : m.start()]
        if before.strip():
            parts = _STEP_PATTERN.split(before)
            for i, part in enumerate(parts):
                if i > 0:
                    result.append(_STEP)
                result.append(part)
        block_text = _STEP_PATTERN.sub("", m.group(1)).strip()
        if block_text:
            result.append(_StepsBlock(block_text))
        pos = m.end()

    tail = text[pos:]
    parts = _STEP_PATTERN.split(tail)
    for i, part in enumerate(parts):
        if i > 0:
            result.append(_STEP)
        result.append(part)

    return result


def _parse_zone_params(params_str: str) -> _ParamMap:
    params: _ParamMap = {}
    for token in params_str.split():
        if "=" in token:
            key, _, value = token.partition("=")
            params[key.strip()] = value.strip()
    return params


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


def steps_wrap_content(html: str, base_step: int) -> tuple[str, int]:
    """Wrap each top-level <p>, <li>, and <dt>+<dd> group in a stepped fade-in div."""

    wrapped = f"<div>{html_fragment_to_xml(html)}</div>"
    root = etree.fromstring(wrapped.encode())

    step = base_step
    for child in list(root):
        tag = child.tag
        if tag in ("ul", "ol"):
            for li in list(child):
                if li.tag != "li":
                    continue
                step += 1
                wrapper = etree.Element("div")
                wrapper.set("class", "anim-fade-in")
                wrapper.set("data-step", str(step))
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
                step += 1
                wrapper = etree.Element("div")
                wrapper.set("class", "anim-fade-in")
                wrapper.set("data-step", str(step))
                for el in group:
                    wrapper.append(el)
                child.append(wrapper)
        elif tag == "p":
            step += 1
            wrapper = etree.Element("div")
            wrapper.set("class", "anim-fade-in")
            wrapper.set("data-step", str(step))
            idx = list(root).index(child)
            root.remove(child)
            wrapper.append(child)
            root.insert(idx, wrapper)

    inner = etree.tostring(root, encoding="unicode")
    inner = inner[len("<div>") : -len("</div>")]
    return inner, step


def chunks_to_html(chunks: Sequence[Chunk], base_step: int) -> tuple[str, int]:
    parts: list[str] = []
    step = base_step
    needs_step_wrap = False  # True only after a ::step:: marker

    for item in chunks:
        if item == _STEP:
            step += 1
            needs_step_wrap = True
            continue

        if isinstance(item, _StepsBlock):
            html = markdown_to_html(item.text)
            html, step = steps_wrap_content(html, step)
            parts.append(html)
            needs_step_wrap = False
            continue

        # Regular string chunk: wrap only when an explicit ::step:: preceded it
        chunk_step = step
        html, step = render_md_with_steps(item, chunk_step)
        if needs_step_wrap:
            parts.append(
                f'<div class="anim-fade-in" data-step="{chunk_step}">{html}</div>'
            )
        else:
            parts.append(html)
        needs_step_wrap = False

    return "".join(parts), step


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


def build_slide_content(
    parsed: ParsedMarkdown | None,
    extra: dict[str, ZoneContent],
    available_zones: set[str] | None = None,
    default_zone: str = "",
) -> SlideContent:
    zones: _ZoneChunks = {}
    zone_params: _ZoneParams = {}
    auto_zones: frozenset[str] = frozenset()
    if parsed is not None:
        # copy: the notes pop below must not mutate the shared parsed object
        zones = dict(parsed.zones)
        zone_params = parsed.params
        auto_zones = parsed.auto_zones

    notes_chunks = zones.pop("notes", None)
    notes_html = ""
    if notes_chunks:
        notes_html, _ = chunks_to_html(notes_chunks, 0)

    if available_zones is not None:
        zones = _reroute_zones(zones, auto_zones, available_zones, default_zone)

    result: dict[str, TextBox | Media] = {}
    base_step = 0

    for zone_name, chunks in zones.items():
        html, base_step = chunks_to_html(chunks, base_step)
        p = zone_params.get(zone_name, {})
        result[f"zone-{zone_name}"] = TextBox(
            text=html,
            align=Align(p["align"]) if "align" in p else None,
            valign=VAlign(p["valign"]) if "valign" in p else None,
            padding=float(p["padding"]) if "padding" in p else None,
        )

    for key, val in extra.items():
        if isinstance(val, str):
            result[f"zone-{key}"] = TextBox(text=markdown_to_html(val))
        else:
            result[f"zone-{key}"] = val

    return SlideContent(content=result, notes=notes_html)
