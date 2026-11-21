from __future__ import annotations

import json
from pathlib import Path

import click
from rich import box as rich_box
from rich.markup import escape
from rich.table import Table

from inkflow.cli._common import Project, deck_option, main, resolve_deck_path
from inkflow.deck_source import Editability
from inkflow.logging import console
from inkflow.outline import API_VERSION, DeckOutline, SlideOutline, build_outline

_EDITABILITY_STYLES = {
    Editability.LITERAL: "green",
    Editability.OPAQUE: "yellow",
    Editability.BLOCK: "yellow",
    Editability.NONE: "red",
}


@main.group("deck")
def deck_group() -> None:
    """Inspect the deck as a whole."""


@deck_group.command("show")
@deck_option
@click.option(
    "--json",
    "as_json",
    is_flag=True,
    help=f"Print the outline as JSON (API {API_VERSION}) on stdout.",
)
def deck_show(deck_path: Path, as_json: bool) -> None:
    """Describe every slide: id, source, zones, cues and how editable it is.

    Hidden slides are included. ZONES lists every zone the composed slide offers,
    with the filled ones in bold and the default zone underlined. EDIT says how much
    of the slide tools may change in deck.py: `literal` (a `Slide(...)` written in
    the list), `opaque` (a helper call or variable, movable as a unit), `block` (part
    of a `*spread`, movable only as a whole) or `none` (the list is computed).

    A slide that cannot be composed is reported with its error instead of failing
    the command. `--json` prints the same outline as a versioned JSON document.
    """
    project = Project.load(deck_path)
    outline = build_outline(project.deck, project.dir, resolve_deck_path(deck_path))
    if as_json:
        click.echo(json.dumps(outline.to_json(), indent=2))
    else:
        _print_outline(outline)


def _print_outline(outline: DeckOutline) -> None:
    console.print(
        f"[bold]{escape(outline.title)}[/bold]  [dim]{escape(outline.deck_file)} · "
        + f"theme {escape(outline.theme)} · {outline.mode}[/dim]"
    )
    table = Table(box=rich_box.ROUNDED, header_style="bold", show_header=True)
    table.add_column("#", justify="right")
    table.add_column("ID", style="bold")
    table.add_column("SRC")
    table.add_column("ZONES")
    table.add_column("CUES", justify="right")
    table.add_column("EDIT")
    table.add_column("DEFINED", style="dim")
    for slide in outline.slides:
        table.add_row(
            str(slide.number) if slide.number is not None else "[dim]hidden[/dim]",
            escape(slide.id or "—"),
            escape(slide.src),
            _zones_cell(slide),
            str(len(slide.cues)) if slide.cues else "",
            _editability_cell(slide),
            escape(_defined_cell(slide)),
            style="dim" if not slide.visible else None,
        )
    console.print(table)

    for slide in outline.slides:
        label = slide.id or slide.src
        for error in slide.errors:
            console.print(
                f"[bold red]error[/bold red]  {escape(label)}  "
                + f"[red]{escape(error)}[/red]"
            )
        if slide.editability.reason is not None:
            style = _EDITABILITY_STYLES[slide.editability.level]
            console.print(
                f"[{style}]{slide.editability.level}[/{style}]  {escape(label)}  "
                + f"[dim]{escape(slide.editability.reason)}[/dim]"
            )


def _zones_cell(slide: SlideOutline) -> str:
    if slide.zones is None:
        return "[red]?[/red]"
    if not slide.zones.available:
        return "[dim]—[/dim]"
    parts: list[str] = []
    for zone in slide.zones.available:
        style = "bold" if zone in slide.zones.filled else "dim"
        if zone == slide.zones.default:
            style += " underline"
        parts.append(f"[{style}]{escape(zone)}[/{style}]")
    return ", ".join(parts)


def _editability_cell(slide: SlideOutline) -> str:
    level = slide.editability.level
    style = _EDITABILITY_STYLES[level]
    return f"[{style}]{level}[/{style}]"


def _defined_cell(slide: SlideOutline) -> str:
    location = slide.defined_at
    return f"{location.path}:{location.line}" if location is not None else ""
