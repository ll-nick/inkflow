from __future__ import annotations

import asyncio
import base64
import contextlib
import errno
import functools
import importlib.resources
import importlib.util
import io
import json
import os
import re
import socket
import ssl
import sys
import time
import traceback
import webbrowser
import zipfile
from collections.abc import (
    AsyncGenerator,
    Awaitable,
    Callable,
    Collection,
    Sequence,
)
from dataclasses import dataclass
from html import escape as escape_html
from pathlib import Path
from typing import Literal, Protocol, TypedDict, cast
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
from websockets.http11 import Request as WsRequest
from websockets.http11 import Response as WsResponse

from inkflow import instances, sshshare
from inkflow.access import (
    TOKEN_PARAM,
    WS_PATH,
    Access,
    Role,
    enter_page,
    is_loopback_name,
    lan_addresses,
    page,
    parse_request,
    peer_host,
    redacted,
    split_host,
)
from inkflow.access import Request as AccessRequest
from inkflow.assets import MIME_TYPES, AssetRoots, is_local_ref, rewrite_references
from inkflow.collab import Client, People
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
from inkflow.editor.model import ModelCache, build_model, starred_ids
from inkflow.editor.problems import Problems
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
from inkflow.handout import handout_page
from inkflow.incremental import SlideCache, as_patch, keys_of, set_keys
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import Levels, collect_logs, logger, report
from inkflow.manifest import Deck
from inkflow.online import config as relay_config
from inkflow.online import crypto as online_crypto
from inkflow.online.host import Hooks, OnlineHost, VirtualConnection
from inkflow.os_compat import install_shutdown_handler, raw_keypresses
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.titles import resolve_deck_title
from inkflow.tui import LiveUI
from inkflow.wsbridge import Bridge

DEFAULT_PORT = 7777

# ── Shared mutable state ──────────────────────────────────────────────────────


@dataclass
class Kept:
    """One deck's builds, slide by slide: a rebuild processes the slides a
    change touched and takes the others from here (`inkflow.incremental`)."""

    deck_path: Path
    slides: SlideCache
    model: ModelCache


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
    model_patch: dict[str, object] | None
    """The model as sent to a page that holds the build before it: the
    slides' entries that build already had are named by key."""
    kept: Kept | None
    """What is kept from one build of the served deck to the next."""
    problems: Problems | None
    """Each slide's problems for the editor's marks (editor/problems.py)."""
    edit_slides: list[SlideData] | None
    """The last editor build's slides (what the layout check measures)."""
    deck_hash: str | None


_editor: EditorState = {
    "deck": None,
    "model": None,
    "clients": set(),
    "session": None,
    "switch": None,
    "shutdown": None,
    "failed_hash": None,
    "compare": None,
    "model_patch": None,
    "kept": None,
    "problems": None,
    "edit_slides": None,
    "deck_hash": None,
}


class _Share:
    """Who may connect (``access.Access``), who is connected
    (``collab.People``), and the listener sharing turns on and off."""

    access: Access
    people: People
    rebind: Callable[[bool], Awaitable[None]] | None
    """Set while serving: listen on the LAN (True) or this machine only
    (in SSH mode: where it listens already, links on or off)."""
    ssh_info: dict[str, object] | None
    """What "Share via SSH" writes its commands from (``sshshare.details``),
    gathered when the owner opens the Share dialog."""
    online: OnlineHost | None
    """The room on a relay while sharing online (``online.host``)."""
    route: Route | None
    """How the one port answers a request: online guests' requests too."""
    ws_handler: Callable[[ServerConnection], Awaitable[None]] | None
    """The WebSocket handler of the deck being served: online guests'
    page connections run through it too."""
    on_change: Callable[[], None] | None
    """Refresh the terminal's share lines (set while serving)."""

    def __init__(self) -> None:
        self.access = Access(DEFAULT_PORT)
        self.people = People()
        self.rebind = None
        self.ssh_info = None
        self.online = None
        self.route = None
        self.ws_handler = None
        self.on_change = None


_share = _Share()


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


def _kept_for(deck_path: Path, full: bool) -> Kept:
    """The served deck's kept builds; none of them after ``full`` (or for
    another deck than the last)."""
    kept = _editor["kept"]
    if kept is None or kept.deck_path != deck_path or full:
        kept = Kept(deck_path, SlideCache(), ModelCache())
        _editor["kept"] = kept
    return kept


def _update_message(
    slides: Sequence[object], changed: dict[str, object] | None = None
) -> str:
    return json.dumps(
        {
            "type": "update",
            "slides": slides,
            "transitions": _state["transitions"],
            "logs": _state["logs"],
            **(changed or {}),
        }
    )


async def rebuild(
    deck_path: Path, ui: LiveUI, levels: Levels, *, full: bool = False
) -> None:
    """Build the deck and tell the pages. Slides whose files and settings
    are as the last build read them are not processed again, and a page is
    sent only the slides that changed; ``full`` forgets the last builds (the
    terminal's ``r``)."""
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
            # The files as this build reads them: a page's write to one that
            # changed since its build is refused (several people editing).
            session = _editor["session"]
            build_id = (
                await asyncio.to_thread(session.snapshot) if session is not None else 0
            )
            deck_hash = file_hash(deck_path.read_bytes())
            deck = await asyncio.to_thread(load_deck, deck_path)
            project_dir = deck_path.parent
            kept = _kept_for(deck_path, full)
            # The editor build stamps source locators on every element; the
            # presenter ignores them, so one build serves both pages.
            edit_slides = await asyncio.to_thread(
                functools.partial(process_deck, editor=True, cache=kept.slides),
                deck,
                project_dir,
                deck_path,
            )
            model = await asyncio.to_thread(
                functools.partial(build_model, cache=kept.model),
                deck,
                deck_path,
                edit_slides,
            )
            model["build"] = build_id
            roots = AssetRoots(project_dir, deck.theme.asset_dir())
            slides = [_versioned(_without_edit(s), roots) for s in edit_slides]
            set_keys(slides)
            set_keys(cast("list[dict[str, object]]", model["slides"]))
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
        # What a page that saw the last build holds: named, not sent again.
        held = keys_of(_state["slides"])
        old_model = _editor["model"]
        held_entries = keys_of(
            cast("list[dict[str, object]]", old_model["slides"]) if old_model else []
        )
        _state["slides"] = slides
        _state["transitions"] = transitions
        _state["styles_css"] = styles_css
        _state["scripts_js"] = scripts_js
        _state["mode"] = deck.effective_mode
        _state["title"] = resolve_deck_title(deck, project_dir)
        _state["theme_dir"] = deck.theme.asset_dir()
        _editor["deck"] = deck
        _editor["model"] = model
        _editor["model_patch"] = {
            **model,
            "slides": as_patch(
                cast("list[dict[str, object]]", model["slides"]), held_entries
            ),
        }
        if _editor["session"] is not None:
            _editor["session"].built_hash = deck_hash
            _editor["session"].live = (edit_slides, model)
        _editor["failed_hash"] = None
        _state["error"] = None
        _state["logs"] = browser_logs
        if slides:
            cur = _state["position"]["slideIndex"]
            _state["position"]["slideIndex"] = max(0, min(len(slides) - 1, cur))
        else:
            _state["position"]["slideIndex"] = 0
        _state["position"]["step"] = 0
        ui.set_ok(
            len(slides),
            time.monotonic() - t0,
            logs=tui_logs,
            processed=len(kept.slides.processed),
        )
        patching = {
            ws
            for ws in _state["ws_clients"]
            if (c := _share.people.get(ws)) is not None and c.patches
        }
        if patching:
            patch = _update_message(as_patch(slides, held), changed)
            await broadcast(patch, skip=_state["ws_clients"] - patching)
        if _state["ws_clients"] - patching:
            # A page of an older inkflow (a tab left open across an update).
            await broadcast(_update_message(slides, changed), skip=patching)
        await _send_editors(_model_message)
        _editor["edit_slides"] = edit_slides
        _editor["deck_hash"] = deck_hash
        _check_problems()
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


