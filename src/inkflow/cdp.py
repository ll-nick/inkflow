"""A minimal Chrome DevTools Protocol client: one headless Chromium, one page.

`inkflow render` drives a single browser for every slide instead of starting one
per screenshot, and reads measurements back from the page. Chromium is started
with ``--remote-debugging-port=0`` and announces the port it picked in
``DevToolsActivePort`` inside its (temporary) profile directory, which is read
rather than its stderr. The socket is opened directly to loopback, so no proxy
configured in the environment gets in the way.
"""

from __future__ import annotations

import base64
import json
import socket
import subprocess
import tempfile
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Self, cast

from typing_extensions import override
from websockets.sync.client import ClientConnection, connect

_START_TIMEOUT = 20.0
_CALL_TIMEOUT = 60.0

Json = dict[str, object]


class Page:
    """One browser tab, driven over a flat DevTools session."""

    def __init__(self, conn: ClientConnection, session_id: str) -> None:
        self._conn: ClientConnection = conn
        self._session: str = session_id
        self._next_id: int = 0
        self._events: list[Json] = []

    def call(self, method: str, params: Json | None = None) -> Json:
        """Send one command and return its result; raises on a protocol error."""
        self._next_id += 1
        ident = self._next_id
        self._conn.send(
            json.dumps(
                {
                    "id": ident,
                    "method": method,
                    "params": params or {},
                    "sessionId": self._session,
                }
            )
        )
        deadline = time.monotonic() + _CALL_TIMEOUT
        while True:
            message = self._receive(deadline, method)
            if message.get("id") == ident:
                error = message.get("error")
                if isinstance(error, dict):
                    text = cast("Json", error).get("message")
                    raise RuntimeError(f"Chromium refused {method}: {text}")
                return cast("Json", message.get("result") or {})
            if "method" in message:
                self._events.append(message)

    def wait_for(self, event: str, timeout: float = _CALL_TIMEOUT) -> Json:
        """The next event called ``event`` (one already received counts)."""
        for i, message in enumerate(self._events):
            if message.get("method") == event:
                del self._events[: i + 1]
                return cast("Json", message.get("params") or {})
        self._events.clear()
        deadline = time.monotonic() + timeout
        while True:
            message = self._receive(deadline, event)
            if message.get("method") == event:
                return cast("Json", message.get("params") or {})

    def _receive(self, deadline: float, waiting_for: str) -> Json:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError(f"Chromium did not answer in time ({waiting_for})")
        try:
            raw = self._conn.recv(timeout=remaining)
        except TimeoutError as exc:
            raise RuntimeError(
                f"Chromium did not answer in time ({waiting_for})"
            ) from exc
        message = cast("Json", json.loads(raw))
        if message.get("sessionId") not in (None, self._session):
            return {}
        return message

    def navigate(self, url: str) -> None:
        """Load ``url`` and return once its ``load`` event has fired."""
        self._events.clear()
        result = self.call("Page.navigate", {"url": url})
        if result.get("errorText"):
            raise RuntimeError(f"Chromium could not load {url}: {result['errorText']}")
        self.wait_for("Page.loadEventFired")

    def evaluate(self, expression: str) -> object:
        """The value of ``expression``, awaited when it is a promise."""
        result = self.call(
            "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True},
        )
        details = result.get("exceptionDetails")
        if isinstance(details, dict):
            details = cast("Json", details)
            exception = cast("Json", details.get("exception") or {})
            text = exception.get("description") or details.get("text")
            raise RuntimeError(f"the render page failed: {text}")
        value = cast("Json", result.get("result") or {})
        return value.get("value")

    def viewport(self, width: int, height: int, scale: float) -> None:
        """Make the viewport exactly ``width`` x ``height`` CSS px at ``scale``."""
        self.call(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": width,
                "height": height,
                "deviceScaleFactor": scale,
                "mobile": False,
            },
        )

    def screenshot(self, width: int, height: int, *, fast: bool = False) -> bytes:
        """A PNG of the top-left ``width`` x ``height`` CSS px of the page
        (``fast``: compressed less, for images only measured, never kept)."""
        return base64.b64decode(self.screenshot_base64(width, height, fast=fast))

    def screenshot_base64(self, width: int, height: int, *, fast: bool = False) -> str:
        """`screenshot`, as the base64 text Chromium sends."""
        params: Json = {
            "format": "png",
            "clip": {"x": 0, "y": 0, "width": width, "height": height, "scale": 1},
        }
        if fast:
            params["optimizeForSpeed"] = True
        result = self.call("Page.captureScreenshot", params)
        return cast(str, result["data"])


