# Built-in theme

Inkflow ships with a built-in theme so a deck looks polished before you touch any
styling. The theme provides a base layout SVG (background + brand frame), a set of
ready-made layouts, and a CSS stylesheet built on the
[Catppuccin](https://catppuccin.com/) palette (Mocha in dark mode, Latte in light mode).

The showcase below is built from the theme's own `showcase/deck.py` and walks through
every built-in layout. Navigate with arrow keys or click to advance, and toggle the
light/dark mode in the presenter to see both palette variants.

[Launch showcase](./presentation/index.html){ .md-button .md-button--primary target="_blank" }

## The layouts

The theme ships eleven layouts plus two building blocks,
listed with their zones in [Layouts](../design/layouts.md#built-in-layouts).
The showcase above walks through each one.

## Using a built-in layout

Pass the bare layout name to `Slide`, with Markdown or SVG content:

```python
from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(
        slides=[
            Slide("cover", md="title"),
            Slide("two-cols", md="compare"),
            Slide("end", md="thanks"),
        ]
    )
```

[Markdown zone markers](../authoring/markdown.md#explicit-markers)
such as `::left::` and `::quote::` target the named zones in each layout.

For restyling the theme, its palette variables and its semantic SVG classes,
see [Themes](../design/themes.md).
