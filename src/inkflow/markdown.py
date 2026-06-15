from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias, TypedDict, cast

from latex2mathml.converter import convert as _latex_to_mathml
from markdown_it import MarkdownIt
from markdown_it.token import Token
from mdit_py_plugins.dollarmath import dollarmath_plugin
from pygments import highlight as _py_highlight
from pygments.formatters import HtmlFormatter as _HtmlFormatter
from pygments.lexers import (
    get_lexer_by_name as _get_lexer_by_name,  # pyright: ignore[reportUnknownVariableType]
)
from pygments.lexers.special import TextLexer as _TextLexer
from pygments.util import ClassNotFound as _ClassNotFound

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

# Fence code-block info-string primitives
_FENCE_LANG = r"[\w+\-#.]+"  # python, c++, c#, text/plain …
_FENCE_SPEC = r"\{[^}]*\}"  # optional {…} highlight spec

_FENCE_INFO_RE = re.compile(
    rf"^\s*(?P<lang>{_FENCE_LANG})?\s*(?P<spec>{_FENCE_SPEC})?\s*$"
)

_STEP = "\x00step\x00"

# ── Highlight-spec types ──────────────────────────────────────────────────────

# One stage: None = "all" (no dimming), [] = "none" (all dimmed), [1,2] = lines
_HlStage: TypeAlias = list[int] | None
_HlSpec: TypeAlias = list[_HlStage]  # ordered list of stages


@dataclass
class _FenceEntry:
    base_step: int
    lang: str
    spec: _HlSpec | None  # None = plain block, no step-based highlighting


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


class _MathOpts(TypedDict, total=False):
    display_mode: bool


def _math_to_mathml(content: str, options: _MathOpts) -> str:
    display = "block" if options.get("display_mode") else "inline"
    return _latex_to_mathml(content, display=display)


_md = MarkdownIt().use(dollarmath_plugin, renderer=_math_to_mathml)

# ── Fence info / highlight-spec parsing ───────────────────────────────────────


def _parse_hl_spec(spec_str: str) -> _HlSpec:
    """Parse '{1|2-3|all}' content (without braces) into a list of stages."""
    stages: _HlSpec = []
    for part in spec_str.split("|"):
        part = part.strip()
        if not part or part in ("all", "*"):
            stages.append(None)
        elif part == "none":
            stages.append([])
        else:
            lines: list[int] = []
            for seg in part.split(","):
                seg = seg.strip()
                if "-" in seg:
                    lo, _, hi = seg.partition("-")
                    lo, hi = lo.strip(), hi.strip()
                    if lo.isdigit() and hi.isdigit():
                        lines.extend(range(int(lo), int(hi) + 1))
                elif seg.isdigit():
                    lines.append(int(seg))
            stages.append(lines)
    return stages


def _parse_fence_info(info: str) -> tuple[str, _HlSpec | None]:
    """Parse a fence info string like 'python {1|2-3|all}' → ('python', spec)."""
    m = _FENCE_INFO_RE.match(info)
    if not m:
        return info.strip() or "text", None
    lang = m.group("lang") or "text"
    raw_spec = m.group("spec")
    if not raw_spec:
        return lang, None
    return lang, _parse_hl_spec(raw_spec[1:-1])  # strip { }


# ── Pygments syntax highlighting ──────────────────────────────────────────────

_PYGMENTS_FMT: _HtmlFormatter[str] = _HtmlFormatter(nowrap=True, noclasses=False)


def _highlight_code_lines(code: str, lang: str) -> list[str]:
    """Syntax-highlight code and return one HTML string per source line."""
    try:
        lexer = _get_lexer_by_name(lang, stripnl=False)
    except _ClassNotFound:
        lexer = _TextLexer(stripnl=False)
    highlighted = _py_highlight(code, lexer, _PYGMENTS_FMT)
    return highlighted.splitlines()


def _render_codeblock(
    code: str, lang: str, spec: _HlSpec | None, base_step: int
) -> str:
    """Build the full HTML for a (possibly step-annotated) code block."""
    raw_lines = _highlight_code_lines(code, lang)
    line_spans: list[str] = []
    for i, line in enumerate(raw_lines, 1):
        content = line if line else "&#160;"
        line_spans.append(f'<span class="code-line" data-line="{i}">{content}</span>')
    inner = "".join(line_spans)

    if spec is not None:
        spec_json = json.dumps(spec)
        return (
            f'<div class="inkflow-codeblock"'
            f" data-hl-spec='{spec_json}'"
            f' data-base-step="{base_step}">'
            f'<pre class="highlight"><code>{inner}</code></pre>'
            f"</div>"
        )
    return (
        f'<div class="inkflow-codeblock">'
        f'<pre class="highlight"><code>{inner}</code></pre>'
        f"</div>"
    )


