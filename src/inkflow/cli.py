from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from typing import cast

import click

from inkflow import ns
from inkflow.layout import (
    inject_layout_layers,
    is_layout_current,
    resolve_chain,
    resolve_parent_path,
)
from inkflow.manifest import MarkdownSlide
from inkflow.pipeline import clean_inkscape_svg
from inkflow.server import load_deck
from inkflow.server import serve as _serve


@click.group()
def main() -> None:
    """Terminal-native SVG presentation tool."""


@main.command()
@click.argument("deck", default="deck.py")
@click.option("--port", default=7777, show_default=True, help="HTTP port")
@click.option("--ws-port", default=7778, show_default=True, help="WebSocket port")
def serve(deck: str, port: int, ws_port: int) -> None:
    """Start the presentation server."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")
    try:
        asyncio.run(_serve(deck_path, port, ws_port))
    except KeyboardInterrupt:
        click.echo("\n[inkflow] stopped")


@main.command()
@click.argument("files", nargs=-1, required=True, type=click.Path(path_type=Path))
@click.option(
    "--stdout",
    "to_stdout",
    is_flag=True,
    help="Write to stdout instead of modifying files in place",
)
def clean(files: tuple[Path, ...], to_stdout: bool) -> None:
    """Strip Inkscape editor metadata from SVG files."""
    errors = False
    for p in files:
        if not p.exists():
            click.echo(f"[inkflow] clean: not found: {p}", err=True)
            errors = True
            continue
        try:
            cleaned = clean_inkscape_svg(p)
            if to_stdout:
                sys.stdout.write(cleaned)
            else:
                p.write_text(cleaned, encoding="utf-8")
                click.echo(f"[inkflow] cleaned {p}")
        except Exception as exc:
            click.echo(f"[inkflow] clean: error processing {p}: {exc}", err=True)
            errors = True
    if errors:
        sys.exit(1)


@main.command("setup-git")
def setup_git() -> None:
    """Configure git hooks and SVG diff driver (run once after cloning)."""
    steps = [
        (
            ["git", "config", "core.hooksPath", ".githooks"],
            "pre-commit hook → .githooks/pre-commit",
        ),
        (
            [
                "git",
                "config",
                "diff.inkscape-svg.textconv",
                "uv run inkflow clean --stdout",
            ],
            "SVG diff driver → strips Inkscape metadata before diffs",
        ),
    ]
    for cmd, label in steps:
        try:
            _ = subprocess.run(cmd, check=True, capture_output=True)
            click.echo(f"[inkflow] {label}")
        except subprocess.CalledProcessError as exc:
            stderr = cast(bytes | None, exc.stderr)
            msg = stderr.decode().strip() if isinstance(stderr, bytes) else str(exc)
            raise click.ClickException(f"setup-git failed: {msg}") from exc
    hook = Path(".githooks/pre-commit")
    if hook.exists():
        hook.chmod(hook.stat().st_mode | 0o111)
    click.echo("[inkflow] done — git is configured for this repository")


@main.command("inject-layout")
@click.argument("deck", default="deck.py", type=click.Path(path_type=Path))
@click.option(
    "--check",
    is_flag=True,
    help="Report stale files without rewriting them. Exits 1 if any are stale.",
)
def inject_layout_cmd(deck: Path, check: bool) -> None:
    """Refresh ancestor layout layers in all slide SVGs for Inkscape preview."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")

    deck_obj = load_deck(deck_path)
    project_dir = deck_path.parent
    stale_found = False

    for slide in deck_obj.slides:
        svg_src = slide.layout if isinstance(slide, MarkdownSlide) else slide.src
        svg_path = (project_dir / svg_src).resolve()
        chain = resolve_chain(svg_path, project_dir, deck_obj.themes)
        if not chain:
            continue

        if check:
            if is_layout_current(svg_path, chain):
                click.echo(f"[ok]     {slide.src}")
            else:
                click.echo(f"[stale]  {slide.src}")
                stale_found = True
        else:
            changed = inject_layout_layers(svg_path, chain)
            if changed:
                click.echo(f"[injected]    {slide.src}")
            else:
                click.echo(f"[up to date]  {slide.src}")

    if check and stale_found:
        sys.exit(1)


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

    PARENT is an inkflow:parent string: 'theme:layouts/foo', 'root:layouts/foo',
    or a relative path. OUTPUT is the path for the new SVG file.
    """
    from lxml import etree as _etree

    resolved_deck = Path(deck_path).resolve()
    if not resolved_deck.exists():
        raise click.ClickException(f"deck not found: {resolved_deck}")

    deck_obj = load_deck(resolved_deck)
    project_dir = resolved_deck.parent
    output_path = Path(output).resolve()

    if output_path.exists():
        raise click.ClickException(f"file already exists: {output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Resolve parent to get viewBox from the parent SVG if available.
    try:
        parent_abs = resolve_parent_path(
            parent, output_path, project_dir, deck_obj.themes
        )
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    view_box = "0 0 1920 1080"
    width = "1920"
    height = "1080"
    if parent_abs.exists():
        anc_root = _etree.parse(parent_abs).getroot()
        if anc_root.get("viewBox"):
            view_box = anc_root.get("viewBox", view_box)
            width = anc_root.get("width", width)
            height = anc_root.get("height", height)

    svg_content = (
        f'<svg xmlns="{ns.SVG}"\n'
        f'     xmlns:inkflow="{ns.INKFLOW}"\n'
        f'     inkflow:parent="{parent}"\n'
        f'     viewBox="{view_box}" width="{width}" height="{height}">\n'
        f"</svg>\n"
    )
    output_path.write_text(svg_content, encoding="utf-8")

    chain = resolve_chain(output_path, project_dir, deck_obj.themes)
    if chain:
        inject_layout_layers(output_path, chain)

    output_rel = output_path.relative_to(project_dir)
    click.echo(f"[inkflow] created {output_rel}")
    click.echo("[inkflow] add to deck.py:")
    click.echo(f'    Slide("{output_rel}"),')
