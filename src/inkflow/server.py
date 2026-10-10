from __future__ import annotations

import asyncio
import base64
import contextlib
import errno
import functools
import importlib.resources
import importlib.util
import io
import ipaddress
import json
import os
import re
import socket
import sys
import time
import traceback
import webbrowser
import zipfile
from collections.abc import Awaitable, Callable, Sequence
from html import escape as escape_html
from pathlib import Path
from typing import Literal, TypedDict, cast
from urllib.parse import unquote

from rich.console import Console
from rich.live import Live
from rich.text import Text
from typing_extensions import override
from watchfiles import (
    Change,
    DefaultFilter,
    awatch,  # pyright: ignore[reportUnknownVariableType]
)
from websockets.asyncio.server import ServerConnection
from websockets.asyncio.server import serve as ws_serve

from inkflow import instances
from inkflow.assets import MIME_TYPES, AssetRoots, is_local_ref, rewrite_references
from inkflow.edit import (
    NO_EDIT_COMMANDS,
    EditCommands,
    command_for,
    configured_suffixes,
    open_in_editor,
    resolve_edit_commands,
)
from inkflow.editor import projects
from inkflow.editor.comparehub import CompareHub, side_build_from
from inkflow.editor.comparesrc import CompareError
from inkflow.editor.context import write_context
from inkflow.editor.model import build_model
from inkflow.editor.session import EditError, EditorSession, Exporters
from inkflow.editor.svgops import file_hash
from inkflow.enums import ColorMode
from inkflow.fonts import (
    embed_fonts_css,
    font_mime,
    shipped_font_file,
    shipped_font_url,
    ui_fonts_css,
)
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import Levels, collect_logs, logger, report
from inkflow.manifest import Deck
from inkflow.os_compat import install_shutdown_handler, raw_keypresses
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.titles import resolve_deck_title
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
    logs: list[dict[str, str]]
    title: str
    theme_dir: Path | None
    """Active theme's asset directory, the second root an asset may live under.
    ``None`` until a deck has loaded, which is exactly when nothing can reference
    one yet."""


_state: State = {
    "slides": [],
    "transitions": [],
    "ws_clients": set(),
    "error": None,
    "styles_css": "",
    "scripts_js": "",
    "mode": ColorMode.DARK,
    "position": {"slideIndex": 0, "step": 0},
    "logs": [],
    "title": "Inkflow",
    "theme_dir": None,
}


class EditorState(TypedDict):
    deck: Deck | None
    """The last deck that built, which editor requests are validated against."""
    model: dict[str, object] | None
    """The visual editor's model for the last build (see ``editor.model``)."""
    clients: set[ServerConnection]
    """Connections that identified as an editor page."""
    session: EditorSession | None
    """Undo history and file writes for the editor (one per open deck)."""
    switch: asyncio.Event | None
    """Set when the editor asked to open another deck (see ``serve``)."""
    shutdown: asyncio.Event | None
    """Set to stop the server (the editor's "Quit Inkflow", or idle)."""
    failed_hash: str | None
    """Hash of the deck.py whose build failed last (None after a good build),
    so an agent waiting for its edit to build learns that it never will."""
    compare: CompareHub | None
    """The compare views of the open editor pages (editor/comparehub.py)."""


_editor: EditorState = {
    "deck": None,
    "model": None,
    "clients": set(),
    "session": None,
    "switch": None,
    "shutdown": None,
    "failed_hash": None,
    "compare": None,
}


# ── Deck loader ───────────────────────────────────────────────────────────────


class DeckError(Exception):
    """deck.py did not load: the file, line and error, without the traceback
    through inkflow (the cause stays chained for the server's error overlay)."""


def _deck_failure(deck_path: Path, exc: BaseException) -> str:
    """Where in deck.py ``exc`` happened, as ``deck.py:41: NameError: …``."""
    lineno, line = None, None
    if isinstance(exc, SyntaxError) and exc.filename == str(deck_path):
        lineno, line = exc.lineno, exc.text
    else:
        frames = [
            f
            for f in traceback.extract_tb(exc.__traceback__)
            if f.filename == str(deck_path)
        ]
        if frames:
            lineno, line = frames[-1].lineno, frames[-1].line
    where = f"{deck_path.name}:{lineno}" if lineno else deck_path.name
    detail = f"\n    {line.strip()}" if line and line.strip() else ""
    return f"{where}: {type(exc).__name__}: {exc}{detail}"


def load_deck(deck_path: Path, module: str = "_inkflow_deck") -> Deck:
    """Run deck.py's ``main()``; any failure in it is a ``DeckError``.

    ``module`` names the module it runs as: another deck loaded beside the one
    being served (a compare view's other side) takes its own name, so the
    served deck's custom animation classes stay the ones the editor finds."""
    try:
        return _load_deck(deck_path, module)
    except DeckError:
        raise
    except Exception as exc:
        raise DeckError(_deck_failure(deck_path, exc)) from exc


