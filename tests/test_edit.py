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
def _isolated_env(monkeypatch: pytest.MonkeyPatch):
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
    path = Path("/tmp/slide.svg")
    result = open_in_editor(path, "code -r --goto {path}")
    args = popen.call_args[0][0]  # pyright: ignore[reportAny]
    assert args == ["code", "-r", "--goto", str(path)]
    assert result is None


def test_open_in_editor_appends_path_when_no_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = MagicMock()
    monkeypatch.setattr(subprocess, "Popen", popen)
    path = Path("/tmp/notes.md")
    open_in_editor(path, "nvim")
    args = popen.call_args[0][0]  # pyright: ignore[reportAny]
    assert args == ["nvim", str(path)]


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


def test_per_extension_and_kind_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    from inkflow.edit import configured_suffixes

    monkeypatch.setenv("INKFLOW_EDIT_CMD", "nano {path}")
    monkeypatch.setenv("INKFLOW_EDIT_CMD_IMAGE", "gimp {path}")
    monkeypatch.setenv("INKFLOW_EDIT_CMD_PNG", "krita {path}")
    commands = resolve_edit_commands()
    assert command_for(Path("a.png"), commands) == "krita {path}"
    assert command_for(Path("a.jpg"), commands) == "gimp {path}"
    assert command_for(Path("a.md"), commands) == "nano {path}"
    assert "png" in configured_suffixes(commands)


def test_open_choices_offer_installed_programs_then_the_system_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from inkflow import edit

    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("inkscape", "code") else None

    monkeypatch.setattr("inkflow.edit.shutil.which", which)
    choices = edit.open_choices(Path("slide.svg"), EditCommands(default=None, svg=None))
    assert [c.id for c in choices] == ["inkscape", "code", "system"]
    assert choices[0].command == "inkscape {path}"
    image = edit.open_choices(Path("a.png"), EditCommands(default=None, svg=None))
    assert [c.id for c in image] == ["system"]
    configured = edit.open_choices(
        Path("a.png"), EditCommands(default="nano {path}", svg=None)
    )
    assert configured[0].id == "configured"


def test_video_editors_are_offered_installed_or_as_flatpaks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from inkflow import edit

    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("shotcut", "flatpak") else None

    monkeypatch.setattr("inkflow.edit.shutil.which", which)

    def flatpak(app_id: str) -> bool:
        return app_id == "no.mifi.losslesscut"

    monkeypatch.setattr("inkflow.edit._flatpak_installed", flatpak)
    choices = edit.open_choices(Path("clip.mp4"), EditCommands(default=None, svg=None))
    assert [(c.id, c.command) for c in choices[:2]] == [
        ("losslesscut", "flatpak run no.mifi.losslesscut {path}"),
        ("shotcut", "shotcut {path}"),
    ]
