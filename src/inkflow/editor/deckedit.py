"""Structured edits to ``deck.py`` that keep the author's formatting.

``deck.py`` is ordinary Python, so the editor can only change the parts that have
a recognisable shape: the ``Deck(slides=[...])`` list (a literal list, or a name
bound to one), each ``Slide(...)`` call in it, and that call's keyword arguments
(``animations=[...]``, ``zones={...}``, ``transition=``, ``notes=`` …). Anything
built by a loop or a helper function is reported as not editable rather than
guessed at.

libcst keeps comments and whitespace, and the sequence edits below move an item
together with the comment lines written above it, so reordering slides carries
their explanatory comments along.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

import libcst as cst
from typing_extensions import override

# ── Bracketed sequences (list, dict, call arguments) ───────────────────────────


@dataclass
class _Item:
    node: cst.CSTNode
    """The element without its comma (``Element``, ``DictElement`` or ``Arg``)."""
    leading: Sequence[cst.EmptyLine]
    """Comment lines written above the item."""
    trailing: cst.TrailingWhitespace | None
    """A comment on the item's own line, after its comma."""


def _ws_parts(
    ws: cst.BaseParenthesizableWhitespace,
) -> tuple[cst.TrailingWhitespace | None, Sequence[cst.EmptyLine]]:
    if isinstance(ws, cst.ParenthesizedWhitespace):
        return ws.first_line, ws.empty_lines
    return None, ()


class _Seq:
    """A list, dict or argument list viewed as items separated by gaps.

    ``gaps[0]`` sits before the first item, ``gaps[k]`` between items ``k-1`` and
    ``k``, and ``gaps[n]`` before the closing bracket. An item owns the comment
    lines in the gap above it and the end-of-line comment in the gap after it.
    """

    node: cst.List | cst.Dict | cst.Call
    trailing_comma: bool
    gaps: list[cst.BaseParenthesizableWhitespace]
    items: list[_Item]
    template: cst.ParenthesizedWhitespace | None

    def __init__(self, node: cst.List | cst.Dict | cst.Call) -> None:
        self.node = node
        elements = self._elements()
        gaps: list[cst.BaseParenthesizableWhitespace] = [self._open()]
        for el in elements[:-1]:
            comma = el.comma
            gaps.append(
                comma.whitespace_after
                if isinstance(comma, cst.Comma)
                else cst.SimpleWhitespace(" ")
            )
        self.trailing_comma = bool(elements) and isinstance(
            elements[-1].comma, cst.Comma
        )
        gaps.append(self._close(elements))
        self.gaps = gaps
        self.items = []
        for i, el in enumerate(elements):
            _, leading = _ws_parts(gaps[i])
            trailing, _ = _ws_parts(gaps[i + 1])
            self.items.append(_Item(self._strip(el), leading, trailing))
        self.template = next(
            (g for g in gaps[:-1] if isinstance(g, cst.ParenthesizedWhitespace)), None
        )

    def _elements(self) -> list[cst.Element | cst.DictElement | cst.Arg]:
        if isinstance(self.node, cst.Call):
            return list(self.node.args)
        return cast(
            "list[cst.Element | cst.DictElement | cst.Arg]", list(self.node.elements)
        )

    def _open(self) -> cst.BaseParenthesizableWhitespace:
        if isinstance(self.node, cst.Call):
            return self.node.whitespace_before_args
        if isinstance(self.node, cst.List):
            return self.node.lbracket.whitespace_after
        return self.node.lbrace.whitespace_after

    def _close(
        self, elements: Sequence[cst.Element | cst.DictElement | cst.Arg]
    ) -> cst.BaseParenthesizableWhitespace:
        if isinstance(self.node, cst.Call):
            if not elements:
                return cst.SimpleWhitespace("")
            last = elements[-1]
            if isinstance(last.comma, cst.Comma):
                return last.comma.whitespace_after
            return cast("cst.Arg", last).whitespace_after_arg
        if isinstance(self.node, cst.List):
            return self.node.rbracket.whitespace_before
        return self.node.rbrace.whitespace_before

    @staticmethod
    def _strip(el: cst.Element | cst.DictElement | cst.Arg) -> cst.CSTNode:
        if isinstance(el, cst.Arg):
            return el.with_changes(
                comma=cst.MaybeSentinel.DEFAULT,
                whitespace_after_arg=cst.SimpleWhitespace(""),
            )
        return el.with_changes(comma=cst.MaybeSentinel.DEFAULT)

    def _gap(
        self,
        trailing: cst.TrailingWhitespace | None,
        leading: Sequence[cst.EmptyLine],
    ) -> cst.BaseParenthesizableWhitespace:
        if self.template is None:
            return cst.SimpleWhitespace(" ")
        return self.template.with_changes(
            first_line=trailing or cst.TrailingWhitespace(),
            empty_lines=leading,
        )

    def build(self) -> cst.List | cst.Dict | cst.Call:
        n = len(self.items)
        if n == 0:
            empty = cst.SimpleWhitespace("")
            if isinstance(self.node, cst.Call):
                return self.node.with_changes(args=[], whitespace_before_args=empty)
            if isinstance(self.node, cst.List):
                return self.node.with_changes(
                    elements=[],
                    lbracket=cst.LeftSquareBracket(),
                    rbracket=cst.RightSquareBracket(),
                )
            return self.node.with_changes(
                elements=[], lbrace=cst.LeftCurlyBrace(), rbrace=cst.RightCurlyBrace()
            )
        opening = self.gaps[0]
        if isinstance(opening, cst.ParenthesizedWhitespace):
            opening = opening.with_changes(empty_lines=self.items[0].leading)
        closing = self.gaps[-1]
        if isinstance(closing, cst.ParenthesizedWhitespace):
            closing = closing.with_changes(
                first_line=self.items[-1].trailing or cst.TrailingWhitespace()
            )
        trailing_comma = self.trailing_comma or (
            self.template is not None
            and isinstance(closing, cst.ParenthesizedWhitespace)
        )
        elements: list[cst.CSTNode] = []
        for i, item in enumerate(self.items):
            last = i == n - 1
            node = item.node
            if not last:
                gap = self._gap(item.trailing, self.items[i + 1].leading)
                node = node.with_changes(comma=cst.Comma(whitespace_after=gap))
            elif isinstance(self.node, cst.Call):
                if trailing_comma:
                    node = node.with_changes(comma=cst.Comma(whitespace_after=closing))
                else:
                    node = node.with_changes(whitespace_after_arg=closing)
            elif trailing_comma:
                node = node.with_changes(comma=cst.Comma())
            elements.append(node)
        if isinstance(self.node, cst.Call):
            return self.node.with_changes(args=elements, whitespace_before_args=opening)
        if isinstance(self.node, cst.List):
            return self.node.with_changes(
                elements=elements,
                lbracket=self.node.lbracket.with_changes(whitespace_after=opening),
                rbracket=self.node.rbracket.with_changes(whitespace_before=closing),
            )
        return self.node.with_changes(
            elements=elements,
            lbrace=self.node.lbrace.with_changes(whitespace_after=opening),
            rbrace=self.node.rbrace.with_changes(whitespace_before=closing),
        )

    def insert(self, index: int, node: cst.CSTNode) -> None:
        self.items.insert(index, _Item(node, (), None))

    def remove(self, index: int) -> _Item:
        item = self.items.pop(index)
        # The removed item's leading comments describe it, so they go with it.
        return item

    def move(self, src: int, dst: int) -> None:
        item = self.items.pop(src)
        self.items.insert(dst, item)


