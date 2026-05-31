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

| Variable | Default role |
|---|---|
| `--inkflow-bg` | Slide background |
| `--inkflow-text` | Primary text color |
| `--inkflow-accent` | Accent / highlight color |
| `--inkflow-surface` | Card / panel background |
| `--inkflow-muted` | Secondary / muted text |

## Semantic CSS classes

Layout SVG elements can carry semantic classes that your `styles.css` targets:

| Class | Intended use |
|---|---|
| `theme-accent` | Accent-colored elements (bars, borders) |
| `theme-surface` | Panel or card backgrounds |
| `theme-muted` | Footer text, secondary labels |

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
