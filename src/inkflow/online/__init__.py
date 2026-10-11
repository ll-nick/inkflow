"""Sharing a deck online: through a relay, end-to-end encrypted.

The owner's inkflow (the *host*) connects out to a relay and holds a room
there; a guest's browser opens the relay's guest page with a link whose
fragment carries the room and a key. The relay forwards opaque frames
between the two and never sees what is in them.

- ``crypto``: keys from the link secrets, the handshake, sealed frames.
- ``frames``: messages split into frames and put back together, and the
  envelope every message travels in.
- ``host``: the host side, which turns each guest's page into a connection
  of the server like any other (``server.make_ws_handler``).
- ``relay``: the relay itself, in Python (``inkflow relay``).
- ``config``: the relay a user shares through (``inkflow relay set``).
- ``deploy``: ``inkflow relay deploy cloudflare``.
"""
