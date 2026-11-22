"""Click commands generated from the op registry.

A request field without a default becomes a positional argument, one with a
default a ``--kebab-case`` option (a flag for ``bool``). Every op command also gets
``--dry-run`` and ``--json``, plus the deck options its `DeckUse` calls for.
"""

from __future__ import annotations

import json
import types
from dataclasses import MISSING, Field, fields
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, cast, get_args, get_origin, get_type_hints

import click

from inkflow.cli._common import Project, deck_option, main, no_deck_option
from inkflow.logging import report
from inkflow.ops import ChangeSet, DeckUse, OpContext, OpError, OpResult, registered_ops
from inkflow.ops.registry import FIELD_HELP_KEY, FieldHelp, OpGroup, RegisteredOp
from inkflow.outline import API_VERSION

if TYPE_CHECKING:
    from _typeshed import DataclassInstance

__all__ = ["command_group"]

_CLICK_TYPES: dict[type, click.ParamType[object]] = {
    str: click.STRING,
    int: click.INT,
    Path: click.Path(path_type=Path),
}

_RESERVED = frozenset({"deck_path", "no_deck", "dry_run", "as_json"})


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
        return click.Option(
            [option, field.name], is_flag=True, default=default, help=help_text
        )
    if not isinstance(base, type) or base not in _CLICK_TYPES:
        raise TypeError(f"request field {field.name!r}: no CLI mapping for {base!r}")
    click_type = _CLICK_TYPES[base]
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
    return [_field_param(field, hints[field.name]) for field in fields(request_type)]


def _context(op: RegisteredOp, deck_path: Path, no_deck: bool) -> OpContext:
    if no_deck and op.deck is DeckUse.OPTIONAL:
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
        report(verb, context.label(edit.path), style="yellow" if dry_run else "dim")


def _command(op: RegisteredOp) -> click.Command:
    def callback(
        deck_path: Path,
        dry_run: bool,
        as_json: bool,
        no_deck: bool = False,
        **values: object,
    ) -> None:
        context = _context(op, deck_path, no_deck)
        try:
            changes = op.run_with(values, context)
            if not dry_run:
                changes.apply()
        except OpError as exc:
            raise click.ClickException(str(exc)) from exc
        if as_json:
            result = OpResult.of(op.name, changes, context, applied=not dry_run)
            click.echo(json.dumps(result.to_json(), indent=2))
        else:
            _report(changes, context, dry_run=dry_run)

    command = click.Command(
        op.verb,
        callback=callback,
        params=_request_params(op.request_type),
        help=op.help,
    )
    command = deck_option(command)
    if op.deck is DeckUse.OPTIONAL:
        command = no_deck_option(command)
    command = click.option(
        "-n",
        "--dry-run",
        "dry_run",
        is_flag=True,
        help="Show what would change without writing.",
    )(command)
    return click.option(
        "--json",
        "as_json",
        is_flag=True,
        help=f"Print what changed as JSON (API {API_VERSION}) on stdout.",
    )(command)


for _op in registered_ops():
    command_group(_op.group).add_command(_command(_op))
