from __future__ import annotations

import asyncio
import contextlib
import importlib.resources
import importlib.util
import json
import sys
import traceback
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypedDict, cast

from watchfiles import awatch  # pyright: ignore[reportUnknownVariableType]
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve

from inkflow.manifest import Deck
from inkflow.pipeline import process_deck

# ── Shared mutable state ──────────────────────────────────────────────────────


class _State(TypedDict):
    slides: list[str]
    ws_clients: set[ServerConnection]
    error: str | None


_state: _State = {
    "slides": [],
    "ws_clients": set(),
    "error": None,
}


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


async def rebuild(deck_path: Path) -> None:
    try:
        deck = await asyncio.to_thread(load_deck, deck_path)
        project_dir = deck_path.parent
        slides = await asyncio.to_thread(process_deck, deck, project_dir)
        _state["slides"] = slides
        _state["error"] = None
        print(f"[inkflow] built {len(slides)} slide(s)")
        await broadcast(json.dumps({"type": "update", "slides": slides}))
    except Exception as exc:
        tb = traceback.format_exc()
        _state["error"] = tb
        print(f"[inkflow] build error: {exc}", file=sys.stderr)
        await broadcast(json.dumps({"type": "error", "message": tb}))


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
    try:
        await websocket.wait_closed()
    finally:
        _state["ws_clients"].discard(websocket)


# ── HTTP handler ──────────────────────────────────────────────────────────────

_StreamHandler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


def _build_html(ws_port: int) -> bytes:
    template = (
        importlib.resources.files("inkflow")
        .joinpath("presenter.html")
        .read_text(encoding="utf-8")
    )
    html = (
        template.replace("__SLIDES_JSON__", json.dumps(_state["slides"]))
        .replace("__WS_PORT__", str(ws_port))
        .replace("__ERROR_JSON__", json.dumps(_state["error"]))
    )
    return html.encode("utf-8")


def make_http_handler(ws_port: int) -> _StreamHandler:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            await asyncio.wait_for(reader.read(4096), timeout=10)
            body = _build_html(ws_port)
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


async def _watch(deck_path: Path) -> None:
    async for _changes in awatch(str(deck_path.parent)):
        print("[inkflow] change detected, rebuilding…")
        await rebuild(deck_path)


# ── Public entry point ────────────────────────────────────────────────────────


async def serve(deck_path: Path, http_port: int, ws_port: int) -> None:
    print(f"[inkflow] loading {deck_path}")
    await rebuild(deck_path)

    http_handler = make_http_handler(ws_port)
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
