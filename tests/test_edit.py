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

_ENV_VARS = ("INKFLOW_EDIT_CMD_SVG", "INKFLOW_EDIT_CMD_MD")


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch):  # pyright: ignore[reportUnusedFunction]
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    yield


# ── resolve_edit_commands ────────────────────────────────────────────────────


def test_resolve_edit_commands_unset() -> None:
    assert resolve_edit_commands() == EditCommands(svg=None, md=None)


def test_resolve_edit_commands_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INKFLOW_EDIT_CMD_SVG", "code -r {path}")
    monkeypatch.setenv("INKFLOW_EDIT_CMD_MD", "nvim {path}")
    assert resolve_edit_commands() == EditCommands(
        svg="code -r {path}", md="nvim {path}"
    )


# ── command_for ───────────────────────────────────────────────────────────────


def test_command_for_svg_suffix() -> None:
    commands = EditCommands(svg="edit-svg", md="edit-md")
    assert command_for(Path("slide.svg"), commands) == "edit-svg"


def test_command_for_svg_suffix_case_insensitive() -> None:
    commands = EditCommands(svg="edit-svg", md="edit-md")
    assert command_for(Path("slide.SVG"), commands) == "edit-svg"


def test_command_for_other_suffix_uses_md() -> None:
    commands = EditCommands(svg="edit-svg", md="edit-md")
    assert command_for(Path("notes.md"), commands) == "edit-md"


def test_command_for_none_configured() -> None:
    commands = EditCommands(svg=None, md=None)
    assert command_for(Path("slide.svg"), commands) is None


# ── open_in_editor ────────────────────────────────────────────────────────────


def test_open_in_editor_substitutes_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = MagicMock()
    monkeypatch.setattr(subprocess, "Popen", popen)
    open_in_editor(Path("/tmp/slide.svg"), "code -r --goto {path}")
    args = popen.call_args[0][0]  # pyright: ignore[reportAny]
    assert args == ["code", "-r", "--goto", "/tmp/slide.svg"]


def test_open_in_editor_appends_path_when_no_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = MagicMock()
    monkeypatch.setattr(subprocess, "Popen", popen)
    open_in_editor(Path("/tmp/notes.md"), "nvim")
    args = popen.call_args[0][0]  # pyright: ignore[reportAny]
    assert args == ["nvim", "/tmp/notes.md"]


def test_open_in_editor_launch_failure_warns(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*_args: object, **_kwargs: object) -> None:
        raise OSError("no such file or directory")

    monkeypatch.setattr(subprocess, "Popen", _raise)
    with collect_logs(logging.WARNING) as warnings:
        open_in_editor(Path("/tmp/slide.svg"), "not-a-real-editor {path}")
    assert any("failed to launch edit command" in w.message for w in warnings)
