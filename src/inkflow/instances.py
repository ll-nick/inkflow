"""Running inkflow servers on this machine, one per deck.

Every server records itself in the per-user state directory: its process,
address and the deck it has open (none on the start page). Before a deck is
opened anywhere (``inkflow edit``/``serve``, or the editor's deck menu), the
running servers are asked; one that already has the deck is reused, so two
servers never write the same files.

A record is trusted only when its server answers ``/_inkflow/instance`` with
the same process id: a crashed server's record, or its port since taken by
another program, is dropped on the way.
"""

from __future__ import annotations

import contextlib
import json
import os
import urllib.request
from dataclasses import asdict, dataclass
from http.client import HTTPResponse
from pathlib import Path
from typing import cast

import platformdirs

PROBE_PATH = "/_inkflow/instance"


@dataclass(frozen=True)
class Instance:
    pid: int
    host: str
    port: int
    ws_port: int
    deck: str | None
    """The open deck.py (resolved), or None on the start page."""

    def url(self, path: str = "/edit") -> str:
        host = "localhost" if self.host in ("", "0.0.0.0", "::") else self.host
        return f"http://{host}:{self.port}{path}"


def _dir() -> Path:
    return Path(platformdirs.user_state_dir("inkflow")) / "servers"


def _file(pid: int) -> Path:
    return _dir() / f"{pid}.json"


def register(instance: Instance) -> None:
    """Record (or update) this process's server."""
    try:
        _dir().mkdir(parents=True, exist_ok=True)
        _file(instance.pid).write_text(json.dumps(asdict(instance)), encoding="utf-8")
    except OSError:
        pass  # Only reuse across servers is lost.


def unregister(pid: int) -> None:
    with contextlib.suppress(OSError):
        _file(pid).unlink(missing_ok=True)


def _read(path: Path) -> Instance | None:
    try:
        raw = cast(object, json.loads(path.read_text(encoding="utf-8")))
        data = cast("dict[str, object]", raw)
        deck = data.get("deck")
        return Instance(
            pid=int(cast("int", data["pid"])),
            host=str(data["host"]),
            port=int(cast("int", data["port"])),
            ws_port=int(cast("int", data["ws_port"])),
            deck=str(deck) if isinstance(deck, str) else None,
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def probe(instance: Instance, timeout: float = 1.0) -> dict[str, object] | None:
    """What the server at ``instance`` says about itself, if it is that server."""
    # Straight to the loopback address, never through a configured proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = cast(
            "HTTPResponse", opener.open(instance.url(PROBE_PATH), timeout=timeout)
        )
        with response:
            data = cast("dict[str, object]", json.loads(response.read()))
    except (OSError, ValueError):
        return None
    return data if data.get("pid") == instance.pid else None


def running(exclude_pid: int | None = None) -> list[Instance]:
    """The live servers, with what each has open now; stale records go."""
    found: list[Instance] = []
    if not _dir().is_dir():
        return found
    for path in sorted(_dir().glob("*.json")):
        instance = _read(path)
        if instance is None:
            with contextlib.suppress(OSError):
                path.unlink()
            continue
        if instance.pid == exclude_pid:
            continue
        answer = probe(instance)
        if answer is None:
            with contextlib.suppress(OSError):
                path.unlink()
            continue
        deck = answer.get("deck")
        found.append(
            Instance(
                pid=instance.pid,
                host=instance.host,
                port=instance.port,
                ws_port=instance.ws_port,
                deck=str(deck) if isinstance(deck, str) else None,
            )
        )
    return found


def serving(deck_py: Path, exclude_pid: int | None = None) -> Instance | None:
    """The running server that has ``deck_py`` open, if any."""
    target = os.path.normcase(str(deck_py.resolve()))
    for instance in running(exclude_pid):
        if instance.deck and os.path.normcase(instance.deck) == target:
            return instance
    return None
