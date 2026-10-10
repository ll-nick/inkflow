"""Launching an external program on a deck's source file.

The presenter's edit menu resolves a command from env vars only
(``INKFLOW_EDIT_CMD``, ``INKFLOW_EDIT_CMD_SVG``, and per extension or kind:
``INKFLOW_EDIT_CMD_PNG``, ``INKFLOW_EDIT_CMD_IMAGE``, ``INKFLOW_EDIT_CMD_TEXT``…);
when none applies it copies the path to the clipboard. No command is bundled
by default because "jump an already-open editor to this file" is inherently
editor- and machine-specific.

The visual editor's "Open in…" menu offers more: the configured command, then
the programs found installed for the file's kind (Inkscape for SVG; GIMP,
Krita… for images; PDF viewers for a PDF figure; text editors for Markdown and
deck.py), then the system's default app for the file.
"""

from __future__ import annotations

import functools
import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from inkflow.logging import logger


@dataclass(frozen=True)
class EditCommands:
    default: str | None
    svg: str | None
    overrides: tuple[tuple[str, str], ...] = ()
    """Other ``INKFLOW_EDIT_CMD_<NAME>`` vars: an extension (``PNG``, ``MD``) or
    a kind (``IMAGE``, ``TEXT``, ``VIDEO``, ``DATA``), upper-case, in env order."""


NO_EDIT_COMMANDS = EditCommands(default=None, svg=None)
"""Shared "nothing configured" value, so callers with no real commands to pass
(export.py's build_html call, default handler args) don't each construct their own
equal-but-distinct instance — and so it can be used as a default argument without
ruff's B008 (no function call in a default value)."""


_PREFIX = "INKFLOW_EDIT_CMD_"

KINDS: dict[str, str] = {
    **dict.fromkeys(
        ("png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"), "IMAGE"
    ),
    **dict.fromkeys(("md", "py", "css", "js", "txt", "toml", "json", "yaml"), "TEXT"),
    **dict.fromkeys(("mp4", "webm", "mov", "ogg"), "VIDEO"),
    "pdf": "PDF",
    # A chart's table: a spreadsheet opens it as one.
    **dict.fromkeys(("csv", "tsv"), "DATA"),
}
"""File extension → the kind an ``INKFLOW_EDIT_CMD_<KIND>`` var covers."""


def resolve_edit_commands() -> EditCommands:
    overrides = tuple(
        (name.removeprefix(_PREFIX).upper(), value)
        for name, value in os.environ.items()
        if name.startswith(_PREFIX) and name != f"{_PREFIX}SVG" and value
    )
    return EditCommands(
        default=os.environ.get("INKFLOW_EDIT_CMD"),
        svg=os.environ.get("INKFLOW_EDIT_CMD_SVG"),
        overrides=overrides,
    )


def command_for(path: Path, commands: EditCommands) -> str | None:
    """The most specific configured command: ``INKFLOW_EDIT_CMD_<EXT>`` (``_SVG``
    for SVG files), then ``INKFLOW_EDIT_CMD_<KIND>``, then ``INKFLOW_EDIT_CMD``."""
    suffix = path.suffix.lower().lstrip(".")
    if suffix == "svg" and commands.svg is not None:
        return commands.svg
    named = dict(commands.overrides)
    if suffix.upper() in named:
        return named[suffix.upper()]
    kind = KINDS.get(suffix)
    if kind and kind in named:
        return named[kind]
    return commands.default


def configured_suffixes(commands: EditCommands) -> list[str]:
    """Every extension a command is configured for (the presenter's menu)."""
    known = ["svg", *KINDS]
    return [s for s in known if command_for(Path(f"x.{s}"), commands) is not None]


# ── Programs for the editor's "Open in…" menu ──


@dataclass(frozen=True)
class App:
    id: str
    label: str
    command: str | None
    """A launch template (``{path}`` substituted); None for the system's opener."""


