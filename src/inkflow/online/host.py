"""The host: this inkflow holding a room on a relay, with its guests.

``OnlineHost`` connects *out* to the relay (so it works behind NAT and
firewalls), opens the room named by its room secret, and takes back the
room after a network change. Each guest (a browser tab on the guest page)
is a ``Guest``: its handshake (``crypto.accept``: the key that made the
``hello`` is the guest's role), then sealed frames carrying messages
(``frames``). What a guest asks for is served exactly as the one port serves
a page on the network:

- ``open`` makes a ``VirtualConnection``, which the server runs through its
  WebSocket handler like any other (``Hooks.connect``): roles, the message
  filter, presence, undo per person and owner-only actions apply unchanged;
- ``get`` is answered by the server's HTTP routing (``Hooks.fetch``) into a
  ``_Capture`` writer, whose response goes back as ``res``/``body``/``end``.

Nothing here imports the server (it imports this): the hooks are handed in.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import struct
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Literal, cast
from urllib.parse import quote, urlsplit

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from inkflow.logging import logger
from inkflow.online import crypto
from inkflow.online.crypto import CryptoError, Role, Session, b64u, new_secret
from inkflow.online.frames import (
    FrameError,
    Reassembler,
    chunks,
    pack,
    unpack,
    unwrap,
    wrap,
)
from inkflow.online.relay import (
    HOST_GONE,
    HOST_PATH,
    MAX_WIRE,
    REPLACED,
    SECRET_HEADER,
    UNAUTHORIZED,
)

State = Literal["off", "connecting", "open", "retrying", "error"]

RANGE_CAP = 4 * 1024 * 1024
"""An open-ended byte range (a video's ``bytes=N-``) is answered with at
most this much; the browser asks for the rest as it plays."""
BODY_CHUNK = 1024 * 1024
VIEWER_MESSAGE_LIMIT = 1024 * 1024
"""A viewer sends small messages only (presence, a slide request)."""
_OPEN_RANGE = re.compile(r"^bytes=(\d+)-$")
_PATH = re.compile(r"^/[\x21-\x7e]{0,4000}$")
"""A request target as a page asks for one: printable, no spaces or line
breaks (it becomes a request line for the server's routing)."""
_RANGE = re.compile(r"^bytes=\d{0,20}-\d{0,20}$")
_RESPONSE_HEADERS = (
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
    "cache-control",
)


class VirtualClosed(Exception):
    """A message sent on a page connection that is gone."""


Writer = Callable[[dict[str, object], bytes], Awaitable[None]]


@dataclass
class Hooks:
    """What the server provides."""

    connect: Callable[[VirtualConnection, Role], Awaitable[None]]
    """Run one page connection (the server's WebSocket handler) until it
    closes."""
    fetch: Callable[[str, str | None, Role, _Capture], Awaitable[None]]
    """Answer a GET (path, Range header, role) into the writer."""
    changed: Callable[[], Coroutine[object, object, None]]
    """The status changed (the owner's Share dialog shows it)."""


class VirtualConnection:
    """A guest's page connection, shaped as the server's WebSocket
    handler uses one: ``send``, ``close``, ``async for``."""

    def __init__(self, guest: Guest, cid: int) -> None:
        self.guest: Guest = guest
        self.cid: int = cid
        self.inbox: asyncio.Queue[str | None] = asyncio.Queue()
        self.closed: bool = False
        self.remote_address: tuple[str, int] = ("online", guest.peer)
        self.request: None = None

    async def send(self, message: str | bytes) -> None:
        if self.closed:
            raise VirtualClosed
        body = message.encode() if isinstance(message, str) else message
        await self.guest.send({"t": "ws", "c": self.cid}, body)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed:
            return
        self.closed = True
        self.inbox.put_nowait(None)
        with contextlib.suppress(Exception):
            await self.guest.send(
                {"t": "close", "c": self.cid, "code": code, "reason": reason}
            )

    def ended(self) -> None:
        """The guest went away: end the handler's loop."""
        self.closed = True
        self.inbox.put_nowait(None)

    def __aiter__(self) -> VirtualConnection:
        return self

    async def __anext__(self) -> str:
        message = await self.inbox.get()
        if message is None:
            raise StopAsyncIteration
        return message


class _Capture:
    """An HTTP response written by the server's routing, sent to a guest as
    ``res`` (status, headers), ``body`` chunks as they are drained, and
    ``end``."""

    def __init__(self, guest: Guest, rid: int) -> None:
        self.guest: Guest = guest
        self.rid: int = rid
        self._raw: bytes = b""
        """The response head, until its blank line has been written."""
        self._head: bytes | None = None
        """The complete head, not yet sent."""
        self._in_body: bool = False
        self._body: list[bytes] = []
        self.status: int = 0

    def write(self, data: bytes) -> None:
        if not self._in_body:
            self._raw += data
            if b"\r\n\r\n" not in self._raw:
                return
            self._head, data = self._raw.split(b"\r\n\r\n", 1)
            self._raw, self._in_body = b"", True
        if data:
            self._body.append(data)

    async def _send_head(self) -> None:
        head, self._head = self._head, None
        if head is None:
            return
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ", 2)
        self.status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 500
        headers: dict[str, str] = {}
        for line in lines[1:]:
            name, sep, value = line.partition(":")
            if sep and name.strip().lower() in _RESPONSE_HEADERS:
                headers[name.strip().lower()] = value.strip()
        await self.guest.send(
            {"t": "res", "id": self.rid, "status": self.status, "headers": headers}
        )

    async def drain(self) -> None:
        await self._send_head()
        if not self._body:
            return
        data = b"".join(self._body)
        self._body = []
        for i in range(0, len(data), BODY_CHUNK):
            await self.guest.send(
                {"t": "body", "id": self.rid}, data[i : i + BODY_CHUNK]
            )

    async def finish(self) -> None:
        await self.drain()
        if self.status == 0:
            await self.guest.send(
                {"t": "res", "id": self.rid, "status": 502, "headers": {}}
            )
        await self.guest.send({"t": "end", "id": self.rid})

    # The rest of asyncio.StreamWriter as the routing uses it.
    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass

    def get_extra_info(self, _name: str, default: object = None) -> object:
        return default


class Guest:
    """One guest connection through the relay (a browser tab)."""

    def __init__(self, host: OnlineHost, peer: int) -> None:
        self.host: OnlineHost = host
        self.peer: int = peer
        self.session: Session | None = None
        self.role: Role | None = None
        self.reassembler: Reassembler = Reassembler()
        self.conns: dict[int, VirtualConnection] = {}
        self.tasks: dict[int, asyncio.Task[None]] = {}
        self.lock: asyncio.Lock = asyncio.Lock()
        self.gone: bool = False
        self.sent_bytes: int = 0
        self.received_bytes: int = 0

    async def send(self, header: dict[str, object], body: bytes = b"") -> None:
        """One message, sealed in as many frames as it takes."""
        session = self.session
        if session is None or self.gone:
            raise VirtualClosed
        async with self.lock:
            for chunk in chunks(wrap(pack(header, body), deflate=True)):
                frame = session.seal(chunk)
                self.sent_bytes += len(frame)
                await self.host.send_frame(self.peer, frame)

    async def receive(self, frame: bytes) -> None:
        self.received_bytes += len(frame)
        if self.session is None:
            accepted = crypto.accept(self.host.link_secrets, self.host.room, frame)
            if accepted is None:
                logger.info("online: a guest's key matches no link; sent away")
                await self.host.kick(self.peer)
                return
            self.role, reply, self.session = accepted
            if self.role == "viewer":
                self.reassembler = Reassembler(VIEWER_MESSAGE_LIMIT)
            await self.host.send_frame(self.peer, reply)
            await self.send({"t": "hi", "role": self.role})
            logger.info(f"online: a guest joined as {self.role}")
            return
        try:
            message = self.reassembler.push(self.session.open(frame))
            if message is None:
                return
            header, body = unpack(unwrap(message))
        except (CryptoError, FrameError) as exc:
            logger.warning(f"online: dropped a guest: {exc}")
            await self.host.kick(self.peer)
            self.end()
            return
        self._handle(header, body)

    def _handle(self, header: dict[str, object], body: bytes) -> None:
        kind = header.get("t")
        cid = header.get("c")
        if kind == "ws" and isinstance(cid, int):
            conn = self.conns.get(cid)
            if conn is not None and not conn.closed:
                conn.inbox.put_nowait(body.decode("utf-8", "replace"))
        elif kind == "open" and isinstance(cid, int) and cid not in self.conns:
            if len(self.conns) >= 8:
                return
            conn = VirtualConnection(self, cid)
            self.conns[cid] = conn
            self._spawn(-cid - 1, self._run(conn))
        elif kind == "close" and isinstance(cid, int):
            conn = self.conns.get(cid)
            if conn is not None:
                conn.ended()
        elif kind == "get":
            rid = header.get("id")
            path = header.get("path")
            range_ = header.get("range")
            if not isinstance(range_, str) or not _RANGE.match(range_):
                range_ = None
            if (
                isinstance(rid, int)
                and rid >= 0
                and isinstance(path, str)
                and _PATH.match(path)
                and rid not in self.tasks
                and len(self.tasks) < 64
            ):
                self._spawn(rid, self._fetch(rid, path, range_))
        elif kind == "cancel":
            rid = header.get("id")
            task = self.tasks.get(rid) if isinstance(rid, int) else None
            if task is not None:
                _ = task.cancel()

    def _spawn(self, key: int, work: Awaitable[None]) -> None:
        async def run() -> None:
            try:
                await work
            except (VirtualClosed, asyncio.CancelledError):
                pass
            except Exception:
                logger.exception("online: serving a guest failed")
            finally:
                _ = self.tasks.pop(key, None)

        self.tasks[key] = asyncio.create_task(run())

    async def _run(self, conn: VirtualConnection) -> None:
        assert self.role is not None
        try:
            await self.host.hooks.connect(conn, self.role)
        finally:
            _ = self.conns.pop(conn.cid, None)
            if not conn.closed:
                await conn.close(1000, "")

    async def _fetch(self, rid: int, path: str, range_: str | None) -> None:
        assert self.role is not None
        if range_ is not None:
            m = _OPEN_RANGE.match(range_.strip())
            if m:
                start = int(m.group(1))
                range_ = f"bytes={start}-{start + RANGE_CAP - 1}"
        capture = _Capture(self, rid)
        await self.host.hooks.fetch(path, range_, self.role, capture)
        await capture.finish()

    def end(self) -> None:
        """The guest left (or was sent away): end its pages and requests."""
        self.gone = True
        for conn in list(self.conns.values()):
            conn.ended()
        for key, task in list(self.tasks.items()):
            if key >= 0:  # a request (pages end with their connections)
                _ = task.cancel()


def relay_ws_url(relay: str) -> str:
    """``wss://…/_relay/host`` for a relay's ``https://…`` address."""
    split = urlsplit(relay.strip())
    scheme = "wss" if split.scheme == "https" else "ws"
    return f"{scheme}://{split.netloc}{HOST_PATH}"


def normalize_relay(url: str) -> str:
    """A relay address as links use it: scheme and host, no trailing path."""
    text = url.strip()
    if "://" not in text:
        text = "https://" + text
    split = urlsplit(text)
    if split.scheme not in ("http", "https") or not split.netloc:
        raise ValueError(f"not a relay address: {url}")
    return f"{split.scheme}://{split.netloc}"


class OnlineHost:
    """This inkflow's room on a relay."""

    def __init__(self, relay: str, token: str | None, hooks: Hooks) -> None:
        self.relay: str = normalize_relay(relay)
        self.token: str | None = token or None
        self.hooks: Hooks = hooks
        self.state: State = "off"
        self.error: str | None = None
        self.guests: dict[int, Guest] = {}
        self._ws: ClientConnection | None = None
        self._task: asyncio.Task[None] | None = None
        self._background: set[asyncio.Task[None]] = set()
        self._new_keys()

    def _new_keys(self) -> None:
        self.room_secret: bytes = new_secret()
        self.room: str = crypto.room_id(self.room_secret)
        self.link_secrets: dict[Role, bytes] = {
            "editor": new_secret(),
            "viewer": new_secret(),
        }

    def link(self, role: Role) -> str:
        """A share link: the relay's guest page, the room and the role's
        key in the fragment (which never leaves the guest's browser)."""
        return f"{self.relay}/#r={self.room}&k={b64u(self.link_secrets[role])}"

    def status(self) -> dict[str, object]:
        live = self.state == "open"
        return {
            "relay": self.relay,
            "state": self.state,
            "error": self.error,
            "room": self.room,
            "links": {"editor": self.link("editor"), "view": self.link("viewer")}
            if live
            else None,
            "guests": sum(1 for g in self.guests.values() if g.session is not None),
        }

    # ── Lifecycle ──

    def start(self) -> None:
        if self._task is None or self._task.done():
            self.state = "connecting"
            self.error = None
            self._task = asyncio.create_task(self._run())

    async def stop(self, reason: str = "sharing stopped") -> None:
        """Send every guest away (their pages do not reconnect) and leave."""
        await self._bye_all(reason)
        task, self._task = self._task, None
        if task is not None:
            _ = task.cancel()
            with contextlib.suppress(BaseException):
                await task
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        self._end_guests()
        self.state = "off"

    async def rotate(self) -> None:
        """New links: a new room and new keys; everyone on the old ones is
        sent away."""
        await self._bye_all("new links")
        self._new_keys()
        self._end_guests()
        if self._ws is not None:
            # The run loop opens the new room at once.
            with contextlib.suppress(Exception):
                await self._ws.close()

    async def drop_pages(self, code: int = 1012, reason: str = "restarting") -> None:
        """Close every guest page's connection (the server opens another
        deck): the pages reconnect, and so reach the new one."""
        for guest in list(self.guests.values()):
            for conn in list(guest.conns.values()):
                await conn.close(code, reason)

    async def _bye_all(self, reason: str) -> None:
        for guest in list(self.guests.values()):
            if guest.session is not None and not guest.gone:
                with contextlib.suppress(Exception):
                    await guest.send({"t": "bye", "reason": reason})

    def _end_guests(self) -> None:
        for guest in self.guests.values():
            guest.end()
        self.guests.clear()

    async def _set(self, state: State, error: str | None = None) -> None:
        changed = (state, error) != (self.state, self.error)
        self.state, self.error = state, error
        if changed:
            with contextlib.suppress(Exception):
                await self.hooks.changed()

    async def _run(self) -> None:
        delay = 1.0
        while True:
            try:
                if await self._connect_once():
                    continue  # new links: the new room at once
                delay = 1.0
            except _Refused as refused:
                await self._set("error", refused.reason)
                return
            except (OSError, ConnectionClosed, InvalidStatus, TimeoutError) as exc:
                await self._set("retrying", _why(exc))
            self._end_guests()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    async def _connect_once(self) -> bool:
        """Hold the room until the connection ends; True when it ended
        because the room changed (new links)."""
        headers = {SECRET_HEADER: b64u(self.room_secret)}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        room = self.room
        url = f"{relay_ws_url(self.relay)}?room={quote(room)}"
        async with connect(
            url,
            additional_headers=headers,
            max_size=MAX_WIRE,
            compression=None,
            open_timeout=15,
            user_agent_header="inkflow",
        ) as ws:
            self._ws = ws
            try:
                ready = await asyncio.wait_for(ws.recv(), 15)
                if not isinstance(ready, str) or '"ready"' not in ready:
                    raise _Refused("the relay did not answer as an inkflow relay")
                logger.info(f"online: room {room[:6]}… open on {self.relay}")
                await self._set("open")
                async for msg in ws:
                    if isinstance(msg, str):
                        self._control(msg)
                    elif len(msg) > 4:
                        (peer,) = struct.unpack(">I", msg[:4])
                        guest = self.guests.get(peer)
                        if guest is not None:
                            await guest.receive(msg[4:])
            except ConnectionClosed as closed:
                rcvd = closed.rcvd
                if rcvd is not None and rcvd.code == UNAUTHORIZED:
                    raise _Refused(f"the relay refused: {rcvd.reason}") from closed
                if rcvd is not None and rcvd.code == REPLACED:
                    raise _Refused("another inkflow took this room") from closed
                if room != self.room:
                    return True
                raise
            finally:
                self._ws = None
            if room != self.room:
                return True
            raise ConnectionClosed(None, None)

    def _control(self, text: str) -> None:
        try:
            msg = cast(object, json.loads(text))
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        data = cast("dict[str, object]", msg)
        peer = data.get("peer")
        if not isinstance(peer, int):
            return
        if data.get("type") == "join":
            self.guests[peer] = Guest(self, peer)
        elif data.get("type") == "leave":
            guest = self.guests.pop(peer, None)
            if guest is not None:
                guest.end()
                if guest.session is not None:
                    task = asyncio.create_task(self.hooks.changed())
                    self._background.add(task)
                    task.add_done_callback(self._background.discard)

    async def send_frame(self, peer: int, frame: bytes) -> None:
        ws = self._ws
        if ws is None:
            raise VirtualClosed
        try:
            await ws.send(struct.pack(">I", peer) + frame)
        except ConnectionClosed as exc:
            raise VirtualClosed from exc

    async def kick(self, peer: int) -> None:
        guest = self.guests.pop(peer, None)
        if guest is not None:
            guest.end()
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(ConnectionClosed):
                await ws.send(json.dumps({"type": "kick", "peer": peer}))


class _Refused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason: str = reason


def _why(exc: BaseException) -> str:
    if isinstance(exc, InvalidStatus):
        return f"the relay answered HTTP {exc.response.status_code}"
    if isinstance(exc, ConnectionClosed):
        rcvd = exc.rcvd
        if rcvd is not None and rcvd.code == HOST_GONE:
            return "the relay closed the room"
        return "lost the connection to the relay"
    return f"cannot reach the relay: {exc}" if str(exc) else "cannot reach the relay"