# ── Sections: the slide list as groups ─────────────────────────────────────────


class Infer:
    """``move_in_groups``' default section: the one the slides land among."""


INFER = Infer()


@dataclass
class Group:
    """One run of the slide list: the slides before the first section
    (``name`` None) or one ``Section``."""

    name: str | None
    slides: list[int | str] = field(default_factory=list)
    """Deck indices of existing slides, or the code of a new ``Slide(...)``."""
    origin: int | None = None
    """The existing section (its index) whose ``Section(...)`` call this keeps;
    ``None`` writes a new one."""

    def with_slides(self, slides: list[int | str]) -> Group:
        return Group(self.name, slides, self.origin)


def _count(groups: Sequence[Group]) -> int:
    return sum(len(g.slides) for g in groups)


def flatten(groups: Sequence[Group]) -> list[int | str]:
    """The slides of ``groups`` in deck order."""
    return [s for g in groups for s in g.slides]


def _copy(groups: Sequence[Group]) -> list[Group]:
    return [g.with_slides(list(g.slides)) for g in groups]


def _insert(groups: Sequence[Group], index: int, code: str) -> list[Group]:
    """``code`` as slide ``index``: after slide ``index - 1`` in its group, or
    first in the first slide's group."""
    out = _copy(groups)
    flat = flatten(out)
    if not flat:
        out[0].slides.append(code)
        return out
    anchor, after = (flat[index - 1], True) if index > 0 else (flat[0], False)
    for g in out:
        if anchor in g.slides:
            g.slides.insert(g.slides.index(anchor) + (1 if after else 0), code)
            break
    return out


