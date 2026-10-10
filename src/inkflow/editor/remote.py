"""One editor request from the command line (an agent), applied where it belongs.

Any session action goes this way: ``inkflow slide`` sends the ``slide``
action, ``inkflow shape`` the ``shape`` action (commands that run the editor's
drawing actions, see ``editor/shapes.py``).

When an inkflow server has the deck open, the request goes to it over the
WebSocket, exactly as the editor page sends its own: it becomes a step in that
server's undo History, labelled ``Agent: …``, and every open editor shows it
with an Undo button. Without a server, a fresh ``EditorSession`` applies it to
the files directly: the same code, only without an undo afterwards.

Slide numbers in a request are deck indices the caller resolved against the
deck.py it read; the request carries that file's hash (``deckHash``), so a
server that has built another version refuses it rather than act on the wrong
slide. After the edit, the server's rebuild is waited for, so the next command
sees the deck as this one left it.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from inkflow import instances
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import file_hash
from inkflow.manifest import Deck

# How long to wait for the server to build a deck.py (before and after an edit).
BUILD_WAIT = 30.0
FAILED_GRACE = 2.0
"""How long a failed build of the awaited deck.py must stay the last word."""


class RemoteEditError(Exception):
    """The request was refused, or the server could not be reached in time."""


@dataclass(frozen=True)
class Applied:
    result: dict[str, object]
    """The session's answer: ``label``, ``changes``, ``step``, extras."""
    server: instances.Instance | None
    """The server that applied it (None: applied to the files directly)."""
    build_error: str | None = None
    """The server's build of the result failed (its traceback)."""
    built: bool = True
    """False when the server had not rebuilt within the wait."""


def apply_request(
    deck_path: Path,
    deck: Deck,
    deck_hash: str,
    request: dict[str, object],
    *,
    wait: float = BUILD_WAIT,
) -> Applied:
    """Apply ``request`` (an ``edit-op`` body: ``action`` and its fields) to
    the deck, through the server that has it open if there is one.

    ``deck`` is the deck the caller resolved slide numbers against, loaded
    from the deck.py whose hash is ``deck_hash``.
    """
    request = {**request, "deckHash": deck_hash}
    instance = instances.serving(deck_path)
    if instance is None:
        return Applied(_offline(deck_path, deck, deck_hash, request), None)
    return _on_server(instance, deck_path, deck_hash, request, wait)


def _offline(
    deck_path: Path, deck: Deck, deck_hash: str, request: dict[str, object]
) -> dict[str, object]:
    session = EditorSession(deck_path)
    session.built_hash = deck_hash
    try:
        # This process is on this machine, like a local editor page.
        return session.apply({**request, "_local": True}, deck)
    except EditError as exc:
        raise RemoteEditError(str(exc)) from exc


def _ws_host(instance: instances.Instance) -> str:
    return "localhost" if instance.host in ("", "0.0.0.0", "::") else instance.host


def _on_server(
    instance: instances.Instance,
    deck_path: Path,
    deck_hash: str,
    request: dict[str, object],
    wait: float,
) -> Applied:
    from websockets.exceptions import WebSocketException
    from websockets.sync.client import ClientConnection, connect

    url = f"ws://{_ws_host(instance)}:{instance.ws_port}"
    request_id = f"agent-{time.monotonic_ns()}"

    def receive(
        ws: ClientConnection, wanted: str, deadline: float
    ) -> dict[str, object]:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            try:
                parsed = cast("object", json.loads(ws.recv(timeout=remaining)))
            except ValueError:
                continue
            if isinstance(parsed, dict):
                msg = cast("dict[str, object]", parsed)
                if msg.get("type") == wanted and (
                    wanted != "edit-result" or msg.get("id") == request_id
                ):
                    return msg

    def built(ws: ClientConnection, target: str) -> dict[str, object] | None:
        """Wait until the server has built (or failed to build) ``target``;
        the last status, or None when the wait ran out."""
        deadline = time.monotonic() + wait
        failed_at: float | None = None
        failed_status: dict[str, object] | None = None
        while True:
            ws.send(json.dumps({"type": "build-status"}))
            try:
                status = receive(ws, "build-status", deadline)
            except TimeoutError:
                return failed_status if failed_at is not None else None
            if status.get("deckHash") == target:
                return status
            if status.get("failedHash") == target:
                # A build that read a file mid-write fails, and the write's
                # own rebuild follows: a failure stands once it has lasted.
                failed_at = failed_at or time.monotonic()
                failed_status = status
                if time.monotonic() - failed_at >= FAILED_GRACE:
                    return status
            time.sleep(0.1)

    try:
        with connect(url, open_timeout=3, max_size=None, proxy=None) as ws:
            before = built(ws, deck_hash)
            if before is None:
                raise RemoteEditError(
                    f"the inkflow server at {instance.url()} has not built the "
                    + "current deck.py yet; try again"
                )
            if before.get("deckHash") != deck_hash:
                raise RemoteEditError(
                    "deck.py does not build, so the editor cannot change it: "
                    + "fix it first (see `inkflow verify`)"
                )
            ws.send(json.dumps({"type": "edit-op", "id": request_id, **request}))
            try:
                result = receive(ws, "edit-result", time.monotonic() + wait)
            except TimeoutError as exc:
                raise RemoteEditError(
                    f"the inkflow server at {instance.url()} did not answer"
                ) from exc
            if not result.get("ok"):
                raise RemoteEditError(str(result.get("error") or "edit refused"))
            hashes = cast("dict[str, str]", result.get("hashes") or {})
            new_hash = hashes.get(str(deck_path.resolve()))
            if not new_hash:
                return Applied(result, instance)
            after = built(ws, new_hash)
    except (OSError, WebSocketException) as exc:
        raise RemoteEditError(
            f"lost the inkflow server at {instance.url()} ({exc})"
        ) from exc
    if after is None:
        return Applied(result, instance, built=False)
    error = None if after.get("deckHash") == new_hash else after.get("error")
    return Applied(result, instance, build_error=str(error) if error else None)


def deck_file_hash(deck_path: Path) -> str:
    return file_hash(deck_path.read_bytes())
