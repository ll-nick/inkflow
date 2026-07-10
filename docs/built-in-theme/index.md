# Built-in theme

Inkflow ships with a built-in theme so a deck looks polished before you touch any
styling. The theme provides a base layout SVG (background + brand frame), a set of
ready-made layouts, and a CSS stylesheet built on the
[Catppuccin](https://catppuccin.com/) palette (Mocha in dark mode, Latte in light mode).

The showcase below is built from the theme's own `showcase/deck.py` and walks through
every built-in layout. Navigate with arrow keys or click to advance, and toggle the
light/dark mode in the presenter to see both palette variants.

[Launch showcase](./presentation/index.html){ .md-button .md-button--primary target="_blank" }

## Built-in layouts

Each layout is a bare name you can pass to `Slide(...)`. They resolve through the
active theme first, then fall back to these built-ins.

| Layout | Purpose |
|---|---|
| `cover` | Title slide — large title, subtitle, and an optional full-bleed `media` zone |
| `default` | Standard content slide — title, subtitle, and a content zone for bullets/prose |
| `section` | Section divider — large heading to break the deck into parts |
| `center` | Single centered block — ideal for one statement or image |
| `two-cols` | Two independent content columns beneath a shared title |
| `fact` | A single large fact with a supporting caption |
| `quote` | A blockquote with an attribution line |
| `media-left` | Image on the left, text on the right |
| `media-right` | Image on the right, text on the left |
| `end` | Closing slide — thank-you / wrap-up |

In addition, `base` is the no-parent base layout (background + frame) that the others
extend, and `numbered` is a variant that adds slide-number zones.

## Using a built-in layout

Pass the bare layout name to `Slide`, with Markdown or SVG content:

```python
from inkflow import Deck, Slide

def main() -> Deck:
    return Deck(slides=[
        Slide("cover", md="slides/title.md"),
        Slide("two-cols", md="slides/compare.md"),
        Slide("end", md="slides/thanks.md"),
    ])
```

Markdown zone markers (e.g. `::left::`, `::right::`, `::quote::`) target the named
zones in each layout. See the showcase deck's slide files for the exact markers each
layout expects.

For styling the theme — palette variables, semantic SVG classes, and authoring colors
in Inkscape — see the [Themes guide](../guides/themes.md).
