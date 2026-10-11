"""What travels inside the sealed frames: messages, chunked.

A *message* is an envelope: a 4-byte big-endian length, that many bytes of
JSON header, then the body (raw bytes: a WebSocket message's text, a file's
bytes). On the wire it is *wrapped*: one byte naming its coding (0 as is,
1 raw DEFLATE, which only the host sends: a rebuild's slides and model
shrink several times), then the data. A wrapped message larger than one
frame is split into chunks, each sealed on its own; a chunk's first byte
says whether it is the last one. Chunks of one message are sent one after
another, never interleaved with another's.

Message headers (``t``), guest → host:

- ``open`` ``c``: open a page connection ``c`` (the page's WebSocket);
- ``ws`` ``c`` + text: a message on it; ``close`` ``c`` ``code`` ``reason``;
- ``get`` ``id`` ``path`` (``range``): a GET for a page, picture or font;
  ``cancel`` ``id``.

host → guest:

- ``ws``/``close`` ``c`` as above;
- ``res`` ``id`` ``status`` ``headers``, then ``body`` ``id`` + bytes (any
  number), then ``end`` ``id``;
- ``bye`` ``reason``: the host sends this guest away (sharing stopped, new
  links, disconnected): the guest page does not reconnect.
- ``hi`` ``role``: sent once after the handshake, the role the key made.
"""

from __future__ import annotations

import json
import struct
import zlib
from typing import cast

from inkflow.online.crypto import MAX_PLAINTEXT

LAST = 1
CHUNK = MAX_PLAINTEXT - 1
"""A chunk's data (its flag byte comes first)."""
MAX_MESSAGE = 96 * 1024 * 1024
"""The largest message accepted (the server's WebSocket takes 80 MB)."""


class FrameError(Exception):
    pass


def pack(header: dict[str, object], body: bytes = b"") -> bytes:
    head = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack(">I", len(head)) + head + body


def unpack(message: bytes) -> tuple[dict[str, object], bytes]:
    if len(message) < 4:
        raise FrameError("short message")
    (n,) = struct.unpack(">I", message[:4])
    if 4 + n > len(message):
        raise FrameError("header past the end")
    try:
        header = cast(object, json.loads(message[4 : 4 + n]))
    except ValueError as exc:
        raise FrameError("header is not JSON") from exc
    if not isinstance(header, dict):
        raise FrameError("header is not an object")
    return cast("dict[str, object]", header), message[4 + n :]


RAW = 0
DEFLATE = 1
_WORTH_DEFLATING = 1024


def wrap(message: bytes, *, deflate: bool = False) -> bytes:
    """A message as it is chunked: its coding byte, then the data (raw
    DEFLATE when asked for and smaller)."""
    if deflate and len(message) >= _WORTH_DEFLATING:
        packer = zlib.compressobj(6, zlib.DEFLATED, -15)
        packed = packer.compress(message) + packer.flush()
        if len(packed) < len(message):
            return bytes([DEFLATE]) + packed
    return bytes([RAW]) + message


def unwrap(data: bytes, *, deflate: bool = False, limit: int = MAX_MESSAGE) -> bytes:
    """The message a wrapped one carries; ``deflate``: whether this side
    takes compressed ones (the host does not take them from guests)."""
    if not data:
        raise FrameError("empty message")
    if data[0] == RAW:
        return data[1:]
    if data[0] == DEFLATE and deflate:
        unpacker = zlib.decompressobj(-15)
        try:
            message = unpacker.decompress(data[1:], limit + 1)
        except zlib.error as exc:
            raise FrameError("bad compressed message") from exc
        if len(message) > limit or unpacker.unconsumed_tail:
            raise FrameError("message too large")
        return message
    raise FrameError("unknown message coding")


def chunks(message: bytes, size: int = CHUNK) -> list[bytes]:
    """The plaintexts of the frames ``message`` is sent in."""
    if not message:
        return [bytes([LAST])]
    parts = [message[i : i + size] for i in range(0, len(message), size)]
    return [
        bytes([LAST if i == len(parts) - 1 else 0]) + p for i, p in enumerate(parts)
    ]


class Reassembler:
    """Chunks back into messages."""

    def __init__(self, limit: int = MAX_MESSAGE) -> None:
        self._parts: list[bytes] = []
        self._size: int = 0
        self._limit: int = limit

    def push(self, plaintext: bytes) -> bytes | None:
        """The whole message once its last chunk is in, else None."""
        if not plaintext:
            raise FrameError("empty chunk")
        self._size += len(plaintext) - 1
        if self._size > self._limit:
            raise FrameError("message too large")
        self._parts.append(plaintext[1:])
        if plaintext[0] & LAST:
            message = b"".join(self._parts)
            self._parts, self._size = [], 0
            return message
        return None
