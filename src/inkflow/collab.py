"""The people connected to a server: who each connection is (role, name,
colour) and where they are (page, slide, selection), relayed to everyone as
``presence`` and never written anywhere."""

from __future__ import annotations

import getpass
import itertools
import re
import secrets
from dataclasses import dataclass, field
from typing import cast

from inkflow.access import Role

COLORS = (
    "#e8590c",
    "#1c7ed6",
    "#2f9e44",
    "#c2255c",
    "#7048e8",
    "#0c8599",
    "#e67700",
    "#5c940d",
    "#ae3ec9",
    "#d6336c",
)
"""Distinct on light and dark canvases; a new person takes the first one no
one connected has."""

_KEY = re.compile(r"[A-Za-z0-9_-]{8,64}")


def owner_name() -> str:
    """The owner's default display name: this computer's user."""
    try:
        name = getpass.getuser()
    except (OSError, KeyError, ImportError):
        return "Owner"
    return name or "Owner"


@dataclass
class Client:
    """One connection: a page (editor or presenter) or a program."""

    id: str
    """Public, per connection: what presence and "Disconnect" name."""
    role: Role
    token: str | None = None
    """The share token that admitted it (None: the owner)."""
    peer: str | None = None
    key: str | None = None
    """The page's own secret (kept across reloads in its storage): whose
    steps are whose in the undo history. Never sent to anyone else."""
    name: str = ""
    color: str = ""
    page: str = ""
    """"editor" or "presenter"; "" until the page says (a program)."""
    slide: int | None = None
    selection: list[str] = field(default_factory=list)
    """``data-ink`` locators of what is selected on that slide."""
    editing: str | None = None
    """A zone or text being typed into, if any."""
    online: bool = False
    """Came through the relay (``online.host``), not to this server's port:
    sharing online and on the network start and stop separately."""
    patches: bool = False
    """The page takes a rebuild as what changed (``hello`` with ``patch``):
    slides it holds are named by key instead of sent again."""

    @property
    def author(self) -> str:
        """Whose History steps are this connection's. The owner's pages and
        agents (commands on this machine) are one author; a guest is its page's
        key, or the connection when the page sent none."""
        if self.role == "owner":
            return "owner"
        return f"guest:{self.key or self.id}"

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "role": self.role,
            "name": self.name or ("Owner" if self.role == "owner" else "Guest"),
            "color": self.color,
            "page": self.page,
            "slide": self.slide,
            "selection": self.selection,
            "editing": self.editing,
            "online": self.online,
        }


class People:
    """The connected clients, keyed by their connection object."""

    def __init__(self) -> None:
        self._clients: dict[object, Client] = {}
        self._serial: itertools.count[int] = itertools.count(1)

    def join(
        self, conn: object, role: Role, token: str | None, peer: str | None
    ) -> Client:
        used = {c.color for c in self._clients.values()}
        color = next(
            (c for c in COLORS if c not in used), COLORS[len(used) % len(COLORS)]
        )
        client = Client(
            id=f"p{next(self._serial)}{secrets.token_hex(3)}",
            role=role,
            token=token,
            peer=peer,
            color=color,
            name=owner_name() if role == "owner" else "",
        )
        self._clients[conn] = client
        return client

    def leave(self, conn: object) -> Client | None:
        return self._clients.pop(conn, None)

    def get(self, conn: object) -> Client | None:
        return self._clients.get(conn)

    def items(self) -> list[tuple[object, Client]]:
        return list(self._clients.items())

    def by_id(self, client_id: str) -> tuple[object, Client] | None:
        for conn, client in self._clients.items():
            if client.id == client_id:
                return conn, client
        return None

    def name_of(self, author: str) -> str | None:
        """The display name of whoever ``author`` is (see ``Client.author``)."""
        for client in self._clients.values():
            if client.author == author and client.name:
                return client.name
        return None

    def update(self, conn: object, msg: dict[str, object]) -> bool:
        """Apply a page's ``presence`` message; whether anything changed."""
        client = self._clients.get(conn)
        if client is None:
            return False
        before = client.public()
        name = msg.get("name")
        if isinstance(name, str) and name.strip():
            client.name = " ".join(name.split())[:40]
        key = msg.get("key")
        if isinstance(key, str) and _KEY.fullmatch(key) and client.key is None:
            client.key = key
        page = msg.get("page")
        if page in ("editor", "presenter"):
            client.page = cast("str", page)
        if "slide" in msg:
            slide = msg.get("slide")
            ok = isinstance(slide, int) and not isinstance(slide, bool) and slide >= 0
            client.slide = cast("int", slide) if ok else None
        selection = msg.get("selection")
        if isinstance(selection, list):
            client.selection = [
                s
                for s in cast("list[object]", selection)[:50]
                if isinstance(s, str) and len(s) < 200
            ]
        if "editing" in msg:
            editing = msg.get("editing")
            client.editing = editing[:100] if isinstance(editing, str) else None
        return client.public() != before

    def listing(self) -> list[dict[str, object]]:
        """Everyone with a page open (programs are not people)."""
        return [c.public() for c in self._clients.values() if c.page]
