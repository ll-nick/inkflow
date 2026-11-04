"""Headless Chromium for PDF export: discovery, and printing over DevTools.

The browser may run sandboxed (flatpak, snap) with its own ``/tmp`` and a partial
view of the filesystem, so nothing crosses as a file: the page is served over
loopback, which every sandbox shares, and the PDF comes back in the protocol reply.
"""

from __future__ import annotations

import base64
import functools
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import IO, Protocol, cast

from typing_extensions import override
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

# ── discovery ─────────────────────────────────────────────────────────────────

_CHROMIUM_NAMES = (
    "chrome",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "msedge",  # Chromium-based Edge, ships with Windows
)

# Flatpak launchers are named by app id and live outside PATH by default.
_FLATPAK_CHROMIUM_APP_IDS = (
    "org.chromium.Chromium",
    "com.google.Chrome",
    "io.github.ungoogled_software.ungoogled_chromium",
    "com.brave.Browser",
    "com.microsoft.Edge",
)

# Snap's bin dir is added to PATH by a login-shell profile script, so a
# non-login shell (or an IDE task runner) can miss it.
_SNAP_BIN_DIR = Path("/snap/bin")

_SYSTEM_FLATPAK_EXPORT_DIR = Path("/var/lib/flatpak/exports/bin")


def _flatpak_export_dirs() -> list[Path]:
    user_data_home = os.environ.get("XDG_DATA_HOME") or str(
        Path.home() / ".local" / "share"
    )
    return [
        Path(user_data_home) / "flatpak" / "exports" / "bin",
        _SYSTEM_FLATPAK_EXPORT_DIR,
    ]


def find_chromium() -> str | None:
    for name in _CHROMIUM_NAMES:
        if found := shutil.which(name):
            return found
    for name in _CHROMIUM_NAMES:
        if found := shutil.which(name, path=_SNAP_BIN_DIR):
            return found
    for export_dir in _flatpak_export_dirs():
        for app_id in _FLATPAK_CHROMIUM_APP_IDS:
            if found := shutil.which(app_id, path=export_dir):
                return found
    return None


# ── serving the page ──────────────────────────────────────────────────────────


class _QuietRequestHandler(SimpleHTTPRequestHandler):
    @override
    def log_message(self, format: str, *args: object) -> None:
        pass


@contextmanager
def serve_directory(directory: Path) -> Generator[str]:
    """Serve ``directory`` on an ephemeral loopback port; yields the base URL."""
    handler = functools.partial(_QuietRequestHandler, directory=str(directory))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            yield f"http://127.0.0.1:{server.server_address[1]}"
        finally:
            server.shutdown()


# ── DevTools protocol ─────────────────────────────────────────────────────────

_STARTUP_TIMEOUT_SECONDS = 30.0
_PRINT_TIMEOUT_SECONDS = 120.0
_SHUTDOWN_TIMEOUT_SECONDS = 10.0

_DEVTOOLS_URL_PATTERN = re.compile(r"DevTools listening on (ws://\S+)")

JsonObject = dict[str, object]


class MessageChannel(Protocol):
    def send(self, message: str) -> None: ...

    def recv(self, timeout: float | None = None) -> str | bytes: ...


@dataclass
class DevToolsConnection:
    """Request/response over a DevTools channel, buffering events that arrive
    while a reply is awaited so a later `wait_for_event` still sees them."""

    channel: MessageChannel
    deadline: float
    _last_id: int = 0
    _pending_events: list[JsonObject] = field(default_factory=list[JsonObject])

    def call(
        self,
        method: str,
        params: JsonObject | None = None,
        session_id: str | None = None,
    ) -> JsonObject:
        self._last_id += 1
        request: JsonObject = {
            "id": self._last_id,
            "method": method,
            "params": params or {},
        }
        if session_id is not None:
            request["sessionId"] = session_id
        self.channel.send(json.dumps(request))
        while True:
            message = self._receive()
            if message.get("id") != self._last_id:
                self._pending_events.append(message)
                continue
            if isinstance(error := message.get("error"), dict):
                details = cast(JsonObject, error)
                reason = details.get("message", details)
                raise RuntimeError(f"Chromium refused {method}: {reason}")
            result = message.get("result", {})
            return cast(JsonObject, result) if isinstance(result, dict) else {}

    def wait_for_event(self, method: str, session_id: str) -> JsonObject:
        while True:
            if self._pending_events:
                message = self._pending_events.pop(0)
            else:
                message = self._receive()
            if message.get("method") == method and (
                message.get("sessionId") == session_id
            ):
                return message

    def _receive(self) -> JsonObject:
        remaining = max(self.deadline - time.monotonic(), 0.0)
        try:
            parsed = cast(object, json.loads(self.channel.recv(timeout=remaining)))
        except TimeoutError:
            raise RuntimeError("Chromium did not finish printing in time.") from None
        return cast(JsonObject, parsed) if isinstance(parsed, dict) else {}


