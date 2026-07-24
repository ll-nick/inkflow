from __future__ import annotations

from importlib.resources import files
from pathlib import Path

from inkflow.layout import resolve_theme_dir

_DECK_PY = """\
from inkflow import Deck, Slide, animations


def main() -> Deck:
    return Deck(
        {deck_arg}title="My Talk",
        slides=[
            # 1. A pure SVG you drew. Point a Slide at it and you are done.
            Slide("title", notes="notes/title.md"),
            # 2. A built-in layout, its zone filled with Markdown (slides/guide.md).
            Slide("default", md="guide", notes="notes/guide.md"),
            # 3. Your own SVG: it inherits a themed background via inkflow:parent,
            #    carries its own zone (slides/diagram.md), and animates an element
            #    by id -- here the "Browser" box appears once you click. Open
            #    slides/diagram.svg in Inkscape to see how.
            Slide(
                "diagram",
                md="diagram",
                animations=[animations.FadeIn("box-browser")],
                notes="notes/diagram.md",
            ),
        ],
    )
"""

# Copied verbatim from src/inkflow/templates/ into the new project.
_SLIDE_TEMPLATES = ("title.svg", "diagram.svg", "guide.md", "diagram.md")
_NOTES_TEMPLATES = ("title.md", "guide.md", "diagram.md")


def scaffold(target: Path, theme_path: str | None) -> None:
    """Create starter files for a new presentation in target.

    Copies the packaged starter templates (kept lean, theme-agnostic) into
    ``slides/`` and ``notes/`` and writes a ``deck.py`` that wires them together.
    Layout parents and preview colors are injected live afterwards (see
    ``init_cmd``) so a custom ``--theme`` resolves correctly.

    Raises ValueError on invalid theme.
    """
    if theme_path is not None:
        theme_dir = resolve_theme_dir(theme_path, target)
        if not theme_dir.is_dir():
            raise ValueError(f"theme directory not found: {theme_dir}")

    templates = files("inkflow").joinpath("templates")
    target.mkdir(parents=True, exist_ok=True)
    slides_dir = target / "slides"
    slides_dir.mkdir(exist_ok=True)
    notes_dir = target / "notes"
    notes_dir.mkdir(exist_ok=True)

    for name in _SLIDE_TEMPLATES:
        content = templates.joinpath(name).read_text(encoding="utf-8")
        (slides_dir / name).write_text(content, encoding="utf-8")
    for name in _NOTES_TEMPLATES:
        content = templates.joinpath("notes", name).read_text(encoding="utf-8")
        (notes_dir / name).write_text(content, encoding="utf-8")

    deck_arg = f'theme="{theme_path}", ' if theme_path else ""
    (target / "deck.py").write_text(
        _DECK_PY.format(deck_arg=deck_arg), encoding="utf-8"
    )
