from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TypeAlias, TypedDict, cast
from xml.sax.saxutils import escape

from latex2mathml.converter import convert as _latex_to_mathml
from lxml import etree
from markdown_it import MarkdownIt
from markdown_it.renderer import RendererHTML
from markdown_it.token import Token
from markdown_it.utils import EnvType, OptionsDict
from mdit_py_plugins.attrs import attrs_block_plugin, attrs_plugin
from mdit_py_plugins.deflist import deflist_plugin
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from pygments import highlight as _py_highlight
from pygments.formatters import HtmlFormatter as _HtmlFormatter
from pygments.lexers import (
    get_lexer_by_name as _get_lexer_by_name,  # pyright: ignore[reportUnknownVariableType]
)
from pygments.lexers.special import TextLexer as _TextLexer
from pygments.util import ClassNotFound as _ClassNotFound

# This module renders Markdown (and raw HTML fragments) to HTML. It owns the
# markdown-it configuration, code-fence highlighting, and LaTeX math, and knows
# nothing about inkflow's zone/step marker grammar or slide assembly — those live
# in ``inkflow.zones``, which imports from here.

# ── Fence info primitives ─────────────────────────────────────────────────────

# Fence code-block info-string primitives
_FENCE_LANG = r"[\w+\-#.]+"  # python, c++, c#, text/plain …
_FENCE_SPEC = r"\{[^}]*\}"  # optional {…} highlight spec

_FENCE_INFO_RE = re.compile(
    rf"^\s*(?P<lang>{_FENCE_LANG})?\s*(?P<spec>{_FENCE_SPEC})?\s*$"
)

# ── Highlight-spec types ──────────────────────────────────────────────────────

# One stage: None = "all" (no dimming), [] = "none" (all dimmed), [1,2] = lines
_HlStage: TypeAlias = list[int] | None
_HlSpec: TypeAlias = list[_HlStage]  # ordered list of stages


@dataclass
class _FenceEntry:
    base_step: int
    lang: str
    spec: _HlSpec | None  # None = plain block, no step-based highlighting


class _MathOpts(TypedDict, total=False):
    display_mode: bool


def _math_to_mathml(content: str, options: _MathOpts) -> str:
    display = "block" if options.get("display_mode") else "inline"
    return _latex_to_mathml(content, display=display)


_md = (
    MarkdownIt(options_update={"html": True})
    .enable(["table", "strikethrough"])
    .use(dollarmath_plugin, renderer=_math_to_mathml)
    .use(tasklists_plugin)
    .use(footnote_plugin)
    .use(deflist_plugin)
    .use(attrs_plugin)
    .use(attrs_block_plugin)
)


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


def _render_link_open(
    renderer: object, tokens: object, idx: int, options: object, env: object
) -> str:

    token = cast(Token, cast(list[object], tokens)[idx])
    href = str(token.attrGet("href") or "")
    if href.startswith("slide:"):
        slide_id = href[len("slide:") :]
        return f'<a data-inkflow-slide="{slide_id}" title="Go to slide: {slide_id}">'
    return cast(RendererHTML, renderer).renderToken(
        cast(Sequence[Token], tokens),
        idx,
        cast(OptionsDict, options),
        cast(EnvType, env),
    )


_md.add_render_rule("link_open", _render_link_open)


def render_md_with_steps(md: str, base_step: int) -> tuple[str, int]:
    """Render markdown, assigning base steps to fenced code blocks with specs.

    Returns (html, new_step) where new_step accounts for extra clicks consumed
    by highlight-spec stages (N stages = N-1 extra steps beyond base_step). The
    "step" here counts code-highlight stages, distinct from the ``::step::``
    content-reveal steps owned by ``inkflow.zones``.
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


def html_fragment_to_xml(html: str) -> str:
    """Normalise a rendered-HTML fragment into well-formed XML markup.

    markdown-it with ``html=True`` passes raw author HTML through verbatim, so
    natural void elements like ``<br>`` arrive un-closed and are not valid XML.
    The SVG/foreignObject pipeline re-serialises this content as XML (lxml), so it
    must be well-formed. Parse with lxml's tolerant HTML parser and re-emit as XML:
    void elements close, embedded MathML is preserved. Falls back to XML-escaped
    text if the fragment cannot be made well-formed.
    """
    if not html:
        return ""
    try:
        root = etree.fromstring(f"<div>{html}</div>", etree.HTMLParser())
        div = root.find(".//div")
        if div is None:
            return escape(html)
        inner = etree.tostring(div, encoding="unicode")[len("<div>") : -len("</div>")]
        etree.fromstring(f"<x>{inner}</x>")  # guarantee well-formed downstream
    except (etree.XMLSyntaxError, ValueError):
        return escape(html)
    return inner
