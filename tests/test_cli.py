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


class TestDeckFallback:
    @pytest.mark.usefixtures("project")
    def test_clean_no_files_uses_deck(self, runner: CliRunner) -> None:
        Path("slides/01.svg").write_text(_DIRTY_SVG, encoding="utf-8")
        result = runner.invoke(main, ["clean"])
        assert result.exit_code == 0
        assert "Cleaned" in result.output
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

    def test_sweep_includes_local_layout_once(self, runner: CliRunner) -> None:
        # An md slide has no content SVG of its own; its base is a local layout.
        # The sweep must reach that layout (once, even when referenced by several
        # slides) but leave its built-in ancestor alone.
        deck_py = textwrap.dedent("""\
            from inkflow import Deck, Slide
            def main():
                return Deck(slides=[
                    Slide("card", md="a.md"),
                    Slide("card", md="b.md"),
                ])
        """)
        with runner.isolated_filesystem():
            Path("deck.py").write_text(deck_py, encoding="utf-8")
            Path("slides").mkdir()
            for name in ("a.md", "b.md"):
                (Path("slides") / name).write_text("# hi", encoding="utf-8")
            layouts = Path("layouts")
            layouts.mkdir()
            (layouts / "card.svg").write_text(_PARENTED_SVG, encoding="utf-8")

            result = runner.invoke(main, ["clean"])
            assert result.exit_code == 0
            # The reused local layout appears exactly once in the sweep.
            assert result.output.count("layouts/card.svg") == 1
            # The built-in ancestor (builtin:base) is never touched.
            assert "base.svg" not in result.output


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


class TestParentGet:
    @pytest.mark.usefixtures("project")
    def test_single_file_bare_value(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["parent", "get", "slides/01.svg"])
        assert result.exit_code == 0
        assert result.output.strip() == "(no parent)"

    @pytest.mark.usefixtures("project")
    def test_multiple_files_prefixed(self, runner: CliRunner) -> None:
        Path("slides/02.svg").write_text(_SLIDE_SVG, encoding="utf-8")
        result = runner.invoke(
            main, ["parent", "get", "slides/01.svg", "slides/02.svg"]
        )
        assert result.exit_code == 0
        assert "slides/01.svg: (no parent)" in result.output
        assert "slides/02.svg: (no parent)" in result.output

    @pytest.mark.usefixtures("project")
    def test_no_files_lists_deck_slides(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["parent", "get"])
        assert result.exit_code == 0
        # The deck's single slide is listed in the aligned overview.
        assert "slides/01.svg" in result.output
        assert "(no parent)" in result.output

    def test_list_command_removed(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["parent", "list"])
        assert result.exit_code == 2


_PARENTED_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkflow="urn:inkflow"
         inkflow:parent="builtin:base"
         viewBox="0 0 1920 1080" width="1920" height="1080">
    </svg>
""")

_MISSING_SRC_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide
    def main():
        return Deck(slides=[Slide('slides/missing.svg')])
""")

_AUTOPLAY_CONFLICT_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide, Video, animations
    def main():
        return Deck(slides=[Slide('slides/01.svg',
            zones={'media': Video('clip.mp4', autoplay=True)},
            animations=[animations.PlayVideo('media')])])
""")

_MEDIA_ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-media" x="0" y="0" width="100" height="100"/>
    </svg>
""")


