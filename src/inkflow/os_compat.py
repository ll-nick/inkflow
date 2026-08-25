"""OS-mechanism abstraction"""

from __future__ import annotations

import asyncio
import contextlib
import signal
import sys
import threading
import time
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from types import FrameType

# ── Raw keypress reading ────────────────────────────────────────────────────────


@contextlib.asynccontextmanager
async def raw_keypresses(
    loop: asyncio.AbstractEventLoop,
) -> AsyncGenerator[asyncio.Queue[str]]:
    """Yield a queue fed with single stdin keystrokes, no Enter required.

    Assumes stdin is a TTY — callers check ``sys.stdin.isatty()`` first. Says nothing
    about what the keystrokes mean; that dispatch lives with the caller.
    """
    if sys.platform == "win32":
        async with _raw_keypresses_windows(loop) as queue:
            yield queue
    else:
        async with _raw_keypresses_posix(loop) as queue:
            yield queue


@contextlib.asynccontextmanager
async def _raw_keypresses_posix(
    loop: asyncio.AbstractEventLoop,
) -> AsyncGenerator[asyncio.Queue[str]]:
    import termios
    import tty

    queue: asyncio.Queue[str] = asyncio.Queue()
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)

    def _on_stdin() -> None:
        ch = sys.stdin.read(1)
        loop.call_soon_threadsafe(queue.put_nowait, ch)

    tty.setcbreak(fd)  # single-char reads, output processing (ONLCR) intact
    loop.add_reader(fd, _on_stdin)
    try:
        yield queue
    finally:
        loop.remove_reader(fd)
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


@contextlib.asynccontextmanager
async def _raw_keypresses_windows(
    loop: asyncio.AbstractEventLoop,
) -> AsyncGenerator[asyncio.Queue[str]]:
    queue: asyncio.Queue[str] = asyncio.Queue()
    stop = threading.Event()
    future = loop.run_in_executor(None, _poll_keys_windows, loop, queue, stop)
    try:
        yield queue
    finally:
        stop.set()
        await future


def _poll_keys_windows(
    loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[str], stop: threading.Event
) -> None:
    import msvcrt

    while not stop.is_set():
        if msvcrt.kbhit():
            ch = msvcrt.getwch()
            loop.call_soon_threadsafe(queue.put_nowait, ch)
        else:
            time.sleep(0.05)


# ── Shutdown signal handling ────────────────────────────────────────────────────


def install_shutdown_handler(
    loop: asyncio.AbstractEventLoop, shutdown: asyncio.Event
) -> Callable[[], None]:
    """Wire Ctrl-C (and SIGTERM, where it means anything) to set ``shutdown``.

    Returns an uninstall callback. ``loop.add_signal_handler`` isn't implemented on
    Windows' ProactorEventLoop, so that platform falls back to ``signal.signal`` for
    SIGINT only — there's no POSIX-style SIGTERM delivery there, and Ctrl-C is the
    interactive path that matters.
    """
    if sys.platform == "win32":

        def _handle_sigint(_signum: int, _frame: FrameType | None) -> None:
            shutdown.set()

        signal.signal(signal.SIGINT, _handle_sigint)

        def _uninstall() -> None:
            signal.signal(signal.SIGINT, signal.default_int_handler)

        return _uninstall

    loop.add_signal_handler(signal.SIGINT, shutdown.set)
    loop.add_signal_handler(signal.SIGTERM, shutdown.set)

    def _uninstall() -> None:
        loop.remove_signal_handler(signal.SIGINT)
        loop.remove_signal_handler(signal.SIGTERM)

    return _uninstall


# ── Venv layout ──────────────────────────────────────────────────────────────────


def venv_executable(venv_root: Path, name: str) -> Path:
    """Return where ``name`` would live in a venv rooted at ``venv_root``."""
    if sys.platform == "win32":
        return venv_root / "Scripts" / f"{name}.exe"
    return venv_root / "bin" / name
