from __future__ import annotations

import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import cast

from markdown_it import MarkdownIt

from inkflow.manifest import Align, Content, Media, TextBox, VAlign


@dataclass
class SlideContent:
    content: list[Content]
    notes: str


@dataclass
class _ParsedMarkdown:
    zones: dict[str, list[str]]
    params: dict[str, dict[str, str]]  # zone_name → {align, valign, padding, …}


_ZONE_PATTERN = re.compile(
    r"^::((?!step\b)[\w-]+)((?:\s+[\w-]+=\S+)*)::\s*$", re.MULTILINE
)
_STEP_PATTERN = re.compile(r"^::step::\s*$", re.MULTILINE)
_STEP = "\x00step\x00"

_md = MarkdownIt()


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


def _parse_zone_params(params_str: str) -> dict[str, str]:
    params: dict[str, str] = {}
    for token in params_str.split():
        if "=" in token:
            key, _, value = token.partition("=")
            params[key.strip()] = value.strip()
    return params


def _auto_extract(text: str) -> dict[str, list[str]]:
    zones: dict[str, list[str]] = {}
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

    zones: dict[str, list[str]] = {}
    params: dict[str, dict[str, str]] = {}

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


def parse_markdown_zones(md_path: Path) -> dict[str, list[str]]:
    return _parse_markdown_zones_full(md_path).zones


def chunks_to_html(chunks: list[str], base_step: int) -> tuple[str, int]:
    parts: list[str] = []
    step = base_step
    chunk_index = 0

    for item in chunks:
        if item == _STEP:
            step += 1
            continue
        if chunk_index == 0:
            parts.append(markdown_to_html(item))
        else:
            html = markdown_to_html(item)
            parts.append(f'<div class="anim-fade-in" data-step="{step}">{html}</div>')
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

    inner = etree.tostring(root, encoding="unicode")
    # Strip outer <div> wrapper
    inner = inner[len("<div>") : -len("</div>")]
    return inner, step


def build_slide_content(
    content_path: Path | None,
    steps: bool,
    extra: dict[str, str | Media],
) -> SlideContent:
    zones: dict[str, list[str]] = {}
    zone_params: dict[str, dict[str, str]] = {}
    if content_path is not None:
        parsed = _parse_markdown_zones_full(content_path)
        zones = parsed.zones
        zone_params = parsed.params

    notes_chunks = zones.pop("notes", None)
    notes_html = ""
    if notes_chunks:
        notes_html, _ = chunks_to_html(notes_chunks, 0)

    content: list[Content] = []
    base_step = 0

    for zone_name, chunks in zones.items():
        html, base_step = chunks_to_html(chunks, base_step)
        if steps:
            html, base_step = steps_wrap_list_items(html, base_step)
        p = zone_params.get(zone_name, {})
        content.append(
            TextBox(
                f"#zone-{zone_name}",
                text=html,
                align=Align(p["align"]) if "align" in p else None,
                valign=VAlign(p["valign"]) if "valign" in p else None,
                padding=float(p["padding"]) if "padding" in p else None,
            )
        )

    for key, val in extra.items():
        if isinstance(val, Media):
            content.append(replace(val, element=f"#zone-{key}"))
        else:
            content.append(Media(val, element=f"#zone-{key}"))

    return SlideContent(content=content, notes=notes_html)
