"""Git LFS for decks: which files belong in it, and the ``.gitattributes`` that
says so.

A deck collects videos, screenshots, fonts and exported PDFs, files git keeps
whole in every version, so a repository grows by their full size with each
change. Git LFS stores them outside the history instead. ``inkflow init`` and the
editor's new deck write the rules below into the deck's ``.gitattributes``; the
editor's git menu warns about media that no rule covers.

A deck can opt out ("git only", for a small repository or a host without LFS):
its ``.gitattributes`` then carries the ``OFF_MARKER`` comment, which is
committed, so nobody working on the deck is warned about it again.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

PATTERNS: dict[str, tuple[str, ...]] = {
    "video": ("mp4", "webm", "mov", "m4v", "mkv", "avi"),
    "audio": ("mp3", "wav", "m4a", "aac", "flac", "ogg", "oga"),
    "image": (
        "png",
        "jpg",
        "jpeg",
        "webp",
        "gif",
        "avif",
        "tif",
        "tiff",
        "bmp",
        "heic",
    ),
    "font": ("ttf", "otf", "woff", "woff2"),
    "document": ("pdf", "pptx", "key", "zip"),
    "source": ("psd", "kra", "xcf", "ai", "blend"),
}
"""File kinds that belong in LFS, by extension."""

KIND_OF: dict[str, str] = {ext: kind for kind, exts in PATTERNS.items() for ext in exts}

LARGE_BYTES = 5 * 1024 * 1024
"""Any other file at least this big is worth LFS too."""

ON_MARKER = "# inkflow: large media in Git LFS"
OFF_MARKER = "# inkflow: lfs off"


def available() -> bool:
    """Whether the ``git lfs`` command is installed."""
    if shutil.which("git") is None:
        return False
    try:
        result = subprocess.run(
            ["git", "lfs", "version"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def rule(pattern: str) -> str:
    return f"{pattern} filter=lfs diff=lfs merge=lfs -text"


_OFF_LINES = (
    f"{OFF_MARKER}: videos, images and other media are stored in git itself.",
    "# Remove the line above to be reminded about Git LFS again.",
)


def block(lfs: bool) -> str:
    """The deck's ``.gitattributes`` section: the LFS rules, or the opt-out."""
    if not lfs:
        return "\n".join(_OFF_LINES) + "\n"
    lines = [f"{ON_MARKER} (videos, audio, images, fonts, documents)"]
    for exts in PATTERNS.values():
        lines.extend(rule(f"*.{ext}") for ext in exts)
    return "\n".join(lines) + "\n"


def has_section(text: str) -> bool:
    return ON_MARKER in text or OFF_MARKER in text


def ensure_attributes(path: Path, lfs: bool) -> str:
    """Add the deck's LFS section to the ``.gitattributes`` file at ``path``
    unless it has one. Returns ``created``, ``updated`` or ``ok``."""
    if not path.exists():
        path.write_text(block(lfs), encoding="utf-8")
        return "created"
    text = path.read_text(encoding="utf-8")
    if has_section(text):
        return "ok"
    gap = "" if not text or text.endswith("\n") else "\n"
    path.write_text(f"{text}{gap}\n{block(lfs)}", encoding="utf-8")
    return "updated"


def add_rules(path: Path, patterns: list[str]) -> list[str]:
    """Track ``patterns`` with LFS in the ``.gitattributes`` at ``path`` (and
    drop an opt-out there); returns the patterns it added."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    kept = [line for line in text.splitlines() if line not in _OFF_LINES]
    present = {line.split()[0] for line in kept if "filter=lfs" in line}
    added = [p for p in patterns if p not in present]
    if added and not any(ON_MARKER in line for line in kept):
        kept.append(f"{ON_MARKER} (videos, audio, images, fonts, documents)")
    kept.extend(rule(p) for p in added)
    path.write_text("\n".join(kept).strip("\n") + "\n", encoding="utf-8")
    return added


def mode(root: Path, deck_dir: Path) -> str:
    """``off`` when the deck opted out, ``on`` when LFS rules apply to it,
    else ``none``. Reads the ``.gitattributes`` from the deck up to the root."""
    found = "none"
    folder = deck_dir.resolve()
    root = root.resolve()
    while True:
        attrs = folder / ".gitattributes"
        if attrs.is_file():
            text = attrs.read_text(encoding="utf-8", errors="replace")
            if OFF_MARKER in text:
                return "off"
            if "filter=lfs" in text:
                found = "on"
        if folder == root or folder == folder.parent:
            return found
        folder = folder.parent


def install(root: Path) -> bool:
    """``git lfs install --local`` in a repository; False when LFS is missing."""
    if not available():
        return False
    result = subprocess.run(
        ["git", "-C", str(root), "lfs", "install", "--local"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0
