"""How each evaluated slide maps back to the ``slides=[...]`` list in ``deck.py``.

Evaluating the deck says what it is; this module reads the source to say where each
slide was written and how much of it the tools may change. The match is exact, not
positional: `provenance` records the span of every ``Slide(...)`` call, and Python's
``ast`` reports node spans in the same units (1-based lines, UTF-8 byte columns), so
a literal slide is found by comparing spans. Everything between two literals is
attributed by counting, since a plain list element always yields exactly one slide
and only a ``*spread`` element yields a variable number.
"""

from __future__ import annotations

import ast
from collections.abc import Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path

from inkflow.manifest import Deck, Slide
from inkflow.provenance import SourceLocation, source_location

__all__ = ["Editability", "SlideSource", "locate_slides"]

_SNIPPET_LENGTH = 40


class Editability(StrEnum):
    """How much of a slide the tools may change in ``deck.py``."""

    LITERAL = "literal"
    """A ``Slide(...)`` written directly in the list: its fields can be edited and it
    can be moved or removed."""
    OPAQUE = "opaque"
    """One list element inkflow cannot see inside (a helper call, a variable): it can
    be moved or removed as a unit, but its fields are the author's."""
    BLOCK = "block"
    """One of the slides a single ``*spread`` element produces: only the whole block
    can be moved or removed."""
    NONE = "none"
    """The slide list itself is computed, or cannot be matched to the source."""


@dataclass(frozen=True)
class SlideSource:
    """Where one evaluated slide comes from in ``deck.py``, and what that allows."""

    editability: Editability
    element: SourceLocation | None
    """The span of the list element the slide belongs to: the ``Slide(...)`` call
    itself for a literal, else the helper call, variable or ``*spread`` element."""
    reason: str | None
    """Why the slide is not fully editable; ``None`` for a literal."""


def locate_slides(deck: Deck, deck_path: Path) -> list[SlideSource]:
    """One `SlideSource` per entry of ``deck.slides``, in order."""
    count = len(deck.slides)

    def uniform(reason: str) -> list[SlideSource]:
        return [SlideSource(Editability.NONE, None, reason)] * count

    deck_path = deck_path.resolve()
    deck_location = source_location(deck)
    if deck_location is None or deck_location.path.resolve() != deck_path:
        return uniform(f"the Deck(...) is not constructed in {deck_path.name}")
    if deck_location.column is None:
        return uniform("Python is running without column information")

    source = deck_path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source, filename=str(deck_path))
    except SyntaxError:
        return uniform(f"{deck_path.name} no longer parses")

    deck_call = _call_at(tree, replace(deck_location, path=deck_path))
    if deck_call is None:
        return uniform(f"{deck_path.name} changed since the deck was loaded")
    slides_argument = _slides_argument(deck_call)
    if slides_argument is None:
        return uniform("the Deck(...) call has no slides argument")
    list_node = _resolve_list(slides_argument, tree)
    if list_node is None:
        snippet = _snippet(source, slides_argument)
        return uniform(
            f"slides= is computed (`{snippet}` at line {slides_argument.lineno})"
        )

    matched = _match_elements(list_node.elts, deck.slides, deck_path, source)
    if matched is None:
        return uniform(
            f"the slides list in {deck_path.name} does not match the evaluated deck "
            + "(changed since loading, or modified after construction)"
        )
    return matched


def _location_of(node: ast.expr, path: Path) -> SourceLocation:
    return SourceLocation(
        path=path,
        line=node.lineno,
        column=node.col_offset,
        end_line=node.end_lineno,
        end_column=node.end_col_offset,
    )


def _call_at(tree: ast.Module, location: SourceLocation) -> ast.Call | None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _location_of(node, location.path) == location:
            return node
    return None


def _slides_argument(deck_call: ast.Call) -> ast.expr | None:
    for keyword in deck_call.keywords:
        if keyword.arg == "slides":
            return keyword.value
    return deck_call.args[0] if deck_call.args else None


