"""Sharing online: the encryption (keys, handshake, sealed frames, the
vectors the browser side is held to), messages in frames, the relay's room
rules, and a deck shared through a relay to guests speaking the protocol
as the guest page does."""

from __future__ import annotations

import asyncio
import json
import os
import struct
import threading
from collections.abc import Coroutine, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar, cast
from urllib.parse import parse_qsl

import pytest
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import ClientConnection, connect

from inkflow import server
from inkflow.editor.session import EditorSession
from inkflow.logging import resolve_levels
from inkflow.online import crypto, frames
from inkflow.online.crypto import CryptoError, b64u, unb64u
from inkflow.online.relay import (
    HOST_GONE,
    KICKED,
    NO_ROOM,
    RATE_LIMITED,
    ROOM_FULL,
    SECRET_HEADER,
    UNAUTHORIZED,
    Bucket,
    Relay,
)
from inkflow.tui import LiveUI
from tests import test_slides_cli as slides_tests

project = slides_tests.project
T = TypeVar("T")
VECTORS = Path(__file__).parent / "data" / "online_vectors.json"


# ── Keys and frames (pure) ────────────────────────────────────────────────────


def test_hkdf_is_rfc_5869() -> None:
    # RFC 5869, test case 1.
    okm = crypto.hkdf(
        bytes.fromhex("0b" * 22),
        bytes.fromhex("000102030405060708090a0b0c"),
        bytes.fromhex("f0f1f2f3f4f5f6f7f8f9"),
        42,
    )
    assert okm.hex() == (
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
        + "34007208d5b887185865"
    )


DEFLATABLE = ("<svg>" + "<rect/>" * 400 + "</svg>").encode()


def _vectors() -> dict[str, object]:
    """What the browser's Web Crypto must agree with (src/ts/guest)."""
    room_secret = bytes(range(32))
    room = crypto.room_id(room_secret)
    link = bytes(range(100, 132))
    cnonce = bytes([7] * 32)
    snonce = bytes([9] * 32)
    hello = crypto.hello(link, room, cnonce)
    accepted = crypto.accept({"editor": link}, room, hello, snonce)
    assert accepted is not None
    _, welcome, host = accepted
    g2h, h2g = crypto.session_keys(link, room, cnonce, snonce)
    message = frames.pack({"t": "ws", "c": 1}, b'{"type":"hello"}')
    host.sent = 5
    sealed = host.seal(message)
    return {
        "roomSecret": b64u(room_secret),
        "room": room,
        "link": b64u(link),
        "authKey": crypto.auth_key(link, room).hex(),
        "cnonce": cnonce.hex(),
        "snonce": snonce.hex(),
        "hello": hello.hex(),
        "welcome": welcome.hex(),
        "g2h": g2h.hex(),
        "h2g": h2g.hex(),
        "message": message.hex(),
        "seq": 5,
        "sealed": sealed.hex(),
        "chunks": [c.hex() for c in frames.chunks(bytes(range(10)), 4)],
        "wrapped": frames.wrap(message).hex(),
        "deflated": frames.wrap(DEFLATABLE, deflate=True).hex(),
        "deflatable": DEFLATABLE.decode(),
    }


def test_the_vectors_file_is_what_this_side_computes() -> None:
    expected = cast("dict[str, object]", json.loads(VECTORS.read_text()))
    if os.environ.get("INKFLOW_WRITE_VECTORS"):
        VECTORS.write_text(json.dumps(_vectors(), indent=2) + "\n")
        expected = _vectors()
    assert _vectors() == expected


def test_the_room_id_is_a_hash_of_the_secret_only_the_host_has() -> None:
    secret = crypto.new_secret()
    room = crypto.room_id(secret)
    assert crypto.is_room_id(room) and room == crypto.room_id(secret)
    assert room != crypto.room_id(crypto.new_secret())
    assert not crypto.is_room_id("../../etc") and not crypto.is_room_id("a" * 23)


def _pair(
    role: crypto.Role = "editor",
) -> tuple[crypto.Session, crypto.Session, dict[crypto.Role, bytes], str]:
    secrets_: dict[crypto.Role, bytes] = {
        "editor": crypto.new_secret(),
        "viewer": crypto.new_secret(),
    }
    room = crypto.room_id(crypto.new_secret())
    hello = crypto.hello(secrets_[role], room)
    accepted = crypto.accept(secrets_, room, hello)
    assert accepted is not None
    got, welcome, host = accepted
    assert got == role
    guest = crypto.finish(secrets_[role], room, hello, welcome)
    return guest, host, secrets_, room


