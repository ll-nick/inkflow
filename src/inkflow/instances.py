"""Running inkflow servers on this machine, one per deck.

Every server records itself in the per-user state directory: its process,
address and the deck it has open (none on the start page). Before a deck is
opened anywhere (``inkflow edit``/``serve``, or the editor's deck menu), the
running servers are asked; one that already has the deck is reused, so two
servers never write the same files.

A record is trusted only when its server answers ``/_inkflow/instance`` with
the same process id: a crashed server's record, or its port since taken by
another program, is dropped on the way.

A server in SSH mode (``--ssh``) records its owner token too, which this
machine's other users must not read: the directory is the user's own
(``0700``) and each record ``0600``. Commands (``inkflow slide``, ``goto``…)
send it with every request, as the owner's page sends its cookie.
"""

from __future__ import annotations

import contextlib
import json
import os
import ssl
import urllib.request
from dataclasses import asdict, dataclass
from http.client import HTTPResponse
from pathlib import Path
from typing import cast
from urllib.parse import quote

import platformdirs

PROBE_PATH = "/_inkflow/instance"
WS_PATH = "/_inkflow/ws"
"""The server's WebSocket, on its HTTP port."""


@dataclass(frozen=True)
class Instance:
    pid: int
    host: str
    port: int
    ws_port: int
    """The WebSocket's port: the HTTP port, unless an old separate one was
    asked for (``--ws-port``)."""
    deck: str | None
    """The open deck.py (resolved), or None on the start page."""
    tls: bool = False
    """Served over HTTPS (``--tls``)."""
    owner_token: str | None = None
    """SSH mode: what makes a request from this machine the owner."""

    @property
    def address(self) -> str:
        """The host to reach it at from this machine."""
        host = "localhost" if self.host in ("", "0.0.0.0", "::") else self.host
        return f"[{host}]" if ":" in host else host

    def url(self, path: str = "/edit") -> str:
        """A page's address (without the owner token: to show)."""
        return f"{'https' if self.tls else 'http'}://{self.address}:{self.port}{path}"

    def owner_url(self, path: str = "/edit") -> str:
        """A page's address as the owner opens it: with the owner token in
        SSH mode (the owner link)."""
        if not self.owner_token:
            return self.url(path)
        joiner = "&" if "?" in path else "?"
        return self.url(f"{path}{joiner}k={quote(self.owner_token)}")

    def ws_url(self) -> str:
        """The server's WebSocket (on its HTTP port), with the owner token
        in SSH mode."""
        token = f"?k={quote(self.owner_token)}" if self.owner_token else ""
        scheme = "wss" if self.tls else "ws"
        return f"{scheme}://{self.address}:{self.port}{WS_PATH}{token}"

    def cookie(self) -> str | None:
        """The ``Cookie`` header carrying the owner token (SSH mode)."""
        if not self.owner_token:
            return None
        return f"inkflow-owner-{self.port}={self.owner_token}"


def loopback_tls() -> ssl.SSLContext:
    """TLS to this machine's own server, whose certificate (made for its
    network name, or self-signed) need not name localhost: the connection
    never leaves the machine, and who answers is checked by its pid."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def _dir() -> Path:
    return Path(platformdirs.user_state_dir("inkflow")) / "servers"


def _file(pid: int) -> Path:
    return _dir() / f"{pid}.json"


def on_port(port: int) -> Instance | None:
    """The running server on ``port`` (on this machine), if one is."""
    return next((i for i in running() if i.port == port), None)


def register(instance: Instance) -> None:
    """Record (or update) this process's server: readable by this user only
    (the record may hold the owner token)."""
    try:
        folder = _dir()
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            folder.chmod(0o700)  # made before records held secrets
        path = _file(instance.pid)
        data = json.dumps(asdict(instance)).encode()
        partial = path.with_suffix(".tmp")
        partial.unlink(missing_ok=True)
        fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as out:
            _ = out.write(data)
        _ = partial.replace(path)
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
        token = data.get("owner_token")
        return Instance(
            pid=int(cast("int", data["pid"])),
            host=str(data["host"]),
            port=int(cast("int", data["port"])),
            ws_port=int(cast("int", data.get("ws_port", data["port"]))),
            deck=str(deck) if isinstance(deck, str) else None,
            tls=data.get("tls") is True,
            owner_token=token if isinstance(token, str) and token else None,
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def probe(instance: Instance, timeout: float = 1.0) -> dict[str, object] | None:
    """What the server at ``instance`` says about itself, if it is that server."""
    # Straight to the loopback address, never through a configured proxy.
    handlers: list[urllib.request.BaseHandler] = [urllib.request.ProxyHandler({})]
    if instance.tls:
        handlers.append(urllib.request.HTTPSHandler(context=loopback_tls()))
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(instance.url(PROBE_PATH))
    cookie = instance.cookie()
    if cookie:
        request.add_header("Cookie", cookie)
    try:
        response = cast("HTTPResponse", opener.open(request, timeout=timeout))
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
                tls=instance.tls,
                owner_token=instance.owner_token,
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
