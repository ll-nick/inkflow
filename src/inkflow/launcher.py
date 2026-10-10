"""A desktop launcher for the editor (``inkflow setup-desktop``).

The launcher runs ``inkflow edit --start``: the editor opens in the browser on
its start page (a new deck, another one, a recent one). By default the server
runs hidden and stops a minute after its last page closes (or with "Quit
Inkflow"); ``terminal=True`` runs it in a terminal window instead, which shows
its status and stops it when closed. It names this Python and
``-m inkflow`` rather than whatever ``inkflow`` is on PATH, so it starts the
installation that created it (``uv tool install inkflow`` keeps that path
across upgrades).
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
from importlib.resources import files
from pathlib import Path

import platformdirs

NAME = "Inkflow"
COMMENT = "Edit and present slide decks"


class LauncherError(Exception):
    pass


IDLE_SECONDS = 60
"""A hidden server stops once no page has been open this long."""


def command(terminal: bool = False) -> list[str]:
    """What the launcher runs: in a terminal, or hidden (then it stops by
    itself once no page is open)."""
    python = sys.executable
    if not terminal and sys.platform == "win32":
        # pythonw: no console window.
        windowless = Path(python).with_name("pythonw.exe")
        python = str(windowless) if windowless.exists() else python
    args = [python, "-m", "inkflow", "edit", "--start"]
    return args if terminal else [*args, f"--quit-when-idle={IDLE_SECONDS}"]


def install(terminal: bool = False) -> list[Path]:
    """Add the launcher to the application menu; returns the files written."""
    if sys.platform == "darwin":
        return [_macos(terminal)]
    if sys.platform == "win32":
        return [_windows(terminal)]
    return _linux(terminal)


def uninstall() -> list[Path]:
    """Remove what ``install`` wrote; returns the files removed."""
    removed: list[Path] = []
    for path in _paths():
        if path.is_dir():
            shutil.rmtree(path)
            removed.append(path)
        elif path.exists():
            path.unlink()
            removed.append(path)
    return removed


def _paths() -> list[Path]:
    if sys.platform == "darwin":
        return [Path.home() / "Applications" / f"{NAME}.app"]
    if sys.platform == "win32":
        return [_start_menu() / f"{NAME}.lnk"]
    return [_desktop_file(), _icon_file()]


# ── Linux (freedesktop) ──


def _data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def _desktop_file() -> Path:
    return _data_home() / "applications" / "inkflow.desktop"


def _icon_file() -> Path:
    return _data_home() / "icons" / "hicolor" / "scalable" / "apps" / "inkflow.svg"


def _icon_svg() -> bytes:
    return files("inkflow").joinpath("theme", "icon.svg").read_bytes()


def desktop_entry(exec_line: str, icon: Path, terminal: bool = False) -> str:
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={NAME}\n"
        f"Comment={COMMENT}\n"
        f"Exec={exec_line}\n"
        f"Icon={icon}\n"
        # A terminal shows the server's status, and closing it stops the
        # server; without one the server stops once no page is open.
        f"Terminal={'true' if terminal else 'false'}\n"
        "Categories=Office;Presentation;\n"
        "Keywords=slides;presentation;deck;svg;\n"
    )


def _linux(terminal: bool) -> list[Path]:
    icon = _icon_file()
    icon.parent.mkdir(parents=True, exist_ok=True)
    icon.write_bytes(_icon_svg())
    entry = _desktop_file()
    entry.parent.mkdir(parents=True, exist_ok=True)
    # Exec quoting: the desktop-entry spec's, which matches the shell's for
    # the paths that occur here (no %, $ or backquotes).
    exec_line = " ".join(shlex.quote(part) for part in command(terminal))
    entry.write_text(desktop_entry(exec_line, icon, terminal), encoding="utf-8")
    entry.chmod(0o755)
    if shutil.which("update-desktop-database"):
        subprocess.run(
            ["update-desktop-database", str(entry.parent)],
            check=False,
            capture_output=True,
        )
    return [entry, icon]


# ── macOS ──


def _macos(terminal: bool) -> Path:
    app = Path.home() / "Applications" / f"{NAME}.app"
    macos = app / "Contents" / "MacOS"
    macos.mkdir(parents=True, exist_ok=True)
    plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0"><dict>',
        f"<key>CFBundleName</key><string>{NAME}</string>",
        f"<key>CFBundleExecutable</key><string>{NAME}</string>",
        "<key>CFBundleIdentifier</key><string>dev.inkflow.launcher</string>",
        "<key>CFBundlePackageType</key><string>APPL</string>",
        "</dict></plist>",
    ]
    (app / "Contents" / "Info.plist").write_text(
        "\n".join(plist) + "\n", encoding="utf-8"
    )
    line = " ".join(shlex.quote(part) for part in command(terminal))
    script = macos / NAME
    if terminal:
        # In Terminal: the server's status shows, and closing it stops it.
        body = (
            "osascript -e "
            + shlex.quote(
                f'tell application "Terminal" to do script "{_applescript(line)}"'
            )
            + " -e 'tell application \"Terminal\" to activate'\n"
        )
    else:
        body = f"exec {line} >/dev/null 2>&1\n"
    script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    script.chmod(0o755)
    return app


def _applescript(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


# ── Windows ──


def _start_menu() -> Path:
    appdata = os.environ.get("APPDATA") or platformdirs.user_data_dir()
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def _windows(terminal: bool) -> Path:
    link = _start_menu() / f"{NAME}.lnk"
    link.parent.mkdir(parents=True, exist_ok=True)
    # python.exe keeps a console window (the server's status), pythonw none.
    exe, *args = command(terminal)
    ps = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:INKFLOW_LNK);"
        "$s.TargetPath = $env:INKFLOW_EXE;"
        "$s.Arguments = $env:INKFLOW_ARGS;"
        f"$s.Description = '{COMMENT}';"
        "$s.Save()"
    )
    env = {
        **os.environ,
        "INKFLOW_LNK": str(link),
        "INKFLOW_EXE": exe,
        "INKFLOW_ARGS": subprocess.list2cmdline(args),
    }
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            check=True,
            capture_output=True,
            env=env,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise LauncherError(f"could not create the Start menu shortcut: {exc}") from exc
    return link
