# Fonts shipped with inkflow

The built-in theme's typography names these, and inkflow's own interface
(editor, presenter) uses Inter and JetBrains Mono, so slides and interface look
the same on every computer. `inkflow serve` loads them from
`/_inkflow/fonts/`; `inkflow build`, `inkflow export` and `inkflow render`
embed them subset to the characters a deck uses. Fonts in a project's `fonts/`
or a theme's `fonts/` with the same family name win over these.

| File | Family | Version | Source | Licence |
|---|---|---|---|---|
| `InterVariable.woff2`, `InterVariable-Italic.woff2` | Inter (variable: `wght` 100–900, `opsz` 14–32) | 4.1 (font version 4.001) | `web/` in [Inter-4.1.zip](https://github.com/rsms/inter/releases/tag/v4.1), unchanged | SIL OFL 1.1, `OFL-Inter.txt` |
| `JetBrainsMono-Variable.woff2`, `JetBrainsMono-Variable-Italic.woff2` | JetBrains Mono (variable: `wght` 100–800) | 2.304 | `fonts/variable/*.ttf` in [JetBrainsMono-2.304.zip](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304), repackaged as WOFF2 (fontTools, no glyph changes) | SIL OFL 1.1, `OFL-JetBrainsMono.txt` |
| `STIXTwoMath-Regular.woff2` | STIX Two Math (OpenType MATH table) | 2.13 b171 | `fonts/static_otf_woff2/` at tag [v2.13b171](https://github.com/stipub/stixfonts/tree/v2.13b171), unchanged | SIL OFL 1.1, `OFL-STIXTwo.txt` |
| `TwemojiMozilla.woff2` | Twemoji Mozilla (COLR/CPAL v0 colour emoji, Emoji 14) | 0.7.0 | `Twemoji.Mozilla.ttf` of [twemoji-colr v0.7.0](https://github.com/mozilla/twemoji-colr/releases/tag/v0.7.0), repackaged as WOFF2 with the copyright and licence added to its name table (IDs 0, 13, 14; fontTools, no glyph changes) | Artwork © Twitter, Inc. and other contributors, CC BY 4.0; build code Apache 2.0 (Mozilla). `LICENSE-Twemoji.md` |

SHA-256 of the downloads: Inter-4.1.zip `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`,
JetBrainsMono-2.304.zip `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`,
STIXTwoMath-Regular.woff2 `094191335def3f0452c81ec0713cfc2f29bb6af8cecbf79b60881fbf2db97562`,
Twemoji.Mozilla.ttf `6d90152ee0d29e82fe2a87793af5aa4b7ad13e6538360889e141e81ed299ee8e`.

Why these:

- **Inter**: a sans designed for screens with Latin, Greek and Cyrillic, every
  weight in one variable file, and tabular figures for charts. OFL 1.1 with no
  Reserved Font Name, so embedding a subset under its own name is allowed.
- **JetBrains Mono**: a code font with the same coverage, variable, OFL 1.1.
- **STIX Two Math**: one of the few fonts with an OpenType MATH table, which
  browsers need to lay out MathML (stretchy brackets, radicals, script sizes).
  OFL 1.1; its Reserved Font Name is "TM Math", not "STIX".
- **Twemoji (Mozilla's COLR build)**: colour emoji every browser draws, Safari
  included (COLRv1 fonts such as Noto Color Emoji draw nothing in Safari), at
  0.5 MB, and fontTools subsets it so a deck carries only its own emoji.
  The artwork is CC BY 4.0: credit is given here and in the font's name table
  (added here, the release has none), which every embedded subset keeps.

Not covered: Chinese, Japanese and Korean, Arabic, Hebrew, Indic and other
scripts (the browser falls back to the computer's fonts for those; put a font
for them in the deck's `fonts/` and name it in the theme to make them portable),
and emoji newer than Emoji 14.
