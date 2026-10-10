"""The themes shipped with inkflow besides the default one.

- `Paper`: a quiet white theme, a well-set document: near-black text, neutral
  greys, hairline rules, one ink-blue accent. Light by default, with a matching
  near-black dark mode.
- `Stage`: the big-type keynote look: heavy, tight headings, lots of space,
  centred title, section and end slides, soft grey cards and one vivid blue.
  Black by default (the stage), with a white mode.

Use one with ``Deck(theme=Paper())`` (``from inkflow import Paper``), or
``inkflow init --theme paper``. Both draw on the built-in layouts and take
their font *families* from the default theme (`Builtin`), so they set the same
fonts and embed the fonts it ships; what they change is colour, weight,
spacing and the per-layout details in their own ``styles.css``
(``builtin_themes/<name>/styles.css``, loaded after the built-in layouts'
styling).

A subclass (``class Mine(Paper): light = replace(Paper.light, accent=...)``)
keeps its parent's stylesheet: `asset_dir` is this package's folder for the
theme, not the subclass's module, so tweaking tokens needs no files.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import ClassVar

from typing_extensions import override

from inkflow.enums import ColorMode
from inkflow.themes import Builtin, Palette, Theme, Typography

__all__ = ["THEMES", "Paper", "Stage", "theme_id"]

_HERE = Path(__file__).parent


class _Shipped(Theme):
    """A theme shipped inside inkflow: assets in this package, fonts shared
    with the default theme."""

    asset_root: ClassVar[str] = ""

    @override
    def asset_dir(self) -> Path:
        # The folder of the shipped theme this class is (or derives from), so
        # a subclass in a deck.py keeps the stylesheet.
        return _HERE / self.asset_root

    @property
    @override
    def fonts_dir(self) -> Path:
        # The default theme's fonts: these themes use its font families.
        return Builtin().fonts_dir


class Paper(_Shipped):
    """A quiet white theme: near-black text, neutral greys, hairline rules and
    one ink-blue accent; a near-black dark mode."""

    name: str = "Paper"
    mode: ColorMode = ColorMode.LIGHT
    asset_root: ClassVar[str] = "paper"

    light: Palette = Palette(
        bg="#ffffff",
        surface="#f4f4f5",
        border="#d8d8dc",
        text="#1c1c1f",
        text_muted="#5c5c63",
        accent="#2453c7",
        accent_fg="#ffffff",
        code_bg="#f5f5f6",
        code_text="#1c1c1f",
        link="#2453c7",
        heading="#111113",
        blockquote="#cfcfd4",
        red="#c0362c",
        orange="#b2510e",
        yellow="#8a6400",
        green="#2e7a3c",
        teal="#0d7470",
        blue="#2453c7",
        purple="#7343c2",
        pink="#b42e6e",
        grey="#6b6b73",
    )
    dark: Palette = Palette(
        bg="#17171a",
        surface="#222226",
        border="#3b3b41",
        text="#e4e4e8",
        text_muted="#a2a2aa",
        accent="#8fb2f5",
        accent_fg="#111114",
        code_bg="#1f1f23",
        code_text="#e4e4e8",
        link="#8fb2f5",
        heading="#f4f4f6",
        blockquote="#46464d",
        red="#f08c84",
        orange="#efa86a",
        yellow="#e2c46b",
        green="#86c99a",
        teal="#6fcfc6",
        blue="#8fb2f5",
        purple="#bfa2f2",
        pink="#ee9cc3",
        grey="#9a9aa2",
    )
    typography: Typography = replace(
        Builtin.typography,
        line_height=1.45,
        heading_weight=600,
        heading_line_height=1.2,
    )


class Stage(_Shipped):
    """The big-type keynote look: heavy, tight headings, centred title and
    section slides, soft grey cards and one vivid blue; black or white."""

    name: str = "Stage"
    # Black on screen: Theme's own mode, which Stage leaves unset so that a
    # printed deck (a poster) is still white paper (Deck.effective_mode).
    font_size: int = 40
    asset_root: ClassVar[str] = "stage"

    dark: Palette = Palette(
        bg="#000000",
        surface="#1c1c1e",
        border="#3a3a3c",
        text="#f5f5f7",
        text_muted="#a1a1a6",
        accent="#2997ff",
        accent_fg="#000000",
        code_bg="#1c1c1e",
        code_text="#f5f5f7",
        link="#2997ff",
        heading="#ffffff",
        blockquote="#3a3a3c",
        red="#ff5a4f",
        orange="#ff9f0a",
        yellow="#ffd60a",
        green="#32d74b",
        teal="#5ac8d8",
        blue="#2997ff",
        purple="#bf5af2",
        pink="#ff6eb4",
        grey="#8e8e93",
    )
    light: Palette = Palette(
        bg="#ffffff",
        surface="#f5f5f7",
        border="#d2d2d7",
        text="#1d1d1f",
        text_muted="#6e6e73",
        accent="#006ad8",
        accent_fg="#ffffff",
        code_bg="#f5f5f7",
        code_text="#1d1d1f",
        link="#0066cc",
        heading="#1d1d1f",
        blockquote="#d2d2d7",
        red="#d1242f",
        orange="#bc4c00",
        yellow="#946200",
        green="#1a7f37",
        teal="#00797f",
        blue="#0066cc",
        purple="#8250df",
        pink="#bf3989",
        grey="#6e6e73",
    )
    typography: Typography = replace(
        Builtin.typography,
        line_height=1.4,
        heading_weight=700,
        heading_line_height=1.08,
    )


THEMES: dict[str, type[Theme]] = {"default": Builtin, "paper": Paper, "stage": Stage}
"""The themes inkflow ships, by the name ``inkflow init --theme`` and the
editor know them by."""


def theme_id(theme: Theme) -> str | None:
    """The shipped theme ``theme`` is (exactly, not a subclass), or ``None``."""
    return next((k for k, cls in THEMES.items() if type(theme) is cls), None)
