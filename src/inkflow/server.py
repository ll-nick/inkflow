from __future__ import annotations

import asyncio
import contextlib
import errno
import importlib.resources
import importlib.util
import json
import signal
import sys
import termios
import time
import traceback
import tty
import webbrowser
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import TypedDict, cast

from rich.console import Console, Group, RenderableType
from rich.live import Live
from rich.panel import Panel
from rich.spinner import Spinner
from rich.text import Text
from watchfiles import awatch  # pyright: ignore[reportUnknownVariableType]
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve

from inkflow.manifest import Deck
from inkflow.pipeline import process_deck, resolve_transitions

# ── Shared mutable state ──────────────────────────────────────────────────────


class _State(TypedDict):
    slides: list[str]
    transitions: list[dict[str, object]]
    ws_clients: set[ServerConnection]
    error: str | None
    styles_css: str
    dark_mode: bool


_state: _State = {
    "slides": [],
    "transitions": [],
    "ws_clients": set(),
    "error": None,
    "styles_css": "",
    "dark_mode": True,
}


# ── Live UI state ─────────────────────────────────────────────────────────────


class _LiveUI:
    """Owns the entire terminal UI: header panel + status line."""

    def __init__(
        self, live: Live, http_port: int, ws_port: int, watch_path: Path
    ) -> None:
        self._live: Live = live
        self._http_port: int = http_port
        self._ws_port: int = ws_port
        self._watch_path: Path = watch_path
        self._phase: str = "idle"  # "building" | "ok" | "error"
        self._slides: int = 0
        self._elapsed: float = 0.0
        self._built_at: str = ""
        self._error_tb: str | None = None
        self._show_trace: bool = False

    def _header(self) -> RenderableType:
        clients = len(_state["ws_clients"])
        client_str = f"{clients} client{'s' if clients != 1 else ''}"

        title = Text()
        title.append("ink", style="bold white")
        title.append("flow", style="bold blue")

        content = Group(
            Text.assemble(
                (f"http://localhost:{self._http_port}", "bold"),
                ("  ·  ", "dim"),
                (client_str, "dim"),
            ),
            Text.assemble(
                (str(self._watch_path), "dim"),
                overflow="ellipsis",
                no_wrap=True,
            ),
            Text(""),
            Text.assemble(
                ("o", "bold"),
                ("  open", "dim"),
                ("  ·  ", "dim"),
                ("r", "bold"),
                ("  rebuild", "dim"),
                ("  ·  ", "dim"),
                ("q", "bold"),
                ("  quit", "dim"),
            ),
        )
        return Panel(
            content, title=title, title_align="left", expand=False, padding=(0, 2)
        )

    def _renderable(self) -> RenderableType:
        parts: list[RenderableType] = [Text(""), self._header(), Text("")]

        if self._phase == "building":
            parts.append(Spinner("dots", text=" Building…"))
        elif self._phase == "ok":
            slide_word = "slide" if self._slides == 1 else "slides"
            summary = f" ✓  built {self._slides} {slide_word} in {self._elapsed:.2f}s"
            parts.append(
                Text.assemble(
                    (summary, "bold green"),
                    (" · ", "white"),
                    (self._built_at, "white"),
                )
            )
        elif self._phase == "error":
            tb = self._error_tb or ""
            last = next(
                (ln for ln in reversed(tb.splitlines()) if ln.strip()),
                "unknown error",
            )
            parts.append(Text(f"✗  {last}", style="bold red", no_wrap=True))
            if self._show_trace:
                for line in tb.rstrip().splitlines():
                    parts.append(Text(line, style="dim red"))
                parts.append(Text("[t] hide trace", style="dim"))
            else:
                parts.append(Text("[t] show trace", style="dim"))

        return Group(*parts)

    def refresh(self) -> None:
        self._live.update(self._renderable())
        self._live.refresh()

    def set_building(self) -> None:
        self._phase = "building"
        self.refresh()

    def set_ok(self, slides: int, elapsed: float) -> None:
        self._phase = "ok"
        self._slides = slides
        self._elapsed = elapsed
        self._built_at = datetime.now().strftime("%H:%M:%S")
        self._error_tb = None
        self._show_trace = False
        self.refresh()

    def set_error(self, tb: str) -> None:
        self._phase = "error"
        self._error_tb = tb
        self._show_trace = False
        self.refresh()

    def toggle_trace(self) -> None:
        if self._phase == "error":
            self._show_trace = not self._show_trace
            self.refresh()


_ui: _LiveUI | None = None


# ── Deck loader ───────────────────────────────────────────────────────────────


