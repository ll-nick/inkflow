from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.export import build_pdf, build_static_html
from inkflow.logging import Levels, report
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
@click.pass_obj
def serve(levels: Levels, deck_path: Path, host: str, port: int, ws_port: int) -> None:
    """Start the presentation server with live reload.

    Serves the deck at `http://{host}:{port}` and pushes slide updates over a
    WebSocket whenever a source file changes, swapping content in place without a
    full page reload. Use `--host 0.0.0.0` to expose the server on all interfaces.

    Keyboard shortcuts in the terminal:

    - `o`: open the presentation in a browser
    - `r`: force a rebuild
    - `t`: toggle the error trace
    - `q`: quit (Ctrl-D and Ctrl-C also work)
    """
    resolved = resolve_deck_path(deck_path)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_serve(resolved, host, port, ws_port, levels))


@main.command("build")
@deck_option
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output directory (default: build/ next to deck.py)",
)
@click.option(
    "--inline-assets",
    "inline_assets",
    is_flag=True,
    help="Embed images and video as data URIs so the build is index.html alone.",
)
def build_cmd(deck_path: Path, output: str | None, inline_assets: bool) -> None:
    """Export a self-contained presentation directory for offline use.

    Produces an `index.html` with every slide inlined and copies any assets the
    deck references into the output directory. No server is required to view it.
    Defaults to a `build/` directory next to `deck.py`.

    `--inline-assets` embeds those assets in the HTML instead of copying them, so
    the whole deck is one file that cannot be separated from its images — worth it
    when the deck travels through a file picker, a chat window, or a sandboxed
    browser that only ever hands over the file you point at. The file grows by
    roughly a third of every asset, counted once per reference rather than once
    per file, and every byte of it loads before the first slide renders.
    """
    resolved = resolve_deck_path(deck_path)
    out_dir = Path(output).resolve() if output else resolved.parent / "build"
    try:
        build_static_html(resolved, out_dir, inline_assets=inline_assets)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    index = out_dir / "index.html"
    size = f" ({index.stat().st_size / 1_000_000:.1f} MB)" if inline_assets else ""
    report("Built", f"{index}{size}")


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
    """Export a PDF via headless Chromium — one page per slide, no animations.

    Requires a Chromium-based browser on the system; point `--chromium` at it if
    it is not auto-detected. Pass `--no-sandbox` when running as root or in
    Docker. Defaults to `<deck-stem>.pdf` next to `deck.py`.
    """
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
        build_pdf(resolved, out, chromium, no_sandbox, size=parsed_size)
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    report("Exported", str(out))