def _load_deck(deck_path: Path, module: str = "_inkflow_deck") -> Deck:
    spec = importlib.util.spec_from_file_location(module, deck_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {deck_path}")
    mod = importlib.util.module_from_spec(spec)
    # Keep the module in sys.modules for the process lifetime. Besides being the
    # recommended importlib pattern, it keeps any custom Animation/Transition
    # subclasses the deck defines strongly referenced, so `type=<Name>` markers
    # can still resolve them via Animation.__subclasses__() (a marker only holds
    # the class *name*, so nothing else keeps the class from being collected).
    # A live-reload re-load replaces this entry with the fresh module.
    sys.modules[spec.name] = mod
    # Compiled from source every time rather than through the loader: the
    # bytecode cache validates by mtime (whole seconds) and size, so an edit
    # that keeps the size (the editor reordering slides) within the same second
    # would load the stale cached code.
    code = compile(deck_path.read_bytes(), str(deck_path), "exec")
    exec(code, mod.__dict__)
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
    deck_hash: str | None = None
    try:
        # Collected, not printed, so records reach the TUI/browser without racing the
        # Live display. Floored at the lower surface level, then filtered per surface.
        with collect_logs(min(levels.console, levels.browser)) as entries:
            deck_hash = file_hash(deck_path.read_bytes())
            deck = await asyncio.to_thread(load_deck, deck_path)
            project_dir = deck_path.parent
            # The editor build stamps source locators on every element; the
            # presenter ignores them, so one build serves both pages.
            edit_slides = await asyncio.to_thread(
                functools.partial(process_deck, editor=True),
                deck,
                project_dir,
                deck_path,
            )
            model = await asyncio.to_thread(build_model, deck, deck_path, edit_slides)
            roots = AssetRoots(project_dir, deck.theme.asset_dir())
            slides = [_versioned(_without_edit(s), roots) for s in edit_slides]
            transitions = resolve_transitions(deck)
            styles_css = await asyncio.to_thread(load_deck_styles, deck, project_dir)
            if deck.embed_fonts:
                font_css = await asyncio.to_thread(
                    functools.partial(
                        embed_fonts_css,
                        styles_css=styles_css,
                        font_url=shipped_font_url,
                    ),
                    slides,
                    project_dir,
                    deck.theme.fonts_dir,
                )
            else:
                font_css = ""
            if font_css:
                styles_css = (font_css + "\n" + styles_css).strip()
            scripts_js = await asyncio.to_thread(load_deck_scripts, deck, project_dir)
        tui_logs = [e for e in entries if e.levelno >= levels.console]
        browser_logs = [
            {"level": e.level, "message": e.message}
            for e in entries
            if e.levelno >= levels.browser
        ]
        # Styles and colour mode change rarely (a theme edit) and can be large
        # (embedded fonts): they ride along only when they changed.
        changed: dict[str, object] = {}
        if styles_css != _state["styles_css"]:
            changed["styles"] = styles_css
        if deck.effective_mode != _state["mode"]:
            changed["mode"] = "" if deck.effective_mode == ColorMode.DARK else "light"
        _state["slides"] = slides
        _state["transitions"] = transitions
        _state["styles_css"] = styles_css
        _state["scripts_js"] = scripts_js
        _state["mode"] = deck.effective_mode
        _state["title"] = resolve_deck_title(deck, project_dir)
        _state["theme_dir"] = deck.theme.asset_dir()
        _editor["deck"] = deck
        _editor["model"] = model
        if _editor["session"] is not None:
            _editor["session"].built_hash = deck_hash
        _editor["failed_hash"] = None
        _state["error"] = None
        _state["logs"] = browser_logs
        if slides:
            cur = _state["position"]["slideIndex"]
            _state["position"]["slideIndex"] = max(0, min(len(slides) - 1, cur))
        else:
            _state["position"]["slideIndex"] = 0
        _state["position"]["step"] = 0
        ui.set_ok(len(slides), time.monotonic() - t0, logs=tui_logs)
        await broadcast(
            json.dumps(
                {
                    "type": "update",
                    "slides": slides,
                    "transitions": transitions,
                    "logs": browser_logs,
                    **changed,
                }
            )
        )
        await _send_editors(_model_message())
        hub = _editor["compare"]
        if hub is not None:
            await hub.live_built(
                await asyncio.to_thread(
                    side_build_from, deck, deck_path, edit_slides, model
                )
            )
    except Exception:
        # Outside collect_logs, so a fatal error reaches only the file sink. The overlay
        # and TUI error phase show it instead, never the banner.
        logger.exception("rebuild failed")
        tb = traceback.format_exc()
        _state["error"] = tb
        _editor["failed_hash"] = deck_hash
        ui.set_error(tb)
        await broadcast(json.dumps({"type": "error", "message": tb}))
    finally:
        spin.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await spin
        ui.refresh()


def _model_message() -> dict[str, object]:
    session = _editor["session"]
    return {
        "type": "editor-model",
        "model": _editor["model"],
        "history": {
            "canUndo": bool(session and session.history.done),
            "canRedo": bool(session and session.history.undone),
            **(session.history_labels() if session else {}),
        },
    }


def _build_status() -> dict[str, object]:
    """Which deck.py the server last built (or failed to): an agent's command
    (``inkflow slide``) waits for the build of its own edit with this."""
    session = _editor["session"]
    return {
        "type": "build-status",
        "deckHash": session.built_hash if session else None,
        "failedHash": _editor["failed_hash"],
        "error": _state["error"],
    }


def _without_edit(slide: SlideData) -> SlideData:
    """The presenter's copy of a slide: the editor facts travel in its model."""
    data = slide.copy()
    data.pop("edit", None)
    return data


# ── WebSocket broadcast ───────────────────────────────────────────────────────


async def _send_editors(payload: dict[str, object]) -> None:
    msg = json.dumps(payload)
    for ws in list(_editor["clients"]):
        try:
            await ws.send(msg)
        except Exception:
            _editor["clients"].discard(ws)


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


NotifyStyle = Literal["green", "yellow", "red"]


async def notify(
    target: ServerConnection | None, message: str, *, style: NotifyStyle = "green"
) -> None:
    """Push a transient, colour-coded notification: to one client (a reply) when
    `target` is given, otherwise to every connected client.

    A pure transport primitive, independent of the rebuild-cycle log banner
    (`collect_logs`) above. Whether the event is also worth a `logger` call is the
    caller's decision, not this function's — the two are separate concerns.
    """
    payload = json.dumps({"type": "notify", "message": message, "style": style})
    if target is None:
        await broadcast(payload)
    else:
        await target.send(payload)


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


def _resolve_edit_request(
    msg: dict[str, object], slides: list[SlideData], edit_commands: EditCommands
) -> tuple[Path, str] | None:
    """Validate an `edit` payload and resolve its launch command, if any.

    The path must belong to the *current* build's own `editableFiles` (not just be
    a well-formed path) — this guards against a stale client message surviving a
    deck rebuild, the same spirit as `_coerce_nav_position`'s clamping. Returns
    None when the path is missing/unknown or no command is configured for its kind
    (the client already handled that case as a clipboard copy; nothing to launch).
    """
    path_str = msg.get("path")
    if not isinstance(path_str, str):
        return None
    valid_paths = {f["path"] for slide in slides for f in slide["editableFiles"]}
    if path_str not in valid_paths:
        return None
    template = command_for(Path(path_str), edit_commands)
    if template is None:
        return None
    return Path(path_str), template


def _is_loopback(websocket: ServerConnection) -> bool:
    address = cast("object", websocket.remote_address)
    host = (
        cast("tuple[object, ...]", address)[0]
        if isinstance(address, tuple)
        else address
    )
    try:
        return ipaddress.ip_address(str(host)).is_loopback
    except ValueError:
        return False


async def _handle_edit_op(
    websocket: ServerConnection, msg: dict[str, object], session: EditorSession
) -> None:
    """Apply one editor request and answer the sender with its result."""
    request_id = msg.get("id")
    # Whether the request comes from this machine (opening a program is only
    # for a local page); decided here, overriding anything the client sent.
    msg["_local"] = _is_loopback(websocket)
    # What "Take this slide" takes comes from the compare view's other side,
    # never from the page.
    msg.pop("_take", None)
    hub = _editor["compare"]
    try:
        if msg.get("action") == "compare-take":
            if hub is None:
                raise EditError("no comparison is open")
            try:
                msg["_take"] = await asyncio.to_thread(hub.take_request, websocket, msg)
            except CompareError as exc:
                raise EditError(str(exc)) from exc
        result = await asyncio.to_thread(session.apply, msg, _editor["deck"])
    except EditError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("editor request failed")
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    await websocket.send(
        json.dumps({"type": "edit-result", "id": request_id, **result})
    )
    if result.get("ok") and result.get("changes") and msg.get("agent"):
        # An agent's edit (``inkflow slide``): every open editor says so and
        # offers to undo that very step.
        await _send_editors(
            {
                "type": "agent-edit",
                "label": result.get("label"),
                "step": result.get("step"),
                **session.history_labels(),
                "canUndo": bool(session.history.done),
                "canRedo": bool(session.history.undone),
            }
        )
    if session.switch_to is not None and _editor["switch"] is not None:
        _editor["switch"].set()
    if session.quit_requested and _editor["shutdown"] is not None:
        _editor["shutdown"].set()


async def _handle_compare(websocket: ServerConnection, msg: dict[str, object]) -> None:
    """The compare view's messages (see editor/comparehub.py)."""
    hub = _editor["compare"]
    kind = msg.get("type")
    if kind == "compare-close":
        if hub is not None:
            hub.close(websocket)
        return
    try:
        if hub is None:
            raise CompareError("open a deck first")
        if kind == "compare-sources":
            reply = await asyncio.to_thread(hub.sources)
        else:
            reply = await hub.open(websocket, msg, local=_is_loopback(websocket))
    except Exception as exc:
        if not isinstance(exc, CompareError):
            logger.exception("compare failed")
        reply = {
            "type": "compare-error",
            "view": msg.get("view"),
            "for": kind,
            "message": str(exc) or type(exc).__name__,
        }
    await websocket.send(json.dumps(reply))


def make_ws_handler(
    ui: LiveUI,
    edit_commands: EditCommands,
    session: EditorSession | None = None,
) -> Callable[[ServerConnection], Awaitable[None]]:
    async def handler(websocket: ServerConnection) -> None:
        _state["ws_clients"].add(websocket)
        logger.debug(f"client connected ({len(_state['ws_clients'])} total)")
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
                elif msg_type == "ink":
                    # Ink drawn without "Keep" is relayed like a position: the
                    # server holds none of it, every other window draws it.
                    # Saving goes through the session (edit-op "ink") instead.
                    await broadcast(json.dumps(msg), sender=websocket)
                elif msg_type == "hello" and msg.get("role") == "editor":
                    _editor["clients"].add(websocket)
                    if _editor["model"] is not None:
                        await websocket.send(json.dumps(_model_message()))
                elif msg_type == "edit-op" and session is not None:
                    await _handle_edit_op(websocket, msg, session)
                elif msg_type == "build-status":
                    await websocket.send(json.dumps(_build_status()))
                elif msg_type in ("compare-open", "compare-close", "compare-sources"):
                    await _handle_compare(websocket, msg)
                elif msg_type == "editor-context" and session is not None:
                    raw_context: object = msg.get("context")
                    context: object = raw_context
                    if isinstance(raw_context, dict):
                        # Which server this editor talks to: `inkflow goto`
                        # and `select` find it here when several are running.
                        context = {
                            **cast("dict[str, object]", raw_context),
                            "server": session.server,
                        }
                    await asyncio.to_thread(write_context, session.project_dir, context)
                elif msg_type == "editor-command":
                    # From `inkflow goto/select`: steer every open editor.
                    await _send_editors(msg)
                elif msg_type == "edit":
                    request = _resolve_edit_request(
                        msg, _state["slides"], edit_commands
                    )
                    if request is not None:
                        error = open_in_editor(*request)
                        if error is not None:
                            await notify(websocket, error, style="red")
        finally:
            _state["ws_clients"].discard(websocket)
            _editor["clients"].discard(websocket)
            if _editor["compare"] is not None:
                _editor["compare"].close(websocket)
            logger.debug(f"client disconnected ({len(_state['ws_clients'])} total)")
            ui.refresh()

    return handler


# ── HTTP handler ──────────────────────────────────────────────────────────────

_StreamHandler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


@functools.cache
def favicon_data_uri() -> str:
    """Base64 data URI for the built-in adaptive favicon, computed once."""
    pkg = importlib.resources.files("inkflow")
    svg_bytes = pkg.joinpath("theme", "icon.svg").read_bytes()
    b64 = base64.b64encode(svg_bytes).decode()
    return f"data:image/svg+xml;base64,{b64}"


@functools.cache
def _served_ui_fonts() -> str:
    return ui_fonts_css()


def build_html(
    state: State,
    ws_port: int | None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
    ui_fonts: str | None = None,
) -> bytes:
    """The presenter page. ``ui_fonts`` are the interface's ``@font-face``
    rules: by default loaded from this server (`ui_fonts_css`); a static build
    passes them subset and inline."""
    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("presenter.html").read_text(encoding="utf-8")
    css = pkg.joinpath("bundles", "presenter.css").read_text(encoding="utf-8")
    css = (_served_ui_fonts() if ui_fonts is None else ui_fonts) + "\n" + css
    js = pkg.joinpath("bundles", "presenter.js").read_text(encoding="utf-8")
    data_theme = "" if state["mode"] == ColorMode.DARK else "light"
    ws_port_js = "null" if ws_port is None else str(ws_port)
    edit_commands_json = json.dumps(
        {
            "default": edit_commands.default is not None,
            "svg": edit_commands.svg is not None,
            "suffixes": configured_suffixes(edit_commands),
        }
    )
    html = (
        template.replace("/* __CSS__ */", css)
        .replace("/* __JS__ */", js)
        .replace("/* __STYLES__ */", state["styles_css"])
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES_JSON__", json.dumps(state["slides"]))
        .replace("__TRANSITIONS_JSON__", json.dumps(state["transitions"]))
        .replace("/* __SCRIPTS__ */", state["scripts_js"])
        .replace("__WS_PORT__", ws_port_js)
        .replace("__EDIT_COMMANDS_JSON__", edit_commands_json)
        .replace("__ERROR_JSON__", json.dumps(state["error"]))
        .replace("__LOGS_JSON__", json.dumps(state["logs"]))
        .replace("__FAVICON__", favicon_data_uri())
        .replace("__TITLE__", escape_html(state["title"]))
    )
    return html.encode("utf-8")


def build_editor_html(state: State, editor: EditorState, ws_port: int) -> bytes:
    """The visual editor page: its own shell and bundle, the deck's styles."""
    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("editor.html").read_text(encoding="utf-8")
    css = pkg.joinpath("bundles", "editor.css").read_text(encoding="utf-8")
    css = _served_ui_fonts() + "\n" + css
    js = pkg.joinpath("bundles", "editor.js").read_text(encoding="utf-8")
    data_theme = "" if state["mode"] == ColorMode.DARK else "light"
    html = (
        template.replace("/* __CSS__ */", css)
        .replace("/* __JS__ */", js)
        .replace("/* __STYLES__ */", state["styles_css"])
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES_JSON__", json.dumps(state["slides"]))
        .replace("__MODEL_JSON__", json.dumps(editor["model"]))
        .replace("__WS_PORT__", str(ws_port))
        .replace("__ERROR_JSON__", json.dumps(state["error"]))
        .replace("__FAVICON__", favicon_data_uri())
        .replace("__TITLE__", escape_html(f"Edit · {state['title']}"))
    )
    return html.encode("utf-8")


def _is_editor_path(request_path: str) -> bool:
    path = request_path.split("?", 1)[0].split("#", 1)[0]
    return path == "/edit" or path.startswith("/edit/")


_SERVED_SUFFIXES = set(MIME_TYPES)


def _versioned(slide: SlideData, roots: AssetRoots) -> SlideData:
    """The slide with each local asset reference stamped with its file's
    modification time (``assets/x.png?v=…``), for serving only.

    A page keeps the pictures it has loaded by URL, so a diagram or picture
    changed on disk (draw.io, Inkscape, GIMP) would stay as it was on screen:
    with the stamp, the changed file is a changed slide (pushed as usual) at a
    new URL. ``_resolve_asset`` ignores the query; build and export never
    stamp, and the editor strips it before anything is written back.
    """

    def stamp(ref: str) -> str | None:
        if not is_local_ref(ref) or "?" in ref:
            return None
        located = roots.locate(unquote(ref))
        try:
            mtime = located.stat().st_mtime_ns if located is not None else None
        except OSError:
            return None
        return f"{ref}?v={mtime:x}" if mtime else None

    out = slide.copy()
    out["svg"] = rewrite_references(slide["svg"], stamp)
    out["notes"] = rewrite_references(slide["notes"], stamp)
    return out


def _resolve_asset(roots: AssetRoots, request_path: str) -> Path | None:
    """Map a request path to a file, or ``None`` if it names nothing servable.

    The request path is a canonical asset reference: the pipeline wrote it into
    the slide SVG, so ``AssetRoots.locate`` is the same answer ``build`` copies
    to, and containment against the allowed roots is enforced there. A query
    (the version stamp ``_versioned`` adds) is not part of the name.
    """
    decoded = unquote(request_path.split("?", 1)[0]).lstrip("/")
    located = roots.locate(decoded)
    if located is None:
        return None
    if located.suffix.lower() not in _SERVED_SUFFIXES:
        return None
    resolved = located.resolve()
    if not resolved.is_file():
        return None
    return resolved


_RANGE = re.compile(rb"^range:\s*bytes=(\d*)-(\d*)\s*$", re.I | re.M)
_CHUNK = 1024 * 1024


def _range_header(raw: bytes) -> tuple[int | None, int | None] | None:
    """The single byte range a request asks for (``Range: bytes=a-b``)."""
    m = _RANGE.search(raw.split(b"\r\n\r\n", 1)[0])
    if m is None or (not m.group(1) and not m.group(2)):
        return None
    return (
        int(m.group(1)) if m.group(1) else None,
        int(m.group(2)) if m.group(2) else None,
    )


def byte_range(
    size: int, wanted: tuple[int | None, int | None] | None
) -> tuple[int, int] | None:
    """The inclusive span to send for a ``Range`` request, or None for all of
    it. ``(None, n)`` is the last n bytes. Raises ValueError when the range
    lies outside the file."""
    if wanted is None:
        return None
    start, end = wanted
    if start is None:
        if not end:
            raise ValueError("empty suffix range")
        start, end = max(0, size - end), size - 1
    else:
        end = size - 1 if end is None else min(end, size - 1)
    if start >= size or start > end:
        raise ValueError("range outside the file")
    return start, end


async def _send_file(
    writer: asyncio.StreamWriter,
    path: Path,
    wanted: tuple[int | None, int | None] | None,
) -> None:
    """Stream a file, or the byte range asked for (206): a video seeks and
    plays in every browser (Safari asks for ranges), and a large file is never
    read into memory whole."""
    mime = MIME_TYPES[path.suffix.lower()]
    size = path.stat().st_size
    try:
        span = byte_range(size, wanted)
    except ValueError:
        writer.write(
            b"HTTP/1.1 416 Range Not Satisfiable\r\n"
            + f"Content-Range: bytes */{size}\r\n".encode()
            + b"Connection: close\r\nContent-Length: 0\r\n\r\n"
        )
        await writer.drain()
        return
    start, end = span if span else (0, size - 1)
    length = max(0, end - start + 1)
    status = b"206 Partial Content" if span else b"200 OK"
    header = (
        b"HTTP/1.1 "
        + status
        + b"\r\n"
        + f"Content-Type: {mime}\r\n".encode()
        + b"Accept-Ranges: bytes\r\n"
        + (f"Content-Range: bytes {start}-{end}/{size}\r\n".encode() if span else b"")
        + b"Cache-Control: no-store\r\n"
        + b"Connection: close\r\n"
        + f"Content-Length: {length}\r\n\r\n".encode()
    )
    writer.write(header)
    with path.open("rb") as f:
        _ = f.seek(start)
        left = length
        while left > 0:
            chunk = f.read(min(_CHUNK, left))
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
            left -= len(chunk)


def _read_export(path: Path) -> tuple[str, str, bytes]:
    """An exported file, or an exported folder as a zip, for download."""
    if path.is_dir():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(path.rglob("*")):
                if f.is_file():
                    zf.write(f, f"{path.name}/{f.relative_to(path).as_posix()}")
        return f"{path.name}.zip", "application/zip", buf.getvalue()
    mime = {".pdf": "application/pdf", ".html": "text/html; charset=utf-8"}.get(
        path.suffix.lower(), "application/octet-stream"
    )
    return path.name, mime, path.read_bytes()


def _export_download(
    request_path: str,
) -> tuple[Callable[[Path], tuple[str, str, bytes]], Path] | None:
    """``/_export/<token>/<name>``: a file the editor exported in this session.

    Only paths the session recorded under a random token are served, so this
    route cannot reach any other file."""
    parts = request_path.split("?", 1)[0].split("/")
    if len(parts) < 3 or parts[1] != "_export":
        return None
    session = _editor["session"]
    path = session.exports.get(parts[2]) if session is not None else None
    if path is None or not path.exists():
        return None
    return _read_export, path


def make_http_handler(
    ws_port: int,
    project_dir: Path | None = None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
) -> _StreamHandler:
    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            raw = await asyncio.wait_for(reader.read(4096), timeout=10)
            request_line = raw.split(b"\r\n", 1)[0].decode(errors="replace")
            parts = request_line.split(" ", 2)
            request_path = parts[1] if len(parts) >= 2 else "/"

            if request_path == instances.PROBE_PATH:
                # Who is serving here (see instances.py): another inkflow
                # opening a deck asks before starting a second server for it.
                session = _editor["session"]
                body = json.dumps(
                    {
                        "pid": os.getpid(),
                        "deck": str(session.deck_path)
                        if session is not None and session.has_deck
                        else None,
                    }
                ).encode()
                writer.write(
                    b"HTTP/1.1 200 OK\r\n"
                    + b"Content-Type: application/json\r\n"
                    + b"Cache-Control: no-store\r\n"
                    + b"Connection: close\r\n"
                    + f"Content-Length: {len(body)}\r\n\r\n".encode()
                    + body
                )
                await writer.drain()
                return

            font = shipped_font_file(request_path)
            if font is not None:
                # A font inkflow ships (the deck's and the interface's): the
                # same bytes for as long as this inkflow is installed.
                body = await asyncio.to_thread(font.read_bytes)
                writer.write(
                    b"HTTP/1.1 200 OK\r\n"
                    + f"Content-Type: {font_mime(font)}\r\n".encode()
                    + b"Cache-Control: public, max-age=86400\r\n"
                    + b"Access-Control-Allow-Origin: *\r\n"
                    + b"Connection: close\r\n"
                    + f"Content-Length: {len(body)}\r\n\r\n".encode()
                    + body
                )
                await writer.drain()
                return

            download = _export_download(request_path)
            if download is not None:
                name, mime, body = await asyncio.to_thread(*download)
                header = (
                    b"HTTP/1.1 200 OK\r\n"
                    + f"Content-Type: {mime}\r\n".encode()
                    + f'Content-Disposition: attachment; filename="{name}"\r\n'.encode()
                    + b"Cache-Control: no-store\r\n"
                    + b"Connection: close\r\n"
                    + b"Content-Length: "
                    + str(len(body)).encode()
                    + b"\r\n\r\n"
                )
                writer.write(header + body)
                await writer.drain()
                return

            hub = _editor["compare"]
            if hub is not None and request_path.startswith("/_cmp/"):
                # A compared deck's picture, inside that deck's own roots.
                compared = hub.asset(request_path)
                if compared is None:
                    writer.write(
                        b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n"
                        + b"Content-Length: 0\r\n\r\n"
                    )
                    await writer.drain()
                else:
                    await _send_file(writer, compared, _range_header(raw))
                return

            if project_dir is not None and request_path != "/":
                roots = AssetRoots(project_dir, _state["theme_dir"])
                asset_path = _resolve_asset(roots, request_path)
                if asset_path is not None:
                    await _send_file(writer, asset_path, _range_header(raw))
                    return

            session = _editor["session"]
            starting = session is not None and not session.has_deck
            # The start page (no deck yet) is the editor's, at any path.
            if _is_editor_path(request_path) or starting:
                body = build_editor_html(_state, _editor, ws_port)
            else:
                body = build_html(_state, ws_port, edit_commands)
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
            # File sink only, never the TUI. The client still gets the 500 body below.
            logger.exception("error handling HTTP request")
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


class _WatchFilter(DefaultFilter):
    """The default ignores, plus ``.inkflow/`` (editor context the server
    writes, and the worktrees agents work in) and ``build/``, all matched
    below the watched folder only: a deck that itself lives in a worktree
    under some ``.inkflow/worktrees/`` is watched like any other."""

    # build/ is where `inkflow build` and the editor's export write: never input.
    ignore_dirs: Sequence[str] = (*DefaultFilter.ignore_dirs, ".inkflow", "build")

    def __init__(self, root: Path) -> None:
        super().__init__()
        self._root: str = str(root)

    @override
    def __call__(self, change: Change, path: str) -> bool:
        rel = os.path.relpath(path, self._root)
        if rel == os.curdir or rel.startswith(os.pardir):
            return super().__call__(change, path)
        return super().__call__(change, rel)


async def _watch(
    deck_path: Path, ui: LiveUI, lock: asyncio.Lock, levels: Levels
) -> None:
    root = deck_path.parent
    async for changes in awatch(str(root), watch_filter=_WatchFilter(root)):
        logger.debug(f"change detected in {len(changes)} file(s), rebuilding")
        async with lock:
            await rebuild(deck_path, ui, levels)


# ── Keyboard handler ──────────────────────────────────────────────────────────


def open_browser(url: str) -> None:
    _open_browser(url)


def _open_browser(url: str) -> None:
    # Redirect fd 1/2 to /dev/null so the browser process can't write startup
    # noise to the terminal and corrupt the Rich Live cursor tracking.
    try:
        saved_out = os.dup(1)
        saved_err = os.dup(2)
    except OSError:
        # No console at all (pythonw on Windows): nothing to protect.
        webbrowser.open(url)
        return
    devnull = os.open(os.devnull, os.O_WRONLY)
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
    deck_path: Path | None,
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
    async with raw_keypresses(loop) as queue:
        while True:
            ch = await queue.get()
            if ch in ("\x04", "q"):  # Ctrl-D, q (Ctrl-C handled via SIGINT)
                shutdown.set()
                return
            elif ch == "o":
                _open_browser(f"http://{host}:{http_port}")
            elif ch == "e":
                _open_browser(f"http://{host}:{http_port}/edit")
            elif ch == "r" and deck_path is not None:
                async with lock:
                    await rebuild(deck_path, ui, levels)
            elif ch == "t":
                ui.toggle_trace()


# ── Ports ─────────────────────────────────────────────────────────────────────

DEFAULT_PORT = 7777


def _port_free(host: str, port: int) -> bool:
    """Whether ``port`` can be bound on every address ``host`` names, as the
    servers bind it (``localhost`` is 127.0.0.1 and ::1: a program on either
    takes the port)."""
    try:
        infos = socket.getaddrinfo(
            host or None, port, type=socket.SOCK_STREAM, flags=socket.AI_PASSIVE
        )
    except socket.gaierror:
        infos = []
    addresses = {(info[0], info[4]) for info in infos} or {
        (socket.AF_INET, (host, port))
    }
    for family, address in addresses:
        try:
            sock = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue  # (no IPv6 here: nothing can take the port there)
        with sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            try:
                sock.bind(address)
            except OSError as exc:
                if exc.errno == errno.EADDRNOTAVAIL:
                    continue
                return False
    return True


def pick_ports(host: str, port: int | None, ws_port: int | None) -> tuple[int, int]:
    """The HTTP and WebSocket ports to serve on.

    Explicit ports are used as given (a clash is then reported as before).
    Unset ones take the first free pair from 7777 up, so a second
    ``inkflow edit`` for another deck simply comes up next to the first.
    """
    if port is not None and ws_port is not None:
        return port, ws_port
    if port is not None:
        ws = port + 1
        while not _port_free(host, ws):
            ws += 1
        return port, ws
    candidate = DEFAULT_PORT
    for _ in range(200):
        ws = ws_port if ws_port is not None else candidate + 1
        if (
            candidate != ws
            and _port_free(host, candidate)
            and (ws_port is not None or _port_free(host, ws))
        ):
            return candidate, ws
        candidate += 2 if ws_port is None else 1
    return DEFAULT_PORT, ws_port if ws_port is not None else DEFAULT_PORT + 1


# ── Public entry point ────────────────────────────────────────────────────────


async def serve(
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int,
    levels: Levels,
    open_path: str | None = None,
    exporters: Exporters | None = None,
    quit_when_idle: float | None = None,
    auto_ports: bool = False,
) -> None:
    """Run the server until quit. ``open_path`` (e.g. ``"/edit"``) opens a
    browser on that page once the first build is done; ``exporters`` enable
    the editor's Export dialog. Without a deck (``None``) the editor shows its
    start page: a new deck, another one, or a recent one. With
    ``quit_when_idle`` (seconds) it stops once no page has been connected for
    that long (a server started without a terminal to stop it from).

    ``auto_ports``: the ports came from ``pick_ports``, not the user, so one
    taken in the meantime (another inkflow starting at the same moment, say
    an agent's server for its worktree) means picking the next free pair.

    When the editor opens another deck (or creates one), the servers close and
    start again on the same ports for that deck; open pages reconnect to it."""
    retries = 5 if auto_ports else 0
    while True:
        try:
            next_deck = await _serve_deck(
                deck_path,
                host,
                http_port,
                ws_port,
                levels,
                open_path,
                exporters,
                quit_when_idle,
            )
        except _PortBusy as busy:
            if retries <= 0:
                report("Error", busy.message, style="red")
                return
            retries -= 1
            http_port, ws_port = pick_ports(host, None, None)
            continue
        if next_deck is None:
            return
        report("Opening", str(next_deck))
        deck_path, open_path = next_deck, None
        _state["slides"] = []
        _state["position"] = {"slideIndex": 0, "step": 0}
        _state["error"] = None
        _editor["deck"] = None
        _editor["model"] = None
        _editor["failed_hash"] = None


class _PortBusy(Exception):
    """A port was taken when the server bound it."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message: str = message


async def _quit_when_idle(shutdown: asyncio.Event, delay: float) -> None:
    """Stop once no page has been connected for ``delay`` seconds.

    The delay covers a reload, and the moment a deck switch restarts the
    servers, so only closing the last tab (or never opening one) stops it.
    """
    idle = 0.0
    while True:
        await asyncio.sleep(1)
        idle = 0.0 if _state["ws_clients"] else idle + 1
        if idle >= delay:
            report("Stopping", f"no page open for {delay:g} seconds")
            shutdown.set()
            return


async def _serve_deck(
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int,
    levels: Levels,
    open_path: str | None,
    exporters: Exporters | None,
    quit_when_idle: float | None = None,
) -> Path | None:
    """Serve one deck until quit (None) or until the editor opens another
    (its deck.py). Without a deck, only the editor's start page is served:
    nothing is built or watched, and no files are served."""
    console = Console()
    rebuild_lock = asyncio.Lock()
    shutdown = asyncio.Event()
    switch = asyncio.Event()
    _editor["switch"] = switch
    _editor["shutdown"] = shutdown

    loop = asyncio.get_running_loop()
    uninstall_shutdown_handler = install_shutdown_handler(loop, shutdown)

    try:
        edit_commands = resolve_edit_commands()
        session = EditorSession(deck_path, exporters)
        session.edit_commands = edit_commands
        session.server = {"host": host, "port": http_port, "wsPort": ws_port}
        _editor["session"] = session
        _editor["compare"] = CompareHub(deck_path, load_deck) if deck_path else None
        project_dir = deck_path.parent if deck_path else None
        if deck_path is not None:
            projects.remember(deck_path)
        else:
            _state["title"] = "Inkflow"
        http_handler = make_http_handler(ws_port, project_dir, edit_commands)
        # Bind before the Live UI so port conflicts fail fast with a clean message
        try:
            http_server = await asyncio.start_server(http_handler, host, http_port)
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                raise _PortBusy(
                    f"port {http_port} in use — pass --port to use another"
                ) from e
            raise
        # Other inkflow processes find this server (and its deck) here.
        instances.register(
            instances.Instance(
                pid=os.getpid(),
                host=host,
                port=http_port,
                ws_port=ws_port,
                deck=str(deck_path.resolve()) if deck_path else None,
            )
        )

        with Live(Text(""), console=console, auto_refresh=False) as live:
            ui = LiveUI(
                live,
                host,
                http_port,
                project_dir or Path.home(),
                get_clients=lambda: len(_state["ws_clients"]),
            )
            try:
                async with (
                    http_server,
                    ws_serve(
                        make_ws_handler(ui, edit_commands, session),
                        host,
                        ws_port,
                        # Image uploads from the editor arrive as base64 frames.
                        max_size=80 * 1024 * 1024,
                    ),
                ):
                    if deck_path is not None:
                        await rebuild(deck_path, ui, levels)
                    if open_path is not None:
                        _open_browser(f"http://{host}:{http_port}{open_path}")
                    tasks = [
                        asyncio.create_task(http_server.serve_forever()),
                        *(
                            [
                                asyncio.create_task(
                                    _watch(deck_path, ui, rebuild_lock, levels)
                                )
                            ]
                            if deck_path is not None
                            else []
                        ),
                        *(
                            [
                                asyncio.create_task(
                                    _quit_when_idle(shutdown, quit_when_idle)
                                )
                            ]
                            if quit_when_idle is not None
                            else []
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
                    waits = [
                        asyncio.create_task(shutdown.wait()),
                        asyncio.create_task(switch.wait()),
                    ]
                    _ = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
                    for t in [*tasks, *waits]:
                        t.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
            except OSError as e:
                if e.errno == errno.EADDRINUSE:
                    raise _PortBusy(
                        f"port {ws_port} in use — pass --ws-port to use another"
                    ) from e
                raise
    finally:
        uninstall_shutdown_handler()
        if _editor["compare"] is not None:
            _editor["compare"].close_all()
            _editor["compare"] = None
        _editor["switch"] = None
        _editor["shutdown"] = None
        instances.unregister(os.getpid())
    if switch.is_set() and not shutdown.is_set():
        return _editor["session"].switch_to if _editor["session"] else None
    return None
