"""Find and replace across a deck's own files.

The browser names the files to search (it knows each slide's sources from the
editor model): slide and layout SVGs, Markdown slides and notes. ``deck.py`` is
always searched too, but only inside the strings an author would call text:
``title=``, ``zones={...}`` values (plain strings and ``TextBox`` text) and
``Inline(...)`` Markdown and notes. Code is never matched.

A file is a list of *segments* (one text node of an SVG ``<text>``, a whole
Markdown file, one string literal), searched in document order, so a hit is
named by its file and its index among that file's hits, and replacing hit
``n`` means replacing the ``n``-th match. Matches never span segments.
"""

from __future__ import annotations

import ast
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import libcst as cst
from typing_extensions import override

from inkflow.editor.codegen import Code
from inkflow.editor.provenance import child_path, is_element
from inkflow.editor.svgops import SvgFile
from inkflow.svgio import SvgElement

MAX_HITS = 500
_TEXT_TAGS = {"text", "tspan", "textPath", "flowRoot", "flowPara", "flowSpan"}


class FindError(ValueError):
    pass


@dataclass
class Options:
    match_case: bool = False
    whole_word: bool = False
    regex: bool = False


def pattern(query: str, opts: Options) -> re.Pattern[str]:
    if not query:
        raise FindError("nothing to find")
    body = query if opts.regex else re.escape(query)
    if opts.whole_word:
        body = rf"\b(?:{body})\b"
    try:
        return re.compile(body, 0 if opts.match_case else re.IGNORECASE)
    except re.error as exc:
        raise FindError(f"invalid pattern: {exc}") from exc


@dataclass
class Segment:
    text: str
    set: Callable[[str], None]
    loc: str | None = None  # SVG: the <text> element's child path
    element_id: str | None = None
    slide: int | None = None  # deck.py: the Slide(...) call's position


@dataclass
class Hit:
    file: str
    kind: str
    index: int
    before: str
    match: str
    after: str
    line: int
    loc: str | None
    element_id: str | None
    slide: int | None

    def to_json(self) -> dict[str, object]:
        return {
            "file": self.file,
            "kind": self.kind,
            "index": self.index,
            "before": self.before,
            "match": self.match,
            "after": self.after,
            "line": self.line,
            "loc": self.loc,
            "id": self.element_id,
            "slide": self.slide,
        }


# ── Segments per file kind ──


def _local(tag: object) -> str:
    return str(tag).rsplit("}", 1)[-1]


def svg_segments(svg: SvgFile) -> list[Segment]:
    out: list[Segment] = []
    for el in svg.root.iter():
        if not is_element(el) or _local(el.tag) not in _TEXT_TAGS:
            continue
        owner = el
        while owner.getparent() is not None and _local(owner.tag) != "text":
            parent = owner.getparent()
            if parent is None or _local(parent.tag) not in _TEXT_TAGS:
                break
            owner = parent
        loc = child_path(owner)
        oid = owner.get("id")

        def set_text(v: str, el: SvgElement = el) -> None:
            el.text = v

        if el.text:
            out.append(Segment(el.text, set_text, loc, oid))
        # A span's tail is text of the enclosing <text>; a <text>'s own tail is
        # whitespace between elements.
        parent = el.getparent()
        if el.tail and parent is not None and _local(parent.tag) in _TEXT_TAGS:

            def set_tail(v: str, el: SvgElement = el) -> None:
                el.tail = v

            out.append(Segment(el.tail, set_tail, loc, oid))
    return out


class _Strings(cst.CSTVisitor):
    """The author-text string literals inside ``Slide(...)`` calls."""

    def __init__(self) -> None:
        super().__init__()
        self.nodes: list[cst.SimpleString] = []
        self.slides: list[int] = []
        self.count: int = -1

    @override
    def visit_Call(self, node: cst.Call) -> bool:
        if _callee(node) != "Slide":
            return True
        self.count += 1
        for arg in node.args:
            name = arg.keyword.value if arg.keyword is not None else None
            if name == "title":
                self._take(arg.value)
            elif name in ("md", "notes") and _callee(arg.value) == "Inline":
                self._take_call(arg.value)
            elif name == "zones" and isinstance(arg.value, cst.Dict):
                for el in arg.value.elements:
                    if isinstance(el, cst.DictElement):
                        if _callee(el.value) == "TextBox":
                            self._take_call(el.value, keyword="text")
                        else:
                            self._take(el.value)
        return False

    def _take(self, value: cst.BaseExpression) -> None:
        if isinstance(value, cst.SimpleString) and _string_value(value) is not None:
            self.nodes.append(value)
            self.slides.append(self.count)

    def _take_call(self, call: cst.BaseExpression, keyword: str | None = None) -> None:
        if not isinstance(call, cst.Call):
            return
        for i, arg in enumerate(call.args):
            named = arg.keyword.value if arg.keyword is not None else None
            if (named is None and i == 0) or (keyword and named == keyword):
                self._take(arg.value)