def move_in_groups(
    groups: Sequence[Group],
    indices: Sequence[int],
    to: int,
    section: int | Infer | None = INFER,
) -> list[Group]:
    """Move the slides at ``indices`` (in deck order) so the first of them
    becomes slide ``to`` of the list without them, in ``section`` (an index
    into the sections; ``None`` = before the first section). By default they
    join the section of the slide they land before (past the end: the last
    one). With a section given, ``to`` is clamped into it."""
    n = _count(groups)
    moved = sorted(set(indices))
    if not moved:
        raise DeckEditError("no slides to move")
    for index in moved:
        _check_index(index, n)
    out = [g.with_slides([s for s in g.slides if s not in moved]) for g in groups]
    rest = flatten(out)
    to = max(0, min(to, len(rest)))
    if isinstance(section, Infer):
        if to < len(rest):
            follower = rest[to]
            target = next(g for g in out if follower in g.slides)
            offset = target.slides.index(follower)
        else:
            target = out[-1]
            offset = len(target.slides)
    else:
        k = 0 if section is None else section + 1
        if not 0 <= k < len(out):
            raise DeckEditError(f"no section {section}")
        target = out[k]
        start = sum(len(g.slides) for g in out[:k])
        offset = max(0, min(to - start, len(target.slides)))
    target.slides[offset:offset] = list(moved)
    return out


def add_section(groups: Sequence[Group], name: str, at: int | None) -> list[Group]:
    """A new section ``name`` starting at slide ``at``: it takes that slide
    and the rest of its section (or of the unsectioned slides). ``None``: a
    new empty section at the end."""
    out = _copy(groups)
    if at is None:
        out.append(Group(name))
        return out
    _check_index(at, _count(out))
    for k, g in enumerate(out):
        if at in g.slides:
            pos = g.slides.index(at)
            out.insert(k + 1, Group(name, g.slides[pos:]))
            g.slides[pos:] = []
            break
    return out


def remove_section(
    groups: Sequence[Group], section: int, with_slides: bool = False
) -> list[Group]:
    """Remove section ``section``; its slides join the section before it (or
    none), or, ``with_slides``, are removed too."""
    out = _copy(groups)
    k = section + 1
    if not 1 <= k < len(out):
        raise DeckEditError(f"no section {section}")
    gone = out.pop(k)
    if not with_slides:
        out[k - 1].slides.extend(gone.slides)
    return out


def move_section(groups: Sequence[Group], section: int, to: int) -> list[Group]:
    """Move section ``section`` (with its slides) to position ``to`` among the
    sections. The slides before the first section stay first."""
    out = _copy(groups)
    sections = out[1:]
    _check_index(section, len(sections))
    _check_index(to, len(sections))
    sections.insert(to, sections.pop(section))
    return [out[0], *sections]


def _shift(text: str, delta: int) -> str:
    if delta >= 0:
        return " " * delta + text
    strip = min(-delta, len(text) - len(text.lstrip(" ")))
    return text[strip:]


class _Reindent(cst.CSTTransformer):
    """Shift every continuation line of a moved node by ``delta`` columns, so
    a slide moved into (or out of) a section lines up with its neighbours."""

    def __init__(self, delta: int) -> None:
        super().__init__()
        self.delta: int = delta

    @override
    def leave_ParenthesizedWhitespace(
        self,
        original_node: cst.ParenthesizedWhitespace,
        updated_node: cst.ParenthesizedWhitespace,
    ) -> cst.ParenthesizedWhitespace:
        return updated_node.with_changes(
            last_line=cst.SimpleWhitespace(
                _shift(updated_node.last_line.value, self.delta)
            )
        )

    @override
    def leave_EmptyLine(
        self, original_node: cst.EmptyLine, updated_node: cst.EmptyLine
    ) -> cst.EmptyLine:
        if updated_node.comment is None:
            return updated_node
        return updated_node.with_changes(
            whitespace=cst.SimpleWhitespace(
                _shift(updated_node.whitespace.value, self.delta)
            )
        )


def _reindent(item: _Item, delta: int) -> _Item:
    if delta == 0:
        return item
    shift = _Reindent(delta)
    return _Item(
        cast("cst.CSTNode", item.node.visit(shift)),
        [cast("cst.EmptyLine", line.visit(shift)) for line in item.leading],
        item.trailing,
    )


def _column(seq: _Seq) -> int | None:
    """The column a multi-line list's items start at (relative to the
    statement's indentation); ``None`` for a list written on one line."""
    if seq.template is None:
        return None
    return len(seq.template.last_line.value)


def _name_arg(call: cst.Call) -> cst.Arg | None:
    if call.args and call.args[0].keyword is None:
        return call.args[0]
    return _kwarg(call, "name")


def _slides_arg(call: cst.Call) -> cst.Arg | None:
    positional = [a for a in call.args if a.keyword is None]
    if len(positional) >= 2:
        return positional[1]
    return _kwarg(call, "slides")


@dataclass
class _SectionNode:
    item: _Item
    """Its entry in the outer list."""
    call: cst.Call
    name: str | None
    """As written; ``None`` when it is not a plain string."""
    slides: _Seq | None
    """Its ``slides=[...]``; ``None`` when it has none (an empty section)."""


