"""Click commands generated from the op registry.

A request field without a default becomes a positional argument, one with a
default a ``--kebab-case`` option (a flag for ``bool``, ``--x/--no-x`` when it
defaults to True; a choice of values for a `StrEnum`); a ``tuple[X, ...]`` field
is a variadic argument, required unless it defaults to ``()``. Every command gets
``--json`` and the deck options its `DeckUse` calls for; writes also get
``--dry-run`` and ``--check``. A read op prints its output's ``render()`` on stdout,
a plain ``str`` verbatim (file contents such as a palette or an SVG must survive
byte for byte, which Rich's tab expansion and wrapping would not allow).
"""

from __future__ import annotations

import json
import types
from collections.abc import Callable, Sequence
from dataclasses import MISSING, Field, fields
from enum import StrEnum
from functools import cache
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    cast,
    get_args,
    get_origin,
    get_type_hints,
)

import click

from inkflow.cli._common import (
    Project,
    deck_option,
    main,
    no_deck_option,
    output_console,
)
from inkflow.logging import report
from inkflow.ops import ChangeSet, DeckUse, OpContext, OpError, OpResult
from inkflow.ops.registry import (
    FIELD_HELP_KEY,
    FieldHelp,
    OpGroup,
    RegisteredOp,
    registered_ops,
)
from inkflow.outline import API_VERSION

if TYPE_CHECKING:
    from _typeshed import DataclassInstance

__all__ = ["command_group"]

_CLICK_TYPES: dict[type, click.ParamType[object]] = {
    str: click.STRING,
    int: click.INT,
    Path: click.Path(path_type=Path),
}

_RESERVED = frozenset({"deck_path", "no_deck", "dry_run", "check", "as_json"})


@cache
def command_group(group: OpGroup) -> click.Group:
    """The ``inkflow <group>`` command, shared by generated and hand-written ones."""
    command = click.Group(group.name, help=group.help)
    main.add_command(command)
    return command


def _without_none(annotation: object) -> object:
    """``X`` for ``X | None``: None is the option's default, not a value to parse."""
    if get_origin(annotation) is types.UnionType:
        members = cast(tuple[object, ...], get_args(annotation))
        rest = [member for member in members if member is not type(None)]
        if len(rest) == 1:
            return rest[0]
    return annotation


def _variadic_item(annotation: object) -> object | None:
    """``X`` for ``tuple[X, ...]``, else None."""
    if get_origin(annotation) is tuple:
        args = cast(tuple[object, ...], get_args(annotation))
        if len(args) == 2 and args[1] is Ellipsis:
            return args[0]
    return None


def _enum_option(
    field: Field[object],
    option: str,
    enum_type: type[StrEnum],
    default: object,
    help_text: str | None,
    metavar: str | None,
) -> click.Option:
    def to_member(
        _ctx: click.Context, _param: click.Parameter, value: object
    ) -> object:
        return None if value is None else enum_type(value)

    return click.Option(
        [option, field.name],
        type=click.Choice([str(member) for member in enum_type.__members__.values()]),
        default=None if default is None else str(default),
        callback=to_member,
        help=help_text,
        metavar=metavar,
    )


def _str_enum(annotation: object) -> type[StrEnum] | None:
    if isinstance(annotation, type) and issubclass(annotation, StrEnum):
        return annotation
    return None


def _click_type(field: Field[object], base: object) -> click.ParamType[object]:
    if not isinstance(base, type) or base not in _CLICK_TYPES:
        raise TypeError(f"request field {field.name!r}: no CLI mapping for {base!r}")
    return _CLICK_TYPES[base]


def _field_param(field: Field[object], annotation: object) -> click.Parameter:
    if field.name in _RESERVED:
        raise TypeError(f"request field {field.name!r} clashes with a common option")
    if field.default_factory is not MISSING:
        raise TypeError(f"request field {field.name!r}: use a plain default")
    base = _without_none(annotation)
    help_entry = cast(FieldHelp | None, field.metadata.get(FIELD_HELP_KEY))
    help_text = help_entry.text if help_entry else None
    metavar = help_entry.metavar if help_entry else None
    has_default = field.default is not MISSING
    default = field.default if has_default else None
    option = "--" + field.name.replace("_", "-")

    if base is bool:
        declaration = f"{option}/--no-{option[2:]}" if default is True else option
        return click.Option(
            [declaration, field.name], is_flag=True, default=default, help=help_text
        )
    enum_type = _str_enum(base)
    if enum_type is not None:
        if not has_default:
            raise TypeError(f"request field {field.name!r}: an enum needs a default")
        return _enum_option(field, option, enum_type, default, help_text, metavar)
    item = _variadic_item(base)
    if item is not None:
        if has_default and default != ():
            raise TypeError(f"request field {field.name!r}: only () can be a default")
        return click.Argument(
            [field.name],
            type=_click_type(field, item),
            nargs=-1,
            required=not has_default,
            metavar=metavar,
        )
    click_type = _click_type(field, base)
    if not has_default:
        return click.Argument([field.name], type=click_type, metavar=metavar)
    return click.Option(
        [option, field.name],
        type=click_type,
        default=default,
        help=help_text,
        metavar=metavar,
    )