class Browser:
    """A headless Chromium process and the DevTools connection to it."""

    def __init__(self, process: subprocess.Popen[bytes], conn: ClientConnection):
        self._process: subprocess.Popen[bytes] = process
        self._conn: ClientConnection = conn
        self._next_id: int = 0

    @classmethod
    @contextmanager
    def launch(cls, exe: str, *, no_sandbox: bool = False) -> Generator[Self]:
        with tempfile.TemporaryDirectory(prefix="inkflow-chromium-") as profile:
            cmd = [
                exe,
                "--headless",
                "--disable-gpu",
                "--hide-scrollbars",
                "--mute-audio",
                "--no-first-run",
                "--no-default-browser-check",
                "--remote-debugging-port=0",
                f"--user-data-dir={profile}",
                "about:blank",
            ]
            if no_sandbox:
                cmd.insert(1, "--no-sandbox")
            try:
                process = subprocess.Popen(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
            except OSError as exc:
                raise RuntimeError(f"could not start {exe}: {exc}") from exc
            stderr = _Drain(process)
            try:
                port, path = _devtools_endpoint(Path(profile), exe, process, stderr)
                sock = socket.create_connection(("127.0.0.1", port), timeout=10)
                conn = connect(
                    f"ws://127.0.0.1:{port}{path}",
                    sock=sock,
                    max_size=None,
                    ping_interval=None,
                )
                # The timeout was for connecting: an idle stretch between two
                # calls (fonts being subset for the next page) must not close
                # the connection under the reader.
                sock.settimeout(None)
                with conn:
                    yield cls(process, conn)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                stderr.join()

    def new_page(self) -> Page:
        """A fresh tab with the Page domain enabled."""
        target = self._call("Target.createTarget", {"url": "about:blank"})
        attached = self._call(
            "Target.attachToTarget", {"targetId": target["targetId"], "flatten": True}
        )
        page = Page(self._conn, cast(str, attached["sessionId"]))
        page.call("Page.enable")
        return page

    def _call(self, method: str, params: Json) -> Json:
        self._next_id += 1
        ident = -self._next_id  # never collides with a page's own ids
        self._conn.send(json.dumps({"id": ident, "method": method, "params": params}))
        deadline = time.monotonic() + _CALL_TIMEOUT
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"Chromium did not answer in time ({method})")
            message = cast("Json", json.loads(self._conn.recv(timeout=remaining)))
            if message.get("id") == ident:
                if isinstance(message.get("error"), dict):
                    raise RuntimeError(f"Chromium refused {method}: {message['error']}")
                return cast("Json", message.get("result") or {})


class _Drain(threading.Thread):
    """Reads Chromium's stderr so a full pipe never stalls it; keeps the tail."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        super().__init__(daemon=True)
        self._process: subprocess.Popen[bytes] = process
        self.lines: list[str] = []
        self.start()

    @override
    def run(self) -> None:
        stream = self._process.stderr
        if stream is None:
            return
        while line := cast(bytes, stream.readline()):
            self.lines.append(line.decode("utf-8", "replace").rstrip())
            del self.lines[:-50]


def _devtools_endpoint(
    profile: Path, exe: str, process: subprocess.Popen[bytes], stderr: _Drain
) -> tuple[int, str]:
    """The port and browser path Chromium wrote into its profile on startup."""
    marker = profile / "DevToolsActivePort"
    deadline = time.monotonic() + _START_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stderr.join(timeout=2)
            raise RuntimeError(
                f"{Path(exe).name} exited at startup "
                + f"(exit status {process.returncode})"
                + chromium_said("\n".join(stderr.lines))
            )
        try:
            lines = marker.read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
        if len(lines) >= 2 and lines[0].isdigit():
            return int(lines[0]), lines[1]
        time.sleep(0.02)
    raise RuntimeError(
        "Chromium did not open its DevTools port in time"
        + chromium_said("\n".join(stderr.lines))
    )


def chromium_said(stderr: str) -> str:
    """The last lines of Chromium's stderr that are not routine noise."""
    noise = ("dbus", "Fontconfig", "GPU", "gpu_", "Gtk-", "libva", "vaapi")
    lines = [
        line.strip()
        for line in stderr.splitlines()
        if line.strip() and not any(word in line for word in noise)
    ]
    return ("\n" + "\n".join(lines[-5:])) if lines else ""