@dataclass
class _Layout:
    """The ``Deck(slides=[...])`` literal: leading slides, then sections."""

    outer: _Seq
    prefix: list[_Item]
    sections: list[_SectionNode]

    @classmethod
    def read(cls, slides: cst.List) -> _Layout | None:
        outer = _Seq(slides)
        prefix: list[_Item] = []
        sections: list[_SectionNode] = []
        for item in outer.items:
            el = item.node
            if not isinstance(el, cst.Element):
                return None
            callee = _callee(el.value)
            if callee == "Slide" and not sections:
                prefix.append(item)
            elif callee == "Section":
                node = cls._section(item, cast("cst.Call", el.value))
                if node is None:
                    return None
                sections.append(node)
            else:
                return None
        return cls(outer, prefix, sections)

    @staticmethod
    def _section(item: _Item, call: cst.Call) -> _SectionNode | None:
        name_arg = _name_arg(call)
        name = None
        if name_arg is not None and isinstance(name_arg.value, cst.SimpleString):
            value = name_arg.value.evaluated_value
            name = value if isinstance(value, str) else None
        arg = _slides_arg(call)
        if arg is None:
            return _SectionNode(item, call, name, None)
        if not isinstance(arg.value, cst.List):
            return None
        seq = _Seq(arg.value)
        for el in seq.items:
            node = el.node
            if not isinstance(node, cst.Element) or _callee(node.value) != "Slide":
                return None
        return _SectionNode(item, call, name, seq)

    def _slide_items(self) -> list[tuple[_Item, int | None]]:
        """Every slide's item with the column of the list holding it."""
        out = [(item, _column(self.outer)) for item in self.prefix]
        for section in self.sections:
            if section.slides is not None:
                col = _column(section.slides)
                out.extend((item, col) for item in section.slides.items)
        return out

    def calls(self) -> list[cst.Call]:
        return [
            cast("cst.Call", cast("cst.Element", item.node).value)
            for item, _ in self._slide_items()
        ]

    def groups(self) -> list[Group]:
        out = [Group(None, list(range(len(self.prefix))))]
        index = len(self.prefix)
        for k, section in enumerate(self.sections):
            count = len(section.slides.items) if section.slides is not None else 0
            out.append(Group(section.name, list(range(index, index + count)), k))
            index += count
        return out

    def _unit(self) -> int:
        """The deck's indentation step, read off the outer list."""
        col = _column(self.outer)
        closing = self.outer.gaps[-1]
        if col is not None and isinstance(closing, cst.ParenthesizedWhitespace):
            step = col - len(closing.last_line.value)
            if step > 0:
                return step
        return 4

    def build(self, groups: Sequence[Group]) -> cst.List:
        if not groups or groups[0].name is not None or groups[0].origin is not None:
            raise DeckEditError("the slide list starts with its unsectioned slides")
        slides = self._slide_items()
        current = self.groups()
        seen: set[int] = set()
        for g in groups:
            for s in g.slides:
                if isinstance(s, int):
                    _check_index(s, len(slides))
                    if s in seen:
                        raise DeckEditError(f"slide {s} placed twice")
                    seen.add(s)

        def items(refs: list[int | str], col: int | None) -> list[_Item]:
            out: list[_Item] = []
            for ref in refs:
                if isinstance(ref, str):
                    out.append(_Item(cst.Element(cst.parse_expression(ref)), (), None))
                    continue
                item, src = slides[ref]
                delta = col - src if col is not None and src is not None else 0
                out.append(_reindent(item, delta))
            return out

        outer_col = _column(self.outer)
        unit = self._unit()
        new_items = items(groups[0].slides, outer_col)
        used: set[int] = set()
        for g in groups[1:]:
            if g.origin is None:
                if not g.name:
                    raise DeckEditError("a new section needs a name")
                call = _new_section(g.name, outer_col, unit)
                section_item = _Item(cst.Element(call), (), None)
            else:
                _check_index(g.origin, len(self.sections))
                if g.origin in used:
                    raise DeckEditError(f"section {g.origin} placed twice")
                used.add(g.origin)
                node = self.sections[g.origin]
                if g.slides == current[g.origin + 1].slides and g.name in (
                    None,
                    node.name,
                ):
                    new_items.append(node.item)  # untouched
                    continue
                call = node.call
                if g.name is not None and g.name != node.name:
                    call = _rename(call, g.name)
                section_item = node.item
            call = _fill_section(call, g.slides, items, outer_col, unit)
            new_items.append(
                _Item(
                    cast("cst.Element", section_item.node).with_changes(value=call),
                    section_item.leading,
                    section_item.trailing,
                )
            )
        outer = _Seq(self.outer.node)
        outer.items = new_items
        return cast("cst.List", outer.build())


def _rename(call: cst.Call, name: str) -> cst.Call:
    arg = _name_arg(call)
    if arg is None:
        raise DeckEditError("this section's name is not written in Section(...)")
    new = cst.SimpleString(_py_str(name))
    return call.with_changes(
        args=[a.with_changes(value=new) if a is arg else a for a in call.args]
    )


