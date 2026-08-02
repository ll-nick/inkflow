"""Reusable layout-sync logic shared by the ``sync`` command and ``init``.

Injecting ancestor layout layers plus a theme-colored preview ``<style>`` into a
slide SVG makes editors (Inkscape) render the composited background and semantic
``inkflow-fill-*`` classes with the right colors. The serve/build pipeline never
needs these — it resolves parent chains in memory — so this is purely an authoring
aid written to the file on disk.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import TYPE_CHECKING

from inkflow import colors, loaders
from inkflow.layout import inject_layout_layers, resolve_chain
from inkflow.manifest import Deck

if TYPE_CHECKING:
    from inkflow.themes import Theme


def build_preview_css(
    deck_obj: Deck | None, project_dir: Path | None, dark_mode: bool
) -> str:
    """Build the theme preview ``<style>`` block from a deck's resolved styles."""
    css = loaders.load_deck_styles(deck_obj, project_dir)
    tokens = colors.extract_tokens(css, dark_mode)
    return colors.build_preview_style(tokens)


def sync_slides(
    paths: Iterable[Path],
    *,
    project_dir: Path | None,
    theme: Theme | None,
    deck_obj: Deck | None,
    dark_mode: bool,
) -> None:
    """Inject ancestor layout layers + theme preview styles into each SVG.

    Parentless files still receive the preview style block (empty chain). Raises
    ``ValueError`` if any file's parent chain cannot be resolved.
    """
    preview_css = build_preview_css(deck_obj, project_dir, dark_mode)
    for path in paths:
        chain = resolve_chain(path, project_dir, theme)
        inject_layout_layers(path, chain, preview_css)
