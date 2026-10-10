from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

import pytest

from inkflow.themes import Theme


@pytest.fixture(autouse=True, scope="session")
def _font_cache(tmp_path_factory: pytest.TempPathFactory) -> None:
    """Font subsets cached for this run only, never in the user's cache."""
    os.environ["INKFLOW_CACHE_DIR"] = str(tmp_path_factory.mktemp("cache"))


class DirTheme(Theme):
    """A Theme whose assets live at an explicit directory.

    Production themes derive `asset_dir` from their defining module's file, which
    is awkward to point at a tmp_path in a test. This subclass takes the directory
    directly so tests can build a theme over fixture files.
    """

    def __init__(self, asset_dir: Path) -> None:
        super().__init__()
        self._asset_dir: Path = asset_dir

    def asset_dir(self) -> Path:  # pyright: ignore[reportImplicitOverride]
        return self._asset_dir


@pytest.fixture
def dir_theme() -> Callable[[Path], Theme]:
    """Return a factory that builds a `Theme` rooted at a given asset directory."""
    return DirTheme