def _new_section(name: str, col: int | None, unit: int) -> cst.Call:
    """``Section(name, slides=[])`` laid out as the formatter would at column
    ``col`` (on one line when the slide list is on one line)."""
    if col is None:
        code = f"Section({_py_str(name)}, slides=[])"
        return cast("cst.Call", cst.parse_expression(code))
    inner, outer = " " * (col + unit), " " * col
    code = (
        "Section(\n"
        + f"{inner}{_py_str(name)},\n"
        + f"{inner}slides=[],\n"
        + f"{outer})"
    )
    return cast("cst.Call", cst.parse_expression(code))


def _fill_section(
    call: cst.Call,
    refs: list[int | str],
    items: Callable[[list[int | str], int | None], list[_Item]],
    outer_col: int | None,
    unit: int,
) -> cst.Call:
    """``call`` with its slides list holding ``refs``."""
    arg = _slides_arg(call)
    if arg is None:
        if not refs:
            return call
        call = _set_arg(call, "slides", "[]")
        arg = _slides_arg(call)
        assert arg is not None
    lst = cast("cst.List", arg.value)
    seq = _Seq(lst)
    col = _column(seq)
    if col is None and outer_col is not None and refs:
        # A list on one line that changes gets its slides one per line, like
        # the rest of the deck (and room for their comments).
        multiline = isinstance(call.whitespace_before_args, cst.ParenthesizedWhitespace)
        base = outer_col + (unit if multiline else 0)
        seq = _Seq(_open_list(lst, base + unit, base))
        col = base + unit
    seq.items = items(refs, col)
    built = seq.build()
    return call.with_changes(
        args=[a.with_changes(value=built) if a is arg else a for a in call.args]
    )


def _open_list(lst: cst.List, col: int, close: int) -> cst.List:
    """``lst`` laid out one item per line at ``col``, with ``]`` at ``close``
    (holding a placeholder the caller replaces)."""

    def line(width: int) -> cst.ParenthesizedWhitespace:
        return cst.ParenthesizedWhitespace(
            first_line=cst.TrailingWhitespace(),
            empty_lines=[],
            indent=True,
            last_line=cst.SimpleWhitespace(" " * width),
        )

    return lst.with_changes(
        elements=[cst.Element(cst.Name("None"), comma=cst.Comma())],
        lbracket=cst.LeftSquareBracket(whitespace_after=line(col)),
        rbracket=cst.RightSquareBracket(whitespace_before=line(close)),
    )


# ── Locating things in deck.py ──────────────────────────────────────────────────


class DeckEditError(Exception):
    """An edit that cannot be applied to this ``deck.py`` as written."""


def _callee(node: cst.BaseExpression) -> str | None:
    if isinstance(node, cst.Call):
        func = node.func
        if isinstance(func, cst.Name):
            return func.value
        if isinstance(func, cst.Attribute):
            return func.attr.value
    return None


def _kwarg(call: cst.Call, name: str) -> cst.Arg | None:
    for arg in call.args:
        if arg.keyword is not None and arg.keyword.value == name:
            return arg
    return None


class _Finder(cst.CSTVisitor):
    def __init__(self) -> None:
        super().__init__()
        self.deck_calls: list[cst.Call] = []
        self.assignments: dict[str, list[cst.BaseExpression]] = {}
        self.imports: list[cst.ImportFrom] = []
        self.last_import: cst.CSTNode | None = None

    @override
    def visit_Call(self, node: cst.Call) -> None:
        if _callee(node) == "Deck" and _kwarg(node, "slides") is not None:
            self.deck_calls.append(node)

    @override
    def visit_Assign(self, node: cst.Assign) -> None:
        for target in node.targets:
            if isinstance(target.target, cst.Name):
                self.assignments.setdefault(target.target.value, []).append(node.value)

    @override
    def visit_AnnAssign(self, node: cst.AnnAssign) -> None:
        if isinstance(node.target, cst.Name) and node.value is not None:
            self.assignments.setdefault(node.target.value, []).append(node.value)

    @override
    def visit_ImportFrom(self, node: cst.ImportFrom) -> None:
        module = node.module
        if isinstance(module, cst.Name) and module.value == "inkflow":
            self.imports.append(node)


