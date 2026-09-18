"""Launching an external editor on a slide's source file, from the presenter.

Resolution is env-var only (``INKFLOW_EDIT_CMD_SVG`` / ``INKFLOW_EDIT_CMD_MD``): no
command is bundled by default because "jump an already-open editor to this file"
is inherently editor- and machine-specific (see the two env vars' docs). When
unset, the presenter falls back to copying the path to the clipboard instead.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

from inkflow.logging import logger


@dataclass(frozen=True)
class EditCommands:
    svg: str | None
    md: str | None


NO_EDIT_COMMANDS = EditCommands(svg=None, md=None)
"""Shared "nothing configured" value, so callers with no real commands to pass
(export.py's build_html call, default handler args) don't each construct their own
equal-but-distinct instance — and so it can be used as a default argument without
ruff's B008 (no function call in a default value)."""


def resolve_edit_commands() -> EditCommands:
    return EditCommands(
        svg=os.environ.get("INKFLOW_EDIT_CMD_SVG"),
        md=os.environ.get("INKFLOW_EDIT_CMD_MD"),
    )


def command_for(path: Path, commands: EditCommands) -> str | None:
    return commands.svg if path.suffix.lower() == ".svg" else commands.md


def open_in_editor(path: Path, template: str) -> None:
    """Launch ``template`` with ``path`` substituted, detached from this process.

    ``{path}`` is substituted into every token that contains it; if no token does,
    the path is appended as a final argument (the ``$EDITOR file`` convention).
    Never raises: a bad template or missing binary is a warning, not a crash.
    """
    args = shlex.split(template)
    substituted = [a.replace("{path}", str(path)) for a in args]
    if not any("{path}" in a for a in args):
        substituted.append(str(path))

    devnull = os.open(os.devnull, os.O_WRONLY)
    try:
        subprocess.Popen(
            substituted,
            stdout=devnull,
            stderr=devnull,
            stdin=subprocess.DEVNULL,
        )
    except OSError as e:
        logger.warning(f"failed to launch edit command {template!r}: {e}")
    finally:
        os.close(devnull)
