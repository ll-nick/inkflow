from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.export import build_pdf, build_static_html
from inkflow.server import serve as _serve


@main.command()
@deck_option
@click.option(
    "--host",
    default="localhost",
    show_default=True,
    help="Bind address",
)
@click.option("--port", default=7777, show_default=True, help="HTTP port")
@click.option("--ws-port", default=7778, show_default=True, help="WebSocket port")
def serve(deck_path: Path, host: str, port: int, ws_port: int) -> None:
    """Start the presentation server."""
    resolved = resolve_deck_path(deck_path)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_serve(resolved, host, port, ws_port))


@main.command("build")
@deck_option
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output directory (default: build/ next to deck.py)",
)
def build_cmd(deck_path: Path, output: str | None) -> None:
    """Export a self-contained presentation directory for offline use."""
    resolved = resolve_deck_path(deck_path)
    out_dir = Path(output).resolve() if output else resolved.parent / "build"
    try:
        warnings = build_static_html(resolved, out_dir)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    for w in warnings:
        click.echo(click.style(f" ⚠  {w}", fg="yellow"))
    click.echo(f"[inkflow] built {out_dir / 'index.html'}")


@main.command("export")
@deck_option
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
@click.option(
    "--size",
    default=None,
    metavar="WxH",
    help="Override PDF page size, e.g. 1280x720. Auto-detected from slides if not set.",
)
def export_cmd(
    deck_path: Path,
    output: str | None,
    chromium: str | None,
    no_sandbox: bool,
    size: str | None,
) -> None:
    """Export a PDF via headless Chromium (one page per slide)."""
    resolved = resolve_deck_path(deck_path)
    out = Path(output).resolve() if output else resolved.with_suffix(".pdf")
    parsed_size: tuple[int, int] | None = None
    if size is not None:
        try:
            parts = size.lower().split("x")
            parsed_size = (int(parts[0]), int(parts[1]))
        except (ValueError, IndexError):
            raise click.ClickException(
                f"--size must be WxH (e.g. 1920x1080), got: {size!r}"
            ) from None
    try:
        warnings = build_pdf(resolved, out, chromium, no_sandbox, size=parsed_size)
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    for w in warnings:
        click.echo(click.style(f" ⚠  {w}", fg="yellow"))
    click.echo(f"[inkflow] exported {out}")
