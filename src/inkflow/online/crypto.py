"""End-to-end encryption between a guest's browser and the host.

A share link's fragment (never sent to any server) carries the room id and a
32-byte *link secret*; the editor link and the view link have secrets of
their own. Everything else is derived from them:

- **auth key** = HKDF-SHA256(link secret, info ``inkflow/1 auth <room>``).
  The guest opens with ``hello`` (a fresh 32-byte nonce, HMAC'd with it);
  the host tries each role's auth key, so *which key authenticates* is the
  guest's role, and answers ``welcome`` (its own fresh nonce, HMAC'd over
  both), which proves to the guest that it reached the host and not the
  relay pretending.
- **session keys**, one per direction, = HKDF-SHA256(link secret, salt =
  guest nonce + host nonce, info ``inkflow/1 g2h|h2g <room>``): new for every
  connection, so two guests with the same link never share a key (and never
  reuse a nonce), and a replayed ``hello`` gets nowhere (the host's nonce is
  new).
- **data frames**: AES-256-GCM, nonce = 4 zero bytes + the frame's 64-bit
  sequence number, which is also in the clear header that is the AAD. Each
  side expects exactly the next number: a frame replayed, dropped or
  reordered by the relay fails, and the connection ends.

The room itself is named by the hash of a *room secret* only the host has
(``room_id``), which the relay checks when the host opens the room: a guest
link (room id + link secret) cannot hold the room.

Hashing and HMAC are the standard library's; AES-GCM is the ``cryptography``
package's (``pip install 'inkflow[online]'``), imported only when a frame is
sealed or opened.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import importlib
import secrets
import struct
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, Protocol, cast

VERSION = 1
HELLO = 1
WELCOME = 2
DATA = 3

SECRET_BYTES = 32
NONCE_BYTES = 32
MAC_BYTES = 32
TAG_BYTES = 16
HEADER_BYTES = 9
"""A data frame's clear header: its type and 64-bit sequence number."""
MAX_FRAME = 512 * 1024
"""The largest frame on the wire: every message is chunked below this, so no
relay platform's message-size limit ever matters."""
MAX_PLAINTEXT = MAX_FRAME - HEADER_BYTES - TAG_BYTES

HELLO_BYTES = 1 + NONCE_BYTES + MAC_BYTES
WELCOME_BYTES = 1 + NONCE_BYTES + MAC_BYTES

Role = Literal["editor", "viewer"]

INSTALL_HINT = (
    "sharing online needs the cryptography package: "
    + "pip install 'inkflow[online]' (or uv tool install 'inkflow[online]')"
)


class CryptoError(Exception):
    """A frame that is not what it claims (wrong key, tampered, replayed)."""


class MissingCrypto(RuntimeError):
    """The ``cryptography`` package is not installed."""


class _Aead(Protocol):
    def encrypt(
        self, nonce: bytes, data: bytes, associated_data: bytes | None
    ) -> bytes: ...

    def decrypt(
        self, nonce: bytes, data: bytes, associated_data: bytes | None
    ) -> bytes: ...


def available() -> bool:
    """Whether frames can be sealed here (``cryptography`` is installed)."""
    try:
        _ = importlib.import_module("cryptography.hazmat.primitives.ciphers.aead")
    except ImportError:
        return False
    return True


def _aesgcm(key: bytes) -> _Aead:
    try:
        aead = importlib.import_module("cryptography.hazmat.primitives.ciphers.aead")
    except ImportError as exc:
        raise MissingCrypto(INSTALL_HINT) from exc
    make = cast("Callable[[bytes], _Aead]", aead.AESGCM)
    return make(key)


# ── Encodings ──


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_secret() -> bytes:
    return secrets.token_bytes(SECRET_BYTES)


def room_id(room_secret: bytes) -> str:
    """The public name of the room ``room_secret`` holds (22 characters)."""
    return b64u(hashlib.sha256(b"inkflow-room/1" + room_secret).digest())[:22]


def is_room_id(text: str) -> bool:
    return len(text) == 22 and all(
        c.isascii() and (c.isalnum() or c in "-_") for c in text
    )


# ── Keys ──