def print_page(devtools: DevToolsConnection, url: str) -> bytes:
    """Load ``url`` in a fresh tab and return it printed as PDF bytes."""
    target = devtools.call("Target.createTarget", {"url": "about:blank"})
    attached = devtools.call(
        "Target.attachToTarget", {"targetId": target["targetId"], "flatten": True}
    )
    session_id = str(attached["sessionId"])
    devtools.call("Page.enable", session_id=session_id)
    navigation = devtools.call("Page.navigate", {"url": url}, session_id)
    if error_text := navigation.get("errorText"):
        raise RuntimeError(f"Chromium could not load the slides: {error_text}")
    devtools.wait_for_event("Page.loadEventFired", session_id)
    # A web font requested only once layout runs can still be loading when the
    # load event fires; printing then would set its text in the fallback font.
    devtools.call(
        "Runtime.evaluate",
        {"expression": "document.fonts.ready.then(() => true)", "awaitPromise": True},
        session_id,
    )
    printed = devtools.call(
        "Page.printToPDF",
        {
            "printBackground": True,
            "preferCSSPageSize": True,
            "displayHeaderFooter": False,
        },
        session_id,
    )
    return base64.b64decode(str(printed["data"]))


# ── the browser process ───────────────────────────────────────────────────────


def _forward_stderr(stream: IO[str], devtools_urls: queue.Queue[str | None]) -> None:
    """Echo Chromium's stderr and report the DevTools URL it announces there.

    The pipe has to be drained for the browser's whole lifetime, or Chromium
    blocks on a full buffer once it has logged enough.
    """
    for line in stream:
        if match := _DEVTOOLS_URL_PATTERN.search(line):
            devtools_urls.put(match.group(1))
        else:
            sys.stderr.write(line)
    devtools_urls.put(None)


def _wait_for_devtools_url(
    process: subprocess.Popen[str], devtools_urls: queue.Queue[str | None]
) -> str:
    try:
        url = devtools_urls.get(timeout=_STARTUP_TIMEOUT_SECONDS)
    except queue.Empty:
        raise RuntimeError("Chromium did not start in time.") from None
    if url is None:
        raise RuntimeError(
            f"Chromium exited (code {process.wait()}) before it was ready; "
            + "see its output above."
        )
    return url


def _wait_or_kill(process: subprocess.Popen[str]) -> None:
    try:
        process.wait(timeout=_SHUTDOWN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def print_to_pdf(executable: str, url: str, no_sandbox: bool = False) -> bytes:
    """Print ``url`` to PDF bytes with a headless browser at ``executable``."""
    cmd = [
        executable,
        "--headless",
        "--disable-gpu",
        "--remote-debugging-port=0",
        "about:blank",
    ]
    if no_sandbox:
        cmd.insert(1, "--no-sandbox")
    try:
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
        )
    except OSError as exc:
        raise RuntimeError(f"Could not start Chromium at {executable}: {exc}") from exc
    devtools_urls: queue.Queue[str | None] = queue.Queue()
    assert process.stderr is not None
    threading.Thread(
        target=_forward_stderr, args=(process.stderr, devtools_urls), daemon=True
    ).start()
    try:
        devtools_url = _wait_for_devtools_url(process, devtools_urls)
        # The PDF arrives base64-encoded in a single message, often megabytes.
        # A proxy from the environment would only get in the way of loopback.
        with connect(devtools_url, max_size=None, proxy=None) as websocket:
            devtools = DevToolsConnection(
                websocket, time.monotonic() + _PRINT_TIMEOUT_SECONDS
            )
            pdf = print_page(devtools, url)
            websocket.send(json.dumps({"id": 0, "method": "Browser.close"}))
        _wait_or_kill(process)
        return pdf
    except (OSError, WebSocketException) as exc:
        raise RuntimeError(f"Lost the connection to Chromium: {exc}") from exc
    finally:
        if process.poll() is None:
            process.terminate()
            _wait_or_kill(process)
