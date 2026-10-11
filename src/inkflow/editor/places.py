"""Favourite folders and the default location for decks, per user.

Kept in the user's config directory, so every editor page (and every
server) offers the same ones. The default location is where a new deck goes
and where "Open deck" starts, unless the open deck's own repository says
otherwise (see ``projects.new_deck_info``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict, cast

import platformdirs

_MAX = 30


class Places(TypedDict):
    favorites: list[str]
    default: str | None


class PlacesError(Exception):
    pass


def _file() -> Path:
    return Path(platformdirs.user_config_dir("inkflow")) / "places.json"


def load() -> Places:
    """The saved places that still exist."""
    try:
        raw = cast(object, json.loads(_file().read_text(encoding="utf-8")))
    except (OSError, ValueError):
        raw = {}
    data = cast("dict[str, object]", raw) if isinstance(raw, dict) else {}
    favorites = data.get("favorites")
    default = data.get("default")
    return {
        "favorites": [
            str(p)
            for p in cast("list[object]", favorites)
            if isinstance(p, str) and Path(p).is_dir()
        ]
        if isinstance(favorites, list)
        else [],
        "default": default
        if isinstance(default, str) and Path(default).is_dir()
        else None,
    }


def _save(places: Places) -> Places:
    try:
        _file().parent.mkdir(parents=True, exist_ok=True)
        _file().write_text(json.dumps(places, indent=2), encoding="utf-8")
    except OSError as exc:
        raise PlacesError(f"cannot save your places: {exc}") from exc
    return places


def _folder(path: str) -> str:
    folder = Path(path).expanduser()
    if not folder.is_absolute() or not folder.is_dir():
        raise PlacesError(f"not a folder: {path}")
    return str(folder.resolve())


def change(op: str, path: str | None) -> Places:
    """``add`` / ``remove`` a favourite, or make ``path`` the ``default``
    location (``None`` clears it)."""
    places = load()
    if op == "add":
        folder = _folder(path or "")
        if folder not in places["favorites"]:
            places["favorites"] = [*places["favorites"], folder][-_MAX:]
    elif op == "remove":
        places["favorites"] = [p for p in places["favorites"] if p != path]
    elif op == "default":
        places["default"] = _folder(path) if path else None
    else:
        raise PlacesError(f"unknown change {op!r}")
    return _save(places)
