from __future__ import annotations

from pathlib import Path

from inkflow.layout import create_slide, resolve_theme_dir

_MD_CONTENT = (
    "# Slide Title\n\n"
    "- First bullet point\n"
    "- Second bullet point\n"
    "- Third bullet point\n"
    "\n"
    "::step::\n"
    "This paragraph appears on the first click.\n"
    "\n"
    "::step::\n"
    "And this one on the second.\n"
)

_DECK_PY = (
    "from inkflow import Deck, MarkdownSlide, Slide\n\n"
    "deck = Deck({deck_arg})\n\n"
    "deck.slides = [\n"
    '    Slide("slides/01-title.svg"),\n'
    '    MarkdownSlide("builtin:default", content="slides/02-content.md"),\n'
    "]\n"
)


def scaffold(target: Path, theme_path: str | None) -> None:
    """Create starter files for a new presentation in target.

    Raises ValueError on invalid theme or unresolvable layout parent.
    """
    if theme_path is not None:
        theme_dir = resolve_theme_dir(theme_path, target)
        if not theme_dir.is_dir():
            raise ValueError(f"theme directory not found: {theme_dir}")

    target.mkdir(parents=True, exist_ok=True)
    slides_dir = target / "slides"
    slides_dir.mkdir(exist_ok=True)

    title_svg = slides_dir / "01-title.svg"
    create_slide("builtin:cover", title_svg, target, theme_path)

    (slides_dir / "02-content.md").write_text(_MD_CONTENT, encoding="utf-8")

    deck_arg = f'theme="{theme_path}"' if theme_path else ""
    (target / "deck.py").write_text(
        _DECK_PY.format(deck_arg=deck_arg), encoding="utf-8"
    )