def _history_state(client: Client | None) -> dict[str, object]:
    """Undo/Redo for one person: their own steps (see ``History``)."""
    session = _editor["session"]
    if session is None:
        return {"canUndo": False, "canRedo": False}
    return session.history_state(client.author if client else "owner")


def _model_message(
    client: Client | None = None, *, whole: bool = False
) -> dict[str, object]:
    """The editor's model for one person's page: as what changed since the
    last build when the page takes patches, unless ``whole`` (a page just
    connected, or one that asked again)."""
    patch = _editor["model_patch"]
    takes = client is not None and client.patches
    return {
        "type": "editor-model",
        "model": patch
        if takes and patch is not None and not whole
        else _editor["model"],
        "history": _history_state(client),
    }


def _stars() -> list[str]:
    """The starred slides as the editor's model lists them, read anew (a
    star changes no build), and put into the model a page gets on hello."""
    session, model = _editor["session"], _editor["model"]
    if session is None or model is None:
        return []
    entries = cast("list[dict[str, object]]", model["slides"])
    starred = starred_ids(session.project_dir, entries)
    for held in (model, _editor["model_patch"]):
        if held is not None:
            held["stars"] = starred
    return starred


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


_problems_lock = asyncio.Lock()
_background: set[asyncio.Task[None]] = set()


def _check_problems() -> None:
    """Check the slides' problems again in the background (after a build,
    or when an editor asks for the layout check)."""
    task = asyncio.get_running_loop().create_task(_refresh_problems())
    _background.add(task)
    task.add_done_callback(_background.discard)


def _problems_message() -> dict[str, object] | None:
    problems, model = _editor["problems"], _editor["model"]
    slides = _editor["edit_slides"]
    if problems is None or model is None or slides is None:
        return None
    return problems.json(model, slides)


async def _refresh_problems() -> None:
    """verify's checks for the slides whose entry changed, then (when on)
    the layout check for the slides whose SVG changed; editors are told
    after each. One at a time, each on the latest build."""
    async with _problems_lock:
        problems, deck, model = _editor["problems"], _editor["deck"], _editor["model"]
        slides, session = _editor["edit_slides"], _editor["session"]
        if None in (problems, deck, model, slides, session):
            return
        assert problems is not None and deck is not None and model is not None
        assert slides is not None and session is not None
        try:
            await asyncio.to_thread(
                problems.verify,
                deck,
                session.project_dir,
                model,
                _editor["deck_hash"] or "",
            )
        except Exception:
            logger.exception("checking the slides failed")
            return
        if (msg := _problems_message()) is not None:
            await _send_editors(msg)
        if not problems.layout_on:
            return
        problems.running = True
        if (msg := _problems_message()) is not None:
            await _send_editors(msg)
        check = session.exporters.layout if session.exporters else None
        try:
            if check is None:
                problems.error = "the layout check is not available here"
            else:
                await asyncio.to_thread(
                    problems.measure, deck, session.project_dir, slides, check
                )
        finally:
            problems.running = False
        if (msg := _problems_message()) is not None:
            await _send_editors(msg)


async def _send_editors(
    payload: dict[str, object] | Callable[[Client | None], dict[str, object]],
) -> None:
    """To every editor page: one message, or one per person (a callable
    given each one's client, for what differs: their undo history)."""
    for ws in list(_editor["clients"]):
        msg = payload(_share.people.get(ws)) if callable(payload) else payload
        try:
            await ws.send(json.dumps(msg))
        except Exception:
            _editor["clients"].discard(ws)


async def broadcast(
    msg: str,
    sender: ServerConnection | None = None,
    *,
    skip: Collection[ServerConnection] = (),
) -> None:
    dead: set[ServerConnection] = set()
    for ws in list(_state["ws_clients"]):
        if ws is sender or ws in skip:
            continue
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    _state["ws_clients"] -= dead


async def _send_owners(payload: dict[str, object]) -> None:
    """To the owner's editor pages (the Share dialog)."""
    msg = json.dumps(payload)
    for ws in list(_editor["clients"]):
        client = _share.people.get(ws)
        if client is not None and client.role == "owner":
            with contextlib.suppress(Exception):
                await ws.send(msg)


async def _broadcast_presence() -> None:
    """Everyone's page, slide and selection, to everyone with a page open."""
    people = _share.people.listing()
    await broadcast(json.dumps({"type": "presence", "people": people}))
    await _send_owners(_share_status())


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


# ── Sharing ───────────────────────────────────────────────────────────────────


def _link_addresses(access: Access) -> list[str]:
    """Where share links point: this machine's network addresses, or in SSH
    mode ``localhost`` (each guest opens it through their own tunnel)."""
    return ["localhost"] if access.ssh else lan_addresses()


