from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import click

from inkflow.enums import ColorMode
from inkflow.layout import resolve_chain
from inkflow.manifest import Deck
from inkflow.pipeline import resolve_slide_src
from inkflow.server import load_deck


@click.group()
@click.version_option()
def main() -> None:
    """Beautiful slides from SVG. Your editor, your style."""


def resolve_deck_path(deck_path: Path) -> Path:
    resolved = deck_path.resolve()
    if not resolved.exists():
        raise click.ClickException(f"deck not found: {resolved}")
    return resolved


@dataclass(frozen=True)
class Target:
    """A file to operate on: its resolved path plus the label shown to the user."""

    path: Path
    label: str


def resolve_targets(files: Iterable[Path]) -> list[Target]:
    """Resolve each file, raising on the first that does not exist (exit 1)."""
    targets: list[Target] = []
    for file in files:
        resolved = file.resolve()
        if not resolved.exists():
            raise click.ClickException(f"file not found: {resolved}")
        targets.append(Target(resolved, str(file)))
    return targets


@dataclass(frozen=True)
class Project:
    """A loaded deck together with the directory paths resolve against."""

    deck: Deck
    dir: Path

    @classmethod
    def load(cls, deck_path: Path) -> Project:
        resolved = resolve_deck_path(deck_path)
        return cls(load_deck(resolved), resolved.parent)

    @property
    def theme(self) -> str | None:
        return self.deck.theme

    def slide_targets(self) -> list[Target]:
        """Every project-local SVG the deck resolves to, deduplicated.

        For each slide this collects its base SVG plus every ancestor in its layout
        chain, then keeps only files inside the project directory. Built-in and
        theme layouts, and anything referenced by a path outside the project,
        are left out of the default sweep — name them explicitly to touch them.
        """
        seen: dict[Path, Target] = {}
        for slide in self.deck.slides:
            base = resolve_slide_src(slide.src, self.dir, self.theme)
            try:
                chain = resolve_chain(base, self.dir, self.theme)
            except ValueError as exc:
                raise click.ClickException(str(exc)) from exc
            for path in (base, *chain):
                resolved = path.resolve()
                if resolved in seen or not resolved.is_relative_to(self.dir):
                    continue
                seen[resolved] = Target(resolved, str(resolved.relative_to(self.dir)))
        return list(seen.values())


def load_project_or_none(deck_path: Path, no_deck: bool) -> Project | None:
    return None if no_deck else Project.load(deck_path)


def targets_or_deck_slides(
    files: tuple[Path, ...], project: Project | None
) -> list[Target]:
    """Explicit FILES if given, else every project-local SVG the deck uses.

    The fallback covers each slide's base SVG plus its local layout ancestors
    (see ``Project.slide_targets``). Raises if FILES is omitted with no deck to
    fall back on (``--no-deck``).
    """
    if files:
        return resolve_targets(files)
    if project is None:
        raise click.UsageError("FILES required with --no-deck")
    return project.slide_targets()


def resolve_dark_mode(
    color_mode: str | None, deck_obj: Deck | None, no_deck: bool
) -> bool:
    if no_deck or deck_obj is None:
        return color_mode != "light"
    return (
        deck_obj.mode == ColorMode.DARK if color_mode is None else color_mode == "dark"
    )


deck_option = click.option(
    "-d",
    "--deck",
    "deck_path",
    default="deck.py",
    type=click.Path(path_type=Path),
    help="Path to deck.py (default: deck.py in cwd)",
)

no_deck_option = click.option(
    "--no-deck",
    "no_deck",
    is_flag=True,
    help=(
        "Operate without a deck.py (for theme authoring). "
        "Only builtin: and relative-path parents are allowed."
    ),
)

mode_option = click.option(
    "--mode",
    "color_mode",
    type=click.Choice(["dark", "light"]),
    default=None,
    help="Color mode for preview style (default: deck mode; dark with --no-deck).",
)
