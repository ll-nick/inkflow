"""The op registry: every op, its request type, and what it needs to run.

Each surface is generated from these entries, so the surfaces
cannot drift from the implementation or from each other.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Generic, Protocol, TypeAlias, TypeVar, cast

from inkflow.manifest import Deck
from inkflow.ops.changeset import ChangeSet
from inkflow.outline import API_VERSION
from inkflow.themes import Theme

__all__ = [
    "DeckUse",
    "FieldHelp",
    "Op",
    "OpContext",
    "OpGroup",
    "OpResult",
    "RegisteredOp",
    "described",
    "register",
    "register_group",
    "registered_ops",
]

if TYPE_CHECKING:
    from _typeshed import DataclassInstance

RequestT = TypeVar("RequestT", bound="DataclassInstance")

FIELD_HELP_KEY = "inkflow.ops.help"


@dataclass(frozen=True)
class FieldHelp:
    """Help text for a request field that surfaces as an option."""

    text: str
    metavar: str | None = None


def described(text: str, metavar: str | None = None) -> dict[str, FieldHelp]:
    """Field metadata: ``field(metadata=described(...))``."""
    return {FIELD_HELP_KEY: FieldHelp(text, metavar)}


class DeckUse(Enum):
    """Whether an op needs the project's deck."""

    REQUIRED = "required"
    OPTIONAL = "optional"
    """Runs without one too (theme authoring), with fewer parents resolvable."""


@dataclass(frozen=True)
class OpContext:
    """The project an op runs against; both None when it runs without a deck."""

    deck: Deck | None
    project_dir: Path | None

    @classmethod
    def from_deck_file(cls, deck_path: Path) -> OpContext:
        from inkflow.server import load_deck

        resolved = deck_path.resolve()
        return cls(load_deck(resolved), resolved.parent)

    @property
    def theme(self) -> Theme | None:
        return self.deck.theme if self.deck is not None else None

    def label(self, path: Path) -> str:
        """A path as shown to the user: relative to the project (or cwd) when inside."""
        base = self.project_dir or Path.cwd()
        resolved = path.resolve()
        if resolved.is_relative_to(base):
            return resolved.relative_to(base).as_posix()
        return resolved.as_posix()


OpFunction: TypeAlias = Callable[[RequestT, OpContext], ChangeSet]
"""An op's implementation: ``(request, context) -> ChangeSet``."""


@dataclass(frozen=True)
class EditOutline:
    path: str
    before_hash: str | None
    after_hash: str


@dataclass(frozen=True)
class OpResult:
    """What running an op did, as reported by ``--json``."""

    op: str
    applied: bool
    """False for a dry run, and when there was nothing to change."""
    summary: str
    edits: list[EditOutline]

    @classmethod
    def of(
        cls, op: str, changes: ChangeSet, context: OpContext, *, applied: bool
    ) -> OpResult:
        edits = [
            EditOutline(context.label(edit.path), edit.before_hash, edit.after_hash)
            for edit in changes.edits
        ]
        return cls(op, applied and changes.changed, changes.summary, edits)

    def to_json(self) -> dict[str, object]:
        return {"api": API_VERSION, **asdict(self)}


@dataclass(frozen=True)
class OpGroup:
    """The noun ops share: ``parent`` in ``inkflow parent set``."""

    name: str
    help: str


@dataclass(frozen=True)
class Op(Generic[RequestT]):
    """One op: its group and verb, request type and implementation."""

    group: OpGroup
    verb: str
    request_type: type[RequestT]
    run: OpFunction[RequestT]
    deck: DeckUse

    @property
    def name(self) -> str:
        """The name every surface shares, e.g. ``parent.set``."""
        return f"{self.group.name}.{self.verb}"

    @property
    def help(self) -> str:
        return inspect.getdoc(self.run) or ""

    def run_with(self, values: Mapping[str, object], context: OpContext) -> ChangeSet:
        """Build the request from field values a surface parsed, and run the op."""
        # The request type is a dataclass whose fields the surface enumerated, so its
        # constructor takes exactly these keywords.
        build = cast(Callable[..., RequestT], self.request_type)
        return self.run(build(**values), context)


class RegisteredOp(Protocol):
    """An `Op` with its request type erased, as the generated surfaces see it."""

    @property
    def name(self) -> str: ...
    @property
    def request_type(self) -> type[DataclassInstance]: ...
    @property
    def deck(self) -> DeckUse: ...
    @property
    def group(self) -> OpGroup: ...
    @property
    def verb(self) -> str: ...
    @property
    def help(self) -> str: ...
    def run_with(
        self, values: Mapping[str, object], context: OpContext
    ) -> ChangeSet: ...


_OPS: dict[str, RegisteredOp] = {}
_GROUP_NAMES: set[str] = set()


def register_group(name: str, help: str) -> OpGroup:
    """Declare a group once; its ops are registered against the returned object."""
    if name in _GROUP_NAMES:
        raise ValueError(f"op group {name!r} registered twice")
    _GROUP_NAMES.add(name)
    return OpGroup(name, help)


def register(
    group: OpGroup, verb: str, request_type: type[RequestT], *, deck: DeckUse
) -> Callable[[OpFunction[RequestT]], OpFunction[RequestT]]:
    """Register the decorated function as ``group.verb``, taking ``request_type``."""

    def decorate(run: OpFunction[RequestT]) -> OpFunction[RequestT]:
        op = Op(group, verb, request_type, run, deck)
        if op.name in _OPS:
            raise ValueError(f"op {op.name!r} registered twice")
        _OPS[op.name] = op
        return run

    return decorate


def registered_ops() -> list[RegisteredOp]:
    return list(_OPS.values())
