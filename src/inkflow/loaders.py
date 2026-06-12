from __future__ import annotations

import importlib.resources
from pathlib import Path

from inkflow.layout import resolve_theme_dir
from inkflow.manifest import Deck


def _cascade(filename: str, deck: Deck | None, project_dir: Path | None) -> str:
    """Concatenate a named file from builtin → theme → project layers."""
    parts: list[str] = []

    builtin = importlib.resources.files("inkflow").joinpath("theme", filename)
    if builtin.is_file():
        parts.append(builtin.read_text(encoding="utf-8"))

    if deck is not None and deck.theme is not None and project_dir is not None:
        try:
            theme_dir = resolve_theme_dir(deck.theme, project_dir)
            f = theme_dir / filename
            if f.exists():
                parts.append(f.read_text(encoding="utf-8"))
        except ValueError:
            pass

    if project_dir is not None:
        f = project_dir / filename
        if f.exists():
            parts.append(f.read_text(encoding="utf-8"))

    return "\n".join(parts)


def load_styles(deck: Deck | None, project_dir: Path | None) -> str:
    """Return concatenated CSS in cascade order: builtin → theme → project."""
    return _cascade("styles.css", deck, project_dir)


def load_scripts(deck: Deck | None, project_dir: Path | None) -> str:
    """Return concatenated JS in cascade order: builtin → theme → project."""
    return _cascade("scripts.js", deck, project_dir)
