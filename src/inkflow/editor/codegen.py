"""Turn deck DSL values back into the Python source that would construct them.

The editor never writes a value into ``deck.py`` as raw text from the browser. It
builds the real object first (an ``Animation``, a ``Transition``, a ``TextBox``),
so the dataclass validates it, then emits the shortest call that reconstructs it:
fields equal to their default are left out, enums and value objects are spelled
the way an author would (``Direction.LEFT``, ``Trigger.WITH_PREVIOUS``,
``Easing.cubic_bezier(...)``). Every name the code needs is collected so the
caller can add it to the deck's ``from inkflow import (...)``.
"""

from __future__ import annotations

import dataclasses
import json
import re
import types
import typing
from collections.abc import Callable
from enum import Enum
from typing import cast

from inkflow import animations as animations_module
from inkflow import transitions as transitions_module
from inkflow.animations import Cue
from inkflow.enums import Easing, Trigger
from inkflow.manifest import Chart

_EASING_PRESETS = {
    "ease": "EASE",
    "ease-in": "EASE_IN",
    "ease-out": "EASE_OUT",
    "ease-in-out": "EASE_IN_OUT",
    "linear": "LINEAR",
    "step-start": "STEP_START",
    "step-end": "STEP_END",
}
_TRIGGER_PRESETS = {
    "on-click": "ON_CLICK",
    "with-previous": "WITH_PREVIOUS",
    "after-previous": "AFTER_PREVIOUS",
}
_UNION_TYPES: tuple[object, ...] = (types.UnionType, getattr(typing, "Union"))  # noqa: B009


def _fields(obj: object) -> tuple[dataclasses.Field[object], ...]:
    return cast(
        "tuple[dataclasses.Field[object], ...]",
        dataclasses.fields(obj),  # pyright: ignore[reportArgumentType]
    )


def _hints(cls: type) -> dict[str, object]:
    return cast("dict[str, object]", typing.get_type_hints(cls))


def _args(annotation: object) -> tuple[object, ...]:
    return cast("tuple[object, ...]", typing.get_args(annotation))


_BEZIER = re.compile(r"cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)")


class Code:
    """Source text plus the ``inkflow`` names it refers to."""

    def __init__(self) -> None:
        self.imports: set[str] = set()

    def literal(self, value: object) -> str:
        if isinstance(value, Trigger):
            self.imports.add("Trigger")
            preset = _TRIGGER_PRESETS.get(str(value))
            return f"Trigger.{preset}" if preset else f"Trigger.at({int(value)})"
        if isinstance(value, Easing):
            self.imports.add("Easing")
            preset = _EASING_PRESETS.get(str(value))
            if preset:
                return f"Easing.{preset}"
            match = _BEZIER.fullmatch(str(value).strip())
            if match:
                points = ", ".join(g.strip() for g in match.groups())
                return f"Easing.cubic_bezier({points})"
            return f"Easing.raw({_string(str(value))})"
        if isinstance(value, Enum):
            name = type(value).__name__
            self.imports.add(name)
            return f"{name}.{value.name}"
        if isinstance(value, bool) or value is None:
            return repr(value)
        if isinstance(value, int | float):
            return _number(value)
        if isinstance(value, str):
            return _string(value)
        if isinstance(value, list):
            items = cast("list[object]", value)
            return "[" + ", ".join(self.literal(v) for v in items) + "]"
        if isinstance(value, dict):
            entries = cast("dict[object, object]", value).items()
            body = ", ".join(
                f"{self.literal(k)}: {self.literal(v)}" for k, v in entries
            )
            return "{" + body + "}"
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return self.call(value)
        return repr(value)

    def type_name(self, cls: type) -> str:
        """How deck.py refers to a DSL class: a namespace member or a bare name."""
        if cls.__module__ == animations_module.__name__:
            self.imports.add("animations")
            return f"animations.{cls.__name__}"
        if cls.__module__ == transitions_module.__name__:
            self.imports.add("transitions")
            return f"transitions.{cls.__name__}"
        if cls.__module__.startswith("inkflow"):
            self.imports.add(cls.__name__)
        return cls.__name__

    def call(self, obj: object) -> str:
        """The shortest constructor call that rebuilds the dataclass ``obj``."""
        cls = type(obj)
        args: list[str] = []
        defaults = _defaults(cls)
        keyword = False  # once one argument is a keyword, the rest must be too
        for f in _fields(obj):
            if not f.init:
                continue
            value = cast("object", getattr(obj, f.name))
            positional = isinstance(obj, Cue) and f.name in ("element", "trigger")
            # A chart's file reads like a picture's: ``Chart("data/sales.csv")``.
            positional = positional or (isinstance(obj, Chart) and f.name == "src")
            if f.name == "element" and positional:
                args.append(self.literal(value))
                continue
            if f.name in defaults and _same(defaults[f.name], value):
                continue
            if f.name not in defaults and f.name != "trigger":
                # A required field reads best positional, as an author writes
                # it (``Video("clip.mp4")``), while nothing before it was a keyword.
                positional = not keyword
            if positional and not keyword:
                args.append(self.literal(value))
            else:
                keyword = True
                args.append(f"{f.name}={self.literal(value)}")
        return f"{self.type_name(cls)}({', '.join(args)})"