_TEXT_EDITORS = [
    ("code", "VS Code"),
    ("codium", "VSCodium"),
    ("zed", "Zed"),
    ("subl", "Sublime Text"),
    ("kate", "Kate"),
    ("gnome-text-editor", "Text Editor"),
    ("gedit", "gedit"),
    ("mousepad", "Mousepad"),
    ("notepad++", "Notepad++"),
]
_CANDIDATES: dict[str, list[tuple[str, str]]] = {
    "SVG": [("inkscape", "Inkscape"), *_TEXT_EDITORS],
    # A draw.io diagram (*.drawio.svg): draw.io desktop edits its source.
    "DIAGRAM": [("drawio", "draw.io"), ("inkscape", "Inkscape"), *_TEXT_EDITORS],
    "IMAGE": [("gimp", "GIMP"), ("krita", "Krita"), ("pinta", "Pinta")],
    # A figure: read in a viewer; Inkscape opens a page of it as a drawing.
    "PDF": [
        ("okular", "Okular"),
        ("evince", "Document Viewer"),
        ("zathura", "Zathura"),
        ("xreader", "Xreader"),
        ("inkscape", "Inkscape"),
    ],
    "TEXT": _TEXT_EDITORS,
    "DATA": [
        ("localc", "LibreOffice Calc"),
        ("libreoffice", "LibreOffice"),
        ("gnumeric", "Gnumeric"),
        ("numbers", "Numbers"),
        ("excel", "Microsoft Excel"),
        *_TEXT_EDITORS,
    ],
    "VIDEO": [
        ("losslesscut", "LosslessCut (trim, no re-encoding)"),
        ("shotcut", "Shotcut"),
        ("kdenlive", "Kdenlive"),
        ("avidemux3_qt5", "Avidemux"),
        ("avidemux", "Avidemux"),
        ("ghb", "HandBrake (convert)"),
        ("openshot-qt", "OpenShot"),
        ("vlc", "VLC"),
        ("mpv", "mpv"),
    ],
}
# The same programs installed as Flatpaks (no binary on PATH).
_FLATPAKS = {
    "losslesscut": "no.mifi.losslesscut",
    "shotcut": "org.shotcut.Shotcut",
    "kdenlive": "org.kde.kdenlive",
    "avidemux": "org.avidemux.Avidemux",
    "ghb": "fr.handbrake.ghb",
    "openshot-qt": "org.openshot.OpenShot",
    "vlc": "org.videolan.VLC",
    "mpv": "io.mpv.Mpv",
    "inkscape": "org.inkscape.Inkscape",
    "gimp": "org.gimp.GIMP",
    "krita": "org.kde.krita",
    "drawio": "com.jgraph.drawio.desktop",
    "okular": "org.kde.okular",
    "evince": "org.gnome.Evince",
    "libreoffice": "org.libreoffice.LibreOffice",
    "gnumeric": "org.gnome.Gnumeric",
}
# macOS apps live in /Applications rather than on PATH.
_MAC_APPS = {
    "inkscape": "Inkscape",
    "gimp": "GIMP",
    "krita": "krita",
    "code": "Visual Studio Code",
    "zed": "Zed",
    "subl": "Sublime Text",
    "vlc": "VLC",
    "losslesscut": "LosslessCut",
    "shotcut": "Shotcut",
    "kdenlive": "kdenlive",
    "ghb": "HandBrake",
    "openshot-qt": "OpenShot Video Editor",
    "drawio": "draw.io",
    "libreoffice": "LibreOffice",
    "numbers": "Numbers",
    "excel": "Microsoft Excel",
}


def _kind(path: Path) -> str | None:
    if path.name.lower().endswith(".drawio.svg"):
        return "DIAGRAM"
    suffix = path.suffix.lower().lstrip(".")
    return "SVG" if suffix == "svg" else KINDS.get(suffix)


def _installed(binary: str) -> str | None:
    if shutil.which(binary):
        return f"{shlex.quote(binary)} {{path}}"
    app = _MAC_APPS.get(binary)
    if sys.platform == "darwin" and app and Path(f"/Applications/{app}.app").exists():
        return f"open -a {shlex.quote(app)} {{path}}"
    flatpak = _FLATPAKS.get(binary)
    if flatpak and _flatpak_installed(flatpak):
        return f"flatpak run {flatpak} {{path}}"
    return None


@functools.cache
def _flatpak_installed(app_id: str) -> bool:
    """Whether a Flatpak app is installed (asked once per process)."""
    if shutil.which("flatpak") is None:
        return False
    try:
        result = subprocess.run(
            ["flatpak", "info", app_id], capture_output=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def open_choices(path: Path, commands: EditCommands) -> list[App]:
    """What the editor offers to open ``path`` with, most specific first."""
    apps: list[App] = []
    configured = command_for(path, commands)
    if configured:
        program = Path(shlex.split(configured)[0]).name
        apps.append(App("configured", f"{program} (configured)", configured))
    labels: set[str] = set()
    for binary, label in _CANDIDATES.get(_kind(path) or "", []):
        command = _installed(binary)
        if command and label not in labels:  # one Avidemux, however installed
            labels.add(label)
            apps.append(App(binary, label, command))
    apps.append(App("system", "Default app", None))
    return apps


def open_with(path: Path, app: App) -> str | None:
    """Open ``path`` with ``app``; returns an error message rather than raising."""
    if app.command is not None:
        return open_in_editor(path, app.command)
    if sys.platform == "win32":
        try:
            os.startfile(path)
        except OSError as e:
            return f"failed to open {path.name}: {e}"
        return None
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    if not shutil.which(opener):
        return f"no default app opener ({opener}) on this system"
    return open_in_editor(path, f"{opener} {{path}}")


def open_in_editor(path: Path, template: str) -> str | None:
    """Launch ``template`` with ``path`` substituted, detached from this process.

    ``{path}`` is substituted into every token that contains it; if no token does,
    the path is appended as a final argument (the ``$EDITOR file`` convention).
    Never raises: a bad template or missing binary is logged and returned as a
    message (e.g. so the caller can also report it back to the requesting
    browser tab, which is otherwise the only place nothing visibly happens),
    not raised as a crash.
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
        message = f"failed to launch edit command {template!r}: {e}"
        logger.warning(message)
        return message
    finally:
        os.close(devnull)
    return None