class TestCleanModes:
    @pytest.mark.usefixtures("project")
    def test_check_dirty_exits_1_untouched(self, runner: CliRunner) -> None:
        Path("dirty.svg").write_text(_DIRTY_SVG, encoding="utf-8")
        result = runner.invoke(main, ["clean", "--check", "dirty.svg"])
        assert result.exit_code == 1
        assert Path("dirty.svg").read_text(encoding="utf-8") == _DIRTY_SVG

    @pytest.mark.usefixtures("project")
    def test_check_clean_exits_0(self, runner: CliRunner) -> None:
        Path("clean.svg").write_text(_SLIDE_SVG, encoding="utf-8")
        result = runner.invoke(main, ["clean", "--check", "clean.svg"])
        assert result.exit_code == 0

    @pytest.mark.usefixtures("project")
    def test_check_and_stdout_mutually_exclusive(self, runner: CliRunner) -> None:
        Path("x.svg").write_text(_DIRTY_SVG, encoding="utf-8")
        result = runner.invoke(main, ["clean", "--check", "--stdout", "x.svg"])
        assert result.exit_code == 2

    @pytest.mark.usefixtures("project")
    def test_stdout_leaves_file_untouched(self, runner: CliRunner) -> None:
        Path("dirty.svg").write_text(_DIRTY_SVG, encoding="utf-8")
        result = runner.invoke(main, ["clean", "--stdout", "dirty.svg"])
        assert result.exit_code == 0
        assert "inkscape:" not in result.output
        assert Path("dirty.svg").read_text(encoding="utf-8") == _DIRTY_SVG


