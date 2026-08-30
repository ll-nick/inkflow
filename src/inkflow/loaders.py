from __future__ import annotations

import importlib.resources
from dataclasses import dataclass
from pathlib import Path

from inkflow.manifest import Content, Deck, Inline
from inkflow.markdown import markdown_to_html
from inkflow.themes import Builtin, Theme


@dataclass(frozen=True)
class LoadedText:
    """Text plus the file it was written in, or ``None`` when it came from a
    literal ``Inline(...)`` in ``deck.py``.

    The path is what lets a relative asset reference inside the text resolve
    against its own file, so it must not be dropped on the way back.
    """

    text: str
    path: Path | None


def _contract_css() -> str:
    """inkflow's always-loaded runtime stylesheet (structural rules + neutral token
    floor + markdown element rules). Not a theme; loads before any theme layer."""
    return (
        importlib.resources.files("inkflow")
        .joinpath("contract.css")
        .read_text(encoding="utf-8")
    )


def _deck_theme(deck: Deck | None) -> Theme:
    return deck.theme if deck is not None else Builtin()


def _project_file(filename: str, project_dir: Path | None) -> str:
    if project_dir is not None:
        f = project_dir / filename
        if f.is_file():
            return f.read_text(encoding="utf-8")
    return ""


def load_deck_styles(deck: Deck | None, project_dir: Path | None) -> str:
    """Return concatenated CSS: contract → tokens → built-in → theme → project."""
    theme = _deck_theme(deck)
    builtin = Builtin()
    # The built-in layouts are the fallback set for every theme, so their styling
    # loads regardless of which theme is active. It reads the active theme's tokens,
    # and the theme's own styles come after it and win. Skipped when the active theme
    # *is* the built-in, which would otherwise emit the same file twice.
    active_styles = (
        "" if theme.styles_path == builtin.styles_path else theme.styles_css()
    )
    parts = [
        _contract_css(),
        theme.render_tokens_css(),
        builtin.styles_css(),
        active_styles,
        _project_file("styles.css", project_dir),
    ]
    return "\n".join(p for p in parts if p)


def load_deck_scripts(deck: Deck | None, project_dir: Path | None) -> str:
    """Return concatenated JS: theme scripts → project."""
    theme = _deck_theme(deck)
    parts = [theme.scripts_js(), _project_file("scripts.js", project_dir)]
    return "\n".join(p for p in parts if p)


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


def load_md(md: Content, project_dir: Path) -> LoadedText | None:
    """Resolve a Content md field to raw markdown and the file it was written in."""
    if md is None:
        return None
    if isinstance(md, Inline):
        return LoadedText(str(md), None)
    path = resolve_content_src(str(md), project_dir)
    return LoadedText(path.read_text(encoding="utf-8"), path)


def load_notes(notes: Content, project_dir: Path) -> LoadedText:
    """Resolve a Content notes field to rendered HTML and the file it came from.

    Notes are always Markdown.
    """
    if not notes:
        return LoadedText("", None)
    if isinstance(notes, Inline):
        return LoadedText(markdown_to_html(str(notes)), None)
    resolved = Path(str(notes))
    if not resolved.is_absolute():
        resolved = project_dir / resolved
    return LoadedText(markdown_to_html(resolved.read_text(encoding="utf-8")), resolved)


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
