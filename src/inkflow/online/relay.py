"""The relay: rooms of one host and its guests, forwarding sealed frames.

The same protocol as the Cloudflare Worker (``relay/cloudflare``), for
running on any server (behind HTTPS) and for tests. It also serves the guest
page (``online/guest``), which is what a share link opens.

Protocol (all WebSocket, on the relay's one port):

- ``/_relay/host?room=<id>``: the host opens (or takes back) its room,
  proving it holds the room's secret (header ``Inkflow-Room-Secret``, whose
  hash is the room id) and, when the relay has one, the access token
  (``Authorization: Bearer …``). The relay answers ``{"type":"ready"}`` and
  then tells the host ``{"type":"join"|"leave","peer":n}``. Binary messages
  both ways are a 4-byte peer number and one frame; the host may send
  ``{"type":"kick","peer":n}``.
- ``/_relay/join?room=<id>``: a guest. Binary messages are frames, nothing
  else.
- ``/_relay/health``: ``{"ok": true, "v": 1}`` (plain HTTP).

A room exists while its host is connected: guests joining a room with no
host are closed with 4404, the host leaving closes its guests with 4410.
Guests per room are capped (4409 when full), frames are at most
``MAX_WIRE`` bytes (1009), and each connection may send so many frames
per second (4429). The relay sees room ids, peer numbers, timing and sizes;
the frames are sealed end to end (see ``crypto``).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import importlib.resources
import json
import mimetypes
import secrets
import struct
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, cast
from urllib.parse import parse_qsl, urlsplit

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from inkflow.logging import logger
from inkflow.online.crypto import MAX_FRAME, is_room_id, room_id, unb64u

PROTOCOL = 1
MAX_WIRE = MAX_FRAME + 64
"""A frame plus the peer header, with room to spare."""
MAX_GUESTS = 50

HOST_PATH = "/_relay/host"
JOIN_PATH = "/_relay/join"
HEALTH_PATH = "/_relay/health"
SECRET_HEADER = "Inkflow-Room-Secret"

# Close codes (the Worker uses the same).
NO_ROOM = 4404
ROOM_FULL = 4409
HOST_GONE = 4410
UNAUTHORIZED = 4401
KICKED = 4403
RATE_LIMITED = 4429
BAD_REQUEST = 4400
REPLACED = 4408

_GUEST_BUFFER = 32 * 1024 * 1024
"""Bytes waiting for one slow guest before it is dropped (a frame lost
would break its encryption anyway)."""


def guest_dir() -> Path:
    """The guest page's files, as shipped in the package."""
    return Path(str(importlib.resources.files("inkflow").joinpath("online", "guest")))


@dataclass
class Bucket:
    """Frames a connection may send: ``rate`` per second, ``burst`` at once."""

    rate: float
    burst: float
    tokens: float = -1.0
    at: float = field(default_factory=time.monotonic)

    def take(self) -> bool:
        now = time.monotonic()
        if self.tokens < 0:
            self.tokens = self.burst
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


def guest_bucket() -> Bucket:
    return Bucket(rate=100, burst=400)


def host_bucket() -> Bucket:
    return Bucket(rate=2000, burst=8000)


class _Guest:
    """One guest's connection and the frames on their way to it."""

    def __init__(self, ws: ServerConnection, peer: int) -> None:
        self.ws: ServerConnection = ws
        self.peer: int = peer
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.buffered: int = 0
        self.task: asyncio.Task[None] | None = None

    def put(self, frame: bytes) -> bool:
        if self.buffered + len(frame) > _GUEST_BUFFER:
            return False
        self.buffered += len(frame)
        self.queue.put_nowait(frame)
        return True

    async def pump(self) -> None:
        with contextlib.suppress(ConnectionClosed):
            while True:
                frame = await self.queue.get()
                if frame is None:
                    return
                self.buffered -= len(frame)
                await self.ws.send(frame)


@dataclass
class Room:
    host: ServerConnection
    guests: dict[int, _Guest] = field(default_factory=dict)


@dataclass
class Stats:
    """What a test (or the log) may know: what crossed the relay."""

    frames: int = 0
    bytes: int = 0
    seen: list[bytes] | None = None
    """Every frame forwarded, when recording (tests assert no plaintext)."""
    dump: BinaryIO | None = None
    """Every frame forwarded, appended to a file (``inkflow relay --dump``)."""

    def note(self, frame: bytes) -> None:
        self.frames += 1
        self.bytes += len(frame)
        if self.seen is not None:
            self.seen.append(frame)
        if self.dump is not None:
            _ = self.dump.write(struct.pack(">I", len(frame)) + frame)
            self.dump.flush()


