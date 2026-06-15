from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict, cast

from latex2mathml.converter import convert as _latex_to_mathml
from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin

from inkflow.manifest import Align, Media, TextBox, VAlign, ZoneContent

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
class _ParsedMarkdown:
    zones: _ZoneChunks
    params: _ZoneParams


class _MathOpts(TypedDict, total=False):
    display_mode: bool


def _math_to_mathml(content: str, options: _MathOpts) -> str:
    display = "block" if options.get("display_mode") else "inline"
    return _latex_to_mathml(content, display=display)


_md = MarkdownIt().use(dollarmath_plugin, renderer=_math_to_mathml)


def markdown_to_html(md_str: str) -> str:
    return cast(str, _md.render(md_str))


def _split_steps(text: str) -> list[str]:
    parts = _STEP_PATTERN.split(text)
    result: list[str] = []
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


def _parse_markdown_zones_full(md_path: Path) -> _ParsedMarkdown:
    text = md_path.read_text(encoding="utf-8")

    markers = list(_ZONE_PATTERN.finditer(text))
    if not markers:
        return _ParsedMarkdown(zones=_auto_extract(text), params={})

    zones: _ZoneChunks = {}
    params: _ZoneParams = {}

    # Content before the first marker:
    # auto-extract title/subtitle, remainder → "content"
    before = text[: markers[0].start()].strip()
    if before:
        zones.update(_auto_extract(before))

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

    return _ParsedMarkdown(zones=zones, params=params)


def parse_markdown_zones(md_path: Path) -> _ZoneChunks:
    return _parse_markdown_zones_full(md_path).zones


def chunks_to_html(
    chunks: list[str], base_step: int, wrap_list_items: bool = False
) -> tuple[str, int]:
    parts: list[str] = []
    step = base_step
    chunk_index = 0

    for item in chunks:
        if item == _STEP:
            step += 1
            continue
        html = markdown_to_html(item)
        if chunk_index == 0:
            if wrap_list_items:
                html, step = steps_wrap_list_items(html, step)
            parts.append(html)
        else:
            if wrap_list_items:
                # _STEP already incremented step; pass step-1 so the first
                # list item lands at `step`, not `step+1`
                html_wrapped, new_step = steps_wrap_list_items(html, step - 1)
                if new_step >= step:
                    html = html_wrapped
                    step = new_step
                else:
                    html = f'<div class="anim-fade-in" data-step="{step}">{html}</div>'
            else:
                html = f'<div class="anim-fade-in" data-step="{step}">{html}</div>'
            parts.append(html)
        chunk_index += 1

    return "".join(parts), step


def steps_wrap_list_items(html: str, base_step: int) -> tuple[str, int]:
    from lxml import etree

    # Wrap in a root element to parse as fragment
    wrapped = f"<div>{html}</div>"
    root = etree.fromstring(wrapped.encode())

    step = base_step
    for ul_or_ol in root.findall("ul") + root.findall("ol"):
        for li in ul_or_ol:
            if li.tag != "li":
                continue
            step += 1
            wrapper = etree.Element("div")
            wrapper.set("class", "anim-fade-in")
            wrapper.set("data-step", str(step))
            # Move li into wrapper
            idx = list(ul_or_ol).index(li)
            ul_or_ol.remove(li)
            wrapper.append(li)
            ul_or_ol.insert(idx, wrapper)
    steps: bool,
    steps: bool,

    inner = etree.tostring(root, encoding="unicode")
    # Strip outer <div> wrapper
    inner = inner[len("<div>") : -len("</div>")]
    return inner, step


def build_slide_content(
    content_path: Path | None,
    extra: dict[str, ZoneContent],
) -> SlideContent:
    zones: _ZoneChunks = {}
    zone_params: _ZoneParams = {}
    if content_path is not None:
        parsed = _parse_markdown_zones_full(content_path)
        zones = parsed.zones
        zone_params = parsed.params

    notes_chunks = zones.pop("notes", None)
    notes_html = ""
    if notes_chunks:
        notes_html, _ = chunks_to_html(notes_chunks, 0)

    content: dict[str, TextBox | Media] = {}
    base_step = 0

    for zone_name, chunks in zones.items():
        html, base_step = chunks_to_html(chunks, base_step)
        p = zone_params.get(zone_name, {})
        content[f"zone-{zone_name}"] = TextBox(
            text=html,
            align=Align(p["align"]) if "align" in p else None,
            valign=VAlign(p["valign"]) if "valign" in p else None,
            padding=float(p["padding"]) if "padding" in p else None,
        )

    for key, val in extra.items():
        if isinstance(val, str):
            content[f"zone-{key}"] = TextBox(text=markdown_to_html(val))
        else:
            content[f"zone-{key}"] = val

    return SlideContent(content=content, notes=notes_html)
