from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from inkflow.edit import (
    EditCommands,
    command_for,
    open_in_editor,
    resolve_edit_commands,
)
from inkflow.logging import collect_logs

_ENV_VARS = ("INKFLOW_EDIT_CMD", "INKFLOW_EDIT_CMD_SVG")


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch):  # pyright: ignore[reportUnusedFunction]
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    yield


# ── resolve_edit_commands ────────────────────────────────────────────────────


def test_resolve_edit_commands_unset() -> None:
    assert resolve_edit_commands() == EditCommands(default=None, svg=None)


def test_resolve_edit_commands_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INKFLOW_EDIT_CMD", "nvim {path}")
    monkeypatch.setenv("INKFLOW_EDIT_CMD_SVG", "code -r {path}")
    assert resolve_edit_commands() == EditCommands(
        default="nvim {path}", svg="code -r {path}"
    )


# ── command_for ───────────────────────────────────────────────────────────────


def test_command_for_svg_suffix_uses_svg_override() -> None:
    commands = EditCommands(default="edit-default", svg="edit-svg")
    assert command_for(Path("slide.svg"), commands) == "edit-svg"


def test_command_for_svg_suffix_case_insensitive() -> None:
    commands = EditCommands(default="edit-default", svg="edit-svg")
    assert command_for(Path("slide.SVG"), commands) == "edit-svg"


def test_command_for_other_suffix_uses_default() -> None:
    commands = EditCommands(default="edit-default", svg="edit-svg")
    assert command_for(Path("notes.md"), commands) == "edit-default"


def test_command_for_svg_falls_back_to_default_without_override() -> None:
    # The general command also applies to SVG files when no SVG-specific
    # override is set — setting only INKFLOW_EDIT_CMD covers everything.
    commands = EditCommands(default="edit-default", svg=None)
    assert command_for(Path("slide.svg"), commands) == "edit-default"


def test_command_for_none_configured() -> None:
    commands = EditCommands(default=None, svg=None)
    assert command_for(Path("slide.svg"), commands) is None


# ── open_in_editor ────────────────────────────────────────────────────────────


def test_open_in_editor_substitutes_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = MagicMock()
    monkeypatch.setattr(subprocess, "Popen", popen)
    result = open_in_editor(Path("/tmp/slide.svg"), "code -r --goto {path}")
    args = popen.call_args[0][0]  # pyright: ignore[reportAny]
    assert args == ["code", "-r", "--goto", "/tmp/slide.svg"]
    assert result is None


def test_open_in_editor_appends_path_when_no_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = MagicMock()
    monkeypatch.setattr(subprocess, "Popen", popen)
    open_in_editor(Path("/tmp/notes.md"), "nvim")
    args = popen.call_args[0][0]  # pyright: ignore[reportAny]
    assert args == ["nvim", "/tmp/notes.md"]


def test_open_in_editor_launch_failure_warns_and_returns_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _raise(*_args: object, **_kwargs: object) -> None:
        raise OSError("no such file or directory")

    monkeypatch.setattr(subprocess, "Popen", _raise)
    with collect_logs(logging.WARNING) as warnings:
        result = open_in_editor(Path("/tmp/slide.svg"), "not-a-real-editor {path}")
    assert any("failed to launch edit command" in w.message for w in warnings)
    assert result is not None
    assert "failed to launch edit command" in result
