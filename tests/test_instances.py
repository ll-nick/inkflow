"""One server per deck: the registry of running servers (instances.py), the
editor sending you to the server that has a deck open, quitting, and the
hidden server stopping once no page is open."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast

import pytest
from typing_extensions import override
from websockets.asyncio.server import ServerConnection

from inkflow import instances, server
from inkflow.editor.session import EditError, EditorSession


@pytest.fixture(autouse=True)
def _state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(instances, "_dir", lambda: tmp_path / "servers")


def _answering(pid: int, deck: str | None) -> Iterator[int]:
    """A stand-in server answering the instance probe; yields its port."""

    class Handler(BaseHTTPRequestHandler):
        @override
        def log_message(self, format: str, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            body = json.dumps({"pid": pid, "deck": deck}).encode()
            self.send_response(200 if self.path == instances.PROBE_PATH else 404)
            self.end_headers()
            _ = self.wfile.write(body)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd.server_address[1]
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture
def other_server(tmp_path: Path) -> Iterator[tuple[instances.Instance, Path]]:
    deck = tmp_path / "talk" / "deck.py"
    deck.parent.mkdir()
    deck.write_text("# deck\n", encoding="utf-8")
    pid = os.getpid() + 100000  # another process, as far as the registry knows
    for port in _answering(pid, str(deck.resolve())):
        record = instances.Instance(pid, "127.0.0.1", port, port + 1, str(deck))
        instances.register(record)
        yield record, deck


def test_a_deck_open_in_another_server_is_found(
    other_server: tuple[instances.Instance, Path], tmp_path: Path
) -> None:
    record, deck = other_server
    found = instances.serving(deck)
    assert found is not None and found.port == record.port
    assert found.url() == f"http://127.0.0.1:{record.port}/edit"
    assert instances.serving(deck, exclude_pid=record.pid) is None
    assert instances.serving(tmp_path / "other" / "deck.py") is None


def test_stale_records_are_dropped(tmp_path: Path) -> None:
    for port in _answering(4242, None):
        # The port answers, but as another process: not that server.
        instances.register(instances.Instance(1, "127.0.0.1", port, port + 1, None))
    instances.register(instances.Instance(2, "127.0.0.1", 1, 2, None))  # gone
    (tmp_path / "servers" / "junk.json").write_text("{", encoding="utf-8")
    assert instances.running() == []
    assert list((tmp_path / "servers").iterdir()) == []


def test_opening_a_deck_another_server_has_goes_there(
    other_server: tuple[instances.Instance, Path],
) -> None:
    record, deck = other_server
    session = EditorSession(None)
    result = session.apply(
        {"action": "open-deck", "path": str(deck.parent), "_local": True}, None
    )
    assert result["redirect"] == record.url("/edit")
    assert result["opening"] is False and session.switch_to is None


def test_quit_is_local_only() -> None:
    session = EditorSession(None)
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "quit"}, None)
    assert session.apply({"action": "quit", "_local": True}, None) == {"ok": True}
    assert session.quit_requested


def test_an_idle_server_stops_and_a_watched_one_does_not() -> None:
    async def run(clients: set[object]) -> bool:
        server._state["ws_clients"] = cast("set[ServerConnection]", clients)  # pyright: ignore[reportPrivateUsage]
        shutdown = asyncio.Event()
        task = asyncio.create_task(server._quit_when_idle(shutdown, 2))  # pyright: ignore[reportPrivateUsage]
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(shutdown.wait(), timeout=3.5)
        task.cancel()
        return shutdown.is_set()

    try:
        assert asyncio.run(run(set()))
        assert not asyncio.run(run({object()}))
    finally:
        server._state["ws_clients"] = set()  # pyright: ignore[reportPrivateUsage]