def test_the_key_that_made_the_hello_is_the_role() -> None:
    for role in ("editor", "viewer"):
        guest, host, _, _ = _pair(role)
        assert host.role == role
        assert host.open(guest.seal(b"x")) == b"x"
        assert guest.open(host.seal(b"y")) == b"y"


def test_a_key_of_no_link_gets_nowhere() -> None:
    _, _, secrets_, room = _pair()
    stranger = crypto.hello(crypto.new_secret(), room)
    assert crypto.accept(secrets_, room, stranger) is None
    # Nor the right key for another room (a link of an earlier share).
    other = crypto.hello(secrets_["editor"], crypto.room_id(crypto.new_secret()))
    assert crypto.accept(secrets_, room, other) is None
    assert crypto.accept(secrets_, room, b"\x01short") is None


def test_the_relay_cannot_answer_for_the_host() -> None:
    link = crypto.new_secret()
    room = crypto.room_id(crypto.new_secret())
    hello = crypto.hello(link, room)
    forged = bytes([crypto.WELCOME]) + bytes(32) + bytes(32)
    with pytest.raises(CryptoError):
        crypto.finish(link, room, hello, forged)


def test_a_viewer_key_cannot_speak_as_an_editor() -> None:
    viewer, host, secrets_, room = _pair("viewer")
    assert host.role == "viewer"
    # Keys derived from the editor link for this connection do not open it.
    hello = crypto.hello(secrets_["viewer"], room)
    accepted = crypto.accept(secrets_, room, hello)
    assert accepted is not None
    _, welcome, other_host = accepted
    cnonce, snonce = hello[1:33], welcome[1:33]
    g2h, _ = crypto.session_keys(secrets_["editor"], room, cnonce, snonce)
    forged = crypto.seal(g2h, 0, b"edit")
    with pytest.raises(CryptoError):
        other_host.open(forged)
    assert viewer.sent == 0


def test_replayed_reordered_or_tampered_frames_are_refused() -> None:
    guest, host, _, _ = _pair()
    first, second = guest.seal(b"one"), guest.seal(b"two")
    with pytest.raises(CryptoError):
        host.open(second)  # out of order
    assert host.open(first) == b"one"
    with pytest.raises(CryptoError):
        host.open(first)  # again
    assert host.open(second) == b"two"
    third = bytearray(guest.seal(b"three"))
    third[-1] ^= 1
    with pytest.raises(CryptoError):
        host.open(bytes(third))
    # The header (its sequence number) is authenticated too.
    fourth = bytearray(guest.seal(b"four"))
    fourth[8] ^= 1
    with pytest.raises(CryptoError):
        host.open(bytes(fourth))


def test_two_connections_with_one_link_never_share_keys() -> None:
    link = crypto.new_secret()
    room = crypto.room_id(crypto.new_secret())
    keys: set[bytes] = set()
    for _ in range(2):
        hello = crypto.hello(link, room)
        accepted = crypto.accept({"editor": link}, room, hello)
        assert accepted is not None
        keys.add(accepted[2].send_key)
    assert len(keys) == 2


def test_messages_are_chunked_and_put_back_together() -> None:
    message = os.urandom(3 * frames.CHUNK + 17)
    parts = frames.chunks(message)
    assert len(parts) == 4 and all(len(p) <= crypto.MAX_PLAINTEXT for p in parts)
    again = frames.Reassembler()
    assert [again.push(p) for p in parts[:-1]] == [None] * 3
    assert again.push(parts[-1]) == message
    assert frames.Reassembler().push(frames.chunks(b"")[0]) == b""
    small = frames.Reassembler(limit=10)
    with pytest.raises(frames.FrameError):
        for p in frames.chunks(bytes(30), 8):
            small.push(p)
    header, body = frames.unpack(frames.pack({"t": "x", "n": 1}, b"\x00\xff"))
    assert header == {"t": "x", "n": 1} and body == b"\x00\xff"
    for bad in (b"", b"\x00\x00\x00\x09{}", b"\x00\x00\x00\x02[]"):
        with pytest.raises(frames.FrameError):
            frames.unpack(bad)


