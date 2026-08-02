"""Themes for the deck DSL.

A theme is a Python class. Authors subclass `Theme`, set a typed `Palette` per mode
plus optional `Typography`, and drop layout SVGs and an optional `styles.css` next to
their module:

    from inkflow_themes import Nord
    Deck(theme=Nord())

`asset_dir` is derived from the subclass's module file, so a theme must be an
installed (unpacked) package; a zip-imported theme raises rather than failing
obscurely.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, fields
from pathlib import Path
from typing import ClassVar, cast

from inkflow.enums import ColorMode
from inkflow.transitions import Cut, Transition

__all__ = ["Builtin", "Palette", "Theme", "Typography"]


@dataclass(frozen=True)
class Palette:
    """A theme's color tokens for one color mode.

    Field defaults are the neutral dark floor, so ``Palette()`` is a complete,
    usable palette and a subclass overrides only the tokens it names. For light, a
    theme overrides off `Theme.light` (see `Theme`). Semantic tokens first, then the
    named accent palette (consumed by syntax highlighting and the ``inkflow-fill-*``
    / ``inkflow-stroke-*`` utilities).
    """

    # semantic tokens
    bg: str = "#1a1a1a"
    surface: str = "#2a2a2a"
    border: str = "#444444"
    text: str = "#e6e6e6"
    text_muted: str = "#a0a0a0"
    accent: str = "#7aa2f7"
    accent_fg: str = "#1a1a1a"
    code_bg: str = "#111111"
    code_text: str = "#e6e6e6"
    link: str = "#7aa2f7"
    heading: str = "#e6e6e6"
    blockquote: str = "#444444"
    # named palette
    red: str = "#e06c75"
    orange: str = "#d19a66"
    yellow: str = "#e5c07b"
    green: str = "#98c379"
    teal: str = "#56b6c2"
    blue: str = "#61afef"
    purple: str = "#c678dd"
    pink: str = "#d787af"
    grey: str = "#7f848e"


@dataclass(frozen=True)
class Typography:
    """A theme's typography tokens. Heading sizes are fixed in the contract."""

    body_font: str = "sans-serif"
    heading_font: str = "sans-serif"
    mono_font: str = "monospace"
    line_height: float = 1.4
    heading_weight: int = 600
    heading_line_height: float = 1.2


# Neutral light floor. Palette's own defaults are the dark floor, so the light floor
# is spelled out here; themes override light off `Theme.light` via `replace`.
_LIGHT_FLOOR = Palette(
    bg="#ffffff",
    surface="#f0f0f0",
    border="#cccccc",
    text="#1a1a1a",
    text_muted="#666666",
    accent="#3355cc",
    accent_fg="#ffffff",
    code_bg="#f5f5f5",
    code_text="#1a1a1a",
    link="#3355cc",
    heading="#1a1a1a",
    blockquote="#cccccc",
    red="#d0322b",
    orange="#b5690a",
    yellow="#a07a12",
    green="#468c2b",
    teal="#2a8a90",
    blue="#2f6fe0",
    purple="#8a3fd0",
    pink="#c04d8a",
    grey="#8a8f98",
)


def _css_var(name: str) -> str:
    """``body_font`` → ``--inkflow-body-font``, shared by every token group."""
    return "--inkflow-" + name.replace("_", "-")