class DeckSource:
    """One ``deck.py``, parsed once per edit; ``code`` is the edited text."""

    module: cst.Module

    def __init__(self, code: str) -> None:
        self.module = cst.parse_module(code)

    @classmethod
    def read(cls, path: Path) -> DeckSource:
        return cls(path.read_text(encoding="utf-8"))

    @property
    def code(self) -> str:
        return self.module.code

    def _find(self) -> _Finder:
        finder = _Finder()
        self.module.visit(finder)
        return finder

    def slides_list(self) -> cst.List | None:
        finder = self._find()
        if len(finder.deck_calls) != 1:
            return None
        arg = _kwarg(finder.deck_calls[0], "slides")
        value = arg.value if arg is not None else None
        if isinstance(value, cst.Name):
            bound = finder.assignments.get(value.value, [])
            value = bound[0] if len(bound) == 1 else None
        return value if isinstance(value, cst.List) else None

    def _layout(self) -> _Layout | None:
        slides = self.slides_list()
        return _Layout.read(slides) if slides is not None else None

    def slide_calls(self, expected: int | None = None) -> list[cst.Call] | None:
        """The ``Slide(...)`` calls, in deck order (each ``Section``'s in its
        place), or ``None`` if the list is not a plain literal of them (or does
        not match ``expected`` slides)."""
        layout = self._layout()
        if layout is None:
            return None
        calls = layout.calls()
        if expected is not None and len(calls) != expected:
            return None
        return calls

    def groups(self) -> list[Group] | None:
        """The slide list as sections: ``[0]`` the slides before the first
        section (``name`` None), then one group per ``Section``, each slide
        by deck index. ``None`` when the list is not editable."""
        layout = self._layout()
        return layout.groups() if layout is not None else None

    def _require(self) -> tuple[cst.List, _Layout]:
        slides = self.slides_list()
        layout = _Layout.read(slides) if slides is not None else None
        if slides is None or layout is None:
            raise DeckEditError(
                "deck.py's slides are not a plain list of Slide(...) calls"
            )
        return slides, layout

    def _replace(self, old: cst.CSTNode, new: cst.CSTNode) -> None:
        self.module = cast("cst.Module", self.module.deep_replace(old, new))

    # ── Slide list ──

    def restructure(self, groups: Sequence[Group]) -> None:
        """Rewrite the slide list as ``groups`` (see ``groups``): existing
        slides keep their source and comments wherever they move, a section
        with an ``origin`` keeps its own ``Section(...)`` call, and a string
        in ``slides`` is the code of a new slide."""
        slides, layout = self._require()
        self._replace(slides, layout.build(groups))

    def _edit_groups(self) -> list[Group]:
        groups = self.groups()
        if groups is None:
            raise DeckEditError(
                "deck.py's slides are not a plain list of Slide(...) calls"
            )
        return groups

    def move_slide(self, src: int, dst: int) -> None:
        self.move_slides([src], dst)

    def move_slides(
        self, indices: Sequence[int], to: int, section: int | Infer | None = INFER
    ) -> None:
        """See ``move_in_groups``."""
        groups = self._edit_groups()
        self.restructure(move_in_groups(groups, indices, to, section))

    def remove_slide(self, index: int) -> None:
        groups = self._edit_groups()
        n = _count(groups)
        _check_index(index, n)
        if n == 1:
            raise DeckEditError("a deck needs at least one slide")
        self.restructure(
            [g.with_slides([s for s in g.slides if s != index]) for g in groups]
        )

    def insert_slide(self, index: int, code: str) -> None:
        """Insert a new slide so it becomes slide ``index``, in the section of
        the slide before it (the first slide's section at index 0)."""
        groups = self._edit_groups()
        n = _count(groups)
        if not 0 <= index <= n:
            raise DeckEditError(f"slide index {index} out of range")
        self.restructure(_insert(groups, index, code))

    def replace_slide(self, index: int, code: str) -> None:
        """Put a new ``Slide(...)`` in slide ``index``'s place (its section,
        its comments)."""
        groups = self._edit_groups()
        _check_index(index, _count(groups))
        self.restructure(
            [
                g.with_slides([code if s == index else s for s in g.slides])
                for g in groups
            ]
        )

    def duplicate_slide(self, index: int, kwargs: dict[str, str | None]) -> None:
        """Insert a copy of slide ``index`` after it, with ``kwargs`` overridden
        (values are source code; ``None`` removes the argument)."""
        _, layout = self._require()
        calls = layout.calls()
        _check_index(index, len(calls))
        copy = calls[index]
        for name, code in kwargs.items():
            copy = _set_arg(copy, name, code)
        groups = self._edit_groups()
        self.restructure(_insert(groups, index + 1, self.module.code_for_node(copy)))

    # ── Sections ──

    def section_names(self) -> list[str | None]:
        """Each section's name as written (``None``: not a plain string)."""
        _, layout = self._require()
        return [s.name for s in layout.sections]

    def rename_section(self, section: int, name: str) -> None:
        _, layout = self._require()
        _check_index(section, len(layout.sections))
        call = layout.sections[section].call
        arg = _name_arg(call)
        if arg is None:
            raise DeckEditError("this section's name is not written in Section(...)")
        self._replace(arg.value, cst.SimpleString(_py_str(name)))

    # ── The Deck(...) call's own arguments ──

    def set_deck_arg(self, name: str, code: str | None) -> None:
        """Set (``code``) or remove (``None``) one keyword of ``Deck(...)``."""
        finder = self._find()
        if len(finder.deck_calls) != 1:
            raise DeckEditError("deck.py has no single Deck(slides=...) call")
        call = finder.deck_calls[0]
        self._replace(call, _set_arg(call, name, code))

    # ── One slide's arguments ──

    def slide_call(self, index: int) -> cst.Call:
        _, layout = self._require()
        calls = layout.calls()
        _check_index(index, len(calls))
        return calls[index]

    def set_slide_arg(self, index: int, name: str, code: str | None) -> None:
        """Set (``code``) or remove (``None``) one argument of ``Slide`` ``index``.

        ``src`` is the first positional argument; everything else is a keyword.
        """
        call = self.slide_call(index)
        self._replace(call, _set_arg(call, name, code))

    # ── animations=[...] ──

    def _animations(self, index: int) -> tuple[cst.Call, cst.List | None]:
        call = self.slide_call(index)
        arg = _kwarg(call, "animations")
        if arg is None:
            return call, None
        if not isinstance(arg.value, cst.List):
            raise DeckEditError("this slide's animations are not a literal list")
        return call, arg.value

    def animation_count(self, index: int) -> int | None:
        try:
            _, anims = self._animations(index)
        except DeckEditError:
            return None
        return 0 if anims is None else len(anims.elements)

    def edit_animations(
        self,
        index: int,
        *,
        insert: tuple[int, str] | None = None,
        replace: tuple[int, str] | None = None,
        remove: int | None = None,
        move: tuple[int, int] | None = None,
    ) -> None:
        call, anims = self._animations(index)
        if anims is None:
            if insert is None:
                raise DeckEditError("this slide has no animations")
            new_call = _set_arg(call, "animations", f"[{insert[1]}]")
            self._replace(call, new_call)
            return
        seq = _Seq(anims)
        n = len(seq.items)
        if insert is not None:
            if not 0 <= insert[0] <= n:
                raise DeckEditError("animation index out of range")
            seq.insert(insert[0], cst.Element(cst.parse_expression(insert[1])))
        if replace is not None:
            _check_index(replace[0], n)
            item = seq.items[replace[0]]
            item.node = cast("cst.Element", item.node).with_changes(
                value=cst.parse_expression(replace[1])
            )
        if remove is not None:
            _check_index(remove, n)
            seq.remove(remove)
        if move is not None:
            _check_index(move[0], n)
            _check_index(move[1], n)
            seq.move(*move)
        if not seq.items:
            self._replace(call, _set_arg(call, "animations", None))
            return
        self._replace(anims, seq.build())

    # ── zones={...} ──

    def set_zone(self, index: int, zone: str, code: str | None) -> None:
        call = self.slide_call(index)
        arg = _kwarg(call, "zones")
        if arg is None:
            if code is None:
                return
            self._replace(call, _set_arg(call, "zones", f"{{{_py_str(zone)}: {code}}}"))
            return
        if not isinstance(arg.value, cst.Dict):
            raise DeckEditError("this slide's zones are not a literal dict")
        zones = arg.value
        seq = _Seq(zones)
        for i, item in enumerate(seq.items):
            el = item.node
            if (
                isinstance(el, cst.DictElement)
                and isinstance(el.key, cst.SimpleString)
                and el.key.evaluated_value == zone
            ):
                if code is None:
                    seq.remove(i)
                else:
                    item.node = el.with_changes(value=cst.parse_expression(code))
                break
        else:
            if code is None:
                return
            seq.insert(
                len(seq.items),
                cst.DictElement(
                    cst.SimpleString(_py_str(zone)), cst.parse_expression(code)
                ),
            )
        if not seq.items:
            self._replace(call, _set_arg(call, "zones", None))
            return
        self._replace(zones, seq.build())

    # ── Imports ──

    def ensure_imports(self, names: set[str]) -> None:
        """Make each name importable from ``inkflow`` at module level."""
        finder = self._find()
        have: set[str] = set()
        for imp in finder.imports:
            if isinstance(imp.names, cst.ImportStar):
                return
            for alias in imp.names:
                bound = alias.asname.name if alias.asname else alias.name
                if isinstance(bound, cst.Name):
                    have.add(bound.value)
        missing = sorted(names - have - self._local_names())
        if not missing:
            return
        if finder.imports:
            imp = finder.imports[0]
            assert not isinstance(imp.names, cst.ImportStar)
            seq = _ImportSeq(imp)
            for name in missing:
                seq.add(name)
            self._replace(imp, seq.build())
            return
        stmt = cst.parse_statement(f"from inkflow import {', '.join(missing)}\n")
        body = list(self.module.body)
        insert_at = 0
        for i, node in enumerate(body):
            if _is_import(node) or _is_docstring(node, i):
                insert_at = i + 1
        body.insert(insert_at, stmt)
        self.module = self.module.with_changes(body=body)

    def _local_names(self) -> set[str]:
        """Classes defined in deck.py itself (custom animations/transitions)."""
        return {
            node.name.value
            for node in self.module.body
            if isinstance(node, cst.ClassDef)
        }


