"""Compilation smoke test for the feature-test decks under tests/decks/.

Each deck is built via the static HTML export (pure Python, no browser). This
catches deck-loading / pipeline / manifest regressions automatically; visual
correctness (e.g. transition smoothness) stays a manual ``inkflow serve`` check.
"""

from pathlib import Path

import pytest

from inkflow.export import build_static_html

DECKS_DIR = Path(__file__).parent / "decks"
DECK_PATHS = sorted(DECKS_DIR.glob("*.py"))


@pytest.mark.parametrize(
    "deck_path", DECK_PATHS, ids=[path.stem for path in DECK_PATHS]
)
def test_deck_builds(deck_path: Path, tmp_path: Path) -> None:
    out_dir = tmp_path / deck_path.stem
    warnings = build_static_html(deck_path, out_dir)
    assert (out_dir / "index.html").exists()
    assert isinstance(warnings, list)