def test_the_host_compresses_and_guests_may_not() -> None:
    big = frames.pack({"t": "ws", "c": 1}, DEFLATABLE)
    wrapped = frames.wrap(big, deflate=True)
    assert wrapped[0] == frames.DEFLATE and len(wrapped) < len(big) // 5
    assert frames.unwrap(wrapped, deflate=True) == big
    with pytest.raises(frames.FrameError):
        frames.unwrap(wrapped)  # what the host takes from a guest
    small = frames.wrap(b"x", deflate=True)
    assert small == b"\x00x" and frames.unwrap(small) == b"x"
    bomb = frames.wrap(bytes(10_000), deflate=True)
    with pytest.raises(frames.FrameError):
        frames.unwrap(bomb, deflate=True, limit=1000)
    for bad in (b"", b"\x07x", b"\x01not deflate"):
        with pytest.raises(frames.FrameError):
            frames.unwrap(bad, deflate=True)


def test_a_sealed_frame_never_exceeds_the_limit() -> None:
    guest, _, _, _ = _pair()
    for part in frames.chunks(os.urandom(frames.CHUNK * 2)):
        assert len(guest.seal(part)) <= crypto.MAX_FRAME


# ── The relay ─────────────────────────────────────────────────────────────────


@dataclass
class Running:
    relay: Relay
    port: int
    loop: asyncio.AbstractEventLoop

    def call(self, coro: Coroutine[object, object, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(20)


@pytest.fixture
def relay() -> Iterator[Running]:
    """A Python relay on a thread of its own."""
    loop = asyncio.new_event_loop()
    started = threading.Event()
    stop = asyncio.Event()
    box: list[Running] = []

    async def run() -> None:
        relay = Relay(record=True)
        srv = await relay.serve("127.0.0.1", 0)
        port = cast("tuple[str, int]", next(iter(srv.sockets)).getsockname())[1]
        box.append(Running(relay, port, loop))
        started.set()
        await stop.wait()
        srv.close()
        await srv.wait_closed()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(10)
    try:
        yield box[0]
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()


def _host_ws(port: int, secret: bytes, token: str | None = None) -> ClientConnection:
    room = crypto.room_id(secret)
    headers = {SECRET_HEADER: b64u(secret)}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return connect(
        f"ws://127.0.0.1:{port}/_relay/host?room={room}",
        proxy=None,
        additional_headers=headers,
        max_size=None,
    )


def _guest_ws(port: int, room: str) -> ClientConnection:
    return connect(
        f"ws://127.0.0.1:{port}/_relay/join?room={room}", proxy=None, max_size=None
    )


def _closed_with(ws: ClientConnection) -> int | None:
    with pytest.raises(ConnectionClosed) as closed:
        while True:
            # Long enough for a relay that leaves the TCP close to the client
            # (workerd: the client's 10 s close timeout).
            ws.recv(timeout=15)
    rcvd = closed.value.rcvd
    return rcvd.code if rcvd else None


def _control(ws: ClientConnection) -> dict[str, object]:
    while True:
        msg = ws.recv(timeout=5)
        if isinstance(msg, str):
            return cast("dict[str, object]", json.loads(msg))


def test_only_the_holder_of_the_room_secret_hosts(relay: Running) -> None:
    secret = crypto.new_secret()
    room = crypto.room_id(secret)
    # A guest link carries the room id, not the secret.
    with connect(
        f"ws://127.0.0.1:{relay.port}/_relay/host?room={room}",
        proxy=None,
        additional_headers={SECRET_HEADER: b64u(crypto.new_secret())},
    ) as impostor:
        assert _closed_with(impostor) == UNAUTHORIZED
    with _guest_ws(relay.port, room) as early:
        assert _closed_with(early) == NO_ROOM
    with _host_ws(relay.port, secret) as host:
        assert _control(host)["type"] == "ready"
        with _guest_ws(relay.port, room) as guest:
            joined = _control(host)
            assert joined["type"] == "join"
            peer = cast("int", joined["peer"])
            guest.send(b"\x01frame")
            assert host.recv(timeout=5) == struct.pack(">I", peer) + b"\x01frame"
            host.send(struct.pack(">I", peer) + b"\x03back")
            assert guest.recv(timeout=5) == b"\x03back"
            host.close()
            assert _closed_with(guest) == HOST_GONE
    with _guest_ws(relay.port, room) as late:
        assert _closed_with(late) == NO_ROOM


def test_an_access_token_keeps_the_relay_to_its_owner(relay: Running) -> None:
    relay.relay.access_token = "s3cret"
    secret = crypto.new_secret()
    with _host_ws(relay.port, secret) as host:
        assert _closed_with(host) == UNAUTHORIZED
    with _host_ws(relay.port, secret, "wrong") as host:
        assert _closed_with(host) == UNAUTHORIZED
    with _host_ws(relay.port, secret, "s3cret") as host:
        assert _control(host)["type"] == "ready"


def test_rooms_are_capped_and_guests_can_be_sent_away(relay: Running) -> None:
    relay.relay.max_guests = 1
    secret = crypto.new_secret()
    room = crypto.room_id(secret)
    with _host_ws(relay.port, secret) as host, _guest_ws(relay.port, room) as one:
        assert _control(host)["type"] == "ready"
        peer = _control(host)["peer"]
        with _guest_ws(relay.port, room) as two:
            assert _closed_with(two) == ROOM_FULL
        host.send(json.dumps({"type": "kick", "peer": peer}))
        assert _closed_with(one) == KICKED


def test_a_flood_of_frames_is_cut_off(relay: Running) -> None:
    relay.relay.guest_bucket = lambda: Bucket(rate=1, burst=5)
    secret = crypto.new_secret()
    with _host_ws(relay.port, secret) as host:
        _control(host)
        with _guest_ws(relay.port, crypto.room_id(secret)) as guest:
            with pytest.raises(ConnectionClosed) as closed:
                for _ in range(50):
                    guest.send(b"\x03x")
                for _ in range(50):
                    guest.recv(timeout=10)
            assert closed.value.rcvd is not None
            assert closed.value.rcvd.code == RATE_LIMITED


def test_the_relay_serves_the_guest_page(relay: Running) -> None:
    import http.client

    def get(path: str) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", relay.port, timeout=5)
        conn.request("GET", path)
        res = conn.getresponse()
        out = res.status, {k.lower(): v for k, v in res.getheaders()}, res.read()
        conn.close()
        return out

    status, headers, body = get("/")
    assert status == 200 and b"_guest/boot.js" in body
    assert headers["referrer-policy"] == "no-referrer"
    # Any page inside the guest page is the guest page too.
    assert get("/edit")[2] == body
    status, headers, _ = get("/_guest/sw.js")
    assert status == 200 and headers["service-worker-allowed"] == "/"
    assert get("/_guest/../relay.py")[0] == 404
    status, _, body = get("/_relay/health")
    assert status == 200 and json.loads(body)["ok"] is True


# ── Any relay, by the same rules (the Worker under `wrangler dev`) ────────────

EXTERNAL = os.environ.get("INKFLOW_TEST_RELAY_PORT")
"""A relay already running on this port, with access token ``s3cret`` and
one guest per room: ``cd relay/cloudflare && pnpm exec wrangler dev --port
8002 --var RELAY_ACCESS_TOKEN:s3cret --var MAX_GUESTS:1``, or
``inkflow relay --port 8002 --access-token s3cret --max-guests 1``."""


@pytest.mark.skipif(not EXTERNAL, reason="INKFLOW_TEST_RELAY_PORT not set")
class TestAnyRelay:
    port: int = int(EXTERNAL or 0)

    def test_hosts_need_the_token_and_the_room_secret(self) -> None:
        secret = crypto.new_secret()
        for token in (None, "wrong"):
            with _host_ws(self.port, secret, token) as host:
                assert _closed_with(host) == UNAUTHORIZED
        with connect(
            f"ws://127.0.0.1:{self.port}/_relay/host?room={crypto.room_id(secret)}",
            proxy=None,
            additional_headers={
                SECRET_HEADER: b64u(crypto.new_secret()),
                "Authorization": "Bearer s3cret",
            },
        ) as impostor:
            assert _closed_with(impostor) == UNAUTHORIZED

    def test_a_room_lives_while_its_host_is_there(self) -> None:
        secret = crypto.new_secret()
        room = crypto.room_id(secret)
        with _guest_ws(self.port, room) as early:
            assert _closed_with(early) == NO_ROOM
        with _host_ws(self.port, secret, "s3cret") as host:
            assert _control(host)["type"] == "ready"
            with _guest_ws(self.port, room) as guest:
                peer = cast("int", _control(host)["peer"])
                guest.send(b"\x01hello")
                assert host.recv(timeout=5) == struct.pack(">I", peer) + b"\x01hello"
                host.send(struct.pack(">I", peer) + b"\x03frame")
                assert guest.recv(timeout=5) == b"\x03frame"
                with _guest_ws(self.port, room) as second:
                    assert _closed_with(second) == ROOM_FULL
                host.close()
                assert _closed_with(guest) == HOST_GONE

    def test_the_host_sends_a_guest_away(self) -> None:
        secret = crypto.new_secret()
        with _host_ws(self.port, secret, "s3cret") as host:
            _control(host)
            with _guest_ws(self.port, crypto.room_id(secret)) as guest:
                peer = _control(host)["peer"]
                host.send(json.dumps({"type": "kick", "peer": peer}))
                assert _closed_with(guest) == KICKED

    def test_a_flood_is_cut_off(self) -> None:
        secret = crypto.new_secret()
        with _host_ws(self.port, secret, "s3cret") as host:
            _control(host)
            with _guest_ws(self.port, crypto.room_id(secret)) as guest:
                with pytest.raises(ConnectionClosed) as closed:
                    for _ in range(1000):
                        guest.send(b"\x03x")
                    while True:
                        guest.recv(timeout=10)
                assert closed.value.rcvd is not None
                assert closed.value.rcvd.code == RATE_LIMITED

    def test_it_serves_the_guest_page(self) -> None:
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/_guest/sw.js")
        res = conn.getresponse()
        _ = res.read()
        assert res.status == 200
        assert res.getheader("Service-Worker-Allowed") == "/"
        conn.request("GET", "/edit", headers={"Sec-Fetch-Mode": "navigate"})
        res = conn.getresponse()
        assert b"_guest/boot.js" in res.read()
        conn.request("GET", "/_relay/health")
        res = conn.getresponse()
        assert json.loads(res.read())["ok"] is True
        conn.close()


# ── A deck shared online ──────────────────────────────────────────────────────


class Guest:
    """A guest speaking the protocol as the guest page does."""

    def __init__(self, relay_port: int, link: str) -> None:
        fragment = dict(parse_qsl(link.split("#", 1)[1]))
        self.room: str = fragment["r"]
        self.secret: bytes = unb64u(fragment["k"])
        # Entered here, closed by ``close`` (a guest outlives a with block).
        self.ws: ClientConnection = _guest_ws(relay_port, self.room).__enter__()
        hello = crypto.hello(self.secret, self.room)
        self.ws.send(hello)
        welcome = self.ws.recv(timeout=10)
        assert isinstance(welcome, bytes)
        self.session: crypto.Session = crypto.finish(
            self.secret, self.room, hello, welcome
        )
        self.again: frames.Reassembler = frames.Reassembler()
        self.role: object = self.next()[0]["role"]
        self.rid: int = 0

    def send(self, header: dict[str, object], body: bytes = b"") -> None:
        for chunk in frames.chunks(frames.wrap(frames.pack(header, body))):
            self.ws.send(self.session.seal(chunk))

    def next(self, timeout: float = 10) -> tuple[dict[str, object], bytes]:
        while True:
            frame = self.ws.recv(timeout=timeout)
            assert isinstance(frame, bytes)
            message = self.again.push(self.session.open(frame))
            if message is not None:
                return frames.unpack(frames.unwrap(message, deflate=True))

    def page(self, cid: int = 1) -> None:
        self.send({"t": "open", "c": cid})

    def say(self, msg: dict[str, object], cid: int = 1) -> None:
        self.send({"t": "ws", "c": cid}, json.dumps(msg).encode())

    def until(self, kind: str, cid: int = 1) -> dict[str, object]:
        while True:
            header, body = self.next()
            if header.get("t") == "ws" and header.get("c") == cid:
                msg = cast("dict[str, object]", json.loads(body))
                if msg.get("type") == kind:
                    return msg
            if header.get("t") == "close" and header.get("c") == cid:
                raise ConnectionError(str(header))

    def edit(self, request: dict[str, object], cid: int = 1) -> dict[str, object]:
        self.say({"type": "edit-op", "id": 77, **request}, cid)
        return self.until("edit-result", cid)

    def get(
        self, path: str, range_: str | None = None
    ) -> tuple[int, dict[str, str], bytes]:
        self.rid += 1
        rid = self.rid
        self.send({"t": "get", "id": rid, "path": path, "range": range_})
        status, headers, body = 0, {}, b""
        while True:
            header, data = self.next()
            if header.get("id") != rid:
                continue
            if header["t"] == "res":
                status = cast("int", header["status"])
                headers = cast("dict[str, str]", header["headers"])
            elif header["t"] == "body":
                body += data
            elif header["t"] == "end":
                return status, headers, body

    def close(self) -> None:
        self.ws.close()


@dataclass
class Shared:
    session: EditorSession
    relay: Relay
    relay_port: int
    loop: asyncio.AbstractEventLoop

    def call(self, coro: Coroutine[object, object, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(20)

    @property
    def host(self):
        online = server._share.online  # pyright: ignore[reportPrivateUsage]
        assert online is not None
        return online

    def link(self, role: crypto.Role) -> str:
        return self.host.link(role)


@pytest.fixture
def online(project: Path) -> Iterator[Shared]:
    """The deck served, shared online through a relay (one event loop)."""
    (project / "assets").mkdir()
    (project / "assets" / "clip.mp4").write_bytes(os.urandom(6 * 1024 * 1024))
    deck_path = project / "deck.py"
    session = EditorSession(deck_path)
    ui = cast("LiveUI", cast("object", slides_tests._UI()))  # pyright: ignore[reportPrivateUsage]
    levels = resolve_levels()
    loop = asyncio.new_event_loop()
    started = threading.Event()
    stop = asyncio.Event()
    box: list[Shared] = []

    async def run() -> None:
        relay = Relay(record=True)
        relay_server = await relay.serve("127.0.0.1", 0)
        relay_port = cast(
            "tuple[str, int]", next(iter(relay_server.sockets)).getsockname()
        )[1]
        server._editor["session"] = session  # pyright: ignore[reportPrivateUsage]
        await server.rebuild(deck_path, ui, levels)
        async with server.listening(ui, session):
            problem = await server.start_online(f"http://127.0.0.1:{relay_port}")
            assert problem is None
            for _ in range(100):
                online = server._share.online  # pyright: ignore[reportPrivateUsage]
                if online is not None and online.state == "open":
                    break
                await asyncio.sleep(0.05)
            box.append(Shared(session, relay, relay_port, loop))
            started.set()
            await stop.wait()
            await server.stop_online()
        relay_server.close()
        await relay_server.wait_closed()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    try:
        yield box[0]
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()
        server._editor.update(  # pyright: ignore[reportPrivateUsage]
            {"session": None, "deck": None, "model": None, "failed_hash": None}
        )
        server._editor["clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["ws_clients"].clear()  # pyright: ignore[reportPrivateUsage]


def test_an_online_editor_edits_the_deck(online: Shared) -> None:
    guest = Guest(online.relay_port, online.link("editor"))
    assert guest.role == "editor"
    status, headers, body = guest.get("/edit")
    assert status == 200 and headers["content-type"].startswith("text/html")
    assert b"__JS__" not in body and b"/_inkflow/ws" in body
    guest.page()
    welcome = guest.until("welcome")
    assert welcome["role"] == "editor"
    guest.say({"type": "hello", "role": "editor"})
    guest.until("editor-model")
    reply = guest.edit({"action": "notes", "slide": 0, "text": "Typed online"})
    assert reply["ok"] is True
    notes = online.session.project_dir / "notes" / "drawn.md"
    assert notes.read_text() == "Typed online"
    # What the owner alone may do is refused as for any guest.
    reply = guest.edit({"action": "git", "op": "push"})
    assert reply["ok"] is False
    guest.say({"type": "presence", "page": "editor", "name": "Ada"})
    guest.until("presence")
    people = online.call(_people())
    assert any(p["online"] and p["role"] == "editor" for p in people)
    guest.close()


async def _people() -> list[dict[str, object]]:
    return server._share.people.listing()  # pyright: ignore[reportPrivateUsage]


def test_an_online_viewer_follows_and_cannot_edit(online: Shared) -> None:
    viewer = Guest(online.relay_port, online.link("viewer"))
    assert viewer.role == "viewer"
    assert viewer.get("/")[0] == 200
    for path in ("/edit", "/_export/x/y.pdf"):
        assert viewer.get(path)[0] == 403
    viewer.page()
    assert viewer.until("welcome")["role"] == "viewer"
    reply = viewer.edit({"action": "notes", "slide": 0, "text": "x"})
    assert reply["ok"] is False and "view-only" in str(reply["error"])
    # Asking to be an editor page changes nothing.
    viewer.say({"type": "hello", "role": "editor"})
    viewer.say({"type": "share", "op": "online-off"})
    reply = viewer.edit({"action": "notes", "slide": 0, "text": "x"})
    assert reply["ok"] is False
    assert online.host.state == "open"
    assert not online.session.history.done
    viewer.close()


def test_pictures_and_video_ranges_come_through_the_channel(online: Shared) -> None:
    guest = Guest(online.relay_port, online.link("viewer"))
    status, headers, body = guest.get("/slides/drawn.svg")
    assert status == 200 and body.startswith(b"<svg")
    clip = (online.session.project_dir / "assets" / "clip.mp4").read_bytes()
    status, headers, body = guest.get("/assets/clip.mp4", "bytes=0-")
    # An open range is answered in part; the browser asks for the rest.
    assert status == 206 and body == clip[: 4 * 1024 * 1024]
    assert headers["content-range"] == f"bytes 0-{4 * 1024 * 1024 - 1}/{len(clip)}"
    status, _, body = guest.get("/assets/clip.mp4", "bytes=100-199")
    assert status == 206 and body == clip[100:200]
    # A request line or header smuggled into the path or range gets nowhere.
    guest.send({"t": "get", "id": 99, "path": "/ HTTP/1.1\r\nX: y"})
    guest.send({"t": "get", "id": 100, "path": "/x", "range": "bytes=0-\r\nX: y"})
    status, headers, body = guest.get("/assets/clip.mp4", "bytes=0-1")
    assert status == 206 and body == clip[:2]
    guest.close()


def test_the_relay_sees_no_plaintext(online: Shared) -> None:
    guest = Guest(online.relay_port, online.link("editor"))
    guest.page()
    guest.until("welcome")
    guest.say({"type": "hello", "role": "editor"})
    guest.until("editor-model")
    guest.edit({"action": "notes", "slide": 0, "text": "Secret plans"})
    guest.get("/slides/intro.md")
    seen = b"".join(online.relay.stats.seen or [])
    assert len(seen) > 10_000
    for text in (b"Secret plans", b"Intro", b"editor-model", b"drawn.svg", b"notes"):
        assert text not in seen
    guest.close()


def test_a_forged_or_replayed_frame_ends_the_guest(online: Shared) -> None:
    guest = Guest(online.relay_port, online.link("editor"))
    guest.page()
    guest.until("welcome")
    frame = guest.session.seal(frames.chunks(frames.pack({"t": "x"}))[0])
    guest.ws.send(frame)
    guest.ws.send(frame)  # again: the host sends this guest away
    assert _closed_with(guest.ws) == KICKED


def test_new_links_and_stopping_send_guests_away(online: Shared) -> None:
    old = online.link("editor")
    guest = Guest(online.relay_port, old)
    guest.page()
    guest.until("welcome")
    online.call(online.host.rotate())
    header = guest.next()[0]
    while header.get("t") != "bye":
        header = guest.next()[0]
    assert header["reason"] == "new links"
    assert online.link("editor") != old
    # The old link's room is gone (the relay closed it).
    for _ in range(50):
        if online.host.state == "open" and online.host.room in online.relay.rooms:
            break
        threading.Event().wait(0.05)
    with pytest.raises((ConnectionClosed, TimeoutError)):
        Guest(online.relay_port, old)
    fresh = Guest(online.relay_port, online.link("viewer"))
    online.call(server.stop_online())
    header = fresh.next()[0]
    while header.get("t") != "bye":
        header = fresh.next()[0]
    assert header["reason"] == "sharing stopped"
    assert _closed_with(fresh.ws) == HOST_GONE


def test_the_owner_kicks_an_online_guest(online: Shared) -> None:
    guest = Guest(online.relay_port, online.link("editor"))
    guest.page()
    who = guest.until("welcome")["id"]

    async def kick() -> None:
        await server._disconnect(  # pyright: ignore[reportPrivateUsage]
            lambda c: c.id == who, "disconnected by the owner"
        )

    online.call(kick())
    while True:
        header, _ = guest.next()
        if header.get("t") == "close":
            assert header["code"] == 4001
            break


def test_share_status_has_the_online_links(online: Shared) -> None:
    status = cast(
        "dict[str, object]",
        server._share_status()["online"],  # pyright: ignore[reportPrivateUsage]
    )
    assert status["sharing"] is True and status["state"] == "open"
    links = cast("dict[str, str]", status["links"])
    assert links["editor"].startswith(f"http://127.0.0.1:{online.relay_port}/#r=")
    assert links["editor"] != links["view"]
    lines = server.online_lines()
    assert any("(online)" in line for line in lines)


# ── Setting up: the relay's address, deploying to Cloudflare ──────────────────


def test_the_relay_is_kept_in_the_user_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from inkflow.online import config

    monkeypatch.delenv("INKFLOW_RELAY_URL", raising=False)
    monkeypatch.setattr(config, "_file", lambda: tmp_path / "relay.json")
    assert config.load() is None
    saved = config.save("relay.example.org/whatever", "tok")
    assert saved == config.RelayConfig("https://relay.example.org", "tok")
    assert config.load() == saved
    assert (tmp_path / "relay.json").stat().st_mode & 0o077 == 0
    with pytest.raises(ValueError):
        config.save("ftp://x", None)
    monkeypatch.setenv("INKFLOW_RELAY_URL", "http://localhost:8001")
    assert config.load() == config.RelayConfig("http://localhost:8001", None)
    monkeypatch.delenv("INKFLOW_RELAY_URL")
    config.forget()
    assert config.load() is None


def test_relay_show_prints_the_token_only_when_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from click.testing import CliRunner

    from inkflow.cli import main
    from inkflow.cli import relay as relay_cli
    from inkflow.online import config

    monkeypatch.delenv("INKFLOW_RELAY_URL", raising=False)
    monkeypatch.setattr(config, "_file", lambda: tmp_path / "relay.json")

    def answers(_url: str) -> None:
        return None

    monkeypatch.setattr(relay_cli, "check_relay", answers)
    _ = config.save("https://relay.example.org", "s3cret-token")
    hidden = CliRunner().invoke(main, ["relay", "show"])
    assert hidden.exit_code == 0, hidden.output
    assert "s3cret-token" not in hidden.output
    assert "--token prints it" in hidden.output
    shown = CliRunner().invoke(main, ["relay", "show", "--token"])
    assert shown.exit_code == 0, shown.output
    assert "token: s3cret-token" in shown.output
    assert (
        "inkflow relay set https://relay.example.org --token s3cret-token"
        in shown.output
    )


def test_deploying_to_cloudflare_stages_the_worker_and_its_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    from inkflow.online import deploy

    seen: dict[str, object] = {}

    def fake_run(
        command: list[str], cwd: Path, env: dict[str, str], check: bool
    ) -> subprocess.CompletedProcess[bytes]:
        assert not check
        folder = Path(cwd)
        seen["command"] = command
        seen["toml"] = (folder / "wrangler.toml").read_text()
        seen["files"] = sorted(
            p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file()
        )
        secrets_file = Path(command[command.index("--secrets-file") + 1])
        seen["secret"] = secrets_file.read_text()
        targets = ["https://inkflow-relay.ada.workers.dev"]
        Path(env["WRANGLER_OUTPUT_FILE_PATH"]).write_text(
            json.dumps({"type": "wrangler-session"})
            + "\n"
            + json.dumps({"type": "deploy", "targets": targets})
            + "\n"
        )
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(deploy, "npx", lambda: "/usr/bin/npx")
    result = deploy.deploy_cloudflare(token="tok123", run=fake_run)
    assert result == deploy.Deployed("https://inkflow-relay.ada.workers.dev", "tok123")
    command = cast("list[str]", seen["command"])
    assert command[:4] == ["/usr/bin/npx", "--yes", deploy.WRANGLER, "deploy"]
    assert seen["secret"] == "RELAY_ACCESS_TOKEN=tok123\n"
    toml = cast("str", seen["toml"])
    assert 'new_sqlite_classes = ["Room"]' in toml
    assert 'REQUIRE_ACCESS_TOKEN = "1"' in toml
    assert 'run_worker_first = ["/_relay/*"]' in toml
    files = cast("list[str]", seen["files"])
    for name in (
        "worker.js",
        "guest/index.html",
        "guest/_headers",
        "guest/_guest/sw.js",
    ):
        assert name in files
    with pytest.raises(deploy.DeployError):
        deploy.deploy_cloudflare("Not A Name", run=fake_run)
    monkeypatch.setattr(deploy, "npx", lambda: None)
    with pytest.raises(deploy.DeployError, match=r"Node\.js"):
        deploy.deploy_cloudflare(run=fake_run)


def test_a_failed_deploy_says_what_to_do(monkeypatch: pytest.MonkeyPatch) -> None:
    import subprocess

    from inkflow.online import deploy

    def failing(
        command: list[str], **_kw: object
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(command, 1)

    monkeypatch.setattr(deploy, "npx", lambda: "/usr/bin/npx")
    with pytest.raises(deploy.DeployError, match="wrangler login"):
        deploy.deploy_cloudflare(run=failing)
