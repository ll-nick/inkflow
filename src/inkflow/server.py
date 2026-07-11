from __future__ import annotations

import asyncio
import contextlib
import errno
import importlib.resources
import importlib.util
import json
import os
import signal
import sys
import termios
import time
import traceback
import tty
import webbrowser
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypedDict, cast
from urllib.parse import unquote

from rich.console import Console
from rich.live import Live
from rich.text import Text
from watchfiles import awatch  # pyright: ignore[reportUnknownVariableType]
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve

from inkflow.enums import ColorMode
from inkflow.fonts import embed_fonts_css
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.tui import LiveUI

# ── Shared mutable state ──────────────────────────────────────────────────────


class State(TypedDict):
    slides: list[SlideData]
    transitions: list[dict[str, object]]
    ws_clients: set[ServerConnection]
    error: str | None
    styles_css: str
    scripts_js: str
    mode: ColorMode
    position: dict[str, int]


_state: State = {
    "slides": [],
    "transitions": [],
    "ws_clients": set(),
    "error": None,
    "styles_css": "",
    "scripts_js": "",
    "mode": ColorMode.DARK,
    "position": {"slideIndex": 0, "step": 0},
}


# ── Deck loader ───────────────────────────────────────────────────────────────


def load_deck(deck_path: Path) -> Deck:
    spec = importlib.util.spec_from_file_location("_inkflow_deck", deck_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {deck_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "main"):
        raise AttributeError(f"{deck_path} must define a main() -> Deck function")
    return cast(Callable[[], Deck], mod.main)()


# ── Build pipeline ────────────────────────────────────────────────────────────


async def rebuild(deck_path: Path, ui: LiveUI, levels: Levels) -> None:
    ui.set_building()

    async def _animate() -> None:
        while True:
            await asyncio.sleep(0.1)
            ui.refresh()

    spin = asyncio.create_task(_animate())
    t0 = time.monotonic()
    try:
        deck = await asyncio.to_thread(load_deck, deck_path)
        project_dir = deck_path.parent
        slides = await asyncio.to_thread(process_deck, deck, project_dir)
        transitions = resolve_transitions(deck)
        styles_css = await asyncio.to_thread(load_deck_styles, deck, project_dir)
        if deck.embed_fonts:
            font_css, font_warnings = await asyncio.to_thread(
                embed_fonts_css, slides, project_dir
            )
        else:
            font_css, font_warnings = "", []
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()
        scripts_js = await asyncio.to_thread(load_deck_scripts, deck, project_dir)
        _state["slides"] = slides
        _state["transitions"] = transitions
        _state["styles_css"] = styles_css
        _state["scripts_js"] = scripts_js
        _state["mode"] = deck.mode
        _state["error"] = None
        if slides:
            cur = _state["position"]["slideIndex"]
            _state["position"]["slideIndex"] = max(0, min(len(slides) - 1, cur))
        else:
            _state["position"]["slideIndex"] = 0
        _state["position"]["step"] = 0
        ui.set_ok(len(slides), time.monotonic() - t0, warnings=font_warnings)
        await broadcast(
            json.dumps({"type": "update", "slides": slides, "transitions": transitions})
        )
    except Exception:
        tb = traceback.format_exc()
        _state["error"] = tb
        ui.set_error(tb)
        await broadcast(json.dumps({"type": "error", "message": tb}))
    finally:
        spin.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await spin
        ui.refresh()


# ── WebSocket broadcast ───────────────────────────────────────────────────────


async def broadcast(msg: str, sender: ServerConnection | None = None) -> None:
    dead: set[ServerConnection] = set()
    for ws in list(_state["ws_clients"]):
        if ws is sender:
            continue
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    _state["ws_clients"] -= dead


# ── WebSocket handler ─────────────────────────────────────────────────────────


def _coerce_nav_position(
    msg: dict[str, object], n_slides: int
) -> dict[str, int] | None:
    """Validate and clamp a `nav` payload's slideIndex/step.

    Returns None when the values cannot be coerced to ints (a hostile or buggy
    sender), so the caller can drop the frame instead of tearing down the
    connection. slideIndex is clamped to [0, n_slides-1] (or 0 for an empty deck)
    and step to >= 0, so the stored position is always valid regardless of sender.
    """
    try:
        slide_index = int(cast(int, msg.get("slideIndex", 0)))
        step = int(cast(int, msg.get("step", 0)))
    except (ValueError, TypeError):
        return None
    slide_index = max(0, min(n_slides - 1, slide_index)) if n_slides > 0 else 0
    step = max(0, step)
    return {"slideIndex": slide_index, "step": step}


def make_ws_handler(ui: LiveUI) -> Callable[[ServerConnection], Awaitable[None]]:
    async def handler(websocket: ServerConnection) -> None:
        _state["ws_clients"].add(websocket)
        ui.refresh()
        try:
            pos = _state["position"]
            await websocket.send(
                json.dumps(
                    {
                        "type": "position",
                        "slideIndex": pos["slideIndex"],
                        "step": pos["step"],
                    }
                )
            )
            async for raw in websocket:
                try:
                    parsed = cast(object, json.loads(raw))
                except (ValueError, TypeError):
                    continue
                if not isinstance(parsed, dict):
                    continue
                msg = cast(dict[str, object], parsed)
                msg_type = msg.get("type")
                if msg_type == "sync-request":
                    # A client that just switched into a receiving sync mode asks
                    # for the current position. Reply to it alone, not a broadcast.
                    cur = _state["position"]
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "position",
                                "slideIndex": cur["slideIndex"],
                                "step": cur["step"],
                            }
                        )
                    )
                elif msg_type == "nav":
                    pos = _coerce_nav_position(msg, len(_state["slides"]))
                    if pos is None:
                        continue
                    _state["position"] = pos
                    position_msg: dict[str, object] = {
                        "type": "position",
                        "slideIndex": pos["slideIndex"],
                        "step": pos["step"],
                    }
                    nav_transition = msg.get("transition")
                    if nav_transition:
                        position_msg["transition"] = nav_transition
                    if msg.get("snap"):
                        position_msg["snap"] = True
                    await broadcast(json.dumps(position_msg), sender=websocket)
        finally:
            _state["ws_clients"].discard(websocket)
            ui.refresh()

    return handler