class TestSyncCheck:
    def test_check_stale_then_write(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            Path("s.svg").write_text(_PARENTED_SVG, encoding="utf-8")
            stale = runner.invoke(main, ["sync", "--check", "--no-deck", "s.svg"])
            assert stale.exit_code == 1
            written = runner.invoke(main, ["sync", "--no-deck", "s.svg"])
            assert written.exit_code == 0
            fresh = runner.invoke(main, ["sync", "--check", "--no-deck", "s.svg"])
            assert fresh.exit_code == 0


class TestVerify:
    def test_missing_src_exits_1(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            Path("deck.py").write_text(_MISSING_SRC_DECK, encoding="utf-8")
            result = runner.invoke(main, ["verify"])
            assert result.exit_code == 1

    @pytest.mark.usefixtures("project")
    def test_warning_fails_only_with_strict(self, runner: CliRunner) -> None:
        # An autoplaying video also targeted by a PlayVideo cue is a warning
        # (the cue wins). Warnings pass by default and fail under --strict.
        Path("slides/01.svg").write_text(_MEDIA_ZONE_SVG, encoding="utf-8")
        Path("clip.mp4").write_bytes(b"")
        Path("deck.py").write_text(_AUTOPLAY_CONFLICT_DECK, encoding="utf-8")
        lenient = runner.invoke(main, ["verify"])
        assert lenient.exit_code == 0
        strict = runner.invoke(main, ["verify", "--strict"])
        assert strict.exit_code == 1


class TestParentMutation:
    def test_set_writes_parent(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            Path("s.svg").write_text(_SLIDE_SVG, encoding="utf-8")
            result = runner.invoke(
                main, ["parent", "set", "s.svg", "builtin:base", "--no-deck"]
            )
            assert result.exit_code == 0
            assert 'inkflow:parent="builtin:base"' in Path("s.svg").read_text(
                encoding="utf-8"
            )

    def test_strip_removes_parent(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            Path("s.svg").write_text(_PARENTED_SVG, encoding="utf-8")
            result = runner.invoke(main, ["parent", "strip", "-y", "s.svg"])
            assert result.exit_code == 0
            assert "inkflow:parent" not in Path("s.svg").read_text(encoding="utf-8")


class TestPalette:
    def test_no_deck_writes_gpl_to_stdout(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["palette", "--no-deck"])
        assert result.exit_code == 0
        assert result.output.startswith("GIMP Palette")

    @pytest.mark.parametrize("flag", ["--install", "--output"])
    def test_removed_flags_rejected(self, runner: CliRunner, flag: str) -> None:
        result = runner.invoke(main, ["palette", "--no-deck", flag])
        assert result.exit_code == 2


class TestLayouts:
    def test_no_deck_lists_builtin(self, runner: CliRunner) -> None:
        result = runner.invoke(main, ["layouts", "--no-deck"])
        assert result.exit_code == 0
        assert "base" in result.output


class TestInitGit:
    """Git bootstrap on `inkflow init`. Asserts only on git artifacts + deck.py,
    never on scaffold file names, so it stays decoupled from the scaffold layout."""

    def test_fresh_project_inits_repo(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            result = runner.invoke(main, ["init", "my-talk"])
            assert result.exit_code == 0, result.output
            root = Path("my-talk")
            assert (root / "deck.py").exists()
            assert (root / ".git").is_dir()
            gitignore = (root / ".gitignore").read_text(encoding="utf-8")
            assert ".venv/" in gitignore
            assert "*.pdf" in gitignore
            assert (root / ".githooks" / "pre-commit").exists()

    def test_no_git_skips_bootstrap(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            result = runner.invoke(main, ["init", "my-talk", "--no-git"])
            assert result.exit_code == 0, result.output
            root = Path("my-talk")
            assert (root / "deck.py").exists()
            assert not (root / ".git").exists()
            assert not (root / ".gitignore").exists()

    def test_existing_repo_left_untouched(self, runner: CliRunner) -> None:
        import subprocess

        with runner.isolated_filesystem() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            result = runner.invoke(main, ["init", "."])
            assert result.exit_code == 0, result.output
            assert Path("deck.py").exists()
            # Inside an existing repo, init must not drop a .gitignore or take over
            # the repo's hook config.
            assert not Path(".gitignore").exists()
            assert "setup-git" in result.output


class TestInitScaffold:
    def test_creates_starter_files(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            result = runner.invoke(main, ["init", "my-talk", "--no-git"])
            assert result.exit_code == 0, result.output
            root = Path("my-talk")
            for rel in (
                "deck.py",
                "slides/title.svg",
                "slides/diagram.svg",
                "slides/guide.md",
                "slides/diagram.md",
                "notes/title.md",
                "notes/guide.md",
                "notes/diagram.md",
            ):
                assert (root / rel).exists(), rel

    def test_sync_injects_layout_live(self, runner: CliRunner) -> None:
        """The parented diagram SVG gets its base layer + preview style injected
        into the project copy, while the packaged template stays lean."""
        with runner.isolated_filesystem():
            result = runner.invoke(main, ["init", "my-talk", "--no-git"])
            assert result.exit_code == 0, result.output
            diagram = Path("my-talk/slides/diagram.svg").read_text(encoding="utf-8")
            assert "inkflow:layout-src" in diagram
            assert "inkflow-preview" in diagram

    def test_scaffolded_deck_builds(self, runner: CliRunner, tmp_path: Path) -> None:
        from inkflow.export import build_static_html

        with runner.isolated_filesystem():
            result = runner.invoke(main, ["init", "my-talk", "--no-git"])
            assert result.exit_code == 0, result.output
            out = tmp_path / "build"
            build_static_html(Path("my-talk/deck.py").resolve(), out)
            assert (out / "index.html").exists()


class TestInitEmptyDirGuard:
    def test_refuses_non_empty_directory(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            Path("keep.txt").write_text("mine", encoding="utf-8")
            result = runner.invoke(main, ["init", ".", "--no-git"])
            assert result.exit_code != 0
            assert "not empty" in result.output
            assert not Path("deck.py").exists()

    def test_force_scaffolds_into_non_empty_directory(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            Path("keep.txt").write_text("mine", encoding="utf-8")
            result = runner.invoke(main, ["init", ".", "--no-git", "--force"])
            assert result.exit_code == 0, result.output
            assert Path("deck.py").exists()
            assert Path("keep.txt").exists()

    def test_dotfiles_do_not_count_as_non_empty(self, runner: CliRunner) -> None:
        with runner.isolated_filesystem():
            Path(".hidden").write_text("x", encoding="utf-8")
            result = runner.invoke(main, ["init", ".", "--no-git"])
            assert result.exit_code == 0, result.output
            assert Path("deck.py").exists()