def _resolve_list(node: ast.expr, tree: ast.Module) -> ast.List | None:
    """The list literal ``node`` is, or the one a name bound exactly once refers to."""
    if isinstance(node, ast.List):
        return node
    if not isinstance(node, ast.Name):
        return None
    bound: list[ast.expr | None] = []
    for candidate in ast.walk(tree):
        if isinstance(candidate, ast.Assign):
            if any(_binds(target, node.id) for target in candidate.targets):
                bound.append(candidate.value)
        elif isinstance(candidate, ast.AnnAssign | ast.AugAssign) and _binds(
            candidate.target, node.id
        ):
            bound.append(candidate.value)
    if len(bound) == 1 and isinstance(bound[0], ast.List):
        return bound[0]
    return None


def _binds(target: ast.expr, name: str) -> bool:
    return isinstance(target, ast.Name) and target.id == name


def _is_slide_call(node: ast.expr) -> bool:
    if not isinstance(node, ast.Call):
        return False
    callee = node.func
    if isinstance(callee, ast.Name):
        return callee.id == "Slide"
    return isinstance(callee, ast.Attribute) and callee.attr == "Slide"


def _snippet(source: str, node: ast.expr) -> str:
    text = " ".join((ast.get_source_segment(source, node) or "").split())
    if len(text) > _SNIPPET_LENGTH:
        return text[: _SNIPPET_LENGTH - 1] + "…"
    return text


def _match_elements(
    elements: Sequence[ast.expr],
    slides: Sequence[Slide],
    deck_path: Path,
    source: str,
) -> list[SlideSource] | None:
    """Attribute every slide to a list element, or ``None`` if they cannot agree.

    Literal ``Slide(...)`` elements are anchors, found by exact location. Between two
    anchors, each plain element yields one slide and a single ``*spread`` takes the
    rest; two spreads with no anchor between them cannot be told apart.
    """
    slide_locations = [_location_in(slide, deck_path) for slide in slides]
    result: list[SlideSource] = []
    slide_index = 0
    segment: list[ast.expr] = []

    def close_segment(end: int) -> bool:
        nonlocal slide_index
        attributed = _attribute_segment(segment, end - slide_index, deck_path, source)
        if attributed is None:
            return False
        result.extend(attributed)
        slide_index = end
        segment.clear()
        return True

    for element in elements:
        if not _is_slide_call(element):
            segment.append(element)
            continue
        element_location = _location_of(element, deck_path)
        try:
            anchor = slide_locations.index(element_location, slide_index)
        except ValueError:
            return None
        if not close_segment(anchor):
            return None
        result.append(SlideSource(Editability.LITERAL, element_location, None))
        slide_index += 1
    if not close_segment(len(slides)):
        return None
    return result


def _location_in(slide: Slide, deck_path: Path) -> SourceLocation | None:
    """The slide's location with its path resolved, or ``None`` outside deck.py."""
    location = source_location(slide)
    if location is None or location.path.resolve() != deck_path:
        return None
    return replace(location, path=deck_path)


def _attribute_segment(
    segment: Sequence[ast.expr], slide_count: int, deck_path: Path, source: str
) -> list[SlideSource] | None:
    spreads = [element for element in segment if isinstance(element, ast.Starred)]
    plain_count = len(segment) - len(spreads)
    spread_size = slide_count - plain_count
    if spread_size < 0 or (not spreads and spread_size != 0):
        return None
    if len(spreads) > 1:
        reason = "several *spread elements in a row; their boundary is ambiguous"
        return [SlideSource(Editability.NONE, None, reason)] * slide_count

    result: list[SlideSource] = []
    for element in segment:
        location = _location_of(element, deck_path)
        snippet = _snippet(source, element)
        if isinstance(element, ast.Starred):
            reason = (
                f"one of {spread_size} slides from `{snippet}` at line {element.lineno}"
            )
            result += [SlideSource(Editability.BLOCK, location, reason)] * spread_size
        else:
            reason = f"written as `{snippet}` at line {element.lineno}"
            result.append(SlideSource(Editability.OPAQUE, location, reason))
    return result