def _share_status() -> dict[str, object]:
    """What the owner's Share dialog shows."""
    access = _share.access
    return {
        "type": "share-status",
        "sharing": access.sharing,
        "links": access.links(_link_addresses(access)) if access.sharing else [],
        "names": []
        if access.ssh
        else sorted(
            {n for n in access.names if n.endswith(".local")} | access.allow_hosts
        ),
        "port": access.port,
        "ssh": access.ssh,
        "sshInfo": _share.ssh_info,
        "people": _share.people.listing(),
        "online": _online_status(),
    }


async def _gather_ssh_info() -> None:
    session = _editor["session"]
    deck = session.deck_path if session is not None and session.has_deck else None
    try:
        _share.ssh_info = await asyncio.to_thread(
            sshshare.details, deck, _share.access.port
        )
    except Exception as exc:  # A guess for the dialog: never fails the status.
        logger.debug(f"share via SSH: {exc}")


async def _disconnect(
    which: Callable[[Client], bool], reason: str, code: int = 4001
) -> int:
    """Close every guest connection ``which`` picks (one the owner sent away,
    or every guest of links that stopped working); their pages say why and
    stop reconnecting."""
    gone = 0
    for conn, client in _share.people.items():
        if client.role != "owner" and which(client):
            gone += 1
            with contextlib.suppress(Exception):
                await cast("ServerConnection", conn).close(code, reason)
    return gone


async def _handle_share(websocket: ServerConnection, msg: dict[str, object]) -> None:
    """The owner's Share dialog: status, on/off, new links, disconnect."""
    op = msg.get("op")
    access = _share.access
    error: str | None = None
    try:
        if op == "status":
            await _gather_ssh_info()
        elif op == "on" and not access.sharing:
            access.sharing = True
            if _share.rebind is not None:
                await _share.rebind(True)
            logger.info("sharing on")
        elif op == "off" and access.sharing:
            access.sharing = False
            if _share.rebind is not None:
                await _share.rebind(False)
            _ = await _disconnect(lambda c: not c.online, "sharing stopped")
            logger.info("sharing off")
        elif op == "rotate":
            access.rotate()
            gone = await _disconnect(lambda c: not c.online, "new links")
            logger.info(f"new share links ({gone} guests disconnected)")
        elif op == "kick":
            target = str(msg.get("id") or "")
            _ = await _disconnect(lambda c: c.id == target, "disconnected by the owner")
        elif isinstance(op, str) and op.startswith(("online-", "relay-")):
            error = await _online_op(op, msg)
    except OSError as exc:
        access.sharing = False
        error = f"cannot listen on the network: {exc}"
        if _share.rebind is not None:
            with contextlib.suppress(OSError):
                await _share.rebind(False)
    reply = _share_status()
    if error:
        reply["error"] = error
    await websocket.send(json.dumps(reply))
    if op in ("on", "off", "rotate") or (
        isinstance(op, str) and op.startswith(("online-", "relay-"))
    ):
        await _send_owners(_share_status())


# ── Sharing online (through a relay, see inkflow/online) ──────────────────────


def _online_status() -> dict[str, object]:
    """The Share dialog's Online section."""
    configured = relay_config.load()
    host = _share.online
    status: dict[str, object] = {
        "available": online_crypto.available(),
        "installHint": online_crypto.INSTALL_HINT,
        "relay": configured.url if configured else None,
        "sharing": host is not None,
    }
    if host is not None:
        status.update(host.status())
    return status


async def _online_connect(conn: VirtualConnection, role: Role) -> None:
    """An online guest's page: a connection like any other, of its role."""
    handler = _share.ws_handler
    if handler is None:
        await conn.close(1013, "the server is starting")
        return
    client = _share.people.join(conn, role, None, "online")
    client.online = True
    await handler(cast("ServerConnection", cast("object", conn)))


async def _online_fetch(
    path: str, range_: str | None, role: Role, writer: ResponseWriter
) -> None:
    """An online guest's GET (a page, picture, font, download), answered as
    this server answers one from the network, for that role."""
    route = _share.route
    head = f"GET {path} HTTP/1.1\r\nHost: online\r\n"
    if range_:
        head += f"Range: {range_}\r\n"
    raw = (head + "\r\n").encode("latin-1", "replace")
    request = parse_request(raw)
    if route is None or request is None:
        await _respond(writer, "503 Service Unavailable", b"", "text/plain")
        return
    await route(request, raw, role, None, writer)


async def _online_changed() -> None:
    if _share.on_change is not None:
        _share.on_change()
    await _send_owners(_share_status())


def _online_hooks() -> Hooks:
    return Hooks(connect=_online_connect, fetch=_online_fetch, changed=_online_changed)


async def start_online(url: str | None = None, token: str | None = None) -> str | None:
    """Share online through the configured relay (or ``url``); an error
    message when it cannot start."""
    if _share.online is not None:
        return None
    if not online_crypto.available():
        return online_crypto.INSTALL_HINT
    configured = relay_config.load()
    if url is None and configured is None:
        return "no relay set: see Share online in the docs, or `inkflow relay set URL`"
    relay = url or (configured.url if configured else "")
    try:
        host = OnlineHost(
            relay, token or (configured.token if configured else None), _online_hooks()
        )
    except ValueError as exc:
        return str(exc)
    _share.online = host
    host.start()
    logger.info(f"sharing online through {host.relay}")
    return None


async def stop_online(reason: str = "sharing stopped") -> None:
    host, _share.online = _share.online, None
    if host is not None:
        await host.stop(reason)
        logger.info("sharing online off")


async def _online_op(op: str, msg: dict[str, object]) -> str | None:
    """The Share dialog's Online section: on/off, new links, the relay."""
    if op == "online-on":
        return await start_online()
    if op == "online-off":
        await stop_online()
    elif op == "online-rotate" and _share.online is not None:
        await _share.online.rotate()
        logger.info("new online links")
    elif op == "relay-set":
        url = msg.get("url")
        token = msg.get("token")
        if not isinstance(url, str) or not url.strip():
            relay_config.forget()
            return None
        try:
            relay_config.save(url, token if isinstance(token, str) else None)
        except (ValueError, OSError) as exc:
            return f"cannot use that relay address: {exc}"
    return None


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
    """Whether a connection is the owner's (see ``access.Access.is_owner``)."""
    client = _share.people.get(websocket)
    return client is not None and client.role == "owner"


