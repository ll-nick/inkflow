from __future__ import annotations

import importlib.resources
from pathlib import Path

from inkflow.layout import resolve_theme_dir
from inkflow.manifest import Content, Deck, Inline
from inkflow.markdown import markdown_to_html


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


def load_deck_styles(deck: Deck | None, project_dir: Path | None) -> str:
    """Return concatenated CSS in cascade order: builtin → theme → project."""
    return _cascade("styles.css", deck, project_dir)


def load_deck_scripts(deck: Deck | None, project_dir: Path | None) -> str:
    """Return concatenated JS in cascade order: builtin → theme → project."""
    return _cascade("scripts.js", deck, project_dir)


# ── Content field loaders ─────────────────────────────────────────────────────


def resolve_content_src(src: str, project_dir: Path) -> Path:
    """Resolve a slide Markdown content path to an absolute Path.

    Bare single-part names are looked up in slides/ with a .md suffix.
    """
    p = Path(src)
    if p.is_absolute():
        return p if p.suffix else p.with_suffix(".md")
    if len(p.parts) == 1:
        name = p.stem if p.suffix else src
        return project_dir / "slides" / (name + ".md")
    if not p.suffix:
        p = p.with_suffix(".md")
    return (project_dir / p).resolve()


def load_md(md: Content, project_dir: Path) -> str | None:
    """Resolve a Content md field to a raw markdown string."""
    if md is None:
        return None
    if isinstance(md, Inline):
        return str(md)
    return resolve_content_src(str(md), project_dir).read_text(encoding="utf-8")


def load_notes(notes: Content, project_dir: Path) -> str:
    """Resolve a Content notes field to rendered HTML. Notes are always Markdown."""
    if not notes:
        return ""
    if isinstance(notes, Inline):
        return markdown_to_html(str(notes))
    resolved = Path(str(notes))
    if not resolved.is_absolute():
        resolved = project_dir / resolved
    return markdown_to_html(resolved.read_text(encoding="utf-8"))


def load_style(style: Content, project_dir: Path) -> str:
    """Resolve a Content style field to a raw CSS string."""
    if not style:
        return ""
    if isinstance(style, Inline):
        return str(style)
    resolved = Path(str(style))
    if not resolved.is_absolute():
        resolved = project_dir / resolved
    return resolved.read_text(encoding="utf-8")