def _request_params(request_type: type[DataclassInstance]) -> list[click.Parameter]:
    hints: dict[str, object] = get_type_hints(request_type)
    params = [_field_param(field, hints[field.name]) for field in fields(request_type)]
    variadic = [
        p.name for p in params if isinstance(p, click.Argument) and p.nargs == -1
    ]
    if len(variadic) > 1:
        raise TypeError(f"{request_type.__name__}: more than one variadic field")
    return params


def _names_files(op: RegisteredOp, values: dict[str, object]) -> bool:
    """Whether the request names its files, which spares a SWEEP_ONLY op the deck."""
    hints: dict[str, object] = get_type_hints(op.request_type)
    swept = [
        field.name
        for field in fields(op.request_type)
        if _variadic_item(hints[field.name]) is Path
    ]
    if len(swept) != 1:
        raise TypeError(f"{op.name}: SWEEP_ONLY needs exactly one tuple[Path, ...]")
    return bool(cast(Sequence[Path], values[swept[0]]))


def _context(
    op: RegisteredOp, deck_path: Path | None, no_deck: bool, values: dict[str, object]
) -> OpContext:
    if deck_path is None or (op.deck is DeckUse.OPTIONAL and no_deck):
        return OpContext(None, None)
    if op.deck is DeckUse.SWEEP_ONLY and _names_files(op, values):
        return OpContext(None, None)
    project = Project.load(deck_path)
    return OpContext(project.deck, project.dir)


def _report(changes: ChangeSet, context: OpContext, *, dry_run: bool) -> None:
    if not changes.changed:
        report("Unchanged", changes.summary, style="dim")
        return
    report("Planned" if dry_run else "Applied", changes.summary)
    for edit in changes.edits:
        verb = "Would write" if dry_run else "Wrote"
        label = context.label(edit.path)
        shown = f"{label}: {edit.detail}" if edit.detail else label
        report(verb, shown, style="yellow" if dry_run else "dim")


def _json_option(text: str) -> Callable[[click.Command], click.Command]:
    return click.option(
        "--json",
        "as_json",
        is_flag=True,
        help=f"Print {text} as JSON (API {API_VERSION}) on stdout.",
    )


def _with_deck_options(op: RegisteredOp, command: click.Command) -> click.Command:
    if op.deck is DeckUse.NONE:
        return command
    command = deck_option(command)
    if op.deck is DeckUse.OPTIONAL:
        command = no_deck_option(command)
    return command


def _write_command(op: RegisteredOp) -> click.Command:
    def callback(
        dry_run: bool,
        check: bool,
        as_json: bool,
        deck_path: Path | None = None,
        no_deck: bool = False,
        **values: object,
    ) -> None:
        dry_run = dry_run or check
        context = _context(op, deck_path, no_deck, values)
        try:
            changes = op.run_with(values, context)
            if not isinstance(changes, ChangeSet):
                raise TypeError(f"write op {op.name!r} returned {changes!r}")
            if not dry_run:
                changes.apply()
        except OpError as exc:
            raise click.ClickException(str(exc)) from exc
        if as_json:
            result = OpResult.of(op.name, changes, context, applied=not dry_run)
            click.echo(json.dumps(result.to_json(), indent=2))
        else:
            _report(changes, context, dry_run=dry_run)
        if check and changes.changed:
            raise click.exceptions.Exit(1)

    command = click.Command(
        op.verb,
        callback=callback,
        params=_request_params(op.request_type),
        help=op.help,
    )
    command = _with_deck_options(op, command)
    command = click.option(
        "-n",
        "--dry-run",
        "dry_run",
        is_flag=True,
        help="Show what would change without writing.",
    )(command)
    command = click.option(
        "--check",
        "check",
        is_flag=True,
        help="Exit 1 if anything would change, without writing (implies --dry-run).",
    )(command)
    return _json_option("what changed")(command)


def _read_command(op: RegisteredOp) -> click.Command:
    def callback(
        as_json: bool,
        deck_path: Path | None = None,
        no_deck: bool = False,
        **values: object,
    ) -> None:
        context = _context(op, deck_path, no_deck, values)
        try:
            output = op.run_with(values, context)
        except OpError as exc:
            raise click.ClickException(str(exc)) from exc
        if isinstance(output, ChangeSet):
            raise TypeError(f"read op {op.name!r} returned a ChangeSet")
        if as_json:
            payload = {"api": API_VERSION, "op": op.name, **output.to_json()}
            click.echo(json.dumps(payload, indent=2))
            return
        rendered = output.render()
        if isinstance(rendered, str):
            click.echo(rendered, nl=False)
            return
        output_console.print(rendered, markup=False, highlight=False, soft_wrap=True)

    command = click.Command(
        op.verb,
        callback=callback,
        params=_request_params(op.request_type),
        help=op.help,
    )
    command = _with_deck_options(op, command)
    return _json_option("the result")(command)


for _op in registered_ops():
    build_command = _write_command if _op.writes else _read_command
    command_group(_op.group).add_command(build_command(_op))