async def _handle_edit_op(
    websocket: ServerConnection, msg: dict[str, object], session: EditorSession
) -> None:
    """Apply one editor request and answer the sender with its result."""
    request_id = msg.get("id")
    client = _share.people.get(websocket)
    # Who asks is decided here, from the connection, never by the page: keys
    # starting with "_" are the server's (whether a program may open on this
    # machine's screen, whose undo history the step joins).
    for key in [k for k in msg if k.startswith("_")]:
        del msg[key]
    role: Role = client.role if client is not None else "viewer"
    msg["_local"] = role == "owner"
    msg["_role"] = role
    msg["_author"] = client.author if client is not None else "owner"
    msg["_name"] = client.name if client is not None else ""
    hub = _editor["compare"]
    try:
        if role not in ("owner", "editor"):
            raise EditError("this link is view-only")
        if msg.get("action") == "compare-take":
            if hub is None:
                raise EditError("no comparison is open")
            try:
                msg["_take"] = await asyncio.to_thread(hub.take_request, websocket, msg)
            except CompareError as exc:
                raise EditError(str(exc)) from exc
        result = await asyncio.to_thread(session.apply, msg, _editor["deck"])
    except EditError as exc:
        result = {"ok": False, "error": str(exc), **exc.extra}
    except Exception as exc:
        logger.exception("editor request failed")
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    await websocket.send(
        json.dumps({"type": "edit-result", "id": request_id, **result})
    )
    if result.get("ok") and msg.get("action") == "star":
        # No file of the deck changed and nothing rebuilds: every editor
        # page is told which slides are starred now.
        await _send_editors({"type": "stars", "stars": _stars()})
    if result.get("ok") and msg.get("action") == "comment":
        # Likewise every editor page is told the review comments now.
        threads = result.get("comments")
        for held in (_editor["model"], _editor["model_patch"]):
            if held is not None:
                held["comments"] = threads
        await _send_editors({"type": "comments", "comments": threads})
    if result.get("ok") and (
        result.get("changes") or msg.get("action") in ("undo", "redo")
    ):
        # Everyone's Undo/Redo may have changed (a step of theirs is now
        # blocked, or free again); an agent's edit (``inkflow slide``) also
        # says so, with an undo of that very step for the owner's pages.
        agent = bool(msg.get("agent")) and bool(result.get("changes"))
        author = msg["_author"]

        def per_person(c: Client | None) -> dict[str, object]:
            return {
                "type": "agent-edit" if agent else "history",
                "label": result.get("label"),
                "step": result.get("step"),
                "mine": (c.author if c is not None else "owner") == author,
                **_history_state(c),
            }

        await _send_editors(per_person)
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


_OWNER_ONLY = frozenset({"edit", "editor-context", "editor-command", "share"})
"""Messages only the owner's pages and programs send: opening a program on
this machine, the agents' context file and commands, and sharing itself."""
_EDITORS = frozenset(
    {"edit-op", "compare-open", "compare-close", "compare-sources", "problems-check"}
)


def allowed(role: Role, msg: dict[str, object]) -> bool:
    """Whether ``role`` may send this message at all."""
    kind = msg.get("type")
    if kind in _OWNER_ONLY:
        return role == "owner"
    if kind in _EDITORS or (kind == "hello" and msg.get("role") == "editor"):
        return role in ("owner", "editor")
    if role == "viewer":
        # A viewer follows: it moves no one else's slide and draws on no one
        # else's screen (it may ask for the ink already drawn).
        if kind == "nav":
            return False
        if kind == "ink":
            return msg.get("op") == "request"
    return True


def make_ws_handler(
    ui: LiveUI,
    edit_commands: EditCommands,
    session: EditorSession | None = None,
) -> Callable[[ServerConnection], Awaitable[None]]:
    async def handler(websocket: ServerConnection) -> None:
        client = _share.people.get(websocket)
        if client is None:
            # Not admitted at the door (cannot happen through the listeners).
            await websocket.close(4003, "not admitted")
            return
        _state["ws_clients"].add(websocket)
        logger.debug(f"client connected ({len(_state['ws_clients'])} total)")
        ui.refresh()
        try:
            pos = _state["position"]
            await websocket.send(
                json.dumps(
                    {
                        "type": "welcome",
                        "id": client.id,
                        "role": client.role,
                        "color": client.color,
                        "name": client.name,
                    }
                )
            )
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
                if not allowed(client.role, msg):
                    if msg_type == "edit-op":
                        await websocket.send(
                            json.dumps(
                                {
                                    "type": "edit-result",
                                    "id": msg.get("id"),
                                    "ok": False,
                                    "error": "this link is view-only",
                                }
                            )
                        )
                    continue
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
                elif msg_type == "presence":
                    if _share.people.update(websocket, msg):
                        await _broadcast_presence()
                elif msg_type in ("hello", "resync"):
                    # A page says which rebuilds it takes (``patch``: what
                    # changed), and is told which slides the deck has now:
                    # by key when it may hold them (the ones its HTML came
                    # with), whole when it found it does not (``resync``).
                    if msg_type == "hello":
                        client.patches = bool(msg.get("patch"))
                    editor = msg.get("role") == "editor"
                    if msg_type == "hello" and editor:
                        _editor["clients"].add(websocket)
                    if client.patches and _state["error"] is None:
                        whole = msg_type == "resync"
                        slides = _state["slides"]
                        await websocket.send(
                            _update_message(
                                slides if whole else as_patch(slides, keys_of(slides))
                            )
                        )
                    if websocket not in _editor["clients"]:
                        continue
                    if _editor["model"] is not None:
                        await websocket.send(
                            json.dumps(_model_message(client, whole=True))
                        )
                    if msg_type == "resync":
                        continue
                    if (problems_msg := _problems_message()) is not None:
                        await websocket.send(json.dumps(problems_msg))
                    await websocket.send(
                        json.dumps(
                            {"type": "presence", "people": _share.people.listing()}
                        )
                    )
                elif msg_type == "edit-op" and session is not None:
                    await _handle_edit_op(websocket, msg, session)
                elif msg_type == "problems-check":
                    # The Problems list's layout check (and its contrast
                    # setting), for everyone editing this deck.
                    problems = _editor["problems"]
                    if problems is not None:
                        problems.layout_on = msg.get("on") is not False
                        problems.contrast = msg.get("contrast") is True
                        _check_problems()
                elif msg_type == "build-status":
                    await websocket.send(json.dumps(_build_status()))
                elif msg_type in ("compare-open", "compare-close", "compare-sources"):
                    await _handle_compare(websocket, msg)
                elif msg_type == "share":
                    await _handle_share(websocket, msg)
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
            left = _share.people.leave(websocket)
            if left is not None and left.page:
                await _broadcast_presence()
            logger.debug(f"client disconnected ({len(_state['ws_clients'])} total)")
            ui.refresh()

    return handler


