from __future__ import annotations

from pathlib import Path

from inkflow.loaders import load_deck_styles, load_notes
from inkflow.manifest import Deck, Inline


class TestLoadNotes:
    def test_none_returns_empty(self, tmp_path: Path) -> None:
        assert load_notes(None, tmp_path) == ""

    def test_inline_rendered_as_markdown(self, tmp_path: Path) -> None:
        result = load_notes(Inline("First paragraph.\n\nSecond paragraph."), tmp_path)
        assert "<p>First paragraph.</p>" in result
        assert "<p>Second paragraph.</p>" in result

    def test_inline_markdown_formatting_applied(self, tmp_path: Path) -> None:
        result = load_notes(Inline("Remember **this**."), tmp_path)
        assert "<strong>this</strong>" in result

    def test_file_path_rendered_as_markdown(self, tmp_path: Path) -> None:
        (tmp_path / "notes.md").write_text("Remember **this**.\n", encoding="utf-8")
        result = load_notes("notes.md", tmp_path)
        assert "<strong>this</strong>" in result

    def test_any_file_rendered_as_markdown(self, tmp_path: Path) -> None:
        (tmp_path / "notes.html").write_text("# Heading\n", encoding="utf-8")
        result = load_notes("notes.html", tmp_path)
        assert "Heading" in result

    def test_relative_path_resolved_from_project_dir(self, tmp_path: Path) -> None:
        sub = tmp_path / "notes"
        sub.mkdir()
        (sub / "slide1.md").write_text("A note.\n", encoding="utf-8")
        result = load_notes("notes/slide1.md", tmp_path)
        assert "A note." in result

    def test_absolute_path_used_directly(self, tmp_path: Path) -> None:
        f = tmp_path / "abs.md"
        f.write_text("Absolute.\n", encoding="utf-8")
        result = load_notes(str(f), tmp_path / "other")
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

    def test_appends_theme_css(self, tmp_path: Path) -> None:
        theme_dir = tmp_path / "my-theme"
        theme_dir.mkdir()
        (theme_dir / "styles.css").write_text("/* theme */", encoding="utf-8")
        result = load_deck_styles(Deck(theme="./my-theme"), tmp_path)
        assert "/* theme */" in result

    def test_theme_without_css_no_crash(self, tmp_path: Path) -> None:
        (tmp_path / "my-theme").mkdir()
        result = load_deck_styles(Deck(theme="./my-theme"), tmp_path)
        assert result  # base CSS still returned

    def test_named_theme_silently_ignored(self, tmp_path: Path) -> None:
        # named themes raise ValueError in resolve_theme_dir — must be swallowed
        result = load_deck_styles(Deck(theme="nonexistent-named-theme"), tmp_path)
        assert result  # base CSS still returned, no crash

    def test_ordering(self, tmp_path: Path) -> None:
        (tmp_path / "theme").mkdir()
        (tmp_path / "theme" / "styles.css").write_text("/* theme */", encoding="utf-8")
        (tmp_path / "styles.css").write_text("/* project */", encoding="utf-8")
        result = load_deck_styles(Deck(theme="./theme"), tmp_path)
        theme_pos = result.index("/* theme */")
        project_pos = result.index("/* project */")
        assert theme_pos < project_pos
