# Fonts

A deck looks the same on every computer: inkflow ships its default fonts and
embeds every font a deck uses into the presentation, so neither you nor your
audience has to install anything.

## The fonts inkflow ships

| Used for | Font | Licence |
|---|---|---|
| Text and headings | [Inter](https://rsms.me/inter/) 4.1, variable (every weight 100–900, upright and italic; Latin, Greek, Cyrillic) | SIL OFL 1.1 |
| Code | [JetBrains Mono](https://www.jetbrains.com/lp/mono/) 2.304, variable (100–800, upright and italic) | SIL OFL 1.1 |
| Formulas (MathML) | [STIX Two Math](https://www.stixfonts.org/) 2.13, with the OpenType MATH table browsers lay formulas out with | SIL OFL 1.1 |
| Emoji | [Twemoji](https://github.com/mozilla/twemoji-colr) 0.7.0 (Mozilla's COLR build: colour emoji in every browser, Safari included; Emoji 14) | CC BY 4.0 (artwork) |

They live in the built-in theme's `fonts/` folder of the installed package, with
their licence files and a README naming each one's source and version. Together
they add about 2 MB to the package.

The theme's typography names them first, each list ending in a generic family:

```python
Typography(
    body_font='"Inter", "Twemoji Mozilla", sans-serif',
    heading_font='"Inter", "Twemoji Mozilla", sans-serif',
    mono_font='"JetBrains Mono", "Twemoji Mozilla", monospace',
    math_font='"STIX Two Math", math',
)
```

These are the defaults of every theme, not just the built-in one, so a theme that
only changes colours still gets them. The emoji font comes after the text font:
it draws only the characters the text font has no glyph for.

**Slides drawn in Inkscape.** `sans-serif` and `monospace`, Inkscape's default
fonts (and the fonts of the built-in layouts), mean whatever sans or monospace
the computer showing the slide has. In a slide inkflow reads them as the deck's
own body and code fonts, so that text looks the same everywhere too: as an
attribute (`font-family="sans-serif"`, mapped by the stylesheet, so any rule of
yours still wins) or in a `style` (rewritten in the built slide; the file on disk
is left alone). Text that names no font at all is in the body font.

**The interface.** The editor and the presenter's own text (menus, status bar,
panels, the ink palette) use Inter and JetBrains Mono too, so inkflow itself looks
the same on Linux, macOS and Windows.

**Not covered.** Chinese, Japanese and Korean, Arabic, Hebrew, the Indic scripts
and other scripts the shipped fonts do not include fall back to the computer's
fonts, as do emoji newer than Emoji 14. To make such text portable, put a font
that has it in the project's `fonts/` and name it in the theme (below).

## Using other fonts

Name them in the theme's typography (or a `Theme` subclass, or the editor's
**Theme** dialog), or on an SVG element (`font-family`, as Inkscape writes it):

```python
class Talk(Theme):
    typography = Typography(
        body_font='"Source Sans 3", "Twemoji Mozilla", sans-serif',
        heading_font='"Fraunces", serif',
    )
```

Inkflow looks for each family it finds, in this order, and uses the first match:

1. **`fonts/`** next to your `deck.py`
2. **The active theme's `fonts/`**, so a theme package can ship its typefaces (see the [Themes guide](themes.md))
3. **The fonts inkflow ships** (above)
4. Your user font directory (`~/.local/share/fonts` on Linux, `~/Library/Fonts` on macOS, `%LOCALAPPDATA%\Microsoft\Windows\Fonts` on Windows)
5. The system font directories (`/usr/share/fonts`, `/Library/Fonts`, `C:\Windows\Fonts`)

A same-named file in `fonts/` wins over the theme's and inkflow's, so a project can
always pin its own version. A font found only in 4 or 5 is embedded too, but it is
on *this* computer only: commit it to `fonts/` so a teammate or a CI runner
building the deck has it (`inkflow setup-pages` warns about such fonts).

```
my-talk/
  deck.py
  fonts/
    SourceSans3-Variable.ttf
    Fraunces-Variable.woff2
  slides/
    title.svg
```

TTF, OTF, WOFF and WOFF2 files are read. A variable font is one file for every
weight; a family of static files is matched weight by weight (regular, bold,
italic…). A family a slide defines itself with an `@font-face` in its `<style>`
is used as it is.

`inkflow fonts` lists where each font the deck uses comes from (`project`,
`theme`, `machine`, `missing`, `generic`), and `inkflow fonts bundle` copies the
ones only your computer has into `fonts/`, with their licences: see
[A deck that looks the same everywhere](../presenting/portable.md).

## How it is embedded

- **`inkflow serve` and the editor** link the shipped fonts from the server
  (`/_inkflow/fonts/…`, fetched once and cached) and embed any other font whole.
- **`inkflow build`, `inkflow export` (PDF) and `inkflow render`** subset each
  font to the characters the deck uses, as WOFF2 data inside the page: typically
  20–80 KB a face. A subset keeps every OpenType feature (tabular figures in
  charts, a formula's script sizes) and the font's name table (its copyright and
  licence). The emoji font is carried only if the deck has emoji, the maths font
  only if it has formulas, with the forms a browser draws a formula with (the
  italic 𝑥 of `$x$`, stretched brackets and roots). Subsets are cached in your
  user cache folder, so rebuilding the same deck is quick.
- **The PDF** embeds every face: Chromium writes the variable fonts and the
  maths and emoji fonts as Type 3 fonts (their outlines, text still selectable
  and searchable), static TrueType fonts as TrueType.

## Warnings

A font named but found nowhere is reported once, and the browser shows its own
fallback instead:

```
 ⚠  font "Söhne" not found in any font directory
```

Add it to `fonts/` and rebuild.

## Opting out

`Deck(embed_fonts=False)` embeds no font at all, so every family must be installed
on the computer showing the deck:

```python
def main() -> Deck:
    return Deck(embed_fonts=False)
```