class Relay:
    """The rooms of one relay."""

    def __init__(
        self,
        *,
        access_token: str | None = None,
        max_guests: int = MAX_GUESTS,
        static: Path | None = None,
        record: bool = False,
        dump: BinaryIO | None = None,
    ) -> None:
        self.access_token: str | None = access_token or None
        self.max_guests: int = max_guests
        self.static: Path = static or guest_dir()
        self.rooms: dict[str, Room] = {}
        self.stats: Stats = Stats(seen=[] if record else None, dump=dump)
        self.guest_bucket: Callable[[], Bucket] = guest_bucket
        self.host_bucket: Callable[[], Bucket] = host_bucket
        self._tasks: set[asyncio.Task[None]] = set()

    def _later(self, work: Coroutine[object, object, None]) -> None:
        """Run ``work`` without waiting for it (a close, while forwarding)."""
        task = asyncio.create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # ── HTTP ──

    def process_request(
        self, _connection: ServerConnection, request: Request
    ) -> Response | None:
        path = urlsplit(request.path).path
        upgrade = "websocket" in request.headers.get("Upgrade", "").lower()
        if path in (HOST_PATH, JOIN_PATH) and upgrade:
            return None
        if path == HEALTH_PATH:
            body = json.dumps({"ok": True, "v": PROTOCOL, "relay": "inkflow"})
            return _response(200, body.encode(), "application/json")
        if path.startswith("/_relay/"):
            return _response(404, b"not found\n", "text/plain")
        return self._static(path)

    def _static(self, path: str) -> Response:
        """The guest page: its files under ``/_guest/``, and ``index.html``
        for any other path (a page inside the guest page may be at
        ``/edit``, which is still the guest page as far as the relay goes)."""
        root = self.static.resolve()
        if path.startswith("/_guest/"):
            target = (root / path.lstrip("/")).resolve()
            if not target.is_relative_to(root) or not target.is_file():
                return _response(404, b"not found\n", "text/plain")
        else:
            target = root / "index.html"
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if mime.startswith("text/") or mime.endswith(("javascript", "json")):
            mime += "; charset=utf-8"
        extra: dict[str, str] = {}
        if target.name == "sw.js":
            extra["Service-Worker-Allowed"] = "/"
        return _response(200, target.read_bytes(), mime, extra)

    # ── WebSocket ──

    async def handler(self, ws: ServerConnection) -> None:
        request = ws.request
        assert request is not None
        split = urlsplit(request.path)
        query = dict(parse_qsl(split.query))
        room = query.get("room", "")
        if not is_room_id(room):
            await ws.close(BAD_REQUEST, "bad room")
            return
        if split.path == HOST_PATH:
            await self._host(ws, room, request.headers)
        else:
            await self._guest(ws, room)

    def _host_allowed(self, room: str, headers: Headers) -> str | None:
        """Why this host may not hold ``room`` (None: it may)."""
        if self.access_token is not None:
            given = headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if not hmac.compare_digest(given.encode(), self.access_token.encode()):
                return "this relay needs its access token"
        try:
            secret = unb64u(headers.get(SECRET_HEADER, ""))
        except ValueError:
            return "bad room secret"
        if len(secret) < 16 or not hmac.compare_digest(room_id(secret), room):
            return "not this room's host"
        return None

    async def _host(self, ws: ServerConnection, room: str, headers: Headers) -> None:
        refused = self._host_allowed(room, headers)
        if refused is not None:
            await ws.close(UNAUTHORIZED, refused)
            return
        old = self.rooms.get(room)
        if old is not None:
            # The host again (a new connection after a network change): its
            # guests' sessions were with the old one.
            await self._close_room(old, HOST_GONE, "the host reconnected")
            await old.host.close(REPLACED, "replaced by a new connection")
        current = Room(host=ws)
        self.rooms[room] = current
        logger.info(f"relay: room {room[:6]}… opened")
        bucket = self.host_bucket()
        try:
            await ws.send(
                json.dumps(
                    {
                        "type": "ready",
                        "room": room,
                        "v": PROTOCOL,
                        "maxGuests": self.max_guests,
                        "maxFrame": MAX_FRAME,
                    }
                )
            )
            async for msg in ws:
                if not bucket.take():
                    await ws.close(RATE_LIMITED, "too many frames")
                    return
                if isinstance(msg, str):
                    self._host_control(current, msg)
                    continue
                if len(msg) < 5 or len(msg) > MAX_WIRE:
                    await ws.close(1009, "frame too large")
                    return
                (peer,) = struct.unpack(">I", msg[:4])
                guest = current.guests.get(peer)
                if guest is None:
                    continue
                frame = msg[4:]
                self.stats.note(frame)
                if not guest.put(frame):
                    _ = current.guests.pop(peer, None)
                    self._later(guest.ws.close(1013, "too slow"))
        except ConnectionClosed:
            pass
        finally:
            if self.rooms.get(room) is current:
                del self.rooms[room]
                await self._close_room(current, HOST_GONE, "the host left")
                logger.info(f"relay: room {room[:6]}… closed")

    def _host_control(self, room: Room, text: str) -> None:
        try:
            msg = cast(object, json.loads(text))
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        data = cast("dict[str, object]", msg)
        peer = data.get("peer")
        if data.get("type") == "kick" and isinstance(peer, int):
            guest = room.guests.pop(peer, None)
            if guest is not None:
                guest.queue.put_nowait(None)
                self._later(guest.ws.close(KICKED, "sent away"))

    async def _close_room(self, room: Room, code: int, reason: str) -> None:
        guests = list(room.guests.values())
        room.guests.clear()
        for guest in guests:
            guest.queue.put_nowait(None)
            with contextlib.suppress(Exception):
                await guest.ws.close(code, reason)

    async def _guest(self, ws: ServerConnection, room_name: str) -> None:
        room = self.rooms.get(room_name)
        if room is None:
            await ws.close(NO_ROOM, "no one is sharing in this room now")
            return
        if len(room.guests) >= self.max_guests:
            await ws.close(ROOM_FULL, "the room is full")
            return
        peer = secrets.randbits(32)
        while peer in room.guests:
            peer = secrets.randbits(32)
        guest = _Guest(ws, peer)
        room.guests[peer] = guest
        guest.task = asyncio.create_task(guest.pump())
        bucket = self.guest_bucket()
        try:
            await room.host.send(json.dumps({"type": "join", "peer": peer}))
            async for msg in ws:
                if not bucket.take():
                    await ws.close(RATE_LIMITED, "too many frames")
                    return
                if isinstance(msg, str) or not msg or len(msg) > MAX_WIRE - 4:
                    await ws.close(1009 if msg else BAD_REQUEST, "bad frame")
                    return
                if room.guests.get(peer) is not guest:
                    return
                self.stats.note(msg)
                await room.host.send(struct.pack(">I", peer) + msg)
        except ConnectionClosed:
            pass
        finally:
            guest.queue.put_nowait(None)
            if room.guests.get(peer) is guest:
                del room.guests[peer]
                with contextlib.suppress(Exception):
                    await room.host.send(json.dumps({"type": "leave", "peer": peer}))

    async def serve(self, host: str, port: int) -> Server:
        return await serve(
            self.handler,
            host,
            port,
            process_request=self.process_request,
            max_size=MAX_WIRE,
            # Pings keep idle connections alive through proxies.
            ping_interval=20,
            # A connection sent away with frames still queued (a flood) is not
            # read any more: do not wait long for its side of the close.
            close_timeout=3,
            compression=None,
        )


def _response(
    status: int, body: bytes, mime: str, extra: dict[str, str] | None = None
) -> Response:
    headers = Headers()
    headers["Content-Type"] = mime
    headers["Content-Length"] = str(len(body))
    headers["Cache-Control"] = "no-cache"
    headers["Referrer-Policy"] = "no-referrer"
    headers["X-Content-Type-Options"] = "nosniff"
    headers["X-Frame-Options"] = "SAMEORIGIN"
    headers["Content-Security-Policy"] = "frame-ancestors 'self'"
    for key, value in (extra or {}).items():
        headers[key] = value
    reason = {200: "OK", 404: "Not Found"}.get(status, "OK")
    return Response(status, reason, headers, body)


def token_digest(token: str) -> str:
    """How a log may name an access token."""
    return hashlib.sha256(token.encode()).hexdigest()[:8]