# ── HTTP handler ──────────────────────────────────────────────────────────────

_StreamHandler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


class ResponseWriter(Protocol):
    """Where a response is written: a socket's ``asyncio.StreamWriter``, or
    an online guest's (``online.host._Capture``)."""

    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


Route = Callable[
    [AccessRequest, bytes, Role, str | None, ResponseWriter], Awaitable[None]
]
"""Answer one admitted request (see ``make_http_route``)."""


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


def build_handout_html(state: State, request_path: str) -> bytes:
    """The handout view (handout.py): the served slides with their notes,
    ``?layout=notes|compact&paper=a4|letter``."""
    from urllib.parse import parse_qs, urlsplit

    query = parse_qs(urlsplit(request_path).query)
    page = handout_page(
        state["slides"],
        _served_ui_fonts() + "\n" + state["styles_css"],
        title=state["title"],
        data_theme="" if state["mode"] == ColorMode.DARK else "light",
        layout=(query.get("layout") or ["notes"])[0],
        paper=(query.get("paper") or ["a4"])[0],
        bar=True,
    )
    return page.encode("utf-8")


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
    writer: ResponseWriter,
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


_HTML_HEADERS = (
    b"Cache-Control: no-store\r\n"
    # Never inside another site's frame (a click on the editor that its user
    # did not mean), and no share token in a Referer.
    + b"X-Frame-Options: SAMEORIGIN\r\n"
    + b"Content-Security-Policy: frame-ancestors 'self'\r\n"
    + b"Referrer-Policy: no-referrer\r\n"
)


