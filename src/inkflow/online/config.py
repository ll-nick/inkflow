"""The relay this user shares through, kept in the user's config directory
(``relay.json``, beside ``places.json``): its address and, when it has one,
the access token a host must present (``RELAY_ACCESS_TOKEN`` on the
Worker, ``--access-token`` on ``inkflow relay``).

``INKFLOW_RELAY_URL`` / ``INKFLOW_RELAY_TOKEN`` override the file (a server
started by a script, tests)."""

from __future__ import annotations

import contextlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import platformdirs

from inkflow.online.host import normalize_relay


@dataclass(frozen=True)
class RelayConfig:
    url: str
    token: str | None = None


def _file() -> Path:
    return Path(platformdirs.user_config_dir("inkflow")) / "relay.json"


def load() -> RelayConfig | None:
    env = os.environ.get("INKFLOW_RELAY_URL")
    if env:
        return RelayConfig(
            normalize_relay(env), os.environ.get("INKFLOW_RELAY_TOKEN") or None
        )
    try:
        raw = cast(object, json.loads(_file().read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    data = cast("dict[str, object]", raw)
    url, token = data.get("url"), data.get("token")
    if not isinstance(url, str) or not url:
        return None
    try:
        return RelayConfig(
            normalize_relay(url), token if isinstance(token, str) and token else None
        )
    except ValueError:
        return None


def save(url: str, token: str | None) -> RelayConfig:
    """Remember a relay (raises ValueError for an address that is not one)."""
    config = RelayConfig(normalize_relay(url), token or None)
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    data: dict[str, str] = {"url": config.url}
    if config.token:
        data["token"] = config.token
    # The token lets anyone open rooms on the relay: readable by this user only.
    with contextlib.suppress(OSError):
        path.touch(mode=0o600, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    with contextlib.suppress(OSError):
        path.chmod(0o600)
    return config


def forget() -> None:
    with contextlib.suppress(OSError):
        _file().unlink()
