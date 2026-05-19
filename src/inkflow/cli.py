from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from typing import cast

import click

from inkflow.pipeline import clean_inkscape_svg
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
