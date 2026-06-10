from __future__ import annotations

import asyncio
import contextlib
import sys
from pathlib import Path

import click

from inkflow import git_setup, init, ns
from inkflow.export import build_pdf, build_static_html
from inkflow.layout import (
    create_slide,
    inject_layout_layers,
    is_layout_current,
    resolve_chain,
    resolve_parent_path,
    strip_parent,
    with_namespaces,
)
from inkflow.manifest import Deck, MarkdownSlide
from inkflow.pipeline import clean_inkscape_svg, resolve_slide_src
from inkflow.server import load_deck
from inkflow.server import serve as _serve


@click.group()
@click.version_option()
def main() -> None:
    """Beautiful slides from SVG. Your editor, your style."""


def _deck_context(deck_path: Path) -> tuple[Deck, Path]:
    resolved = deck_path.resolve()
    if not resolved.exists():
        raise click.ClickException(f"deck not found: {resolved}")
    deck_obj = load_deck(resolved)
    return deck_obj, resolved.parent


_deck_option = click.option(
    "--deck",
    "deck_path",
    default="deck.py",
    type=click.Path(path_type=Path),
    help="Path to deck.py (default: deck.py in cwd)",
)

_no_deck_option = click.option(
    "--no-deck",
    "no_deck",
    is_flag=True,
    help=(
        "Operate without a deck.py (for theme authoring). "
        "Only builtin: and relative-path parents are allowed."
    ),
)


@main.command("init")
@click.argument("directory", default=".", type=click.Path(path_type=Path))
@click.option(
    "--theme", "theme_path", default=None, help="Path to a custom theme directory."
)
@click.option(
    "--no-git",
    "no_git",
    is_flag=True,
    help="Skip git hook setup even when inside a git repository.",
)
def init_cmd(directory: Path, theme_path: str | None, no_git: bool) -> None:
    """Scaffold a new presentation project."""
    target = directory.resolve()
    if (target / "deck.py").exists():
        raise click.ClickException(f"deck.py already exists: {target / 'deck.py'}")
    try:
        init.scaffold(target, theme_path)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo("[inkflow] created slides/01-title.svg")
    click.echo("[inkflow] created slides/02-content.md")
    click.echo("[inkflow] created deck.py")
    if not no_git:
        git_root_path = git_setup.detect_git_root(target)
        if git_root_path:
            git_setup.run_git_setup(git_root_path, verbose=False, log=click.echo)
    rel = str(directory) if str(directory) not in (".", "./") else None
    suffix = f"cd {rel} && inkflow serve" if rel else "inkflow serve"
    click.echo(f"\n[inkflow] run:  {suffix}")


