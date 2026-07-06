from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import click
from lxml import etree as _etree
from rich import box as rich_box
from rich.console import Console
from rich.table import Table

from inkflow import colors, loaders, ns
from inkflow.clean import clean_inkscape_svg
from inkflow.cli._common import (
    Project,
    deck_option,
    load_project_or_none,
    main,
    mode_option,
    no_deck_option,
    resolve_dark_mode,
    resolve_targets,
    targets_or_deck_slides,
)
from inkflow.layout import (
    create_slide,
    discover_layouts,
    inject_layout_layers,
    is_layout_current,
    layout_zones,
    resolve_chain,
    resolve_parent_path,
    strip_parent,
)
from inkflow.pipeline import resolve_slide_src
from inkflow.svg import with_namespaces
from inkflow.svgio import parse_svg_file


@main.command()
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@deck_option
@click.option(
    "--stdout",
    "to_stdout",
    is_flag=True,
    help="Write to stdout instead of modifying files in place",
)
@click.option(
    "--check",
    is_flag=True,
    help="Exit non-zero if any file would be modified, without writing changes",
)
def clean(
    files: tuple[Path, ...], deck_path: Path, to_stdout: bool, check: bool
) -> None:
    """Strip Inkscape editor metadata from SVG files.

    If FILES is omitted, cleans every project-local SVG the deck uses
    (each slide and its local layout ancestors).
    """
    if check and to_stdout:
        raise click.UsageError("--check and --stdout are mutually exclusive")
    if files:
        targets = resolve_targets(files)
    else:
        targets = Project.load(deck_path).slide_targets()
    dirty = False
    errors = False
    for target in targets:
        try:
            cleaned = clean_inkscape_svg(target.path, keep_preview=True)
            if check:
                if cleaned != target.path.read_text(encoding="utf-8"):
                    click.echo(f"[inkflow] would clean: {target.label}", err=True)
                    dirty = True
            elif to_stdout:
                sys.stdout.write(cleaned)
            else:
                target.path.write_text(cleaned, encoding="utf-8")
                click.echo(f"[inkflow] cleaned {target.label}")
        except Exception as exc:
            click.echo(
                f"[inkflow] clean: error processing {target.label}: {exc}", err=True
            )
            errors = True
    if dirty or errors:
        sys.exit(1)


@main.group()
def parent() -> None:
    """Manage slide layout parents."""


@parent.command("get")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@deck_option
def parent_get(files: tuple[Path, ...], deck_path: Path) -> None:
    """Print the inkflow:parent value of slide SVGs.

    With FILES, prints each file's parent (a bare value for a single file, else
    one 'file: parent' line each). With FILES omitted, lists every slide in the
    deck alongside its parent.
    """
    if not files:
        project = Project.load(deck_path)
        for slide in project.deck.slides:
            svg_path = resolve_slide_src(slide.src, project.dir, project.theme)
            root = parse_svg_file(svg_path)
            value = root.get(ns.INKFLOW_PARENT) or "(no parent)"
            click.echo(f"{slide.src!s:<45} {value}")
        return

    targets = resolve_targets(files)
    multi = len(targets) > 1
    for target in targets:
        root = parse_svg_file(target.path)
        value = root.get(ns.INKFLOW_PARENT)
        shown = value if value is not None else "(no parent)"
        click.echo(f"{target.label}: {shown}" if multi else shown)


@parent.command("set")
@click.argument("file", type=click.Path(path_type=Path))
@click.argument("parent_str", metavar="PARENT")
@deck_option
@no_deck_option
def parent_set(file: Path, parent_str: str, deck_path: Path, no_deck: bool) -> None:
    """Set the inkflow:parent of a slide SVG and refresh its layout layers.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path.
    """

    (target,) = resolve_targets([file])
    svg_path = target.path

    project = load_project_or_none(deck_path, no_deck)
    project_dir = project.dir if project else None
    theme = project.theme if project else None

    try:
        resolve_parent_path(parent_str, svg_path, project_dir, theme)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    root = parse_svg_file(svg_path)
    old_parent = root.get(ns.INKFLOW_PARENT)

    root = with_namespaces(root, {"inkflow": ns.INKFLOW})
    root.set(ns.INKFLOW_PARENT, parent_str)
    svg_path.write_text(
        _etree.tostring(root, encoding="unicode", xml_declaration=False),
        encoding="utf-8",
    )

    if old_parent is not None:
        click.echo(f"[inkflow] {svg_path.name}: parent {old_parent!r} → {parent_str!r}")
    else:
        click.echo(f"[inkflow] {svg_path.name}: parent set to {parent_str!r}")

    chain = resolve_chain(svg_path, project_dir, theme)
    if chain:
        inject_layout_layers(svg_path, chain)
        click.echo(f"[injected]    {svg_path.name}")


@parent.command("strip")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@click.option(
    "-y", "--yes", "confirmed", is_flag=True, help="Skip confirmation prompt."
)
@deck_option
def parent_strip(files: tuple[Path, ...], confirmed: bool, deck_path: Path) -> None:
    """Remove inkflow:parent and injected layout layers from slide SVG(s).

    If FILES is omitted, strips every project-local SVG the deck uses
    (each slide and its local layout ancestors).
    """
    if files:
        targets = resolve_targets(files)
    else:
        targets = Project.load(deck_path).slide_targets()

    if not confirmed:
        n = len(targets)
        click.confirm(
            f"Remove inkflow:parent and injected layers from {n} file(s)?",
            abort=True,
        )
    for target in targets:
        had_parent = strip_parent(target.path)
        click.echo(
            f"[stripped]    {target.label}"
            if had_parent
            else f"[no parent]   {target.label}"
        )


