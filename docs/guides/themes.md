# Themes

A theme is a directory that provides a base layout SVG, optional built-in layouts, and a CSS stylesheet.
Themes define the visual identity of a deck (background, color palette, typography)
without coupling that identity to individual slide files.

## Theme directory structure

```
my-theme/
  main.svg              ← base layout (no parent); background + brand elements
  numbered-main.svg     ← variant that adds zone-slide-number / zone-slide-total
  styles.css            ← CSS cascade injected into every MarkdownSlide
  layouts/
    cover.svg
    default.svg
    two-cols.svg
    ...                 ← layout SVGs that extend main.svg or numbered-main.svg
```

## Using a theme

Point `Deck` at the theme directory:

```python
deck = Deck(theme="./my-theme")
```

Bare theme names (e.g. `Deck(theme="catppuccin-mocha")`) will be resolved from installed pip packages
once named theme support is implemented.
For now, use a path.

With a theme set, bare layout names in `MarkdownSlide` are resolved through the theme's `layouts/` directory
before falling back to the built-in layouts.

## Dark mode

```python
deck = Deck(dark_mode=True)   # default
deck = Deck(dark_mode=False)
```

`dark_mode` sets a `data-theme="dark"` (or `"light"`) attribute on the presenter's `<html>` element.
Your theme CSS can target this to provide palette variants:

```css
:root { --inkflow-bg: #1e1e2e; --inkflow-text: #cdd6f4; }
[data-theme="light"] { --inkflow-bg: #eff1f5; --inkflow-text: #4c4f69; }
```

## CSS variables

The built-in theme and the presenter use a set of CSS custom properties.
Override them in your `styles.css` to change colors without rewriting layout SVGs:

| Variable | Default (Mocha) | Default (Latte) | Role |
|---|---|---|---|
| `--inkflow-bg` | `#1e1e2e` | `#eff1f5` | Slide background |
| `--inkflow-surface` | `#313244` | `#ccd0da` | Card / panel background |
| `--inkflow-border` | `#585b70` | `#acb0be` | Border / divider color |
| `--inkflow-text` | `#cdd6f4` | `#4c4f69` | Primary text color |
| `--inkflow-text-muted` | `#a6adc8` | `#6c6f85` | Secondary / muted text |
| `--inkflow-accent` | `#cba6f7` | `#8839ef` | Accent / highlight color (Mauve) |
| `--inkflow-accent-fg` | `#11111b` | `#eff1f5` | Foreground on accent backgrounds |
| `--inkflow-code-bg` | `#181825` | `#e6e9ef` | Code block background |
| `--inkflow-code-text` | `#cdd6f4` | `#4c4f69` | Code block text color |
| `--inkflow-red` | `#f38ba8` | `#d20f39` | Red — errors, deletions |
| `--inkflow-green` | `#a6e3a1` | `#40a02b` | Green — success, additions |
| `--inkflow-blue` | `#89b4fa` | `#1e66f5` | Blue — info, links |
| `--inkflow-yellow` | `#f9e2af` | `#df8e1d` | Yellow — warnings, highlights |

## SVG element utility classes

SVG elements can carry semantic classes that respond to the active color mode
(light/dark toggle in the presenter).
Each token has both a fill and a stroke variant:

| Fill class | Stroke class | Variable |
|---|---|---|
| `inkflow-fill-bg` | `inkflow-stroke-bg` | `--inkflow-bg` |
| `inkflow-fill-surface` | `inkflow-stroke-surface` | `--inkflow-surface` |
| `inkflow-fill-border` | `inkflow-stroke-border` | `--inkflow-border` |
| `inkflow-fill-text` | `inkflow-stroke-text` | `--inkflow-text` |
| `inkflow-fill-text-muted` | `inkflow-stroke-text-muted` | `--inkflow-text-muted` |
| `inkflow-fill-accent` | `inkflow-stroke-accent` | `--inkflow-accent` |
| `inkflow-fill-accent-fg` | `inkflow-stroke-accent-fg` | `--inkflow-accent-fg` |
| `inkflow-fill-code-bg` | `inkflow-stroke-code-bg` | `--inkflow-code-bg` |
| `inkflow-fill-code-text` | `inkflow-stroke-code-text` | `--inkflow-code-text` |
| `inkflow-fill-red` | `inkflow-stroke-red` | `--inkflow-red` |
| `inkflow-fill-green` | `inkflow-stroke-green` | `--inkflow-green` |
| `inkflow-fill-blue` | `inkflow-stroke-blue` | `--inkflow-blue` |
| `inkflow-fill-yellow` | `inkflow-stroke-yellow` | `--inkflow-yellow` |

Example — a rect that fills with the accent color and uses the surface color as its stroke:

```xml
<rect class="inkflow-fill-accent inkflow-stroke-surface" .../>
```

## Authoring theme colors in Inkscape

Inkscape can't read CSS custom properties from the HTML page, so elements with semantic
classes appear unstyled in the editor without extra setup.
Two commands bridge this gap:

**1. Install the Inkscape palette (once per machine):**

```bash
inkflow palette --install
# or for a custom theme:
inkflow palette --deck deck.py --install
```

This writes `~/.config/inkscape/palettes/inkflow.gpl`.
Open Inkscape's swatches panel and switch to the "inkflow" palette.
You can now pick theme colors by token name.

**2. Convert hardcoded colors to semantic classes:**

After drawing shapes with palette colors, run:

```bash
inkflow colorize slides/*.svg
```

This scans each SVG for `fill`/`stroke` attributes (and `style=` declarations)
that match known theme hex values, replaces them with the corresponding
`inkflow-fill-*` / `inkflow-stroke-*` classes, and removes the hardcoded attribute.

**3. Refresh the editor preview:**

```bash
inkflow parent inject
```

This injects a `<style id="inkflow-preview">` block into each SVG with hardcoded
hex fallbacks for the semantic classes, so Inkscape renders them with the correct
colors. The block is stripped automatically at serve time — it never appears in the browser.

**Workflow for a new themed shape:**

1. Draw the shape in Inkscape, pick a color from the inkflow swatches panel.
2. Run `inkflow colorize slides/myslide.svg` to convert the hex to a class.
3. Run `inkflow parent inject` to refresh the Inkscape preview.
4. Alternatively, assign the class directly in Object Properties (Shift+Ctrl+O)
   — Inkscape shows the correct color immediately after step 3.

The presenter's light/dark toggle updates all semantic-class elements automatically —
no further changes needed.

## Per-deck and per-slide CSS

Beyond the theme, you can inject CSS at two levels:

**Deck-level**: applied to every slide:

```python
deck = Deck(style="""
    text { font-family: "Inter", sans-serif; }
""")
```

**Slide-level**: applied to one slide only:

```python
Slide("slides/01-title.svg", style="""
    #headline { fill: hotpink; }
""")
```

Slide-level style takes precedence over deck-level, which takes precedence over the theme.

## Font size

The base font size for `MarkdownSlide` content is controlled by `Deck(font_size=36)` (default 36px).
This sets the CSS `font-size` on the `<foreignObject>` root,
and all `em`/`rem` units in your theme cascade from it.

## Building a custom theme

The simplest path is to copy the built-in theme and modify it.
Edit `main.svg` for the base frame, `styles.css` for typography and color,
and the layouts for zone placement:

```bash
cp -r $(uv run python -c "import inkflow; print(inkflow.__file__.replace('__init__.py','theme'))") ./my-theme
```

Then point your deck at it:

```python
deck = Deck(theme="./my-theme")
```