# ── HTTP handler ──────────────────────────────────────────────────────────────

_StreamHandler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


def build_html(state: State, ws_port: int | None) -> bytes:
    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("presenter.html").read_text(encoding="utf-8")
    css = pkg.joinpath("bundles", "presenter.css").read_text(encoding="utf-8")
    js = pkg.joinpath("bundles", "presenter.js").read_text(encoding="utf-8")
    data_theme = "" if state["mode"] == ColorMode.DARK else "light"
    ws_port_js = "null" if ws_port is None else str(ws_port)
    html = (
        template.replace("/* __CSS__ */", css)
        .replace("/* __JS__ */", js)
        .replace("/* __STYLES__ */", state["styles_css"])
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES_JSON__", json.dumps(state["slides"]))
        .replace("__TRANSITIONS_JSON__", json.dumps(state["transitions"]))
        .replace("/* __SCRIPTS__ */", state["scripts_js"])
        .replace("__WS_PORT__", ws_port_js)
        .replace("__ERROR_JSON__", json.dumps(state["error"]))
    )
    return html.encode("utf-8")


_MIME_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "video/ogg",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}
_SERVED_SUFFIXES = set(_MIME_TYPES)


def _resolve_asset(project_dir: Path, request_path: str) -> Path | None:
    decoded = unquote(request_path)
    candidate = project_dir / decoded.lstrip("/")
    # Collapse .. without following symlinks — blocks traversal while allowing
    # symlinks inside project_dir that point outside it.
    normalized = Path(os.path.normpath(candidate))
    if not normalized.is_relative_to(project_dir):
        return None
    if normalized.suffix.lower() not in _SERVED_SUFFIXES:
        return None
    resolved = candidate.resolve()
    if not resolved.is_file():
        return None
    return resolved


def make_http_handler(ws_port: int, project_dir: Path | None = None) -> _StreamHandler:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            raw = await asyncio.wait_for(reader.read(4096), timeout=10)
            request_line = raw.split(b"\r\n", 1)[0].decode(errors="replace")
            parts = request_line.split(" ", 2)
            request_path = parts[1] if len(parts) >= 2 else "/"

            if project_dir is not None and request_path != "/":
                asset_path = _resolve_asset(project_dir, request_path)
                if asset_path is not None:
                    mime = _MIME_TYPES[asset_path.suffix.lower()]
                    body = asset_path.read_bytes()
                    header = (
                        b"HTTP/1.1 200 OK\r\n"
                        + f"Content-Type: {mime}\r\n".encode()
                        + b"Cache-Control: no-store\r\n"
                        + b"Connection: close\r\n"
                        + b"Content-Length: "
                        + str(len(body)).encode()
                        + b"\r\n\r\n"
                    )
                    writer.write(header + body)
                    await writer.drain()
                    return

            body = build_html(_state, ws_port)
            header = (
                b"HTTP/1.1 200 OK\r\n"
                + b"Content-Type: text/html; charset=utf-8\r\n"
                + b"Cache-Control: no-store\r\n"
                + b"Connection: close\r\n"
                + b"Content-Length: "
                + str(len(body)).encode()
                + b"\r\n\r\n"
            )
            writer.write(header + body)

            await writer.drain()
        except Exception:
            # TODO: add logging on top of server response errors
            body = traceback.format_exc().encode()
            try:
                header = (
                    b"HTTP/1.1 500 Internal Server Error\r\n"
                    + b"Content-Type: text/plain; charset=utf-8\r\n"
                    + b"Cache-Control: no-store\r\n"
                    + b"Connection: close\r\n"
                    + b"Content-Length: "
                    + str(len(body)).encode()
                    + b"\r\n\r\n"
                )
                writer.write(header + body)
                await writer.drain()
            except Exception:
                pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    return handler