class _ImportSeq:
    """Adds names to a ``from inkflow import (...)``, keeping it sorted-ish."""

    imp: cst.ImportFrom
    names: list[cst.ImportAlias]

    def __init__(self, imp: cst.ImportFrom) -> None:
        self.imp = imp
        self.names = list(cast("Sequence[cst.ImportAlias]", imp.names))

    def add(self, name: str) -> None:
        alias = cst.ImportAlias(name=cst.Name(name))
        # Insert in case-sensitive sorted position, as isort/ruff would.
        keys = [_alias_key(a) for a in self.names]
        pos = next((i for i, k in enumerate(keys) if k > _sort_key(name)), len(keys))
        self.names.insert(pos, alias)

    def build(self) -> cst.ImportFrom:
        multiline = self.imp.lpar is not None and any(
            isinstance(a.comma, cst.Comma)
            and isinstance(a.comma.whitespace_after, cst.ParenthesizedWhitespace)
            for a in cast("Sequence[cst.ImportAlias]", self.imp.names)
        )
        template = None
        if multiline:
            for a in cast("Sequence[cst.ImportAlias]", self.imp.names):
                if isinstance(a.comma, cst.Comma) and isinstance(
                    a.comma.whitespace_after, cst.ParenthesizedWhitespace
                ):
                    template = a.comma.whitespace_after
                    break
        original = cast("Sequence[cst.ImportAlias]", self.imp.names)
        last_comma = original[-1].comma if original else cst.MaybeSentinel.DEFAULT
        out: list[cst.ImportAlias] = []
        for i, alias in enumerate(self.names):
            if i < len(self.names) - 1:
                ws = template if template is not None else cst.SimpleWhitespace(" ")
                out.append(alias.with_changes(comma=cst.Comma(whitespace_after=ws)))
            elif isinstance(last_comma, cst.Comma):
                # The original last comma carries the newline before ")".
                out.append(alias.with_changes(comma=last_comma))
            else:
                out.append(alias.with_changes(comma=cst.MaybeSentinel.DEFAULT))
        return self.imp.with_changes(names=out)


