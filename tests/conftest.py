from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from inkflow.themes import Theme


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
