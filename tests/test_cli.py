from __future__ import annotations

import textwrap
from collections.abc import Iterator
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main

_DECK_PY = textwrap.dedent("""\
    from inkflow import Deck, Slide

    def main():
        return Deck(slides=[Slide("slides/01.svg")])
""")

_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="my-rect" x="0" y="0" width="10" height="10"/>
    </svg>
""")


@pytest.fixture
def project() -> Iterator[Path]:
    """A minimal deck.py + one slide, inside an isolated cwd."""
    runner = CliRunner()
    with runner.isolated_filesystem() as tmp:
        root = Path(tmp)
        (root / "deck.py").write_text(_DECK_PY, encoding="utf-8")
        slides = root / "slides"
        slides.mkdir()
        (slides / "01.svg").write_text(_SLIDE_SVG, encoding="utf-8")
        yield root


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


# ── Chunk 1: deck is always -d/--deck ─────────────────────────────────────────


class TestDeckOption:
    @pytest.mark.parametrize("cmd", ["serve", "build", "export"])
    def test_missing_deck_exits_1(self, runner: CliRunner, cmd: str) -> None:
        result = runner.invoke(main, [cmd, "--deck", "nope.py"])
        assert result.exit_code == 1
        assert "deck not found" in result.output

    @pytest.mark.parametrize("cmd", ["serve", "build", "export"])
    def test_positional_deck_rejected(self, runner: CliRunner, cmd: str) -> None:
        result = runner.invoke(main, [cmd, "mydeck.py"])
        assert result.exit_code == 2

    def test_short_flag_missing_deck(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["build", "-d", "nope.py"])
        assert result.exit_code == 1
        assert "deck not found" in result.output

    @pytest.mark.usefixtures("project")
    def test_export_bad_size_exits_1(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["export", "--size", "huge"])
        assert result.exit_code == 1
        assert "--size must be WxH" in result.output
