"""``inkflow relay deploy cloudflare``: the relay on the user's own
Cloudflare account, with ``npx wrangler`` (Node.js is the one requirement).

What is deployed ships inside inkflow: the Worker (``online/cloudflare/
worker.js``, bundled from ``relay/cloudflare/src/worker.ts``) and the guest
page (``online/guest``). It is written to a temporary folder with its own
``wrangler.toml`` and deployed from there, with an access token as a
secret in the same step (``--secrets-file``), so the relay never accepts
hosts without it. Wrangler's own sign-in (``npx wrangler login``) and its
questions (a workers.dev subdomain the first time) stay interactive; the
address the Worker got is read from the output file wrangler writes for
programs (``WRANGLER_OUTPUT_FILE_PATH``).
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from inkflow.online.relay import guest_dir

WRANGLER = "wrangler@4.136.3"
"""The wrangler ``npx`` runs (a pinned version: the configuration below is
written for it)."""
COMPATIBILITY_DATE = "2025-09-01"
DEFAULT_NAME = "inkflow-relay"
_NAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

Runner = Callable[..., "subprocess.CompletedProcess[bytes]"]


class DeployError(Exception):
    pass


@dataclass(frozen=True)
class Deployed:
    url: str | None
    """None when wrangler did not say (find it on dash.cloudflare.com)."""
    token: str | None


def worker_file() -> Path:
    return guest_dir().parent / "cloudflare" / "worker.js"


def wrangler_toml(name: str, *, require_token: bool) -> str:
    return "\n".join(
        [
            "# Written by `inkflow relay deploy cloudflare`.",
            f'name = "{name}"',
            'main = "worker.js"',
            f'compatibility_date = "{COMPATIBILITY_DATE}"',
            "",
            "[assets]",
            'directory = "./guest"',
            'not_found_handling = "single-page-application"',
            'run_worker_first = ["/_relay/*"]',
            "",
            "[[durable_objects.bindings]]",
            'name = "ROOMS"',
            'class_name = "Room"',
            "",
            "[[migrations]]",
            'tag = "v1"',
            'new_sqlite_classes = ["Room"]',
            "",
            "[vars]",
            f'REQUIRE_ACCESS_TOKEN = "{"1" if require_token else "0"}"',
            "",
        ]
    )


def stage(folder: Path, name: str, *, require_token: bool) -> None:
    """The Worker, the guest page and the configuration, ready to deploy."""
    _ = shutil.copyfile(worker_file(), folder / "worker.js")
    _ = shutil.copytree(guest_dir(), folder / "guest")
    (folder / "wrangler.toml").write_text(
        wrangler_toml(name, require_token=require_token), encoding="utf-8"
    )


def deployed_url(output_file: Path) -> str | None:
    """The workers.dev (or custom) address of the deployment, from the
    ND-JSON file wrangler writes for programs."""
    try:
        lines = output_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            entry = cast(object, json.loads(line))
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        data = cast("dict[str, object]", entry)
        targets = data.get("targets")
        if data.get("type") == "deploy" and isinstance(targets, list):
            for target in cast("list[object]", targets):
                if isinstance(target, str) and target.startswith("https://"):
                    return target.rstrip("/")
    return None


def npx() -> str | None:
    return shutil.which("npx") or shutil.which("npx.cmd")


def deploy_cloudflare(
    name: str = DEFAULT_NAME,
    *,
    token: str | None = None,
    open_relay: bool = False,
    run: Runner = subprocess.run,
    extra_args: Sequence[str] = (),
) -> Deployed:
    """Deploy the relay as Worker ``name``; its address and access token.

    ``token``: the access token to set (a new one when None); ``open_relay``
    deploys without one (any inkflow may then open rooms on it)."""
    if not _NAME.match(name):
        raise DeployError(
            f"{name!r} is not a Worker name: lower-case letters, digits and dashes"
        )
    runner = npx()
    if runner is None:
        raise DeployError(
            "npx was not found: install Node.js (the LTS version, from "
            + "https://nodejs.org) and run this again"
        )
    if not worker_file().is_file():
        raise DeployError(f"the Worker is missing from this install: {worker_file()}")
    access = None if open_relay else (token or secrets.token_urlsafe(32))
    with tempfile.TemporaryDirectory(prefix="inkflow-relay-") as tmp:
        folder = Path(tmp)
        stage(folder, name, require_token=not open_relay)
        output = folder / "wrangler-output.ndjson"
        command = [runner, "--yes", WRANGLER, "deploy", *extra_args]
        if access is not None:
            secret_file = folder / ".secrets"
            with contextlib.suppress(OSError):
                secret_file.touch(mode=0o600)
            secret_file.write_text(f"RELAY_ACCESS_TOKEN={access}\n", encoding="utf-8")
            command += ["--secrets-file", str(secret_file)]
        env = {**os.environ, "WRANGLER_OUTPUT_FILE_PATH": str(output)}
        result = run(command, cwd=folder, env=env, check=False)
        if result.returncode != 0:
            raise DeployError(
                "wrangler could not deploy the relay (see its messages above). "
                + "Signed in? Run `npx wrangler login` first."
            )
        url = deployed_url(output)
    return Deployed(url, access)
