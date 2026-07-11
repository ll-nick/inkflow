"""Where inkflow reports non-fatal problems and command status.

A thin layer over stdlib logging that separates severity (the call site picks the
level) from destination (each sink is a handler with its own level). Library code
logs instead of printing, so a warning raised mid-rebuild can't race the Rich Live
TUI during serve.

There are three sinks — console, file, browser — each with an independent level, and
``off`` disables one (activation is just another level, as in Rust's log crate or
log4j). Levels come from a flag/env cascade where a per-sink setting beats the shared
baseline.

Diagnostics go to stderr; machine-readable command output stays on stdout and is not
routed here.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

import platformdirs
from rich.console import Console
from rich.text import Text
from typing_extensions import override

# One logger for the whole library. ``propagate = False`` keeps records off the root
# logger's default stderr handler, so nothing double-prints and pytest's ``caplog``
# (which listens on the root) does not see our records.
logger = logging.getLogger("inkflow")
logger.setLevel(logging.DEBUG)
logger.propagate = False
# A NullHandler so a record emitted while every sink is off (e.g. --log-level-console
# off with no file sink) is swallowed rather than leaking to stdlib's lastResort stderr
# handler. It does nothing; the managed handlers below do the real work.
logger.addHandler(logging.NullHandler())

# The single shared Rich console for all human-facing CLI output. On stderr so that
# stdout is reserved for machine-consumable command output.
console = Console(stderr=True)

# Width of the right-aligned status verb column (cargo-style).
_VERB_WIDTH = 12

# A level above anything a record can carry: a sink resolved to OFF gets no handler.
OFF = logging.CRITICAL + 10

# Level names accepted by the CLI / env vars, in increasing severity. ``off`` disables.
LEVELS: dict[str, int] = {
    "off": OFF,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}
LEVEL_NAMES: tuple[str, ...] = tuple(LEVELS)

# Handlers this module installs, tracked so they can be replaced idempotently
# without disturbing handlers anyone else attached to the logger.
_managed: list[logging.Handler] = []


def parse_level(name: str) -> int:
    """Numeric threshold for a level name (case-insensitive)."""
    try:
        return LEVELS[name.lower()]
    except KeyError:
        raise ValueError(
            f"invalid log level {name!r}; choose from {', '.join(LEVEL_NAMES)}"
        ) from None


def _level_render(levelno: int) -> tuple[str, str]:
    """The status verb and colour a record renders with, by severity band."""
    if levelno >= logging.ERROR:
        return ("Error", "red")
    if levelno >= logging.WARNING:
        return ("Warning", "yellow")
    if levelno >= logging.INFO:
        return ("Info", "blue")
    return ("Debug", "dim")


def _entry_level_name(levelno: int) -> str:
    """Coarse level name (debug/info/warning/error) for a numeric level."""
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warning"
    if levelno >= logging.INFO:
        return "info"
    return "debug"


class LogEntry(NamedTuple):
    """A collected record; levelno drives filtering, level (name) is for display."""

    levelno: int
    level: str
    message: str


@dataclass(frozen=True)
class Levels:
    """Resolved per-sink levels (OFF disables a sink) and the file path."""

    console: int
    file: int
    browser: int
    file_path: Path | None


def _status_text(verb: str, detail: str, style: str) -> Text:
    """A cargo-style status line: a right-aligned coloured verb, then the detail."""
    text = Text()
    text.append(f"{verb:>{_VERB_WIDTH}}", style=f"bold {style}")
    if detail:
        text.append(f"  {detail}")
    return text


def report(verb: str, detail: str = "", *, style: str = "green") -> None:
    """Print a cargo-style status line: a coloured verb column, then the detail.

    Not a log record — always prints, carries no severity. Convention: green for a
    completed action, dim for a no-op/skip, yellow for attention.
    """
    console.print(_status_text(verb, detail, style))


class _CollectingHandler(logging.Handler):
    """Appends each record to a caller-provided list for later per-surface filtering."""

    def __init__(self, sink: list[LogEntry], level: int) -> None:
        super().__init__(level=level)
        self._sink: list[LogEntry] = sink

    def emit(self, record: logging.LogRecord) -> None:  # pyright: ignore[reportImplicitOverride]
        self._sink.append(
            LogEntry(
                record.levelno, _entry_level_name(record.levelno), record.getMessage()
            )
        )


@contextmanager
def collect_logs(level: int) -> Generator[list[LogEntry]]:
    """Capture records at or above `level` during the block into a list.

    For surfaces that can't write to stderr directly: the serve TUI (owns the
    terminal) and the browser banner (records shipped over the wire). The caller
    filters the returned entries per surface.
    """
    sink: list[LogEntry] = []
    handler = _CollectingHandler(sink, level)
    logger.addHandler(handler)
    try:
        yield sink
    finally:
        logger.removeHandler(handler)


class _ConsoleHandler(logging.Handler):
    """Renders records through the shared console's cargo-style status column."""

    @override
    def emit(self, record: logging.LogRecord) -> None:
        verb, style = _level_render(record.levelno)
        report(verb, record.getMessage(), style=style)


def _default_log_file() -> Path:
    """The per-user log location for the file sink."""
    return platformdirs.user_log_path("inkflow") / "inkflow.log"


def resolve_levels(
    *,
    log_level: str | None = None,
    console: str | None = None,
    file: str | None = None,
    browser: str | None = None,
    log_file: str | None = None,
) -> Levels:
    """Resolve each sink's level; first candidate present wins, so a per-sink setting
    beats the shared baseline. The file path is resolved separately and does not, on
    its own, enable the sink.
    """
    all_env = os.environ.get("INKFLOW_LOG_LEVEL")

    def resolve(sink_flag: str | None, env_name: str, default: int) -> int:
        for candidate in (sink_flag, os.environ.get(env_name), log_level, all_env):
            if candidate:
                return parse_level(candidate)
        return default

    env_path = os.environ.get("INKFLOW_LOG_FILE")
    file_path = Path(log_file) if log_file else Path(env_path) if env_path else None

    return Levels(
        console=resolve(console, "INKFLOW_LOG_LEVEL_CONSOLE", logging.WARNING),
        file=resolve(file, "INKFLOW_LOG_LEVEL_FILE", OFF),
        browser=resolve(browser, "INKFLOW_LOG_LEVEL_BROWSER", logging.WARNING),
        file_path=file_path,
    )


def configure(levels: Levels, *, attach_console: bool = True) -> None:
    """Reinstall the console and file handlers from the levels, idempotently.

    attach_console is off for serve, which owns the terminal and collects records per
    rebuild instead. The browser sink has no persistent handler for the same reason.
    """
    for handler in _managed:
        logger.removeHandler(handler)
        handler.close()
    _managed.clear()

    if attach_console and levels.console != OFF:
        console_handler = _ConsoleHandler(level=levels.console)
        logger.addHandler(console_handler)
        _managed.append(console_handler)

    if levels.file != OFF:
        path = levels.file_path or _default_log_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(path, encoding="utf-8")
        file_handler.setLevel(levels.file)
        file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(message)s")
        )
        logger.addHandler(file_handler)
        _managed.append(file_handler)
