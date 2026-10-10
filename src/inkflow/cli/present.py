from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from urllib.parse import quote

import click

from inkflow import instances
from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.editor.session import Exporters
from inkflow.export import build_pdf, build_static_html
from inkflow.logging import Levels, report
from inkflow.server import DEFAULT_PORT, open_browser, pick_ports
from inkflow.server import serve as _serve
from inkflow.sizes import PageSize

# The editor's Export dialog runs the same builds as the commands below.
EXPORTERS = Exporters(html=build_static_html, pdf=build_pdf)


@main.command()
@deck_option
@click.option(
    "--host",
    default="localhost",
    show_default=True,
    help="Bind address",
)
@click.option(
    "--port",
    type=int,
    default=None,
    help="HTTP port [default: 7777, or the next free one]",
)
@click.option(
    "--ws-port",
    type=int,
    default=None,
    help="WebSocket port [default: the HTTP port + 1, or the next free one]",
)
@click.pass_obj
def serve(
    levels: Levels, deck_path: Path, host: str, port: int | None, ws_port: int | None
) -> None:
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
    if _already_served(resolved, "/", open_it=False):
        return
    auto = port is None and ws_port is None
    port, ws_port = _ports(host, port, ws_port)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(
            _serve(
                resolved,
                host,
                port,
                ws_port,
                levels,
                exporters=EXPORTERS,
                auto_ports=auto,
            )
        )


def _ports(host: str, port: int | None, ws_port: int | None) -> tuple[int, int]:
    """The ports to serve on; says so when the default ones are taken (another
    deck's server, such as the author's editor while an agent previews its
    worktree), since the address is then not the usual one."""
    picked = pick_ports(host, port, ws_port)
    if port is None and picked[0] != DEFAULT_PORT:
        report("Ports", f"{DEFAULT_PORT} is taken: using {picked[0]} (and {picked[1]})")
    return picked


def _already_served(deck_py: Path, path: str, *, open_it: bool) -> bool:
    """One server per deck: when another inkflow already serves ``deck_py``,
    say where (and open it) instead of starting a second one that would write
    the same files."""
    other = instances.serving(deck_py)
    if other is None:
        return False
    report("Already open", f"{other.url(path)} (process {other.pid})")
    if open_it:
        open_browser(other.url(path))
    return True


@main.command()
@deck_option
@click.option(
    "--host",
    default="localhost",
    show_default=True,
    help="Bind address",
)
@click.option(
    "--port",
    type=int,
    default=None,
    help="HTTP port [default: 7777, or the next free one]",
)
@click.option(
    "--ws-port",
    type=int,
    default=None,
    help="WebSocket port [default: the HTTP port + 1, or the next free one]",
)
@click.option(
    "--no-open",
    "no_open",
    is_flag=True,
    help="Do not open the editor in a browser on start.",
)
@click.option(
    "--start",
    "start",
    is_flag=True,
    help="Open the start page (new deck, open a deck, recent decks) instead of a deck.",
)
@click.option(
    "--quit-when-idle",
    "quit_when_idle",
    type=float,
    is_flag=False,
    flag_value=60.0,
    default=None,
    metavar="SECONDS",
    help="Stop once no editor or presenter page has been open this long "
    + "[default when given: 60]. For a server without a terminal.",
)
@click.option(
    "--compare",
    "compare_with",
    default=None,
    metavar="REV|PATH",
    help="Open the compare view: the working copy beside a git revision "
    + "(branch, tag, sha, HEAD~2) or another deck folder.",
)
@click.pass_obj
def edit(
    levels: Levels,
    deck_path: Path,
    host: str,
    port: int | None,
    ws_port: int | None,
    no_open: bool,
    start: bool,
    quit_when_idle: float | None,
    compare_with: str | None,
) -> None:
    """Open the visual editor: click, drag and type on your slides.

    Runs the same server as `serve` and opens `http://{host}:{port}/edit`. Every
    change is written straight back to the deck's own files (slide SVGs, Markdown,
    `deck.py`), so the editor, Inkscape, your text editor and an agent such as
    Claude Code can all work on the deck at once; each sees the others' edits live.
    The presenter stays at `/`. Run it once per deck to edit several side by
    side: each picks the next free ports, and slides copied in one editor paste
    into another.

    Without a deck (`--start`, or no `deck.py` here and no `--deck`), the
    editor opens on its start page: create a new deck, open one from a folder,
    or pick a recent one. `inkflow setup-desktop` adds a launcher for that to
    the desktop's application menu.

    One server per deck: if another inkflow already has the deck open, this
    opens its editor instead of starting a second server for the same files.

    Keyboard shortcuts in the terminal are those of `serve`, plus `e` to open the
    editor again.
    """
    resolved: Path | None
    page = "/edit"
    if compare_with:
        # A path is passed as one the server can find from anywhere.
        candidate = Path(compare_with).expanduser()
        spec = str(candidate.resolve()) if candidate.exists() else compare_with
        page = f"/edit?compare={quote(spec, safe='')}"
    if start or (deck_path == Path("deck.py") and not deck_path.exists()):
        resolved = None
        report("Starting", "no deck here: the editor opens on its start page")
    else:
        resolved = resolve_deck_path(deck_path)
        if _already_served(resolved, page, open_it=not no_open):
            return
    open_path = None if no_open else page
    auto = port is None and ws_port is None
    port, ws_port = _ports(host, port, ws_port)
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(
            _serve(
                resolved,
                host,
                port,
                ws_port,
                levels,
                open_path,
                exporters=EXPORTERS,
                quit_when_idle=quit_when_idle,
                auto_ports=auto,
            )
        )


