"""Where each deck object was constructed.

Evaluating ``deck.py`` says *what* the deck is; editing it needs to know *where* a
given slide or cue was written. `SourceTracked` records the call site of every
instance, so an evaluated object maps back to the exact ``Slide(...)`` expression
that produced it — and several objects sharing one call site reveal a loop or
helper rather than a literal.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Self

__all__ = ["SourceLocation", "SourceTracked", "source_location"]

# Namespaced: user subclasses of Animation/Transition add their own fields, and this
# attribute must never collide with one of them.
_ATTRIBUTE = "_inkflow_source_location"


@dataclass(frozen=True)
class SourceLocation:
    """The span of the constructor call that created an object."""

    path: Path
    line: int
    """1-based line of the call's start."""
    column: int | None
    """0-based UTF-8 byte offset of the call's start, as Python's own ``ast`` counts.
    ``None`` when the interpreter runs without column info (``-X no_debug_ranges``)."""
    end_line: int | None
    end_column: int | None
    """0-based UTF-8 byte offset just past the call's closing parenthesis."""

    @classmethod
    def of_frame(cls, frame: FrameType) -> SourceLocation:
        code = frame.f_code
        # One position entry per 2-byte code unit; f_lasti is the byte offset of the
        # instruction executing the call.
        positions = list(code.co_positions())
        index = frame.f_lasti // 2
        start_line, end_line, column, end_column = (
            positions[index] if 0 <= index < len(positions) else (None,) * 4
        )
        return cls(
            path=Path(code.co_filename),
            line=start_line if start_line is not None else frame.f_lineno,
            column=column,
            end_line=end_line,
            end_column=end_column,
        )

    def describe(self, relative_to: Path | None = None) -> str:
        """``deck.py:57``, relative to ``relative_to`` when the file lies inside it."""
        path = self.path
        if relative_to is not None and path.is_relative_to(relative_to):
            path = path.relative_to(relative_to)
        return f"{path.as_posix()}:{self.line}"


class SourceTracked:
    """Mixin recording the call site of every instance of a DSL type.

    Hooked into ``__new__`` because dataclasses generate ``__init__`` per class and
    user subclasses may define ``__post_init__`` without calling ``super()``. The
    location is a plain instance attribute, not a dataclass field, so it stays out
    of ``__init__``, ``__eq__``, ``__repr__`` and ``dataclasses.fields()``. Copies
    and pickles carry it over through ``__dict__``.
    """

    def __new__(cls, *args: object, **kwargs: object) -> Self:
        del args, kwargs  # consumed by the dataclass __init__
        instance = super().__new__(cls)
        frame = inspect.currentframe()
        caller = frame.f_back if frame is not None else None
        if caller is not None:
            object.__setattr__(instance, _ATTRIBUTE, SourceLocation.of_frame(caller))
        del frame, caller  # break the frame reference cycle promptly
        return instance


def source_location(obj: object) -> SourceLocation | None:
    """Where ``obj`` was constructed, or ``None`` if that was not recorded."""
    location = getattr(obj, _ATTRIBUTE, None)
    return location if isinstance(location, SourceLocation) else None