def hkdf(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """HKDF-SHA256 (RFC 5869), as Web Crypto computes it."""
    prk = hmac.new(salt or bytes(32), ikm, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def auth_key(link_secret: bytes, room: str) -> bytes:
    return hkdf(link_secret, b"", f"inkflow/{VERSION} auth {room}".encode())


def session_keys(
    link_secret: bytes, room: str, cnonce: bytes, snonce: bytes
) -> tuple[bytes, bytes]:
    """(guest→host key, host→guest key) for one connection."""
    salt = cnonce + snonce
    g2h = hkdf(link_secret, salt, f"inkflow/{VERSION} g2h {room}".encode())
    h2g = hkdf(link_secret, salt, f"inkflow/{VERSION} h2g {room}".encode())
    return g2h, h2g


def _mac(key: bytes, *parts: bytes) -> bytes:
    return hmac.new(key, b"".join(parts), hashlib.sha256).digest()


# ── Sealed frames ──


def _nonce(seq: int) -> bytes:
    return bytes(4) + struct.pack(">Q", seq)


def seal(key: bytes, seq: int, plaintext: bytes) -> bytes:
    """One data frame: clear header (type, seq), then ciphertext and tag."""
    if len(plaintext) > MAX_PLAINTEXT:
        raise ValueError("plaintext larger than a frame")
    header = bytes([DATA]) + struct.pack(">Q", seq)
    return header + _aesgcm(key).encrypt(_nonce(seq), plaintext, header)


def unseal(key: bytes, expect_seq: int, frame: bytes) -> bytes:
    """The plaintext of the data frame numbered ``expect_seq``."""
    if len(frame) < HEADER_BYTES + TAG_BYTES or frame[0] != DATA:
        raise CryptoError("not a data frame")
    header = frame[:HEADER_BYTES]
    (seq,) = struct.unpack(">Q", header[1:])
    if seq != expect_seq:
        raise CryptoError(f"frame {seq} where {expect_seq} was due")
    try:
        return _aesgcm(key).decrypt(_nonce(seq), frame[HEADER_BYTES:], header)
    except MissingCrypto:
        raise
    except Exception as exc:  # cryptography's InvalidTag
        raise CryptoError("frame failed authentication") from exc


@dataclass
class Session:
    """One connection's two directions: what this side sends with and
    expects, each with its own key and sequence."""

    send_key: bytes
    recv_key: bytes
    sent: int = 0
    received: int = 0
    role: Role | None = field(default=None)

    def seal(self, plaintext: bytes) -> bytes:
        frame = seal(self.send_key, self.sent, plaintext)
        self.sent += 1
        return frame

    def open(self, frame: bytes) -> bytes:
        plaintext = unseal(self.recv_key, self.received, frame)
        self.received += 1
        return plaintext


# ── Handshake ──


def hello(link_secret: bytes, room: str, cnonce: bytes | None = None) -> bytes:
    """The guest's first frame."""
    cnonce = cnonce if cnonce is not None else secrets.token_bytes(NONCE_BYTES)
    return bytes([HELLO]) + cnonce + _mac(auth_key(link_secret, room), b"hello", cnonce)


def accept(
    link_secrets: dict[Role, bytes],
    room: str,
    frame: bytes,
    snonce: bytes | None = None,
) -> tuple[Role, bytes, Session] | None:
    """The host's answer to a ``hello``: the role whose key it was made
    with, the ``welcome`` frame and the host's session; None when no link's
    key made it."""
    if len(frame) != HELLO_BYTES or frame[0] != HELLO:
        return None
    cnonce, mac = frame[1 : 1 + NONCE_BYTES], frame[1 + NONCE_BYTES :]
    found: tuple[Role, bytes] | None = None
    for role, secret in link_secrets.items():
        # Every role is checked, whichever matches (no early exit).
        ok = hmac.compare_digest(mac, _mac(auth_key(secret, room), b"hello", cnonce))
        if ok and found is None:
            found = (role, secret)
    if found is None:
        return None
    role, secret = found
    snonce = snonce if snonce is not None else secrets.token_bytes(NONCE_BYTES)
    reply = (
        bytes([WELCOME])
        + snonce
        + _mac(auth_key(secret, room), b"welcome", cnonce, snonce)
    )
    g2h, h2g = session_keys(secret, room, cnonce, snonce)
    return role, reply, Session(send_key=h2g, recv_key=g2h, role=role)


def finish(link_secret: bytes, room: str, hello_frame: bytes, frame: bytes) -> Session:
    """The guest's session, once the host's ``welcome`` checks out."""
    if len(frame) != WELCOME_BYTES or frame[0] != WELCOME:
        raise CryptoError("not a welcome frame")
    cnonce = hello_frame[1 : 1 + NONCE_BYTES]
    snonce, mac = frame[1 : 1 + NONCE_BYTES], frame[1 + NONCE_BYTES :]
    expected = _mac(auth_key(link_secret, room), b"welcome", cnonce, snonce)
    if not hmac.compare_digest(mac, expected):
        raise CryptoError("the welcome is not from the host")
    g2h, h2g = session_keys(link_secret, room, cnonce, snonce)
    return Session(send_key=g2h, recv_key=h2g)