def load_deck(deck_path: Path) -> Deck:
    spec = importlib.util.spec_from_file_location("_inkflow_deck", deck_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {deck_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "deck"):
        raise AttributeError(
            f"{deck_path} must define a module-level variable named 'deck'"
        )
    return cast(Deck, mod.deck)


# ── Build pipeline ────────────────────────────────────────────────────────────


async def rebuild(deck_path: Path, ui: _LiveUI) -> None:
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
        styles_css = await asyncio.to_thread(_load_styles, deck, project_dir)
        _state["slides"] = slides
        _state["transitions"] = transitions
        _state["styles_css"] = styles_css
        _state["dark_mode"] = deck.dark_mode
        _state["error"] = None
        ui.set_ok(len(slides), time.monotonic() - t0)
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


async def broadcast(msg: str) -> None:
    dead: set[ServerConnection] = set()
    for ws in list(_state["ws_clients"]):
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    _state["ws_clients"] -= dead


# ── WebSocket handler ─────────────────────────────────────────────────────────


async def ws_handler(websocket: ServerConnection) -> None:
    _state["ws_clients"].add(websocket)
    if _ui is not None:
        _ui.refresh()
    try:
        await websocket.wait_closed()
    finally:
        _state["ws_clients"].discard(websocket)
        if _ui is not None:
            _ui.refresh()


# ── HTTP handler ──────────────────────────────────────────────────────────────

_StreamHandler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


def _load_styles(deck: Deck, project_dir: Path) -> str:
    from inkflow.layout import _resolve_theme_dir  # pyright: ignore[reportPrivateUsage]

    pkg = importlib.resources.files("inkflow")
    parts = [pkg.joinpath("theme", "styles.css").read_text(encoding="utf-8")]

    if deck.theme is not None:
        try:
            theme_dir = _resolve_theme_dir(deck.theme, project_dir)
            theme_css = theme_dir / "styles.css"
            if theme_css.exists():
                parts.append(theme_css.read_text(encoding="utf-8"))
        except ValueError:
            pass

    project_css = project_dir / "styles.css"
    if project_css.exists():
        parts.append(project_css.read_text(encoding="utf-8"))

    return "\n".join(parts)


def _build_html(ws_port: int, styles_css: str, dark_mode: bool) -> bytes:
    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("presenter.html").read_text(encoding="utf-8")
    css = pkg.joinpath("presenter.css").read_text(encoding="utf-8")
    js = pkg.joinpath("presenter.js").read_text(encoding="utf-8")
    data_theme = "" if dark_mode else "light"
    html = (
        template.replace("__CSS__", css)
        .replace("__JS__", js)
        .replace("__STYLES__", styles_css)
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES_JSON__", json.dumps(_state["slides"]))
        .replace("__WS_PORT__", str(ws_port))
        .replace("__ERROR_JSON__", json.dumps(_state["error"]))
        .replace("__TRANSITIONS_JSON__", json.dumps(_state["transitions"]))
    )
    return html.encode("utf-8")


_SERVED_SUFFIXES = {".mp4", ".webm", ".ogg", ".mov"}
_MIME_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "video/ogg",
    ".mov": "video/quicktime",
}


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
                asset_path = project_dir / request_path.lstrip("/")
                suffix = asset_path.suffix.lower()
                if asset_path.is_file() and suffix in _SERVED_SUFFIXES:
                    mime = _MIME_TYPES[suffix]
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

            body = _build_html(ws_port, _state["styles_css"], _state["dark_mode"])
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
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    return handler


# ── File watcher ──────────────────────────────────────────────────────────────


async def _watch(deck_path: Path, ui: _LiveUI, lock: asyncio.Lock) -> None:
    async for _changes in awatch(str(deck_path.parent)):
        if not lock.locked():  # skip if a rebuild is already in progress
            async with lock:
                await rebuild(deck_path, ui)


# ── Keyboard handler ──────────────────────────────────────────────────────────


async def _read_keys(
    deck_path: Path,
    http_port: int,
    ui: _LiveUI,
    lock: asyncio.Lock,
    shutdown: asyncio.Event,
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
                webbrowser.open(f"http://localhost:{http_port}")
            elif ch == "r":
                async with lock:
                    await rebuild(deck_path, ui)
            elif ch == "t":
                ui.toggle_trace()
    finally:
        loop.remove_reader(fd)
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


# ── Public entry point ────────────────────────────────────────────────────────


async def serve(deck_path: Path, http_port: int, ws_port: int) -> None:
    print(f"[inkflow] loading {deck_path}")
    await rebuild(deck_path)

    http_handler = make_http_handler(ws_port, deck_path.parent)
    http_server = await asyncio.start_server(http_handler, "127.0.0.1", http_port)

    print(f"[inkflow] http://localhost:{http_port}")
    print(f"[inkflow] ws://localhost:{ws_port}")
    print(f"[inkflow] watching {deck_path.parent}  (Ctrl-C to stop)")

    async with (
        http_server,
        ws_serve(ws_handler, "127.0.0.1", ws_port),
        asyncio.TaskGroup() as tg,
    ):
        tg.create_task(http_server.serve_forever())
        tg.create_task(_watch(deck_path))
