# Themes

A theme is a **Python class**.
You subclass `Theme`, give it a typed color `Palette` (and optional `Typography`),
and pass an instance to your deck.
Because a theme is an ordinary class,
it can live in your `deck.py`, in a local module, or in an installed package —
so themes are importable and shareable, no matter how they were installed.

## Using a theme

```python
from inkflow import Deck
from inkflow_themes import Nord  # some installed theme package

Deck(theme=Nord())
```

Set no theme and you get the built-in Catppuccin theme:

```python
Deck()  # == Deck(theme=Builtin())
```

## Defining a theme

Subclass `Theme` and set class attributes:

```python
from dataclasses import replace
from inkflow import ColorMode, Palette, Theme, Typography


class Sunset(Theme):
    mode = ColorMode.DARK
    dark = Palette(bg="#2b1b2f", text="#ffe6d5", accent="#ff7a59")
    light = replace(Theme.light, accent="#d1495b")
    typography = Typography(heading_font="Fraunces", heading_weight=700)
```

- `dark` and `light` are a `Palette` each — one per color mode.
- `typography` is a `Typography`.
- Every token has a sensible default (a neutral floor),
  so you set only the ones you care about.

## The token API

The theme's job is to supply **values** for a fixed set of `--inkflow-*` CSS custom
properties that the layouts and rendered Markdown consume.
inkflow always loads a *contract* stylesheet that provides the structural rules and
the markdown element styling and reads those tokens;
your theme provides the values.
So a theme that sets nothing still renders — you override only what you want.

There are two token groups:
a `Palette` of colors, one instance per color mode,
and a single `Typography` for fonts and text metrics.
Each field maps to a CSS variable by kebab-casing its name
(`text_muted` → `--inkflow-text-muted`).

Every field, its default, and what it styles is listed in the
[Themes reference](../reference/theme.md).

Heading *sizes* are a fixed scale in the contract, not tokens.
Font names are `font-family` values,
so ship the font file in your theme's `fonts/` directory to embed it
(see the [Fonts guide](fonts.md)).

## Overriding only some tokens

A `Palette`'s field defaults are the neutral **dark** floor,
so `Palette(accent="#88c0d0")` gives that accent plus the dark floor for everything
else — correct for a partial *dark* palette.

For a partial *light* palette, start from the light floor with `dataclasses.replace`,
because a bare `Palette(...)` would fill the unnamed fields with the *dark* floor:

```python
class Nord(Theme):
    dark = replace(Theme.dark, accent="#88c0d0")  # dark floor + accent
    light = replace(Theme.light, accent="#5e81ac")  # light floor + accent
```

A full custom palette just names every field:
`Palette(bg=..., text=..., accent=..., ...)`.

## Color mode, font size, transition, and overlays

Deck-level `mode`, `font_size`, `transition`, and `overlays` default to
"defer to the theme".
Resolution runs **slide → deck → theme**:

```python
Deck(theme=Nord())  # mode/size/transition/overlays come from Nord
Deck(theme=Nord(), mode=ColorMode.LIGHT)  # deck overrides the theme's mode
```

`overlays` is how a theme ships its own branding.
Set it on the theme class and every deck using that theme gets the chrome,
with `Deck(overlays=[])` or `Slide(overlays=[])` opting back out:

```python
class Corporate(Theme):
    overlays = [Overlay("theme:brand")]
```

See the [layout system guide](layout-system.md#overlays) for how overlays compose.

`mode` sets the `data-theme` attribute the presenter reads:
`ColorMode.DARK` leaves it empty (the `:root` palette applies) and
`ColorMode.LIGHT` sets `data-theme="light"` (the light palette applies).

## Built-in layouts, recolored

A theme needs no layout files of its own.
Bare layout names in `Slide(...)` resolve through the project, then the theme,
then the built-in layouts,
and the built-ins take your palette automatically
because they paint through the `inkflow-fill-*` token classes.
Ship your own `layouts/*.svg` only when you want different geometry:
you can override just the layouts you care about and inherit the rest.

Because any theme can fall through to them,
the built-in layouts' own stylesheet (zone alignment and heading sizes,
keyed on `.layout-<name>`) is loaded for every deck,
not only for decks on the built-in theme.
Your theme's `styles.css` loads after it,
so restyling a built-in layout is a matter of naming the same selector:

```css
/* your theme's styles.css */
.layout-center #zone-content {
    --inkflow-align: left;
}
```

## Shipping a theme as a package

A theme locates its assets from **its own module**, so an installed theme just works.
Put a `theme/` directory next to the module that defines the class:

```
inkflow_themes/
  __init__.py     # class Nord(Theme): ...
  theme/
    layouts/*.svg   # optional — only layouts you add or override
    overlays/*.svg  # optional — chrome referenced by Theme.overlays
    styles.css      # optional — CSS the token API doesn't cover
    fonts/*.woff2   # optional — bundled fonts
```

Then `from inkflow_themes import Nord; Deck(theme=Nord())`.
Themes must be installed as regular (unpacked) packages;
a zip-imported theme raises a clear error.

## SVG element utility classes

SVG elements can carry semantic classes that follow the active color mode.
Each token has a fill and a stroke variant, e.g.:

```xml
<rect class="inkflow-fill-accent inkflow-stroke-surface" .../>
```

Available for every palette token: `inkflow-fill-<token>` and
`inkflow-stroke-<token>` (`bg`, `surface`, `border`, `text`, `text-muted`, `accent`,
`accent-fg`, `code-bg`, `code-text`, and the named colors `red` … `grey`).
The presenter's light/dark switch updates all of them automatically.

## Authoring theme colors in Inkscape

Inkscape can't read CSS custom properties, so semantically-classed elements appear
unstyled in the editor without help.
Three commands bridge the gap:

```bash
# 1. Install the palette as Inkscape swatches (once per machine):
inkflow palette --deck deck.py > ~/.config/inkscape/palettes/inkflow.gpl

# 2. Convert hardcoded hex fills/strokes to semantic classes:
inkflow colorize slides/*.svg

# 3. Refresh the editor preview (injects hex fallbacks Inkscape can render;
#    stripped at serve time, never shipped to the browser):
inkflow sync
```

`inkflow palette` derives the swatches from the active theme's palette,
so a custom theme exports its own colors.

## Per-deck and per-slide CSS

Beyond the theme you can inject CSS at two levels:

```python
Deck(style='text { font-family: "Inter", sans-serif; }')  # every slide
Slide("title", style="#headline { fill: hotpink; }")  # one slide
```

Slide style beats deck style, which beats the theme.
The full stylesheet order, each layer overriding the ones before it:

1. the contract stylesheet (structural rules, markdown elements)
2. the active theme's tokens
3. the built-in layout styling
4. the active theme's `styles.css`
5. the project's `styles.css` next to `deck.py`
6. `Deck(style=...)`, then `Slide(style=...)`

## Font size

`Deck(font_size=36)` (default from the theme, `36`) sets the base `font-size` on each
zone's `<foreignObject>` root;
all `em`/`rem` units cascade from it.
Set it per slide with `Slide(..., font_size=48)`.
