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

# An SVG carrying Inkscape editor metadata that `clean` strips.
_DIRTY_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
         inkscape:version="1.3.2" viewBox="0 0 1920 1080">
      <sodipodi:namedview id="namedview1" inkscape:zoom="1.0"/>
      <rect id="box" x="0" y="0" width="10" height="10"/>
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


# ── Chunk 2: unified missing-file errors (hard-raise, exit 1) ─────────────────


class TestMissingFile:
    @pytest.mark.usefixtures("project")
    def test_clean_missing_file(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["clean", "ghost.svg"])
        assert result.exit_code == 1
        assert "file not found" in result.output

    @pytest.mark.usefixtures("project")
    def test_colorize_missing_file(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["colorize", "ghost.svg"])
        assert result.exit_code == 1
        assert "file not found" in result.output

    @pytest.mark.usefixtures("project")
    def test_parent_get_missing_file(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["parent", "get", "ghost.svg"])
        assert result.exit_code == 1
        assert "file not found" in result.output

    @pytest.mark.usefixtures("project")
    def test_parent_set_missing_file(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["parent", "set", "ghost.svg", "builtin:base"])
        assert result.exit_code == 1
        assert "file not found" in result.output

    @pytest.mark.usefixtures("project")
    def test_sync_missing_file(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["sync", "ghost.svg"])
        assert result.exit_code == 1
        assert "file not found" in result.output

    @pytest.mark.usefixtures("project")
    def test_clean_validates_before_writing(self, runner: CliRunner) -> None:
        # A dirty file listed alongside a missing one must be left untouched
        # because validation happens up front.
        Path("dirty.svg").write_text(_DIRTY_SVG, encoding="utf-8")
        before = Path("dirty.svg").read_text(encoding="utf-8")
        result = runner.invoke(main, ["clean", "dirty.svg", "ghost.svg"])
        assert result.exit_code == 1
        assert Path("dirty.svg").read_text(encoding="utf-8") == before


# ── Chunk 3: FILES omitted falls back to all deck slides ─────────────────────


class TestDeckFallback:
    @pytest.mark.usefixtures("project")
    def test_clean_no_files_uses_deck(self, runner: CliRunner) -> None:
        Path("slides/01.svg").write_text(_DIRTY_SVG, encoding="utf-8")
        result = runner.invoke(main, ["clean"])
        assert result.exit_code == 0
        assert "cleaned" in result.output
        # The deck slide was rewritten clean (no inkscape metadata left).
        assert "inkscape:" not in Path("slides/01.svg").read_text(encoding="utf-8")

    @pytest.mark.usefixtures("project")
    def test_clean_check_no_files_clean_deck_exits_0(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["clean", "--check"])
        assert result.exit_code == 0

    @pytest.mark.usefixtures("project")
    def test_colorize_no_files_uses_deck(self, runner: CliRunner) -> None:
        # No hex to remap, so it reports the deck slide with no changes.
        result = runner.invoke(main, ["colorize"])
        assert result.exit_code == 0
        assert "01.svg" in result.output

    @pytest.mark.usefixtures("project")
    def test_colorize_no_deck_no_files_errors(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["colorize", "--no-deck"])
        assert result.exit_code == 2
        assert "FILES required" in result.output


# ── Chunk 4: add rework (optional -p/--parent, --no-deck) ────────────────────


class TestAdd:
    @pytest.mark.usefixtures("project")
    def test_parented_slide(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["add", "slides/new.svg", "-p", "builtin:base"])
        assert result.exit_code == 0
        assert 'Slide("slides/new.svg")' in result.output
        svg = Path("slides/new.svg").read_text(encoding="utf-8")
        assert 'inkflow:parent="builtin:base"' in svg

    @pytest.mark.usefixtures("project")
    def test_blank_slide_has_no_parent(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["add", "slides/blank.svg"])
        assert result.exit_code == 0
        svg = Path("slides/blank.svg").read_text(encoding="utf-8")
        assert "inkflow:parent" not in svg

    @pytest.mark.usefixtures("project")
    def test_existing_output_rejected(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["add", "slides/01.svg"])
        assert result.exit_code == 1
        assert "already exists" in result.output

    def test_no_deck_parented_without_deck_py(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            result = runner.invoke(
                main, ["add", "wired.svg", "-p", "builtin:base", "--no-deck"]
            )
            assert result.exit_code == 0
            svg = Path("wired.svg").read_text(encoding="utf-8")
            assert 'inkflow:parent="builtin:base"' in svg
