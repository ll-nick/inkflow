"""Feature-test deck: a custom Theme (palette + typography) on built-in layouts.

Demonstrates themes-as-classes. `Sunset` is a `Theme` subclass with its own dark
palette, a light palette derived from the neutral floor via `replace`, and a couple
of typography tweaks. It ships *no* layout files of its own, so every slide uses the
built-in layouts, recolored purely through the token API — the "style the built-in
layouts without redefining them" path.

Serve with ``uv run inkflow serve tests/decks/theme.py`` to eyeball the (dark)
palette across the markdown elements; the light palette applies when the deck runs
in light mode. Built (not served) by ``tests/test_decks.py`` as a compilation smoke
test.
"""

from dataclasses import replace

from inkflow import ColorMode, Deck, Inline, Palette, Slide, Theme, Typography


class Sunset(Theme):
    mode: ColorMode = ColorMode.DARK
    dark: Palette = Palette(
        bg="#2b1b2f",
        surface="#3d2740",
        border="#5c3a54",
        text="#ffe6d5",
        text_muted="#d6a48f",
        accent="#ff7a59",
        accent_fg="#2b1b2f",
        code_bg="#1f1424",
        code_text="#ffe6d5",
        link="#ffb08a",
        heading="#ff9e7a",
        blockquote="#5c3a54",
        red="#ff6b6b",
        orange="#ff9e64",
        yellow="#ffd166",
        green="#8bd450",
        teal="#4ecdc4",
        blue="#6aa8ff",
        purple="#c792ea",
        pink="#ff8ac4",
        grey="#9a7f92",
    )
    # Light palette: start from the neutral light floor, warm the accent and links.
    light: Palette = replace(
        Theme.light, accent="#d1495b", link="#c05621", heading="#9c3d24"
    )
    typography: Typography = Typography(heading_weight=700, line_height=1.5)


_INTRO = Inline("""\
# Sunset

A custom `Theme` subclass — its own palette and typography, rendered on the
**built-in layouts** and recolored through the token API alone (no layout files of
its own).
""")

_MARKDOWN = Inline("""\
## Themed markdown

Every markdown element takes the theme's palette and typography:

- lists, **bold**, *italic*, and a [link back to the intro](slide:sunset)
- inline `code` and fenced blocks with syntax highlighting

> A blockquote, bordered in the theme's blockquote color.

```python
def greet(name: str) -> str:
    return f"hello, {name}"
```
""")


def main() -> Deck:
    return Deck(
        theme=Sunset(),
        slides=[
            Slide("default", id="sunset", md=_INTRO),
            Slide("default", md=_MARKDOWN),
            Slide(
                "center", md=Inline("# Centered\n\nvia the `center` built-in layout")
            ),
        ],
    )
