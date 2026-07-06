# Font embedding

Inkflow automatically embeds the fonts used in your slides into the presentation HTML.
This means custom fonts render correctly on any machine — no installation required for viewers.

## How it works

When your deck is built or served, Inkflow scans every slide for `font-family` declarations
(SVG attributes, inline styles, and `<style>` blocks). For each named font it finds, it locates
the font file on the system and embeds it as a base64-encoded `@font-face` rule in the page CSS.

Generic family names (`sans-serif`, `serif`, `monospace`, etc.) are always skipped — they
resolve to system fonts at render time and don't need embedding.

```python
def main() -> Deck:
    return Deck()  # embed_fonts=True by default
```

No configuration needed. Name the font in your SVG editor and it will be embedded.

## Font search order

Inkflow searches for font files in this order, using the first match found:

1. **`fonts/`** — a directory next to your `deck.py`
2. User font directory (`~/.local/share/fonts` on Linux, `~/Library/Fonts` on macOS, `%LOCALAPPDATA%\Microsoft\Windows\Fonts` on Windows)
3. System font directories (`/usr/share/fonts` on Linux, `/Library/Fonts` on macOS, `C:\Windows\Fonts` on Windows)

## Committing fonts with your project

Place font files in a `fonts/` directory alongside `deck.py` to make the presentation
fully self-contained and reproducible on any machine:

```
my-talk/
  deck.py
  fonts/
    Inter-Regular.ttf
    Inter-Bold.ttf
  slides/
    01-title.svg
```

Fonts in `fonts/` take precedence over system fonts, so you always get exactly the
variant you committed regardless of what's installed on the machine running `inkflow`.

## Serve vs. build

- **`inkflow serve`** — embeds the full font file for each variant. The font index is built
  once at startup and cached in memory, so live-reload after saving a slide is not affected.
- **`inkflow build` / `inkflow export`** — subsets each font to only the glyphs actually
  present in the slides before embedding. This typically reduces font data from 200–400 KB
  to 10–30 KB per variant, keeping the exported HTML compact.

## Warnings

If a font cannot be found, Inkflow emits a warning in the terminal instead of failing the build.
The slide still renders using the system's fallback font for that family.

```
 ⚠  font "Söhne" not found in any font directory
```

Install the font (or add it to `fonts/`) and rebuild to resolve the warning.

## Opting out

Set `embed_fonts=False` on the deck to disable embedding entirely:

```python
def main() -> Deck:
    return Deck(embed_fonts=False)
```

This is rarely needed — subsetted fonts are small — but can be useful when the font is already
available on all target machines or when minimising build time is a priority.
