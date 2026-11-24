"""Read ops on the active theme."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from inkflow import colors, loaders
from inkflow.enums import ColorMode
from inkflow.ops.registry import (
    DeckUse,
    OpContext,
    described,
    register,
    register_group,
)

__all__ = ["GROUP", "Palette", "ThemePaletteRequest", "palette"]

GROUP = register_group("theme", "Inspect the active theme.")


@dataclass(frozen=True)
class ThemePaletteRequest:
    mode: ColorMode | None = field(
        default=None,
        metadata=described("Color mode (default: the deck's; dark without a deck)."),
    )


@dataclass(frozen=True)
class Palette:
    name: str
    gpl: str
    """The palette in GIMP/Inkscape ``.gpl`` format."""

    def to_json(self) -> dict[str, object]:
        return asdict(self)

    def render(self) -> str:
        return self.gpl


@register(GROUP, "palette", ThemePaletteRequest, Palette, deck=DeckUse.OPTIONAL)
def palette(request: ThemePaletteRequest, context: OpContext) -> Palette:
    """Print an Inkscape GPL color palette for the active theme.

    The palette's colors correspond to the inkflow-fill-* / inkflow-stroke-* CSS
    class tokens, so you can pick theme colors by name in Inkscape's swatches panel
    and then run 'inkflow svg colorize' to convert the hardcoded hex values to
    semantic classes. Redirect it to save:

    \b
        inkflow theme palette > inkflow.gpl
    """
    dark_mode = context.dark_mode(request.mode)
    styles = loaders.load_deck_styles(context.deck, context.project_dir)
    tokens = colors.extract_tokens(styles, dark_mode)
    theme_label = context.theme.name if context.theme is not None else "inkflow"
    name = f"{theme_label} ({'dark' if dark_mode else 'light'})"
    return Palette(name, colors.build_gpl(tokens, name))
