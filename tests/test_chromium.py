# pyright: reportPrivateUsage=none
from __future__ import annotations

import base64
import http.client
import io
import json
import queue
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

import pytest

from inkflow.chromium import (
    DevToolsConnection,
    JsonObject,
    _forward_stderr,
    find_chromium,
    print_page,
    print_to_pdf,
    serve_directory,
)

# ── discovery ─────────────────────────────────────────────────────────────────


def _fake_executable(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    exe = directory / name
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    return exe


# shutil.which only finds extensionless files on Windows if PATHEXT allows it,
# and flatpak/snap do not exist there anyway.
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX executables only")
class TestFindChromium:
    @pytest.fixture(autouse=True)
    def _empty_path(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("PATH", str(tmp_path / "empty-path"))
        monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
        monkeypatch.setattr("inkflow.chromium._SNAP_BIN_DIR", tmp_path / "snap-bin")
        monkeypatch.setattr(
            "inkflow.chromium._SYSTEM_FLATPAK_EXPORT_DIR", tmp_path / "system-flatpak"
        )

    def test_finds_system_flatpak(self, tmp_path: Path) -> None:
        exe = _fake_executable(tmp_path / "system-flatpak", "com.google.Chrome")
        assert find_chromium() == str(exe)

    def test_finds_user_flatpak(self, tmp_path: Path) -> None:
        exe = _fake_executable(
            tmp_path / "data" / "flatpak" / "exports" / "bin", "org.chromium.Chromium"
        )
        assert find_chromium() == str(exe)

    def test_finds_snap_outside_path(self, tmp_path: Path) -> None:
        exe = _fake_executable(tmp_path / "snap-bin", "chromium")
        assert find_chromium() == str(exe)

    def test_path_wins_over_flatpak(self, tmp_path: Path) -> None:
        _fake_executable(
            tmp_path / "data" / "flatpak" / "exports" / "bin", "org.chromium.Chromium"
        )
        exe = _fake_executable(tmp_path / "empty-path", "chromium")
        assert find_chromium() == str(exe)

    def test_ignores_non_executable_export(self, tmp_path: Path) -> None:
        exe = _fake_executable(
            tmp_path / "data" / "flatpak" / "exports" / "bin", "com.google.Chrome"
        )
        exe.chmod(0o644)
        assert find_chromium() is None


# ── serving the page ──────────────────────────────────────────────────────────


def test_serve_directory_serves_files(tmp_path: Path) -> None:
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "pic.svg").write_text("<svg/>")
    with serve_directory(tmp_path) as base_url:
        host_and_port = base_url.removeprefix("http://")
        assert host_and_port.startswith("127.0.0.1:")
        connection = http.client.HTTPConnection(host_and_port)
        connection.request("GET", "/assets/pic.svg")
        assert connection.getresponse().read() == b"<svg/>"
        connection.close()


# ── DevTools protocol ─────────────────────────────────────────────────────────

_PDF_BYTES = b"%PDF-1.4 fake"


@dataclass
class _ScriptedBrowser:
    """A DevTools channel that answers each request from a fixed script.

    ``replies`` maps a method to its result; ``events_after`` maps a method to
    the events Chromium would push right after replying to it.
    """

    replies: dict[str, JsonObject]
    events_after: dict[str, list[JsonObject]] = field(
        default_factory=dict[str, list[JsonObject]]
    )
    events_before_reply: dict[str, list[JsonObject]] = field(
        default_factory=dict[str, list[JsonObject]]
    )
    sent: list[JsonObject] = field(default_factory=list[JsonObject])
    _outbox: list[str] = field(default_factory=list[str])

    def send(self, message: str) -> None:
        request = cast(JsonObject, json.loads(message))
        self.sent.append(request)
        method = str(request["method"])
        session_id = request.get("sessionId")
        for event in self.events_before_reply.get(method, []):
            self._outbox.append(json.dumps({**event, "sessionId": session_id}))
        reply = self.replies[method]
        self._outbox.append(json.dumps({"id": request["id"], **reply}))
        for event in self.events_after.get(method, []):
            self._outbox.append(json.dumps({**event, "sessionId": session_id}))

    def recv(self, timeout: float | None = None) -> str:
        assert timeout is not None, "every receive must be bounded by the deadline"
        if not self._outbox:
            raise TimeoutError
        return self._outbox.pop(0)


def _happy_replies(navigate_result: JsonObject | None = None) -> dict[str, JsonObject]:
    return {
        "Target.createTarget": {"result": {"targetId": "T1"}},
        "Target.attachToTarget": {"result": {"sessionId": "S1"}},
        "Page.enable": {"result": {}},
        "Page.navigate": {"result": navigate_result or {"frameId": "F1"}},
        "Runtime.evaluate": {"result": {}},
        "Page.printToPDF": {
            "result": {"data": base64.b64encode(_PDF_BYTES).decode("ascii")}
        },
    }


_LOAD_EVENT: JsonObject = {"method": "Page.loadEventFired", "params": {}}


def _connection(browser: _ScriptedBrowser) -> DevToolsConnection:
    return DevToolsConnection(browser, deadline=float("inf"))


class TestPrintPage:
    def test_returns_decoded_pdf(self) -> None:
        browser = _ScriptedBrowser(
            _happy_replies(), events_after={"Page.navigate": [_LOAD_EVENT]}
        )
        assert print_page(_connection(browser), "http://x/slides.html") == _PDF_BYTES
        printed = browser.sent[-1]
        assert printed["method"] == "Page.printToPDF"
        assert printed["sessionId"] == "S1"

    def test_load_event_before_navigate_reply_is_not_lost(self) -> None:
        browser = _ScriptedBrowser(
            _happy_replies(), events_before_reply={"Page.navigate": [_LOAD_EVENT]}
        )
        assert print_page(_connection(browser), "http://x/slides.html") == _PDF_BYTES

    def test_failed_navigation_raises(self) -> None:
        browser = _ScriptedBrowser(
            _happy_replies({"frameId": "F1", "errorText": "net::ERR_FILE_NOT_FOUND"})
        )
        with pytest.raises(RuntimeError, match="ERR_FILE_NOT_FOUND"):
            print_page(_connection(browser), "http://x/slides.html")

    def test_protocol_error_names_the_method(self) -> None:
        replies = _happy_replies()
        replies["Page.printToPDF"] = {"error": {"code": -32000, "message": "boom"}}
        browser = _ScriptedBrowser(
            replies, events_after={"Page.navigate": [_LOAD_EVENT]}
        )
        with pytest.raises(RuntimeError, match=r"Page\.printToPDF: boom"):
            print_page(_connection(browser), "http://x/slides.html")

    def test_missing_load_event_times_out(self) -> None:
        browser = _ScriptedBrowser(_happy_replies())
        with pytest.raises(RuntimeError, match="in time"):
            print_page(_connection(browser), "http://x/slides.html")


# ── the browser process ───────────────────────────────────────────────────────


def test_forward_stderr_reports_url_and_echoes_the_rest(
    capsys: pytest.CaptureFixture[str],
) -> None:
    stream = io.StringIO(
        "Fontconfig error: whatever\n"
        + "DevTools listening on ws://127.0.0.1:4321/devtools/browser/abc\n"
        + "later log line\n"
    )
    urls: queue.Queue[str | None] = queue.Queue()
    _forward_stderr(stream, urls)
    assert urls.get_nowait() == "ws://127.0.0.1:4321/devtools/browser/abc"
    assert urls.get_nowait() is None
    stderr = capsys.readouterr().err
    assert "Fontconfig error" in stderr
    assert "later log line" in stderr
    assert "DevTools listening" not in stderr


def test_missing_executable_raises(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="Could not start Chromium"):
        print_to_pdf(str(tmp_path / "no-such-browser"), "http://x/slides.html")


def test_executable_that_exits_early_raises() -> None:
    # Python rejects Chromium's flags and exits without announcing DevTools.
    with pytest.raises(RuntimeError, match="before it was ready"):
        print_to_pdf(sys.executable, "http://x/slides.html")