# ── Step-aware markdown rendering ─────────────────────────────────────────────

# Module-level fence render queue (safe: asyncio single-threaded, sync render).
_fence_queue: list[_FenceEntry] = []
_fence_pos = [0]


def _fence_renderer(
    _renderer: object, tokens: object, idx: int, _options: object, _env: object
) -> str:

    token = cast(Token, cast(list[object], tokens)[idx])
    entry = _fence_queue[_fence_pos[0]] if _fence_pos[0] < len(_fence_queue) else None
    _fence_pos[0] += 1

    if entry is not None:
        return _render_codeblock(token.content, entry.lang, entry.spec, entry.base_step)
    lang, spec = _parse_fence_info(token.info.strip() if token.info else "")
    return _render_codeblock(token.content, lang, spec, 0)


_md.add_render_rule("fence", _fence_renderer)


def _render_md_with_steps(md: str, base_step: int) -> tuple[str, int]:
    """Render markdown, assigning base steps to fenced code blocks with specs.

    Returns (html, new_step) where new_step accounts for extra clicks consumed
    by highlight-spec stages (N stages = N-1 extra steps beyond base_step).
    """
    tokens = _md.parse(md, {})

    step = base_step
    _fence_queue.clear()
    for token in tokens:
        if token.type == "fence":
            lang, spec = _parse_fence_info(token.info.strip() if token.info else "")
            _fence_queue.append(_FenceEntry(step, lang, spec))
            if spec is not None:
                step += len(spec) - 1

    _fence_pos[0] = 0
    html = cast(str, _md.renderer.render(tokens, _md.options, {}))
    return html, step


# ── Markdown rendering ────────────────────────────────────────────────────────


def markdown_to_html(md_str: str) -> str:
    return cast(str, _md.render(md_str))


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


def parse_markdown_zones(md_path: Path) -> ParsedMarkdown:
    text = md_path.read_text(encoding="utf-8")

    markers = list(_ZONE_PATTERN.finditer(text))
    if not markers:
        return ParsedMarkdown(zones=_auto_extract(text), params={})

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

    return ParsedMarkdown(zones=zones, params=params)


# ── HTML rendering from chunks ────────────────────────────────────────────────


def steps_wrap_list_items(html: str, base_step: int) -> tuple[str, int]:
    from lxml import etree

    wrapped = f"<div>{html}</div>"
    root = etree.fromstring(wrapped.encode())

    step = base_step
    for ul_or_ol in root.findall("ul") + root.findall("ol"):
        for li in list(ul_or_ol):
            if li.tag != "li":
                continue
            step += 1
            wrapper = etree.Element("div")
            wrapper.set("class", "anim-fade-in")
            wrapper.set("data-step", str(step))
            idx = list(ul_or_ol).index(li)
            ul_or_ol.remove(li)
            wrapper.append(li)
            ul_or_ol.insert(idx, wrapper)

    inner = etree.tostring(root, encoding="unicode")
    inner = inner[len("<div>") : -len("</div>")]
    return inner, step


def steps_wrap_content(html: str, base_step: int) -> tuple[str, int]:
    """Wrap each top-level <p> and each <li> in a stepped fade-in div."""
    from lxml import etree

    wrapped = f"<div>{html}</div>"
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
        html, step = _render_md_with_steps(item, chunk_step)
        if needs_step_wrap:
            parts.append(
                f'<div class="anim-fade-in" data-step="{chunk_step}">{html}</div>'
            )
        else:
            parts.append(html)
        needs_step_wrap = False

    return "".join(parts), step


# ── Public API ────────────────────────────────────────────────────────────────


def build_slide_content(
    content_path: Path | None,
    extra: dict[str, ZoneContent],
) -> SlideContent:
    zones: _ZoneChunks = {}
    zone_params: _ZoneParams = {}
    if content_path is not None:
        parsed = parse_markdown_zones(content_path)
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
