from __future__ import annotations

from pathlib import Path

from inkflow.manifest import Deck


def humanize(name: str) -> str:
    """Turn a kebab/snake-case slug into a Title Case phrase."""
    return name.replace("-", " ").replace("_", " ").title()


def resolve_deck_title(deck: Deck, project_dir: Path) -> str:
    """The deck's explicit title, or one inferred from the project directory name."""
    if deck.title:
        return deck.title
    return humanize(project_dir.name) or "Inkflow"
