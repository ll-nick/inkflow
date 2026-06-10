from __future__ import annotations

import importlib.resources
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from inkflow.manifest import Deck


def load_styles(deck: Deck | None, project_dir: Path | None) -> str:
    """Return concatenated theme CSS in cascade order: builtin → theme → project."""
    from inkflow.layout import resolve_theme_dir

    pkg = importlib.resources.files("inkflow")
    parts = [pkg.joinpath("theme", "styles.css").read_text(encoding="utf-8")]

    if deck is not None and deck.theme is not None and project_dir is not None:
        try:
            theme_dir = resolve_theme_dir(deck.theme, project_dir)
            theme_css = theme_dir / "styles.css"
            if theme_css.exists():
                parts.append(theme_css.read_text(encoding="utf-8"))
        except ValueError:
            pass

    if project_dir is not None:
        project_css = project_dir / "styles.css"
        if project_css.exists():
            parts.append(project_css.read_text(encoding="utf-8"))

    return "\n".join(parts)


def load_scripts(deck: Deck, project_dir: Path) -> str:
    """Return concatenated JS in cascade order: theme → project."""
    from inkflow.layout import resolve_theme_dir

    parts: list[str] = []

    if deck.theme is not None:
        try:
            theme_dir = resolve_theme_dir(deck.theme, project_dir)
            theme_js = theme_dir / "scripts.js"
            if theme_js.exists():
                parts.append(theme_js.read_text(encoding="utf-8"))
        except ValueError:
            pass

    project_js = project_dir / "scripts.js"
    if project_js.exists():
        parts.append(project_js.read_text(encoding="utf-8"))

    return "\n".join(parts)
