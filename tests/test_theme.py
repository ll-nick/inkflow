from __future__ import annotations

from collections.abc import Callable
from dataclasses import fields, replace
from pathlib import Path

import pytest

from inkflow import ColorMode, Palette, Theme, Typography
from inkflow.themes import (
    Builtin,
    _css_var,  # pyright: ignore[reportPrivateUsage]
)
from inkflow.transitions import Cut


class TestTokenDataclasses:
    def test_palette_default_is_full_neutral_floor(self) -> None:
        p = Palette()
        # Every field carries a concrete value (the dark floor); none are None.
        assert all(getattr(p, f.name) is not None for f in fields(p))
        assert p.bg == "#1a1a1a"
        assert p.accent == "#7aa2f7"

    def test_typography_defaults(self) -> None:
        t = Typography()
        assert t.body_font == "sans-serif"
        assert t.mono_font == "monospace"
        assert t.line_height == 1.4
        assert t.heading_weight == 600


class TestRenderTokensCss:
    def test_emits_both_root_blocks_with_all_tokens(self) -> None:
        css = Theme().render_tokens_css()
        assert css.startswith(":root {")
        assert ':root[data-theme="light"]' in css
        assert "--inkflow-bg:" in css
        assert "--inkflow-body-font: sans-serif;" in css
        assert "None" not in css  # no sentinel leaks into the CSS

    def test_partial_dark_override_keeps_floor(self) -> None:
        class T(Theme):
            dark: Palette = replace(Theme.dark, accent="#abcdef")

        css = T().render_tokens_css()
        assert "--inkflow-accent: #abcdef;" in css  # the override
        assert "--inkflow-bg: #1a1a1a;" in css  # floor kept for unnamed tokens

    def test_partial_light_override_uses_light_floor(self) -> None:
        class T(Theme):
            light: Palette = replace(Theme.light, accent="#abcdef")

        css = T().render_tokens_css()
        light_block = css.split(':root[data-theme="light"]')[1]
        assert "--inkflow-accent: #abcdef;" in light_block  # the override
        assert "--inkflow-bg: #ffffff;" in light_block  # *light* floor, not dark

    def test_builtin_emits_full_catppuccin(self) -> None:
        css = Builtin().render_tokens_css()
        assert "--inkflow-accent: #cba6f7;" in css  # Mocha (dark)
        assert "--inkflow-accent: #8839ef;" in css  # Latte (light)


class TestName:
    def test_defaults_to_class_name(self) -> None:
        class Nord(Theme):
            pass

        assert Nord().name == "Nord"

    def test_explicit_override_wins(self) -> None:
        class Nord(Theme):
            name: str = "Nord Theme"

        assert Nord().name == "Nord Theme"

    def test_builtin_name(self) -> None:
        assert Builtin().name == "inkflow"


class TestMetadataDefaults:
    def test_transition_defaults_to_cut(self) -> None:
        assert isinstance(Theme().transition, Cut)

    def test_mode_and_font_size(self) -> None:
        assert Theme().mode == ColorMode.DARK
        assert Theme().font_size == 36


class TestAssetLocation:
    def test_builtin_asset_dir(self) -> None:
        d = Builtin().asset_dir()
        assert d.name == "theme"
        assert (d / "layouts").is_dir()

    def test_layouts_and_fonts_dirs(self) -> None:
        b = Builtin()
        assert b.layouts_dir == b.asset_dir() / "layouts"
        assert b.fonts_dir == b.asset_dir() / "fonts"

    def test_styles_css_reads_file(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        (tmp_path / "styles.css").write_text("/* theme css */", encoding="utf-8")
        assert "/* theme css */" in dir_theme(tmp_path).styles_css()

    def test_styles_css_absent_returns_empty(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        assert dir_theme(tmp_path).styles_css() == ""

    def test_asset_dir_raises_without_module_file(self) -> None:
        class T(Theme):
            pass

        T.__module__ = "sys"  # a built-in module has no __file__ on disk
        with pytest.raises(ValueError, match="unpacked"):
            T().asset_dir()


class TestCssVar:
    def test_transliterates_field_to_property(self) -> None:
        assert _css_var("body_font") == "--inkflow-body-font"
        assert _css_var("text_muted") == "--inkflow-text-muted"
        assert _css_var("accent") == "--inkflow-accent"
