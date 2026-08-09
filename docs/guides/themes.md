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
from inkflow_themes import Nord   # some installed theme package

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

### Palette (colors, one per mode)

| Token | Role |
|---|---|
| `bg` | Slide background |
| `surface` | Card / panel background |
| `border` | Border / divider |
| `text` | Primary text |
| `text_muted` | Secondary / muted text |
| `accent` | Accent / highlight |
| `accent_fg` | Foreground on accent backgrounds |
| `code_bg` / `code_text` | Code block background / text |
| `link` | Link color |
| `heading` | Heading color |
| `blockquote` | Blockquote border |
| `red` `orange` `yellow` `green` `teal` `blue` `purple` `pink` `grey` | Named accent palette — syntax highlighting and the `inkflow-fill-*` / `inkflow-stroke-*` SVG utility classes |

Each field maps to a CSS variable by kebab-casing its name
(`text_muted` → `--inkflow-text-muted`).

### Typography

| Token | Default | Role |
|---|---|---|
| `body_font` | `sans-serif` | Body `font-family` |
| `heading_font` | `sans-serif` | Heading `font-family` |
| `mono_font` | `monospace` | Code `font-family` |
| `line_height` | `1.4` | Body line height |
| `heading_weight` | `600` | Heading weight |
| `heading_line_height` | `1.2` | Heading line height |

Heading *sizes* are a fixed scale in the contract, not tokens.
Font names are `font-family` values;
ship the font file in your theme's `fonts/` directory to embed it
(see the [Fonts guide](fonts.md)).

## Overriding only some tokens

A `Palette`'s field defaults are the neutral **dark** floor,
so `Palette(accent="#88c0d0")` gives that accent plus the dark floor for everything
else — correct for a partial *dark* palette.

For a partial *light* palette, start from the light floor with `dataclasses.replace`,
because a bare `Palette(...)` would fill the unnamed fields with the *dark* floor:

```python
class Nord(Theme):
    dark = replace(Theme.dark, accent="#88c0d0")    # dark floor + accent
    light = replace(Theme.light, accent="#5e81ac")  # light floor + accent
```

A full custom palette just names every field:
`Palette(bg=..., text=..., accent=..., ...)`.

## Color mode, font size, and transition

Deck-level `mode`, `font_size`, and `transition` default to "defer to the theme".
Resolution runs **slide → deck → theme**:

```python
Deck(theme=Nord())                        # mode/size/transition come from Nord
Deck(theme=Nord(), mode=ColorMode.LIGHT)  # deck overrides the theme's mode
```

`mode` sets the `data-theme` attribute the presenter reads:
`ColorMode.DARK` leaves it empty (the `:root` palette applies) and
`ColorMode.LIGHT` sets `data-theme="light"` (the light palette applies).

## Built-in layouts, recolored

A theme needs no layout files of its own.
Bare layout names in `Slide(...)` resolve through the project, then the theme,
then the built-in layouts,
and the built-ins take your palette automatically
because they paint through the `inkflow-fill-*` token classes.
Ship your own `layouts/*.svg` only when you want different geometry;
you can override just the layouts you care about and inherit the rest.

## Shipping a theme as a package

A theme locates its assets from **its own module**, so an installed theme just works.
Put a `theme/` directory next to the module that defines the class:

```
inkflow_themes/
  __init__.py     # class Nord(Theme): ...
  theme/
    layouts/*.svg   # optional — only layouts you add or override
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
Deck(style='text { font-family: "Inter", sans-serif; }')   # every slide
Slide("title", style="#headline { fill: hotpink; }")       # one slide
```

Slide style beats deck style, which beats the theme.

## Font size

`Deck(font_size=36)` (default from the theme, `36`) sets the base `font-size` on each
zone's `<foreignObject>` root;
all `em`/`rem` units cascade from it.
Set it per slide with `Slide(..., font_size=48)`.
