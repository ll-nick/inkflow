"""What the Share dialog's "Share via SSH" needs to write ready-to-use
commands: this machine's names, the login user, and where the deck lives in
its git repository (the remote to clone, the deck's path in it, whether its
``pyproject.toml`` pins inkflow so ``uv run inkflow`` works there).

Sent to the owner's page only (``share-status``'s ``sshInfo``); the commands
themselves are written by the page (``src/ts/editor/sshtext.ts``).
"""

from __future__ import annotations

import contextlib
import getpass
import socket
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from inkflow.access import is_loopback_name, ssh_server_address


def strip_credentials(url: str) -> str:
    """A remote URL without the user name and password of a web address
    (``https://token@host/…`` carries a secret); SSH addresses keep their
    user (``git@host:…``)."""
    if "://" not in url:
        return url
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or "@" not in parts.netloc:
        return url
    host = parts.netloc.rpartition("@")[2]
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def clone_folder(remote: str | None, fallback: str) -> str:
    """The folder ``git clone <remote>`` makes: the repository's name
    (``talks`` from ``git@host:me/talks.git``), else ``fallback``."""
    if not remote:
        return fallback
    path = urlsplit(remote).path if "://" in remote else remote.rpartition(":")[2]
    name = path.rstrip("/").rpartition("/")[2]
    name = name.removesuffix(".git")
    return name or fallback


def server_names() -> list[str]:
    """Guesses at the name others log in to this machine by: the address the
    current SSH login reached (if any), its fully qualified name, its host
    name."""
    names: list[str] = []
    address = ssh_server_address()
    if address:
        names.append(address)
    for get in (socket.getfqdn, socket.gethostname):
        with contextlib.suppress(OSError):
            name = get()
            if name and name not in names and not is_loopback_name(name.lower()):
                names.append(name)
    return names


def login_user() -> str:
    try:
        return getpass.getuser()
    except (OSError, KeyError, ImportError):
        return ""


def details(deck_path: Path | None, port: int) -> dict[str, object]:
    """Everything the dialog's commands are made of (JSON-ready)."""
    from inkflow.init import inkflow_requirement
    from inkflow.publish import layout, remote_url

    info: dict[str, object] = {
        "port": port,
        "serverNames": server_names(),
        "user": login_user(),
        "requirement": inkflow_requirement(),
        "inRepo": False,
        "remote": None,
        "folder": "",
        "deck": "deck.py",
        "project": None,
        "pinned": False,
        "branch": "main",
    }
    if deck_path is None:
        return info
    where = layout(deck_path)
    remote = remote_url(where.root) if where.in_repo else None
    info.update(
        {
            "inRepo": where.in_repo,
            "remote": strip_credentials(remote) if remote else None,
            "folder": clone_folder(remote, where.root.name),
            "deck": where.deck_path.relative_to(where.root).as_posix(),
            "project": where.project,
            "pinned": where.pins_inkflow,
            "branch": where.branch,
        }
    )
    return info
