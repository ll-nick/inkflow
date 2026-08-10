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

    Each field maps to a CSS custom property by kebab-casing its name, so
    ``text_muted`` is available to stylesheets and layouts as ``--inkflow-text-muted``.
    """

    # semantic tokens
    bg: str = "#1a1a1a"
    """Slide background."""
    surface: str = "#2a2a2a"
    """Card and panel background."""
    border: str = "#444444"
    """Border and divider color."""
    text: str = "#e6e6e6"
    """Primary text."""
    text_muted: str = "#a0a0a0"
    """Secondary, de-emphasized text."""
    accent: str = "#7aa2f7"
    """Accent and highlight color."""
    accent_fg: str = "#1a1a1a"
    """Foreground on accent-colored backgrounds."""
    code_bg: str = "#111111"
    """Code block background."""
    code_text: str = "#e6e6e6"
    """Code block text."""
    link: str = "#7aa2f7"
    """Link color."""
    heading: str = "#e6e6e6"
    """Heading color."""
    blockquote: str = "#444444"
    """Blockquote border."""
    # named palette
    red: str = "#e06c75"
    """Named color: `.inkflow-fill-red`, `.inkflow-stroke-red`."""
    orange: str = "#d19a66"
    """Named color: `.inkflow-fill-orange`, `.inkflow-stroke-orange`."""
    yellow: str = "#e5c07b"
    """Named color: `.inkflow-fill-yellow`, `.inkflow-stroke-yellow`."""
    green: str = "#98c379"
    """Named color: `.inkflow-fill-green`, `.inkflow-stroke-green`."""
    teal: str = "#56b6c2"
    """Named color: `.inkflow-fill-teal`, `.inkflow-stroke-teal`."""
    blue: str = "#61afef"
    """Named color: `.inkflow-fill-blue`, `.inkflow-stroke-blue`."""
    purple: str = "#c678dd"
    """Named color: `.inkflow-fill-purple`, `.inkflow-stroke-purple`."""
    pink: str = "#d787af"
    """Named color: `.inkflow-fill-pink`, `.inkflow-stroke-pink`."""
    grey: str = "#7f848e"
    """Named color: `.inkflow-fill-grey`, `.inkflow-stroke-grey`."""


@dataclass(frozen=True)
class Typography:
    """A theme's typography tokens. Heading sizes are fixed in the contract.

    Fields map to CSS custom properties the same way `Palette`'s do, so ``body_font``
    is available as ``--inkflow-body-font``. Font values are ordinary ``font-family``
    values: ship the file in the theme's ``fonts/`` directory to have it embedded.
    """

    body_font: str = "sans-serif"
    """Body `font-family`."""
    heading_font: str = "sans-serif"
    """Heading `font-family`."""
    mono_font: str = "monospace"
    """Code `font-family`."""
    line_height: float = 1.4
    """Body line height."""
    heading_weight: int = 600
    """Heading `font-weight`."""
    heading_line_height: float = 1.2
    """Heading line height."""


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
    """Display name. Defaults to the subclass's class name."""
    mode: ColorMode = ColorMode.DARK
    """Color mode a deck gets when it sets none of its own."""
    font_size: int = 36
    """Base font size (px) for zone content, unless the deck or slide overrides it."""
    transition: Transition = Cut()
    """Slide transition a deck gets when it sets none of its own."""

    # palette per mode; defaults are the neutral floor (dark via Palette(), light via
    # the light-floor constant). Override off these with `dataclasses.replace`.
    dark: Palette = Palette()
    """Colors for dark mode. Defaults to the neutral dark floor."""
    light: Palette = _LIGHT_FLOOR
    """Colors for light mode. Defaults to the neutral light floor."""

    typography: Typography = Typography()
    """Font families and text metrics, shared by both color modes."""

    # asset subdirectory relative to the defining module's package dir
    asset_root: ClassVar[str] = "theme"
    """Asset subdirectory, relative to the module that defines the theme."""

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

    @property
    def styles_path(self) -> Path:
        """Where this theme's `styles.css` would live, whether or not it exists."""
        return self.asset_dir() / "styles.css"

    def styles_css(self) -> str:
        """The theme's optional escape-hatch stylesheet, or ``""`` if absent."""
        f = self.styles_path
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
