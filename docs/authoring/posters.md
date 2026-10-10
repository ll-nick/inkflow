# Posters and page sizes

A deck can be any size: a 16:9 talk, a 4:3 one, a phone-shaped 9:16 story, or
a sheet of paper. A conference poster is a deck of one slide on an A0 page:
drawn and written like any slide, checked in the browser, and exported as a
PDF at its printed size.

## Start a poster

```bash
inkflow init my-poster --poster            # A0 portrait
inkflow init my-poster --size a1-landscape # any paper size
```

or, in the [editor](../editor/index.md#new-decks-and-switching-between-them),
**deck ▾ → New deck…** with the **Poster** look and a paper size. Either way
the deck is:

```python
from inkflow import Deck, Image, Slide


def main() -> Deck:
    return Deck(
        title="My Poster",
        size="a0",
        slides=[
            Slide(
                "poster-3col",
                md="poster",
                zones={"logos": Image("figures/logo.svg")},
            ),
        ],
    )
```

with its sections in `slides/poster.md`, a chart plotted from
`data/results.csv`, a method figure and a logo placeholder in `figures/`.

## Sizes

`Deck(size=...)` sets the canvas new slides are drawn on and the page the PDF
prints at. A name, or a `PageSize` built for any other sheet:

| `size` | Canvas (units) | Page |
|---|---|---|
| `"16:9"` (default) | 1920 x 1080 | 1920 x 1080 px |
| `"16:10"`, `"4:3"`, `"1:1"` | 1728 x 1080, 1440 x 1080, 1080 x 1080 | the canvas in px |
| `"9:16"` (`"phone"`), `"3:4"` | 1080 x 1920, 1080 x 1440 | the canvas in px |
| `"a0"` … `"a5"` | 3179 x 4494 | 841 x 1189 mm … 148 x 210 mm |
| `"a0-landscape"` … | 4494 x 3179 | 1189 x 841 mm … |
| `"letter"`, `"legal"`, `"tabloid"` (`-landscape`) | 816 x 1056, … | 8.5 x 11 in, … |
| `PageSize.mm(600, 900)`, `.cm(…)`, `.inches(36, 48)` | the sheet at 96 units per inch | as given |
| `PageSize.px(1280, 720)` | 1280 x 720 | 1280 x 720 px |

```python
from inkflow import Deck, PageSize

Deck(size="a1-landscape")
Deck(size=PageSize.inches(36, 48))
```

Without a size a deck keeps each slide's own size and draws new slides at
16:9, as it always has. The rules behind the numbers:

- **Screens** keep 1080 units on the shorter side, the size the theme's type
  scale is drawn for, so text reads the same on a 16:9, 4:3 or 9:16 slide.
- **The A sizes share one canvas**, A0's at 1 unit = 1 CSS px (1/96 in). They
  are one shape at different scales, so a poster drawn once prints at any of
  them: set `size="a1"` and the A0 design prints on A1, everything in
  proportion. The layouts below are drawn on that canvas.
- **Other sheets** are their size at 1 unit = 1 CSS px.

Every new slide (the editor's **+ New slide**, `inkflow add`) takes the deck's
canvas, and the editor's thumbnails its shape. A slide drawn in another shape
is still shown, letterboxed; `inkflow verify` says so.

A paper size also makes the deck light (unless `mode=` or the theme says
otherwise) and gives it a print type scale.

## Layouts

Four built-in poster layouts, offered by the layout gallery to a poster deck
(a 16:9 deck gets the 16:9 ones, a deck's own layouts are always offered):

| Layout | Sheet | Body |
|---|---|---|
| `poster-3col` | portrait | three columns |
| `poster-2col` | portrait | two columns |
| `poster-landscape-3col` | landscape | three columns |
| `poster-landscape-4col` | landscape | four columns |

Each has a title band (zones `title`, `authors`, `affiliations` and a `logos`
picture zone) over an accent rule, the columns `col-1` to `col-4`, and a
footer with `references` and `contact` (a line of text or a QR code picture).
In Markdown a leading `# Title` goes to the title, the text after it to
`col-1`, and `::authors::`, `::col-2::`, `::references::` route the rest:

```markdown
# A Short Title That States the Finding

::authors::
**Ada Lovelace**¹, Charles Babbage²

::affiliations::
¹ University of Somewhere · ² Institute of Elsewhere

::col-1::
## Background

Two or three sentences on the problem.

::col-2::
## Results

![The method](../figures/method.svg)
```

`## Section` headings get the accent colour over a rule. Background in light
mode is paper white: a tinted page wastes ink and needs bleed.

## Typography

On paper, body text is the sheet's shorter side over 80: 30 pt on A0, 21 pt on
A1, 15 pt on A2, never below 10 pt (A4, letter). In units that is 40 on the A
canvas, and the poster layouts size everything in em of it:

| | em | A0 | A1 |
|---|---|---|---|
| Title | 3.4 | 102 pt | 72 pt |
| Section heading (`##`) | 1.75 | 52 pt | 37 pt |
| Body | 1 | 30 pt | 21 pt |
| References, contact | 0.8 | 24 pt | 17 pt |

Text follows the sheet, so an A1 poster is the A0 one scaled down: read from a
little closer. `Deck(font_size=...)` still sets the body size in units
(`font_size=44` on A0 is 33 pt).

## Figures and charts

- **Charts** ([`Chart`](charts.md) or a ```` ```chart ```` fence) draw their
  text at the body size on paper (0.6 of it on a screen): axis labels 24 pt on
  A0. They are vector, so they print sharp at any size.
- **Figures from a paper**: a [PDF figure](pdf-figures.md) stays vector, as
  does an SVG. Prefer them to screenshots.
- **Photos** need pixels: at least 150 dpi at their printed size (a picture
  30 cm wide wants 1800 px). `inkflow render --check` reports any below.

## Check it

```bash
inkflow verify          # slides of another shape than the deck's
inkflow render --check  # text and pictures, measured as printed
inkflow render          # a PNG to look at
```

On a print deck `inkflow render` measures the slide as printed:

- text in points against the sheet's body size: below 0.6 of it is a hint
  (18 pt on A0), body text (paragraphs, lists, tables) below 0.8 of it (24 pt);
- every raster picture's resolution at its printed size: below 150 dpi a hint
  (it prints soft), below 100 dpi a problem (pixelated). SVG and PDF figures are
  never low resolution.

Slides of a deck without a size are checked this way when their SVG is drawn
on paper (`width="841mm"`).

## Export

```bash
inkflow export                          # deck.pdf, A0 at 841 x 1189 mm
inkflow export --size a1                # the same poster on A1
inkflow export --bleed 3mm --crop-marks # for a print shop that asks
```

or **Export → PDF** in the editor, which shows the page and offers "3 mm bleed
and crop marks". See [Export](../presenting/export.md#page-size) for the
details.

## Printing tips

- Send the PDF **at its final size**: the page is the sheet, so the shop
  prints it 1:1 without guessing a scale.
- The PDF is **RGB**, as screens are. Every poster printer accepts it; a shop
  that wants CMYK converts it with its own profile. Very bright greens and
  blues may print a little duller than on screen.
- Ask whether the shop wants **bleed**. A poster on a white background needs
  none; one whose background runs to the edge does: `--bleed 3mm --crop-marks`.
- **Print a proof** on A4 or A3 first (`--size a4`): the whole layout shrinks
  in proportion, so what is cramped there is cramped on the poster too.
- Fonts are embedded and subset; text stays selectable and searchable.