# ── File watcher ──────────────────────────────────────────────────────────────


async def _watch(
    deck_path: Path, ui: LiveUI, lock: asyncio.Lock, levels: Levels
) -> None:
    async for changes in awatch(str(deck_path.parent)):
        logger.debug(f"change detected in {len(changes)} file(s), rebuilding")
        async with lock:
            await rebuild(deck_path, ui, levels)


# ── Keyboard handler ──────────────────────────────────────────────────────────


def _open_browser(url: str) -> None:
    # Redirect fd 1/2 to /dev/null so the browser process can't write startup
    # noise to the terminal and corrupt the Rich Live cursor tracking.
    devnull = os.open(os.devnull, os.O_WRONLY)
    saved_out = os.dup(1)
    saved_err = os.dup(2)
    try:
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        webbrowser.open(url)
    finally:
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(devnull)
        os.close(saved_out)
        os.close(saved_err)


async def _read_keys(
    deck_path: Path,
    host: str,
    http_port: int,
    ui: LiveUI,
    lock: asyncio.Lock,
    shutdown: asyncio.Event,
    levels: Levels,
) -> None:
    if not sys.stdin.isatty():
        return

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str] = asyncio.Queue()

    def _on_stdin() -> None:
        ch = sys.stdin.read(1)
        loop.call_soon_threadsafe(queue.put_nowait, ch)

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)  # single-char reads, output processing (ONLCR) intact
        loop.add_reader(fd, _on_stdin)
        while True:
            ch = await queue.get()
            if ch in ("\x04", "q"):  # Ctrl-D, q (Ctrl-C handled via SIGINT)
                shutdown.set()
                return
            elif ch == "o":
                _open_browser(f"http://{host}:{http_port}")
            elif ch == "r":
                async with lock:
                    await rebuild(deck_path, ui, levels)
            elif ch == "t":
                ui.toggle_trace()
    finally:
        loop.remove_reader(fd)
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


# ── Public entry point ────────────────────────────────────────────────────────


async def serve(
    deck_path: Path, host: str, http_port: int, ws_port: int, levels: Levels
) -> None:
    console = Console()
    rebuild_lock = asyncio.Lock()
    shutdown = asyncio.Event()

    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGINT, shutdown.set)
    loop.add_signal_handler(signal.SIGTERM, shutdown.set)

    try:
        http_handler = make_http_handler(ws_port, deck_path.parent)
        # Bind before the Live UI so port conflicts fail fast with a clean message
        try:
            http_server = await asyncio.start_server(http_handler, host, http_port)
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                msg = (
                    f"[red]error:[/red] port {http_port} is already in use."
                    f" Pass [dim]--port PORT[/dim] to serve on a different port."
                )
                console.print(msg)
                return
            raise

        with Live(Text(""), console=console, auto_refresh=False) as live:
            ui = LiveUI(
                live,
                host,
                http_port,
                deck_path.parent,
                get_clients=lambda: len(_state["ws_clients"]),
            )
            try:
                async with (
                    http_server,
                    ws_serve(make_ws_handler(ui), host, ws_port),
                ):
                    await rebuild(deck_path, ui, levels)
                    tasks = [
                        asyncio.create_task(http_server.serve_forever()),
                        asyncio.create_task(
                            _watch(deck_path, ui, rebuild_lock, levels)
                        ),
                        asyncio.create_task(
                            _read_keys(
                                deck_path,
                                host,
                                http_port,
                                ui,
                                rebuild_lock,
                                shutdown,
                                levels,
                            )
                        ),
                    ]
                    await shutdown.wait()
                    for t in tasks:
                        t.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
            except OSError as e:
                if e.errno == errno.EADDRINUSE:
                    msg = (
                        f"[red]error:[/red] port {ws_port} is already in use."
                        f" Pass [dim]--ws-port PORT[/dim] to use a different one."
                    )
                    console.print(msg)
                else:
                    raise
    finally:
        loop.remove_signal_handler(signal.SIGINT)
        loop.remove_signal_handler(signal.SIGTERM)
