from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from inkflow.loaders import load_deck_styles, load_notes
from inkflow.manifest import Deck, Inline
from inkflow.themes import Theme


class TestLoadNotes:
    def test_none_returns_empty(self, tmp_path: Path) -> None:
        assert load_notes(None, tmp_path).text == ""

    def test_inline_rendered_as_markdown(self, tmp_path: Path) -> None:
        result = load_notes(
            Inline("First paragraph.\n\nSecond paragraph."), tmp_path
        ).text
        assert "<p>First paragraph.</p>" in result
        assert "<p>Second paragraph.</p>" in result

    def test_inline_markdown_formatting_applied(self, tmp_path: Path) -> None:
        result = load_notes(Inline("Remember **this**."), tmp_path).text
        assert "<strong>this</strong>" in result

    def test_file_path_rendered_as_markdown(self, tmp_path: Path) -> None:
        (tmp_path / "notes.md").write_text("Remember **this**.\n", encoding="utf-8")
        result = load_notes("notes.md", tmp_path).text
        assert "<strong>this</strong>" in result

    def test_any_file_rendered_as_markdown(self, tmp_path: Path) -> None:
        (tmp_path / "notes.html").write_text("# Heading\n", encoding="utf-8")
        result = load_notes("notes.html", tmp_path).text
        assert "Heading" in result

    def test_relative_path_resolved_from_project_dir(self, tmp_path: Path) -> None:
        sub = tmp_path / "notes"
        sub.mkdir()
        (sub / "slide1.md").write_text("A note.\n", encoding="utf-8")
        result = load_notes("notes/slide1.md", tmp_path).text
        assert "A note." in result

    def test_absolute_path_used_directly(self, tmp_path: Path) -> None:
        f = tmp_path / "abs.md"
        f.write_text("Absolute.\n", encoding="utf-8")
        result = load_notes(str(f), tmp_path / "other").text
        assert "Absolute." in result


class TestLoadDeckStyles:
    def test_base_css_always_present(self, tmp_path: Path) -> None:
        result = load_deck_styles(Deck(), tmp_path)
        assert result  # non-empty — base package CSS is always included

    def test_no_theme_no_project(self, tmp_path: Path) -> None:
        result = load_deck_styles(Deck(), tmp_path)
        assert "/* project */" not in result
        assert "/* theme */" not in result

    def test_appends_project_css(self, tmp_path: Path) -> None:
        (tmp_path / "styles.css").write_text("/* project */", encoding="utf-8")
        result = load_deck_styles(Deck(), tmp_path)
        assert "/* project */" in result

    def test_appends_theme_css(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        theme_dir = tmp_path / "my-theme"
        theme_dir.mkdir()
        (theme_dir / "styles.css").write_text("/* theme */", encoding="utf-8")
        result = load_deck_styles(Deck(theme=dir_theme(theme_dir)), tmp_path)
        assert "/* theme */" in result

    def test_theme_without_css_no_crash(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        theme_dir = tmp_path / "my-theme"
        theme_dir.mkdir()
        result = load_deck_styles(Deck(theme=dir_theme(theme_dir)), tmp_path)
        assert result  # contract CSS still returned

    def test_ordering(self, tmp_path: Path, dir_theme: Callable[[Path], Theme]) -> None:
        theme_dir = tmp_path / "my-theme"
        theme_dir.mkdir()
        (theme_dir / "styles.css").write_text("/* theme */", encoding="utf-8")
        (tmp_path / "styles.css").write_text("/* project */", encoding="utf-8")
        result = load_deck_styles(Deck(theme=dir_theme(theme_dir)), tmp_path)
        assert result.index("/* theme */") < result.index("/* project */")


class TestBuiltinLayoutStyles:
    """The built-in layouts are every theme's fallback, so their styling loads too."""

    def test_loaded_under_a_custom_theme(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        theme_dir = tmp_path / "my-theme"
        theme_dir.mkdir()
        result = load_deck_styles(Deck(theme=dir_theme(theme_dir)), tmp_path)
        assert ".layout-center #zone-content" in result

    def test_custom_theme_css_wins_over_builtin(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        theme_dir = tmp_path / "my-theme"
        theme_dir.mkdir()
        (theme_dir / "styles.css").write_text("/* theme */", encoding="utf-8")
        result = load_deck_styles(Deck(theme=dir_theme(theme_dir)), tmp_path)
        assert result.index(".layout-center #zone-content") < result.index(
            "/* theme */"
        )

    def test_not_duplicated_when_builtin_is_active(self, tmp_path: Path) -> None:
        result = load_deck_styles(Deck(), tmp_path)
        assert result.count(".layout-center #zone-content") == 1