@main.command("build")
@deck_option
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output directory (default: build/ next to deck.py)",
)
@click.option(
    "--assets-folder",
    "assets_folder",
    is_flag=True,
    help="Copy images and videos beside index.html instead of inside it.",
)
@click.option(
    "--inline-assets",
    "inline_assets",
    is_flag=True,
    hidden=True,
    help="What a build does by default now; kept so older scripts still work.",
)
def build_cmd(
    deck_path: Path, output: str | None, assets_folder: bool, inline_assets: bool
) -> None:
    """Export the presentation as one self-contained HTML file.

    Writes `index.html` (in a `build/` directory next to `deck.py` unless
    `--output` names another) with every slide, picture, video and font inside
    it: it opens offline in any browser, from a file picker, a chat window or
    a USB stick, and makes no request to any server. Fonts are subset to the
    characters the deck uses.

    `--assets-folder` copies the pictures and videos into the output directory
    next to `index.html` instead, the better shape for a large deck (videos
    above all) on a web host: the page shows its first slide at once and each
    file loads when its slide needs it. The two then travel together. A single
    file larger than 50 MB is reported with its largest assets.
    """
    del inline_assets  # the default
    resolved = resolve_deck_path(deck_path)
    out_dir = Path(output).resolve() if output else resolved.parent / "build"
    try:
        build_static_html(resolved, out_dir, inline_assets=not assets_folder)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    index = out_dir / "index.html"
    report("Built", f"{index} ({index.stat().st_size / 1_000_000:.1f} MB)")


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
    metavar="SIZE",
    help="Page size for every page: a0, a1-landscape, letter, 841x1189mm, "
    + "36x48in or 1920x1080 (px). Default: the deck's size, else each slide's own.",
)
@click.option(
    "--bleed",
    default=None,
    metavar="LENGTH",
    help="Print the background this far past each trimmed edge, for a print "
    + "shop that asks for bleed (3mm, 0.125in; a bare number is mm).",
)
@click.option(
    "--crop-marks",
    "crop_marks",
    is_flag=True,
    help="Mark each page's corners outside the bleed, where it is to be cut.",
)
def export_cmd(
    deck_path: Path,
    output: str | None,
    chromium: str | None,
    no_sandbox: bool,
    size: str | None,
    bleed: str | None,
    crop_marks: bool,
) -> None:
    """Export a PDF via headless Chromium — one page per slide, no animations.

    Each page is the deck's size (`Deck(size="a0")`): a poster prints at its
    final size, as vector text and graphics. A deck without a size prints each
    slide at its own: an SVG's `width`/`height` in mm, cm or inches (an Inkscape
    A0 page), else its viewBox at 1 unit = 1 px. `--size` prints every slide on
    one sheet instead, scaled to fit (a poster drawn for A0 prints on A1).

    Requires a Chromium-based browser on the system; point `--chromium` at it if
    it is not auto-detected. Pass `--no-sandbox` when running as root or in
    Docker. Defaults to `<deck-stem>.pdf` next to `deck.py`.
    """
    resolved = resolve_deck_path(deck_path)
    out = Path(output).resolve() if output else resolved.with_suffix(".pdf")
    try:
        sheet = PageSize(size) if size is not None else None
    except ValueError as exc:
        raise click.ClickException(f"--size: {exc}") from None
    try:
        build_pdf(
            resolved,
            out,
            chromium,
            no_sandbox or (hasattr(os, "geteuid") and os.geteuid() == 0),
            size=sheet,
            bleed=bleed,
            crop_marks=crop_marks,
        )
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    report("Exported", str(out))