def _sort_key(name: str) -> tuple[int, str]:
    # ruff/isort order: CONSTANTS, Classes, functions/modules.
    if name.isupper():
        return (0, name)
    if name[:1].isupper():
        return (1, name)
    return (2, name)


def _alias_key(alias: cst.ImportAlias) -> tuple[int, str]:
    name = alias.name
    return _sort_key(name.value if isinstance(name, cst.Name) else "")


def _is_import(node: cst.CSTNode) -> bool:
    return isinstance(node, cst.SimpleStatementLine) and any(
        isinstance(s, cst.Import | cst.ImportFrom) for s in node.body
    )


def _is_docstring(node: cst.CSTNode, index: int) -> bool:
    return (
        index == 0
        and isinstance(node, cst.SimpleStatementLine)
        and len(node.body) == 1
        and isinstance(node.body[0], cst.Expr)
        and isinstance(node.body[0].value, cst.SimpleString)
    )


def _check_index(index: int, n: int) -> None:
    if not 0 <= index < n:
        raise DeckEditError(f"index {index} out of range")


def _py_str(value: str) -> str:
    import json

    return json.dumps(value, ensure_ascii=False)


def _src_arg(call: cst.Call) -> cst.Arg | None:
    if call.args and call.args[0].keyword is None:
        return call.args[0]
    return _kwarg(call, "src")


def _set_arg(call: cst.Call, name: str, code: str | None) -> cst.Call:
    if name == "src":
        arg = _src_arg(call)
        if arg is None or code is None:
            raise DeckEditError("a slide's src cannot be removed")
        new_args = [
            a.with_changes(value=cst.parse_expression(code)) if a is arg else a
            for a in call.args
        ]
        return call.with_changes(args=new_args)
    seq = _Seq(call)
    for i, item in enumerate(seq.items):
        arg = cast("cst.Arg", item.node)
        if arg.keyword is not None and arg.keyword.value == name:
            if code is None:
                seq.remove(i)
            else:
                item.node = arg.with_changes(value=cst.parse_expression(code))
            return cast("cst.Call", seq.build())
    if code is None:
        return call
    seq.insert(
        len(seq.items),
        cst.Arg(
            value=cst.parse_expression(code),
            keyword=cst.Name(name),
            equal=cst.AssignEqual(
                whitespace_before=cst.SimpleWhitespace(""),
                whitespace_after=cst.SimpleWhitespace(""),
            ),
        ),
    )
    return cast("cst.Call", seq.build())