@main.command()
@click.argument("deck", default="deck.py")
@click.option(
    "--host",
    default="localhost",
    show_default=True,
    help="Bind address",
)
@click.option("--port", default=7777, show_default=True, help="HTTP port")
@click.option("--ws-port", default=7778, show_default=True, help="WebSocket port")
def serve(deck: str, host: str, port: int, ws_port: int) -> None:
    """Start the presentation server."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_serve(deck_path, host, port, ws_port))


@main.command()
@click.argument("files", nargs=-1, required=True, type=click.Path(path_type=Path))
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
def clean(files: tuple[Path, ...], to_stdout: bool, check: bool) -> None:
    """Strip Inkscape editor metadata from SVG files."""
    if check and to_stdout:
        raise click.UsageError("--check and --stdout are mutually exclusive")
    dirty = False
    errors = False
    for p in files:
        if not p.exists():
            click.echo(f"[inkflow] clean: not found: {p}", err=True)
            errors = True
            continue
        try:
            cleaned = clean_inkscape_svg(p)
            if check:
                if cleaned != p.read_text(encoding="utf-8"):
                    click.echo(f"[inkflow] would clean: {p}", err=True)
                    dirty = True
            elif to_stdout:
                sys.stdout.write(cleaned)
            else:
                p.write_text(cleaned, encoding="utf-8")
                click.echo(f"[inkflow] cleaned {p}")
        except Exception as exc:
            click.echo(f"[inkflow] clean: error processing {p}: {exc}", err=True)
            errors = True
    if dirty or errors:
        sys.exit(1)


@main.command("setup-git")
def setup_git() -> None:
    """Configure git hooks and SVG diff driver for any git repository."""
    try:
        root = git_setup.git_root()
        git_setup.run_git_setup(root, verbose=True, log=click.echo)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc


@main.group()
def parent() -> None:
    """Manage slide layout parents."""


@parent.command("get")
@click.argument("files", nargs=-1, required=True, type=click.Path(path_type=Path))
def parent_get(files: tuple[Path, ...]) -> None:
    """Print the inkflow:parent value of one or more slide SVGs."""
    from lxml import etree as _etree

    multi = len(files) > 1
    for f in files:
        svg_path = Path(f).resolve()
        if not svg_path.exists():
            raise click.ClickException(f"file not found: {svg_path}")
        root = _etree.parse(svg_path).getroot()
        value = root.get(ns.INKFLOW_PARENT)
        label = value if value is not None else "(no parent)"
        click.echo(f"{f}: {label}" if multi else label)


@parent.command("set")
@click.argument("file", type=click.Path(path_type=Path))
@click.argument("parent_str", metavar="PARENT")
@_deck_option
@_no_deck_option
def parent_set(file: Path, parent_str: str, deck_path: Path, no_deck: bool) -> None:
    """Set the inkflow:parent of a slide SVG and refresh its layout layers.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path.
    """
    from lxml import etree as _etree

    svg_path = Path(file).resolve()
    if not svg_path.exists():
        raise click.ClickException(f"file not found: {svg_path}")

    if no_deck:
        project_dir: Path | None = None
        theme: str | None = None
    else:
        deck_obj, project_dir = _deck_context(deck_path)
        theme = deck_obj.theme

    try:
        resolve_parent_path(parent_str, svg_path, project_dir, theme)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    tree = _etree.parse(svg_path)
    root = tree.getroot()
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
@_deck_option
def parent_strip(files: tuple[Path, ...], confirmed: bool, deck_path: Path) -> None:
    """Remove inkflow:parent and injected layout layers from slide SVG(s).

    If FILES is omitted, strips all slides in the deck.
    """
    if files:
        targets = [(Path(f).resolve(), str(f)) for f in files]
        for svg_path, _ in targets:
            if not svg_path.exists():
                raise click.ClickException(f"file not found: {svg_path}")
    else:
        deck_obj, project_dir = _deck_context(deck_path)
        targets = [
            (resolve_slide_src(s.src, project_dir), str(s.src))
            for s in deck_obj.slides
            if not isinstance(s, MarkdownSlide)
        ]

    if not confirmed:
        n = len(targets)
        click.confirm(
            f"Remove inkflow:parent and injected layers from {n} file(s)?",
            abort=True,
        )
    for svg_path, label in targets:
        had_parent = strip_parent(svg_path)
        click.echo(f"[stripped]    {label}" if had_parent else f"[no parent]   {label}")


_mode_option = click.option(
    "--mode",
    "color_mode",
    type=click.Choice(["dark", "light"]),
    default=None,
    help="Color mode for preview style (default: deck dark_mode; dark with --no-deck).",
)


@parent.command("inject")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@click.option(
    "--check",
    is_flag=True,
    help="Report stale files without rewriting. Exits 1 if any are stale.",
)
@_deck_option
@_no_deck_option
@_mode_option
def parent_inject(
    files: tuple[Path, ...],
    check: bool,
    deck_path: Path,
    no_deck: bool,
    color_mode: str | None,
) -> None:
    """Refresh ancestor layout layers in slide SVG(s) for editor preview.

    Also injects a preview style block so Inkscape renders semantic CSS classes
    (e.g. inkflow-fill-accent) with the correct theme colors.

    If FILES is omitted, refreshes all slides in the deck.
    Use --no-deck when authoring a theme without a project deck.py.
    """
    if no_deck:
        if not files:
            raise click.UsageError("FILES required with --no-deck")
        project_dir: Path | None = None
        theme: str | None = None
        deck_obj: Deck | None = None
        dark_mode = color_mode != "light"
        targets = [(Path(f).resolve(), str(f)) for f in files]
        for svg_path, _ in targets:
            if not svg_path.exists():
                raise click.ClickException(f"file not found: {svg_path}")
    else:
        deck_obj, project_dir = _deck_context(deck_path)
        theme = deck_obj.theme
        dark_mode = deck_obj.dark_mode if color_mode is None else (color_mode == "dark")
        if files:
            targets = [(Path(f).resolve(), str(f)) for f in files]
            for svg_path, _ in targets:
                if not svg_path.exists():
                    raise click.ClickException(f"file not found: {svg_path}")
        else:
            targets = [
                (resolve_slide_src(s.src, project_dir), str(s.src))
                for s in deck_obj.slides
                if not isinstance(s, MarkdownSlide)
            ]

    css = loaders.load_styles(deck_obj, project_dir)
    tokens = colors.extract_tokens(css, dark_mode)
    preview_css = colors.build_preview_style(tokens)

    stale_found = False
    for svg_path, label in targets:
        try:
            chain = resolve_chain(svg_path, project_dir, theme)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc
        if not chain:
            if not (files or no_deck):
                continue
            if check:
                if is_layout_current(svg_path, [], preview_css):
                    click.echo(f"[ok]          {label}")
                else:
                    click.echo(f"[stale]       {label}")
                    stale_found = True
            else:
                inject_layout_layers(svg_path, [], preview_css)
                click.echo(f"[no parent]   {label}")
            continue
        if check:
            if is_layout_current(svg_path, chain, preview_css):
                click.echo(f"[ok]     {label}")
            else:
                click.echo(f"[stale]  {label}")
                stale_found = True
        else:
            changed = inject_layout_layers(svg_path, chain, preview_css)
            click.echo(
                f"[injected]    {label}" if changed else f"[up to date]  {label}"
            )

    if check and stale_found:
        sys.exit(1)


@parent.command("list")
@_deck_option
def parent_list(deck_path: Path) -> None:
    """List all slides and their inkflow:parent values."""
    from lxml import etree as _etree

    deck_obj, project_dir = _deck_context(deck_path)

    for slide in deck_obj.slides:
        if isinstance(slide, MarkdownSlide):
            click.echo(f"{'[markdown: ' + slide.template + ']':<45} (markdown slide)")
            continue
        svg_path = resolve_slide_src(slide.src, project_dir)
        root = _etree.parse(svg_path).getroot()
        value = root.get(ns.INKFLOW_PARENT) or "(no parent)"
        click.echo(f"{slide.src!s:<45} {value}")


@main.command("add")
@click.argument("parent")
@click.argument("output", type=click.Path(path_type=Path))
@click.option(
    "--deck",
    "deck_path",
    default="deck.py",
    type=click.Path(path_type=Path),
    help="Path to deck.py (default: deck.py in cwd)",
)
def add_slide(parent: str, output: Path, deck_path: Path) -> None:
    """Create a new slide SVG wired to a layout parent.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path. OUTPUT is the path for the new SVG file.
    """
    resolved_deck = deck_path.resolve()
    if not resolved_deck.exists():
        raise click.ClickException(f"deck not found: {resolved_deck}")

    deck_obj = load_deck(resolved_deck)
    project_dir = resolved_deck.parent
    output_path = output.resolve()

    if output_path.exists():
        raise click.ClickException(f"file already exists: {output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        create_slide(parent, output_path, project_dir, deck_obj.theme)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    output_rel = output_path.relative_to(project_dir)
    click.echo(f"[inkflow] created {output_rel}")
    click.echo("[inkflow] add to deck.py:")
    click.echo(f'    Slide("{output_rel}"),')


@main.command("build")
@click.argument("deck", default="deck.py")
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output directory (default: build/ next to deck.py)",
)
def build_cmd(deck: str, output: str | None) -> None:
    """Export a self-contained presentation directory for offline use."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")
    out_dir = Path(output).resolve() if output else deck_path.parent / "build"
    build_static_html(deck_path, out_dir)
    click.echo(f"[inkflow] built {out_dir / 'index.html'}")


@main.command("export")
@click.argument("deck", default="deck.py")
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output PDF path (default: <deck-stem>.pdf next to deck.py)",
)
@click.option(
    "--chromium",
    default=None,
    help="Path to chromium/chrome binary (auto-detected if not set)",
)
@click.option(
    "--no-sandbox",
    "no_sandbox",
    is_flag=True,
    help="Pass --no-sandbox to Chromium (needed when running as root or in Docker).",
)
def export_cmd(
    deck: str, output: str | None, chromium: str | None, no_sandbox: bool
) -> None:
    """Export a PDF via headless Chromium (one page per slide)."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")
    out = Path(output).resolve() if output else deck_path.with_suffix(".pdf")
    try:
        build_pdf(deck_path, out, chromium, no_sandbox)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(f"[inkflow] exported {out}")