class Theme:
    """Base class for a deck theme. Subclass it and set class attributes.

    ```python
    from dataclasses import replace

    class Nord(Theme):
        mode = ColorMode.DARK
        dark = replace(Theme.dark, bg="#2e3440", accent="#88c0d0")
        light = replace(Theme.light, accent="#5e81ac")
        typography = Typography(heading_font="Fraunces")
    ```

    Assets live under `asset_dir` (a ``theme/`` dir next to the module by default;
    set `asset_root` to relocate).
    """

    # metadata / deck defaults (consulted by the deck→theme precedence resolution).
    # `name` defaults to the subclass's class name (see __init_subclass__).
    name: str = "Theme"
    mode: ColorMode = ColorMode.DARK
    font_size: int = 36
    transition: Transition = Cut()

    # palette per mode; defaults are the neutral floor (dark via Palette(), light via
    # the light-floor constant). Override off these with `dataclasses.replace`.
    dark: Palette = Palette()
    light: Palette = _LIGHT_FLOOR

    typography: Typography = Typography()

    # asset subdirectory relative to the defining module's package dir
    asset_root: ClassVar[str] = "theme"

    def __init_subclass__(cls, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)
        # A theme's display name defaults to its class name unless it sets one.
        if "name" not in cls.__dict__:
            cls.name = cls.__name__

    # ── Asset location ────────────────────────────────────────────────────────

    def asset_dir(self) -> Path:
        """Directory holding this theme's assets, derived from its module's file."""
        module = sys.modules[type(self).__module__]
        file: str | None = getattr(module, "__file__", None)
        if file is None:
            raise ValueError(
                f"Theme {type(self).__name__} cannot locate its assets: module "
                + f"{type(self).__module__!r} has no file on disk. Themes must be "
                + "installed as regular (unpacked) packages."
            )
        base = Path(file).parent
        return base / self.asset_root if self.asset_root else base

    @property
    def layouts_dir(self) -> Path:
        return self.asset_dir() / "layouts"

    @property
    def fonts_dir(self) -> Path:
        return self.asset_dir() / "fonts"

    def styles_css(self) -> str:
        """The theme's optional escape-hatch stylesheet, or ``""`` if absent."""
        f = self.asset_dir() / "styles.css"
        return f.read_text(encoding="utf-8") if f.is_file() else ""

    def scripts_js(self) -> str:
        """The theme's optional scripts, or ``""`` if absent."""
        f = self.asset_dir() / "scripts.js"
        return f.read_text(encoding="utf-8") if f.is_file() else ""

    # ── Token CSS ─────────────────────────────────────────────────────────────

    def render_tokens_css(self) -> str:
        """Emit the ``:root`` and ``:root[data-theme="light"]`` token blocks.

        These define every ``--inkflow-*`` token; there is no CSS floor to fall back
        to. Typography and the dark palette go in ``:root``, the light palette in the
        ``data-theme`` block.
        """
        main = "\n".join(self._decls(self.typography) + self._decls(self.dark))
        light = "\n".join(self._decls(self.light))
        return (
            ":root {\n"
            + main
            + "\n}\n"
            + ':root[data-theme="light"] {\n'
            + light
            + "\n}"
        )

    @staticmethod
    def _decls(tokens: Palette | Typography) -> list[str]:
        """One CSS declaration per field of a token dataclass."""
        return [
            f"    {_css_var(f.name)}: {cast('object', getattr(tokens, f.name))};"
            for f in fields(tokens)
        ]


class Builtin(Theme):
    """The default theme: Catppuccin (Mocha dark / Latte light)."""

    name: str = "inkflow"

    dark: Palette = Palette(
        bg="#1e1e2e",
        surface="#313244",
        border="#585b70",
        text="#cdd6f4",
        text_muted="#a6adc8",
        accent="#cba6f7",
        accent_fg="#11111b",
        code_bg="#181825",
        code_text="#cdd6f4",
        link="#89b4fa",
        heading="#cdd6f4",
        blockquote="#585b70",
        red="#f38ba8",
        orange="#fab387",
        yellow="#f9e2af",
        green="#a6e3a1",
        teal="#94e2d5",
        blue="#89b4fa",
        purple="#cba6f7",
        pink="#f5c2e7",
        grey="#6c7086",
    )
    light: Palette = Palette(
        bg="#eff1f5",
        surface="#ccd0da",
        border="#acb0be",
        text="#4c4f69",
        text_muted="#6c6f85",
        accent="#8839ef",
        accent_fg="#eff1f5",
        code_bg="#e6e9ef",
        code_text="#4c4f69",
        link="#1e66f5",
        heading="#4c4f69",
        blockquote="#acb0be",
        red="#d20f39",
        orange="#fe640b",
        yellow="#df8e1d",
        green="#40a02b",
        teal="#179299",
        blue="#1e66f5",
        purple="#8839ef",
        pink="#ea76cb",
        grey="#9ca0b0",
    )