def _callee(node: cst.BaseExpression) -> str | None:
    if not isinstance(node, cst.Call):
        return None
    func = node.func
    if isinstance(func, cst.Name):
        return func.value
    if isinstance(func, cst.Attribute):
        return func.attr.value
    return None


def _string_value(node: cst.SimpleString) -> str | None:
    if any(c in node.prefix.lower() for c in "bf"):
        return None  # bytes and f-strings are not text
    try:
        value = cast("object", ast.literal_eval(node.value))
    except (ValueError, SyntaxError):
        return None
    return value if isinstance(value, str) else None


class DeckStrings:
    """deck.py's author-text literals as segments; ``code`` has the edits."""

    module: cst.Module
    nodes: list[cst.SimpleString]
    slides: list[int]
    replacements: dict[int, str]

    def __init__(self, code: str) -> None:
        self.module = cst.parse_module(code)
        finder = _Strings()
        self.module.visit(finder)
        self.nodes = finder.nodes
        self.slides = finder.slides
        self.replacements = {}

    def segments(self) -> list[Segment]:
        out: list[Segment] = []
        for i, node in enumerate(self.nodes):
            value = _string_value(node) or ""

            def set_value(v: str, i: int = i) -> None:
                self.replacements[i] = v

            out.append(Segment(value, set_value, slide=self.slides[i]))
        return out

    @property
    def code(self) -> str:
        by_node = {
            id(self.nodes[i]): Code().literal(v) for i, v in self.replacements.items()
        }
        return self.module.visit(_Rewrite(by_node)).code


class _Rewrite(cst.CSTTransformer):
    """Every changed literal in one pass (node identity is the original tree's)."""

    by_node: dict[int, str]

    def __init__(self, by_node: dict[int, str]) -> None:
        super().__init__()
        self.by_node = by_node

    @override
    def leave_SimpleString(
        self, original_node: cst.SimpleString, updated_node: cst.SimpleString
    ) -> cst.BaseExpression:
        literal = self.by_node.get(id(original_node))
        return updated_node.with_changes(value=literal) if literal else updated_node


# ── Searching and replacing ──


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def iter_hits(
    path: Path, kind: str, segments: list[Segment], pat: re.Pattern[str]
) -> Iterator[Hit]:
    index = 0
    for seg in segments:
        for m in pat.finditer(seg.text):
            if m.end() == m.start():
                continue
            start, end = m.span()
            before = seg.text[max(0, start - 40) : start]
            after = seg.text[end : end + 40]
            yield Hit(
                file=str(path),
                kind=kind,
                index=index,
                before=before.rsplit("\n", 1)[-1],
                match=m.group(0),
                after=after.split("\n", 1)[0],
                line=_line_of(seg.text, start) if kind != "svg" else 0,
                loc=seg.loc,
                element_id=seg.element_id,
                slide=seg.slide,
            )
            index += 1


def replace_in(
    segments: list[Segment],
    pat: re.Pattern[str],
    replacement: str,
    only: int | None,
    regex: bool,
) -> int:
    """Replace every match (or only match number ``only``); returns how many."""
    seen = 0
    done = 0
    for seg in segments:
        pieces: list[str] = []
        pos = 0
        changed = False
        for m in pat.finditer(seg.text):
            if m.end() == m.start():
                continue
            if only is None or seen == only:
                pieces.append(seg.text[pos : m.start()])
                pieces.append(m.expand(replacement) if regex else replacement)
                pos = m.end()
                changed = True
                done += 1
            seen += 1
        if changed:
            pieces.append(seg.text[pos:])
            seg.set("".join(pieces))
        if only is not None and seen > only:
            break
    return done