@main.command("add")
@click.argument("output", type=click.Path(path_type=Path))
@click.option(
    "-p",
    "--parent",
    "parent",
    default=None,
    help="Layout name or inkflow:parent string; omit for a blank slide.",
)
@deck_option
@no_deck_option
def add_slide(output: Path, parent: str | None, deck_path: Path, no_deck: bool) -> None:
    """Create a new slide SVG, optionally wired to a layout parent.

    OUTPUT is the path for the new SVG file. With -p/--parent, the slide is wired
    to that layout (bare name, 'local:foo', 'theme:foo', 'builtin:foo', or a
    relative path) and given preview layers. Without it, a blank slide is created.
    """
    if parent is not None and not no_deck:
        project = Project.load(deck_path)
        project_dir: Path | None = project.dir
        theme = project.theme
    else:
        project_dir = None
        theme = None

    output_path = output.resolve()
    if output_path.exists():
        raise click.ClickException(f"file already exists: {output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        create_slide(parent, output_path, project_dir, theme)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    base = project_dir or Path.cwd()
    try:
        output_rel = output_path.relative_to(base)
    except ValueError:
        output_rel = output_path
    click.echo(f"[inkflow] created {output_rel}")
    click.echo("[inkflow] add to deck.py:")
    click.echo(f'    Slide("{output_rel}"),')


@main.command("sync")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@click.option(
    "--check",
    is_flag=True,
    help="Report stale files without rewriting. Exits 1 if any are stale.",
)
@deck_option
@no_deck_option
@mode_option
def sync_cmd(
    files: tuple[Path, ...],
    check: bool,
    deck_path: Path,
    no_deck: bool,
    color_mode: str | None,
) -> None:
    """Refresh layout layers and preview styles in slide SVG(s).

    Injects ancestor layout layers for editor preview and a style block so
    Inkscape renders semantic CSS classes (e.g. inkflow-fill-accent) with the
    correct theme colors.

    If FILES is omitted, refreshes every project-local SVG the deck uses
    (each slide and its local layout ancestors).
    Use --no-deck when authoring a theme without a project deck.py.
    """
    project = load_project_or_none(deck_path, no_deck)
    deck_obj = project.deck if project else None
    project_dir = project.dir if project else None
    theme = project.theme if project else None
    dark_mode = resolve_dark_mode(color_mode, deck_obj, no_deck)
    targets = targets_or_deck_slides(files, project)

    css = loaders.load_deck_styles(deck_obj, project_dir)
    tokens = colors.extract_tokens(css, dark_mode)
    preview_css = colors.build_preview_style(tokens)

    stale_found = False
    for target in targets:
        try:
            chain = resolve_chain(target.path, project_dir, theme)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc
        if not chain:
            if not (files or no_deck):
                continue
            if check:
                if is_layout_current(target.path, [], preview_css):
                    click.echo(f"[ok]          {target.label}")
                else:
                    click.echo(f"[stale]       {target.label}")
                    stale_found = True
            else:
                inject_layout_layers(target.path, [], preview_css)
                click.echo(f"[no parent]   {target.label}")
            continue
        if check:
            if is_layout_current(target.path, chain, preview_css):
                click.echo(f"[ok]          {target.label}")
            else:
                click.echo(f"[stale]       {target.label}")
                stale_found = True
        else:
            changed = inject_layout_layers(target.path, chain, preview_css)
            click.echo(
                f"[injected]    {target.label}"
                if changed
                else f"[up to date]  {target.label}"
            )

    if check and stale_found:
        sys.exit(1)


@dataclass
class _LayoutRow:
    name: str
    parent: str
    zones: list[str]
    numbered: bool
    default_zone: str


@main.command("layouts")
@deck_option
@no_deck_option
def layouts_cmd(deck_path: Path, no_deck: bool) -> None:
    """List available layouts with their zones."""

    project = load_project_or_none(deck_path, no_deck)
    project_dir = project.dir if project else None
    theme = project.theme if project else None

    groups: dict[str, list[_LayoutRow]] = {}
    for source_label, layout_path in discover_layouts(project_dir, theme):
        try:
            chain = resolve_chain(layout_path, project_dir, theme)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc
        parent_str = " → ".join(p.stem for p in chain) if chain else "—"
        info = layout_zones(layout_path, project_dir, theme)
        groups.setdefault(source_label, []).append(
            _LayoutRow(
                layout_path.stem,
                parent_str,
                info.zones,
                info.numbered,
                info.default_zone,
            )
        )

    source_styles = [
        ("builtin", "steel_blue", "Built-in"),
        ("theme", "dark_orange", "Theme"),
        ("local", "green", "Local"),
    ]

    console = Console()
    first = True
    for source_key, color, title in source_styles:
        rows = groups.get(source_key)
        if not rows:
            continue
        if not first:
            console.print()
        first = False

        console.print(f"[bold {color}]‣ {title}[/bold {color}]")
        table = Table(
            box=rich_box.ROUNDED,
            header_style=f"bold {color}",
            border_style=color,
            show_header=True,
            pad_edge=True,
        )
        table.add_column("NAME", style="bold", min_width=12)
        table.add_column("PARENT", style="dim", min_width=14)
        table.add_column("ZONES", min_width=20)
        table.add_column("#", justify="center", min_width=1)

        for row in rows:
            zone_parts = [
                f"[bold underline {color}]{z}[/bold underline {color}]"
                if z == row.default_zone
                else f"[{color}]{z}[/{color}]"
                for z in row.zones
            ]
            zones_cell = ", ".join(zone_parts) if zone_parts else "[dim]—[/dim]"
            table.add_row(
                row.name,
                row.parent,
                zones_cell,
                f"[{color}]✓[/{color}]" if row.numbered else "",
            )

        console.print(table)
