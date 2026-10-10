"""The operating system's own folder (or file) chooser, shown by the server.

A web page cannot learn a path on disk, but the server runs on the same
machine as a local editor page, so it can ask the desktop: zenity or kdialog
on Linux, the Finder's chooser on macOS, the Windows folder / file dialog.
The call blocks until the person picks something or cancels.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def _linux_tool() -> str | None:
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return None
    for tool in ("zenity", "kdialog"):
        if shutil.which(tool):
            return tool
    return None


def available() -> bool:
    if sys.platform == "darwin":
        return shutil.which("osascript") is not None
    if sys.platform == "win32":
        return shutil.which("powershell") is not None
    return _linux_tool() is not None


def _command(
    files: bool, start: Path, title: str, suffixes: frozenset[str]
) -> list[str]:
    if sys.platform == "darwin":
        what = "file" if files else "folder"
        script = (
            f'POSIX path of (choose {what} with prompt "{_quote(title)}"'
            + f' default location (POSIX file "{_quote(str(start))}"))'
        )
        return ["osascript", "-e", script]
    if sys.platform == "win32":
        if files:
            pattern = ";".join(f"*{s}" for s in sorted(suffixes)) or "*.*"
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$d = New-Object System.Windows.Forms.OpenFileDialog;"
                "$d.InitialDirectory = $env:INKFLOW_START;"
                f"$d.Filter = 'Videos|{pattern}|All files|*.*';"
                "if ($d.ShowDialog() -eq 'OK') { $d.FileName } else { exit 1 }"
            )
        else:
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
                "$d.SelectedPath = $env:INKFLOW_START;"
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }"
            )
        return ["powershell", "-NoProfile", "-STA", "-Command", ps]
    tool = _linux_tool()
    if tool == "kdialog":
        if files:
            pattern = " ".join(f"*{s}" for s in sorted(suffixes))
            return [
                "kdialog",
                "--title",
                title,
                "--getopenfilename",
                str(start),
                pattern,
            ]
        return ["kdialog", "--title", title, "--getexistingdirectory", str(start)]
    args = ["zenity", "--file-selection", f"--title={title}", f"--filename={start}/"]
    if not files:
        args.append("--directory")
    elif suffixes:
        pattern = " ".join(f"*{s}" for s in sorted(suffixes))
        args.append(f"--file-filter=Videos | {pattern}")
    return args


def _quote(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def pick(
    *,
    files: bool = False,
    start: Path | None = None,
    title: str = "Choose a folder",
    suffixes: frozenset[str] | None = None,
) -> str | None:
    """The chosen path, or None when cancelled (or no chooser is available).
    ``files`` chooses a file (of ``suffixes``, if given) instead of a folder."""
    suffixes = suffixes or frozenset()
    if not available():
        return None
    folder = start if start is not None and start.is_dir() else Path.home()
    try:
        result = subprocess.run(
            _command(files, folder, title, suffixes),
            capture_output=True,
            text=True,
            check=False,
            env={**os.environ, "INKFLOW_START": str(folder)},
        )
    except OSError:
        return None
    chosen = result.stdout.strip()
    if result.returncode != 0 or not chosen:
        return None
    if files:
        return chosen
    return chosen.rstrip("/") or "/"