async def _respond(
    writer: ResponseWriter,
    status: str,
    body: bytes,
    content_type: str = "text/html; charset=utf-8",
    extra: bytes = b"",
) -> None:
    writer.write(
        f"HTTP/1.1 {status}\r\n".encode()
        + f"Content-Type: {content_type}\r\n".encode()
        + _HTML_HEADERS
        + extra
        + b"Connection: close\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    await writer.drain()


async def _refuse(writer: ResponseWriter, status: str, title: str, text: str) -> None:
    await _respond(writer, status, page(title, text))


_SSH_401 = (
    "This inkflow server runs on a machine other people can log in to, so "
    + "being on it is not enough to edit. If you started it, open the owner "
    + "link it printed in its terminal (http://localhost:<port>/edit?k=…, "
    + "with your tunnel's local port if you forwarded another one). If someone "
    + "shared the deck with you, open the link they sent."
)

_VIEW_ONLY = (
    "This link shows the presentation only. Ask the person sharing the deck "
    + "for an editor link to change it."
)


def _probe_body() -> bytes:
    session = _editor["session"]
    return json.dumps(
        {
            "pid": os.getpid(),
            "deck": str(session.deck_path)
            if session is not None and session.has_deck
            else None,
        }
    ).encode()


def make_http_route(
    ws_port: int,
    project_dir: Path | None = None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
) -> Route:
    """Everything the one port answers once it knows who asks (``role``,
    and the share ``token`` that admitted them): pages, pictures, fonts,
    downloads. A guest online gets its requests answered by this too
    (``online.host``), so what each role may fetch is decided here once."""

    async def route(
        request: AccessRequest,
        raw: bytes,
        role: Role,
        token: str | None,
        writer: ResponseWriter,
    ) -> None:
        access = _share.access
        request_path = request.target
        path = request.path
        if token is not None and TOKEN_PARAM in request.query:
            # A share link (or the owner link): the cookie keeps them in;
            # the page moves on to the same address without the token.
            who = "owner signed in" if role == "owner" else f"guest joined as {role}"
            logger.info(f"{who} with {redacted(token)}")
            cookie = access.set_cookie(token, request.host)
            await _respond(
                writer,
                "200 OK",
                enter_page(request.without_token()),
                extra=f"Set-Cookie: {cookie}\r\n".encode(),
            )
            return
        editor_only = (
            _is_editor_path(request_path)
            or path.startswith(("/_export/", "/_cmp/"))
            # The handout shows the speaker notes.
            or path == "/handout"
        )
        if editor_only and role == "viewer":
            await _refuse(writer, "403 Forbidden", "View-only link", _VIEW_ONLY)
            return

        if path == instances.PROBE_PATH:
            # Who is serving here (see instances.py): another inkflow
            # opening a deck asks before starting a second server for it.
            if role != "owner":
                await _refuse(writer, "404 Not Found", "Not found", "")
                return
            await _respond(writer, "200 OK", _probe_body(), "application/json")
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
            await _respond(
                writer,
                "200 OK",
                body,
                mime,
                f'Content-Disposition: attachment; filename="{name}"\r\n'.encode(),
            )
            return

        hub = _editor["compare"]
        if hub is not None and request_path.startswith("/_cmp/"):
            # A compared deck's picture, inside that deck's own roots.
            compared = hub.asset(request_path)
            if compared is None:
                await _respond(writer, "404 Not Found", b"")
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
        if starting and role != "owner":
            await _refuse(
                writer, "404 Not Found", "No deck open", "Nothing is shared yet."
            )
            return
        if path == "/handout" and not starting:
            body = build_handout_html(_state, request_path)
        elif _is_editor_path(request_path) or starting:
            body = build_editor_html(_state, _editor, ws_port)
        else:
            # Opening a source file in a program is the owner's alone.
            body = build_html(
                _state,
                ws_port,
                edit_commands if role == "owner" else NO_EDIT_COMMANDS,
            )
        await _respond(writer, "200 OK", body)

    return route


def make_http_handler(
    ws_port: int,
    project_dir: Path | None = None,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
    bridge: Bridge | None = None,
) -> _StreamHandler:
    """The server's one port: pages, pictures, downloads, and (handed to
    ``bridge``) the WebSocket at ``/_inkflow/ws``. ``ws_port`` is what the
    pages are told (they connect to their own address; it only says the
    deck is served)."""
    route = make_http_route(ws_port, project_dir, edit_commands)

    async def handler(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        handed_off = False
        try:
            try:
                raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
            except (
                asyncio.IncompleteReadError,
                asyncio.LimitOverrunError,
                TimeoutError,
            ):
                return
            request = parse_request(raw)
            if request is None:
                await _refuse(writer, "400 Bad Request", "Bad request", "")
                return
            access = _share.access
            if not access.host_ok(request.host):
                # A name this machine does not answer to: a page whose name
                # was pointed at this machine (DNS rebinding).
                await _refuse(
                    writer,
                    "403 Forbidden",
                    "Unknown host name",
                    "This inkflow server answers to its own names and addresses "
                    + "only (add one with --allow-host).",
                )
                return
            peer = peer_host(cast("object", writer.get_extra_info("peername")))
            role, token = access.admit(peer, request)

            if request.path == WS_PATH:
                if not access.origin_ok(request.headers.get("origin"), request.host):
                    # Another site's page opening a socket to this server.
                    await _refuse(writer, "403 Forbidden", "Forbidden", "")
                    return
                if role is None:
                    await _refuse(writer, "401 Unauthorized", "Not shared", "")
                    return
                if bridge is None or not request.is_websocket:
                    await _refuse(writer, "400 Bad Request", "Bad request", "")
                    return
                connection = bridge.adopt(writer, raw)
                _ = _share.people.join(connection, role, token, peer)
                handed_off = True
                return

            if role is None:
                logger.debug(f"refused {peer}: no valid share link")
                if access.ssh and not access.presents_token(request):
                    await _refuse(
                        writer, "401 Unauthorized", "Open the owner link", _SSH_401
                    )
                    return
                await _refuse(
                    writer,
                    "401 Unauthorized",
                    "This deck is not shared with you",
                    "Open the link the person sharing it gave you. A link stops "
                    + "working when they make new ones or stop sharing.",
                )
                return
            await route(request, raw, role, token, writer)
        except Exception:
            # File sink only, never the TUI. The client still gets the 500 body below.
            logger.exception("error handling HTTP request")
            body = traceback.format_exc().encode()
            with contextlib.suppress(Exception):
                await _respond(
                    writer,
                    "500 Internal Server Error",
                    body,
                    "text/plain; charset=utf-8",
                )
        finally:
            if not handed_off:
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
    base: str,
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
                _open_browser(f"{base}:{http_port}{_share.access.owner_path('/')}")
            elif ch == "e":
                path = _share.access.owner_path("/edit")
                _open_browser(f"{base}:{http_port}{path}")
            elif ch == "r" and deck_path is not None:
                # Asked for by hand: every slide again, whatever is kept.
                async with lock:
                    await rebuild(deck_path, ui, levels, full=True)
            elif ch == "t":
                ui.toggle_trace()


# ── Ports ─────────────────────────────────────────────────────────────────────


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


# ── Public entry point ────────────────────────────────────────────────────────


def pick_port(host: str, port: int | None) -> int:
    """The port to serve on: as given, else the first free one from 7777 up,
    so a second ``inkflow edit`` for another deck comes up next to the first."""
    if port is not None:
        return port
    for candidate in range(DEFAULT_PORT, DEFAULT_PORT + 200):
        if _port_free(host, candidate):
            return candidate
    return DEFAULT_PORT


@dataclass(frozen=True)
class Sharing:
    """How a server is shared (``inkflow edit --share``)."""

    share: bool = False
    """Share links work from the start (and the server listens on the LAN,
    except in SSH mode)."""
    ssh: bool = False
    """SSH mode (``--ssh``): only the owner link makes the owner, links name
    ``localhost`` for each guest's tunnel, nothing listens on the network."""
    allow_hosts: tuple[str, ...] = ()
    """More names to answer to: a reverse proxy's, a tailnet name."""
    tls: tuple[Path, Path] | None = None
    """Certificate and key: HTTPS and WSS on the one port."""
    online: bool = False
    """Share online from the start, through the relay set with ``inkflow
    relay set`` (``--share-online``)."""


def _local_host(host: str) -> str:
    """Where the server listens while not shared."""
    return host if is_loopback_name(split_host(host)[0]) else "localhost"


Hosts = str | list[str] | None
"""What ``asyncio.start_server`` listens on (None: every interface)."""


def _lan_host(host: str) -> Hosts:
    """Where it listens while shared: every interface (None), or the address
    asked for (a VPN's, say) and this machine's own name too, so the owner's
    pages and commands still reach it as the owner."""
    name = split_host(host)[0]
    if is_loopback_name(name) or name in ("", "0.0.0.0", "::"):
        return None
    return [host, "localhost"]


def _listen_hosts(host: str, *, shared: bool, ssh: bool) -> Hosts:
    """Where the server listens for ``--host``, shared or not. In SSH mode
    links are opened through tunnels to this machine, so sharing never moves
    the listener onto the network (only an explicit ``--host`` does)."""
    if ssh:
        shared = _shares(host)
    return _lan_host(host) if shared else _local_host(host)


def _shares(host: str) -> bool:
    """Whether a ``--host`` lets other machines in (so it shares)."""
    return not is_loopback_name(split_host(host)[0])


def owner_lines(access: Access, port: int) -> list[str]:
    """In SSH mode, the owner link (the one thing the person who started the
    server opens, through their tunnel) and the tunnel to open it through."""
    if not access.ssh:
        return []
    server = next(iter(sshshare.server_names()), "<this server>")
    user = sshshare.login_user() or "<you>"
    return [
        f"{access.scheme}://localhost:{port}{access.owner_path('/edit')}",
        f"open it through: ssh -L {port}:localhost:{port} {user}@{server}",
    ]


def online_lines() -> list[str]:
    """What the terminal says about sharing online: the two links, or why
    there are none yet."""
    host = _share.online
    if host is None:
        return []
    if host.state == "open":
        return [
            f"edit  {host.link('editor')}  (online)",
            f"view  {host.link('viewer')}  (online)",
        ]
    why = f": {host.error}" if host.error else ""
    return [f"online  {host.state} ({host.relay}){why}"]


def share_lines(access: Access, port: int) -> list[str]:
    """What the terminal says about sharing: the two links per address, the
    mDNS name, and how to reach the server through SSH instead; the online
    links when sharing online. In SSH mode the links name ``localhost``, for
    each guest's own tunnel."""
    if not access.sharing:
        return online_lines()
    lines: list[str] = []
    links = access.links(_link_addresses(access))
    for link in links:
        lines += [f"edit  {link['editor']}", f"view  {link['view']}"]
    if access.ssh:
        lines.append(
            f"guests: ssh -N -L {port}:localhost:{port} <their login>@<this "
            + "server>, then their link (Share → Share via SSH writes it out)"
        )
        return lines + online_lines()
    names = {n for n in access.names if n.endswith(".local")} | access.allow_hosts
    for name in sorted(names):
        lines.append(f"also  {access.scheme}://{name}:{port} (same ?k= links)")
    if not links:
        lines.append("no network address found: use --host <address>")
    lines.append(
        f"ssh   ssh -L {port}:localhost:{port} <you>@<this machine>, "
        + f"then http://localhost:{port}/edit (as the owner)"
    )
    return lines + online_lines()


async def serve(
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int | None,
    levels: Levels,
    open_path: str | None = None,
    exporters: Exporters | None = None,
    quit_when_idle: float | None = None,
    auto_ports: bool = False,
    sharing: Sharing | None = None,
) -> None:
    """Run the server until quit. ``open_path`` (e.g. ``"/edit"``) opens a
    browser on that page once the first build is done; ``exporters`` enable
    the editor's Export dialog. Without a deck (``None``) the editor shows its
    start page: a new deck, another one, or a recent one. With
    ``quit_when_idle`` (seconds) it stops once no page has been connected for
    that long (a server started without a terminal to stop it from).

    One port carries everything: pages, pictures and the WebSocket
    (``/_inkflow/ws``). ``ws_port`` additionally opens the old separate
    WebSocket port (deprecated; for scripts that still use it).

    ``auto_ports``: the port came from ``pick_port``, not the user, so one
    taken in the meantime (another inkflow starting at the same moment, say
    an agent's server for its worktree) means picking the next free one.

    ``sharing``: share links (``--share``); a non-loopback ``host`` shares
    too, since other machines can reach it.

    When the editor opens another deck (or creates one), the server closes and
    starts again on the same port for that deck; open pages reconnect to it."""
    sharing = sharing or Sharing()
    _share.access = Access(
        http_port,
        allow_hosts={h.lower() for h in sharing.allow_hosts},
        tls=sharing.tls is not None,
        sharing=sharing.share or _shares(host),
        ssh=sharing.ssh,
    )
    if sharing.online:
        problem = await start_online()
        if problem is not None:
            report("Error", f"cannot share online: {problem}", style="red")
    try:
        await _serve_decks(
            deck_path,
            host,
            http_port,
            ws_port,
            levels,
            open_path,
            exporters,
            quit_when_idle,
            auto_ports,
            sharing,
        )
    finally:
        await stop_online("the server stopped")


async def _serve_decks(
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int | None,
    levels: Levels,
    open_path: str | None,
    exporters: Exporters | None,
    quit_when_idle: float | None,
    auto_ports: bool,
    sharing: Sharing,
) -> None:
    """``serve``'s loop: one deck after another, as the editor opens them."""
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
                sharing.tls,
            )
        except _PortBusy as busy:
            if retries <= 0:
                report("Error", busy.message, style="red")
                return
            retries -= 1
            http_port = pick_port(host, None)
            _share.access.port = http_port
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


@contextlib.asynccontextmanager
async def listening(
    ui: LiveUI,
    session: EditorSession | None,
    host: str = "127.0.0.1",
    port: int = 0,
    edit_commands: EditCommands = NO_EDIT_COMMANDS,
) -> AsyncGenerator[int]:
    """The one port as ``serve`` opens it (pages, files, the WebSocket at
    ``/_inkflow/ws``), without the terminal UI, watcher or keyboard: for
    tests and for embedding. Yields the port it listens on."""
    project_dir = (
        session.project_dir if session is not None and session.has_deck else None
    )
    bridge = Bridge(
        make_ws_handler(ui, edit_commands, session),
        max_size=80 * 1024 * 1024,
        forget=_share.people.leave,
    )
    handlers: list[_StreamHandler] = []

    async def http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await handlers[0](reader, writer)

    listener = await asyncio.start_server(http, host, port)
    actual = cast("tuple[str, int]", listener.sockets[0].getsockname())[1]
    handlers.append(make_http_handler(actual, project_dir, edit_commands, bridge))
    _share.ws_handler = make_ws_handler(ui, edit_commands, session)
    _share.route = make_http_route(actual, project_dir, edit_commands)
    try:
        yield actual
    finally:
        listener.close()
        await bridge.shutdown()
        _share.ws_handler = None
        _share.route = None


class Listener:
    """The HTTP port's listening socket, which sharing moves between this
    machine only and the network without dropping a connection: closing a
    listening socket leaves the connections it accepted open."""

    def __init__(
        self, handler: _StreamHandler, port: int, tls: ssl.SSLContext | None
    ) -> None:
        self._handler: _StreamHandler = handler
        self._port: int = port
        self._tls: ssl.SSLContext | None = tls
        self.server: asyncio.Server | None = None
        self.host: Hosts = None

    async def open(self, host: Hosts) -> None:
        self.server = await asyncio.start_server(
            self._handler, host, self._port, ssl=self._tls
        )
        self.host = host

    async def move(self, host: Hosts) -> None:
        """Listen on ``host`` instead (None: every interface)."""
        if self.server is not None and host == self.host:
            return
        previous = self.host
        self.close()
        try:
            await self.open(host)
        except OSError:
            await self.open(previous)
            raise

    def close(self) -> None:
        if self.server is not None:
            self.server.close()
            self.server = None


def _ws_check(port: int) -> Callable[[ServerConnection, WsRequest], WsResponse | None]:
    """The door of the old separate WebSocket port: the same checks as the
    one port's (host, origin of the HTTP port's pages, who)."""

    def check(connection: ServerConnection, request: WsRequest) -> WsResponse | None:
        headers = request.headers
        parsed = parse_request(
            f"GET {request.path} HTTP/1.1\r\n".encode()
            + b"".join(
                f"{k}: {v}\r\n".encode("latin-1", "replace")
                for k, v in headers.raw_items()
            )
        )
        access = _share.access
        if parsed is None or not access.host_ok(parsed.host):
            return connection.respond(403, "Unknown host name\n")
        if not access.origin_ok(parsed.headers.get("origin"), parsed.host, port=port):
            return connection.respond(403, "Forbidden\n")
        peer = peer_host(cast("object", connection.remote_address))
        role, token = access.admit(peer, parsed)
        if role is None:
            return connection.respond(401, "Not shared\n")
        _ = _share.people.join(connection, role, token, peer)
        return None

    return check


def _tls_context(tls: tuple[Path, Path] | None) -> ssl.SSLContext | None:
    if tls is None:
        return None
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(str(tls[0]), str(tls[1]))
    return context


async def _serve_deck(
    deck_path: Path | None,
    host: str,
    http_port: int,
    ws_port: int | None,
    levels: Levels,
    open_path: str | None,
    exporters: Exporters | None,
    quit_when_idle: float | None = None,
    tls: tuple[Path, Path] | None = None,
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
    access = _share.access
    scheme = access.scheme
    local_host = _local_host(host)
    # Where this machine's own pages and commands reach it (as the owner).
    browse_host = local_host

    loop = asyncio.get_running_loop()
    uninstall_shutdown_handler = install_shutdown_handler(loop, shutdown)
    bridge: Bridge | None = None
    listener: Listener | None = None

    try:
        edit_commands = resolve_edit_commands()
        session = EditorSession(deck_path, exporters)
        session.edit_commands = edit_commands
        session.server = {
            "host": browse_host,
            "port": http_port,
            "wsPath": WS_PATH,
            "wsPort": ws_port if ws_port is not None else http_port,
            "tls": tls is not None,
        }
        _editor["session"] = session
        _editor["compare"] = CompareHub(deck_path, load_deck) if deck_path else None
        _editor["problems"] = Problems() if deck_path else None
        _editor["edit_slides"] = None
        project_dir = deck_path.parent if deck_path else None
        if deck_path is not None:
            projects.remember(deck_path)
        else:
            _state["title"] = "Inkflow"
        ui_ref: list[LiveUI] = []

        def handler_for_ws() -> Callable[[ServerConnection], Awaitable[None]]:
            return make_ws_handler(ui_ref[0], edit_commands, session)

        async def ws_entry(connection: ServerConnection) -> None:
            await handler_for_ws()(connection)

        # Image uploads from the editor arrive as base64 frames.
        bridge = Bridge(ws_entry, max_size=80 * 1024 * 1024, forget=_share.people.leave)
        http_handler = make_http_handler(http_port, project_dir, edit_commands, bridge)
        _share.ws_handler = ws_entry
        _share.route = make_http_route(http_port, project_dir, edit_commands)
        listener = Listener(http_handler, http_port, _tls_context(tls))

        # Bind before the Live UI so port conflicts fail fast with a clean message
        def listen_on(shared: bool) -> Hosts:
            return _listen_hosts(host, shared=shared, ssh=access.ssh)

        try:
            await listener.open(listen_on(access.sharing))
        except OSError as e:
            if e.errno == errno.EADDRINUSE:
                raise _PortBusy(
                    f"port {http_port} in use — pass --port to use another"
                ) from e
            raise

        async def rebind(shared: bool) -> None:
            assert listener is not None
            await listener.move(listen_on(shared))
            ui_ref[0].set_share(share_lines(access, http_port))

        _share.rebind = rebind
        _share.ssh_info = None
        # Other inkflow processes find this server (and its deck) here; in
        # SSH mode with the owner token, which only this user can read.
        instances.register(
            instances.Instance(
                pid=os.getpid(),
                host=browse_host,
                port=http_port,
                ws_port=ws_port if ws_port is not None else http_port,
                deck=str(deck_path.resolve()) if deck_path else None,
                tls=tls is not None,
                owner_token=access.owner_token if access.ssh else None,
            )
        )
        owner = owner_lines(access, http_port)
        if owner:
            console.print(
                "[bold]SSH mode[/bold]  being on this machine is not enough to "
                + "edit: open the owner link, through your SSH tunnel",
                highlight=False,
            )
            console.print(
                f"[bold]Owner[/bold]  {owner[0]}", highlight=False, soft_wrap=True
            )
            console.print(f"       {owner[1]}", highlight=False)
        for line in share_lines(access, http_port):
            console.print(f"[bold]Sharing[/bold]  {line}", highlight=False)

        with Live(Text(""), console=console, auto_refresh=False) as live:
            ui = LiveUI(
                live,
                browse_host,
                http_port,
                project_dir or Path.home(),
                get_clients=lambda: len(_state["ws_clients"]),
                scheme=scheme,
            )
            ui.set_owner(owner)
            ui.set_share(share_lines(access, http_port))
            ui_ref.append(ui)
            _share.on_change = lambda: ui.set_share(share_lines(access, http_port))
            try:
                async with contextlib.AsyncExitStack() as stack:
                    if ws_port is not None:
                        _ = await stack.enter_async_context(
                            ws_serve(
                                make_ws_handler(ui, edit_commands, session),
                                local_host,
                                ws_port,
                                process_request=_ws_check(http_port),
                                max_size=80 * 1024 * 1024,
                                ssl=_tls_context(tls),
                            )
                        )
                    if deck_path is not None:
                        await rebuild(deck_path, ui, levels)
                    if open_path is not None:
                        _open_browser(
                            f"{scheme}://{browse_host}:{http_port}"
                            + access.owner_path(open_path)
                        )
                    tasks = [
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
                                f"{scheme}://{browse_host}",
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
                        _ = t.cancel()
                    _ = await asyncio.gather(*tasks, return_exceptions=True)
                    listener.close()
                    await bridge.shutdown()
            except OSError as e:
                if e.errno == errno.EADDRINUSE:
                    raise _PortBusy(
                        f"port {ws_port} in use — pass --ws-port to use another"
                    ) from e
                raise
    finally:
        uninstall_shutdown_handler()
        if listener is not None:
            listener.close()
        if bridge is not None:
            await bridge.shutdown()
        _share.rebind = None
        _share.on_change = None
        _share.ws_handler = None
        _share.route = None
        if _share.online is not None:
            # Online guests' pages reconnect, to the next deck if one opens.
            await _share.online.drop_pages()
        if _editor["compare"] is not None:
            _editor["compare"].close_all()
            _editor["compare"] = None
        _editor["switch"] = None
        _editor["shutdown"] = None
        instances.unregister(os.getpid())
    if switch.is_set() and not shutdown.is_set():
        return _editor["session"].switch_to if _editor["session"] else None
    return None
