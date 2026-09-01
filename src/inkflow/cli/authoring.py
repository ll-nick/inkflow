from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import click
from lxml import etree as _etree
from rich import box as rich_box
from rich.table import Table

from inkflow import ns, sync
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
from inkflow.label2id import promote_labels_to_ids
from inkflow.layout import (
    AssetKind,
    PreviewLayers,
    are_preview_layers_current,
    chain_layers,
    create_slide,
    discover_layouts,
    discover_overlays,
    inject_preview_layers,
    layout_zones,
    resolve_chain,
    resolve_parent_path,
    strip_parent,
)
from inkflow.logging import console, logger, report
from inkflow.pipeline import resolve_slide_src
from inkflow.svg import with_namespaces
from inkflow.svgio import parse_svg_file
from inkflow.themes import Theme


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
                    report("Would clean", target.label, style="yellow")
                    dirty = True
            elif to_stdout:
                sys.stdout.write(cleaned)
            else:
                target.path.write_text(cleaned, encoding="utf-8")
                report("Cleaned", target.label)
        except Exception as exc:
            logger.error(f"clean: {target.label}: {exc}")
            errors = True
    if dirty or errors:
        sys.exit(1)


@main.command("label2id")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@deck_option
@click.option(
    "--all-tags",
    "all_tags",
    is_flag=True,
    help="Also rename non-shape elements (tspan, stop, gradients, …).",
)
@click.option(
    "--refs/--no-refs",
    "rewrite_refs",
    default=True,
    help="Rewrite url(#id) / href='#id' references pointing at renamed ids.",
)
@click.option(
    "-n",
    "--dry-run",
    "dry_run",
    is_flag=True,
    help="Show what would change without writing.",
)
@click.option(
    "--check",
    is_flag=True,
    help="Exit non-zero if any file would change, without writing (implies --dry-run).",
)
def label2id(
    files: tuple[Path, ...],
    deck_path: Path,
    all_tags: bool,
    rewrite_refs: bool,
    dry_run: bool,
    check: bool,
) -> None:
    """Promote each element's inkscape:label to its SVG id.

    Name a group in Inkscape's Layers & Objects panel, run this, and deck.py can
    animate it by id (and the Morph transition can match it across slides). A
    label that is already a valid id is used verbatim; anything else is slugified.
    Labels need not be unique but ids must, so a clash is warned about and
    skipped, never clobbered. Elements inside injected inkflow preview layers are
    left alone.

    If FILES is omitted, processes every project-local SVG the deck uses (each
    slide and its local layout/overlay ancestors). After renaming ids in a layout
    or overlay, run `inkflow sync` so the slides that preview it pick up the
    change.
    """
    dry_run = dry_run or check
    if files:
        targets = resolve_targets(files)
    else:
        targets = Project.load(deck_path).slide_targets()

    dirty = False
    errors = False
    for target in targets:
        try:
            original = target.path.read_text(encoding="utf-8")
            result = promote_labels_to_ids(
                original, all_tags=all_tags, rewrite_refs=rewrite_refs
            )
        except Exception as exc:
            logger.error(f"label2id: {target.label}: {exc}")
            errors = True
            continue

        for skip in result.skips:
            detail = f"{skip.tag} label={skip.label!r}: {skip.reason}"
            logger.warning(f"label2id: {target.label}: {detail}")

        if not result.changed:
            report("No labels", target.label, style="dim")
            continue

        dirty = True
        verb = "Would rename" if dry_run else "Renamed"
        for rename in result.renames:
            old = rename.old_id or "(none)"
            report(
                verb,
                f"{target.label}: {old} → {rename.new_id} (label {rename.label!r})",
            )
        if result.reference_edits:
            report(
                "Rewrote",
                f"{target.label}: {result.reference_edits} reference(s)",
                style="dim",
            )
        if not dry_run:
            target.path.write_text(result.text, encoding="utf-8")

    if errors or (check and dirty):
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
        report("Set", f"{svg_path.name}: parent {old_parent!r} → {parent_str!r}")
    else:
        report("Set", f"{svg_path.name}: parent {parent_str!r}")

    chain = resolve_chain(svg_path, project_dir, theme)
    if chain:
        inject_preview_layers(
            svg_path, PreviewLayers(behind=chain_layers(svg_path, chain))
        )
        report("Injected", svg_path.name)


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
        if had_parent:
            report("Stripped", target.label)
        else:
            report("No parent", target.label, style="dim")


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

    OUTPUT is the path for the new SVG file. With `-p`/`--parent`, the slide is
    wired to that layout (bare name, 'local:foo', 'theme:foo', 'builtin:foo', or a
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
        output_rel = output_path.relative_to(base).as_posix()
    except ValueError:
        output_rel = output_path.as_posix()
    report("Created", output_rel)
    console.print("  add to deck.py:", markup=False)
    console.print(f'    Slide("{output_rel}"),', markup=False)


def _sync_label(label: str, plan: sync.PreviewPlan) -> str:
    """Append which rule decided this file's chrome, so rule 3 is never silent.

    Falling back to the deck default is a guess by design (a shared layout has no
    per-slide answer), so naming the rule is what points at
    ``inkflow:preview-overlays`` when the guess is wrong. An overlay file reports
    its backdrop for the same reason: there is no default, so "no backdrop" has to
    be visible rather than look like nothing happened.
    """
    if plan.is_overlay:
        backdrop = f"backdrop: {plan.backdrop.ref}" if plan.backdrop else "no backdrop"
        return f"{label} ({sync.PreviewRule.OVERLAY_FILE}, {backdrop})"
    if plan.rule is sync.PreviewRule.NO_DECK:
        return f"{label} (no deck, {sync.PreviewRule.ATTRIBUTE} only)"
    if not plan.layers.overlays:
        return label
    count = sum(len(chain) for chain in plan.layers.overlays)
    plural = "" if count == 1 else "s"
    return f"{label} ({count} overlay layer{plural}, {plan.rule})"


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
    """Refresh layout layers, overlay layers and preview styles in slide SVG(s).

    Injects ancestor layout layers below the slide and the overlays it gets at
    runtime above it, plus a style block so Inkscape renders semantic CSS classes
    (e.g. inkflow-fill-accent) with the correct theme colors.

    Which overlays a file previews is decided by, in order: an explicit
    `inkflow:preview-overlays` attribute on the file, agreement among the slides
    backed by it, or the deck default. The rule that fired is shown per file.
    Overlay files themselves get no chrome, only an `inkflow:preview` backdrop.

    If FILES is omitted, refreshes every project-local SVG the deck uses
    (each slide, its local layout ancestors, and the project's overlays).
    Use `--no-deck` when authoring a theme without a project deck.py.
    """
    project = load_project_or_none(deck_path, no_deck)
    deck_obj = project.deck if project else None
    dark_mode = resolve_dark_mode(color_mode, deck_obj, no_deck)
    targets = targets_or_deck_slides(files, project)
    ctx = (
        project.preview_context(dark_mode)
        if project
        else sync.build_context(None, None, None, dark_mode)
    )

    stale_found = False
    for target in targets:
        try:
            plan = sync.plan_preview(target.path, ctx)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc
        # A file with no layers only gains the preview style block, which is worth
        # writing when it was named explicitly but not when sweeping the whole deck.
        # An overlay file is the exception: it is swept precisely to get that block,
        # and it legitimately has no layers until it names a backdrop.
        if plan.is_bare and not plan.is_overlay and not (files or no_deck):
            continue
        label = _sync_label(target.label, plan)
        if check:
            if are_preview_layers_current(target.path, plan.layers):
                report("Ok", label)
            else:
                report("Stale", label, style="yellow")
                stale_found = True
            continue
        changed = inject_preview_layers(target.path, plan.layers)
        if plan.is_bare and not plan.is_overlay:
            report("No parent", label, style="dim")
        elif changed:
            report("Injected", label)
        else:
            report("Up to date", label, style="dim")

    if check and stale_found:
        sys.exit(1)


@dataclass
class _LayoutRow:
    name: str
    parent: str
    zones: list[str]
    numbered: bool
    default_zone: str


def _asset_rows(
    kind: AssetKind,
    project_dir: Path | None,
    theme: Theme | None,
) -> dict[str, list[_LayoutRow]]:
    """Group discovered layouts or overlays by source, with their chains and zones."""
    discover = discover_layouts if kind is AssetKind.LAYOUT else discover_overlays
    groups: dict[str, list[_LayoutRow]] = {}
    for source_label, path in discover(project_dir, theme):
        try:
            chain = resolve_chain(path, project_dir, theme, kind)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc
        parent_str = " → ".join(p.stem for p in chain) if chain else "—"
        info = layout_zones(path, project_dir, theme, kind)
        groups.setdefault(source_label, []).append(
            _LayoutRow(
                path.stem,
                parent_str,
                info.zones,
                info.numbered,
                info.default_zone,
            )
        )
    return groups


@main.command("layouts")
@deck_option
@no_deck_option
def layouts_cmd(deck_path: Path, no_deck: bool) -> None:
    """List available layouts and overlays with their zones and parent chain.

    Discovers both from three sources — built-in, theme, then project-local — and
    prints a table per source with each entry's parent chain and zone names. The
    default zone is underlined; a checkmark marks entries that carry a slide number
    (a `zone-slide-number` or `zone-slide-total`). Layouts compose behind a slide,
    overlays on top of it, and the two are separate namespaces. The overlay section
    is omitted when no overlays exist. Pass `--no-deck` to list only the built-ins.
    """

    project = load_project_or_none(deck_path, no_deck)
    project_dir = project.dir if project else None
    theme = project.theme if project else None

    _print_asset_tables(_asset_rows(AssetKind.LAYOUT, project_dir, theme))

    overlay_groups = _asset_rows(AssetKind.OVERLAY, project_dir, theme)
    if overlay_groups:
        console.print()
        console.print("[bold]OVERLAYS[/bold] [dim](composited on top)[/dim]")
        _print_asset_tables(overlay_groups)


_SOURCE_STYLES = [
    ("builtin", "steel_blue", "Built-in"),
    ("theme", "dark_orange", "Theme"),
    ("local", "green", "Local"),
]


def _print_asset_tables(groups: dict[str, list[_LayoutRow]]) -> None:
    first = True
    for source_key, color, title in _SOURCE_STYLES:
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