def _same(a: object, b: object) -> bool:
    if isinstance(a, float | int) and isinstance(b, float | int):
        return float(a) == float(b)
    return a == b


def _defaults(cls: type) -> dict[str, object]:
    out: dict[str, object] = {}
    for f in _fields(cls):
        if f.default is not dataclasses.MISSING:
            out[f.name] = f.default
        elif f.default_factory is not dataclasses.MISSING:
            out[f.name] = cast("Callable[[], object]", f.default_factory)()
    return out


def _number(value: float) -> str:
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return f"{value:.1f}"
    return repr(value)


def _string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


# ── Field schemas for the editor's property panels ─────────────────────────────


def _field_kind(annotation: object) -> tuple[str, list[str]]:
    """A coarse widget kind and, for enums, the choices."""
    origin = typing.get_origin(annotation)
    if origin in _UNION_TYPES:
        members = [a for a in _args(annotation) if a is not type(None)]
        if len(members) == 1:
            return _field_kind(members[0])
    if isinstance(annotation, type):
        if issubclass(annotation, Trigger):
            return "trigger", list(_TRIGGER_PRESETS)
        if issubclass(annotation, Easing):
            return "easing", list(_EASING_PRESETS)
        if issubclass(annotation, Enum):
            return "enum", [_enum_token(m) for m in annotation]
        if issubclass(annotation, bool):
            return "bool", []
        if issubclass(annotation, int):
            return "int", []
        if issubclass(annotation, float):
            return "float", []
        if issubclass(annotation, str):
            return "str", []
    return "other", []


def field_schema(cls: type) -> list[dict[str, object]]:
    """Editable fields of a DSL dataclass, with kinds, choices and defaults."""
    hints = _hints(cls)
    defaults = _defaults(cls)
    schema: list[dict[str, object]] = []
    for f in _fields(cls):
        if not f.init or f.name == "element":
            continue
        annotation = hints.get(f.name)
        kind, choices = _field_kind(annotation)
        default = defaults.get(f.name)
        union = typing.get_origin(annotation) in _UNION_TYPES
        optional = union and type(None) in _args(annotation)
        schema.append(
            {
                "name": f.name,
                "kind": kind,
                "choices": choices,
                "default": to_json(default),
                "optional": optional,
            }
        )
    return schema


def _enum_token(member: Enum) -> str:
    """How the browser names an enum member: its CSS token for the str enums,
    the lowercase member name for a plain ``Enum`` such as ``Muted``."""
    value = cast("object", member.value)
    return value if isinstance(value, str) else member.name.lower()


def to_json(value: object) -> object:
    """A JSON-safe view of a field value (enums and value objects as strings)."""
    if isinstance(value, Enum):
        return _enum_token(value)
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return str(value)


def coerce_fields(cls: type, raw: dict[str, object]) -> dict[str, object]:
    """Convert JSON field values from the browser to what ``cls`` expects.

    Unknown names are dropped and values that do not convert raise ``ValueError``,
    so a malformed request never reaches ``deck.py``.
    """
    hints = _hints(cls)
    names = {f.name for f in _fields(cls) if f.init}
    out: dict[str, object] = {}
    for name, value in raw.items():
        if name not in names:
            continue
        out[name] = _coerce(hints.get(name), value)
    return out


def _coerce(annotation: object, value: object) -> object:
    origin = typing.get_origin(annotation)
    if origin in _UNION_TYPES:
        if value is None:
            return None
        members = [a for a in _args(annotation) if a is not type(None)]
        if len(members) == 1:
            return _coerce(members[0], value)
        return value
    if not isinstance(annotation, type):
        return value
    if issubclass(annotation, Trigger):
        text = str(value)
        if text in _TRIGGER_PRESETS or text.lstrip("-").isdigit():
            return Trigger(text)
        raise ValueError(f"not a trigger: {value!r}")
    if issubclass(annotation, Easing):
        return Easing(str(value))
    if issubclass(annotation, Enum):
        for member in annotation:
            if _enum_token(member) == value:
                return member
        raise ValueError(f"not a {annotation.__name__}: {value!r}")
    if issubclass(annotation, bool):
        return bool(value)
    if issubclass(annotation, int):
        return int(cast("int", value))
    if issubclass(annotation, float):
        return float(cast("float", value))
    if issubclass(annotation, str):
        return str(value)
    return value
