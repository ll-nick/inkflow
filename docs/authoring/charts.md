# Charts

A chart plots a table of data on a slide: bars, lines, areas, dots or a pie.
The data lives in a plain file next to your slides (CSV, TSV or JSON), so it
diffs well in git and opens in any spreadsheet. inkflow draws the chart as SVG
when it builds the deck, which means the presenter, the static build, the PDF
export and the editor all show exactly the same chart, and no script runs in
the browser.

Charts take their colours and fonts from the deck's [theme](../design/themes.md):
series use the theme palette and text uses its text colours, so a chart follows
light and dark mode like everything else on the slide.

## A chart in a zone

`Chart` fills a [zone](slides.md#zones) the way `Image` does:

```python
from inkflow import Chart, ChartKind, Deck, Slide, animations


def main() -> Deck:
    return Deck(
        slides=[
            Slide(
                "media-right",
                md="results",
                zones={
                    "media": Chart(
                        "data/sales.csv",
                        kind=ChartKind.BAR,
                        x="quarter",
                        y=["revenue", "cost"],
                        title="Revenue and cost",
                        labels=True,
                    )
                },
            ),
        ]
    )
```

with `data/sales.csv`:

```text
quarter,revenue,cost
Q1 2025,120,84
Q2 2025,148,92
Q3 2025,171,101
Q4 2025,212,117
```

The first row names the columns. A cell that reads as a number (`1,234.5` and
`1e3` included) is a number, anything else is a label, and an empty cell is a
gap: a bar is left out, a line breaks.

The chart is drawn at the zone's size, its text at a size that suits the
slide's body text. Put the zone anywhere: in a [layout](../design/layouts.md),
or as a `<rect id="zone-sales">` in the slide's own SVG to place a chart
anywhere on one slide (the [visual editor](../editor/index.md#charts) does that
for you).

### Options

| Option | Default | |
|---|---|---|
| `src` | | The data file, relative to `deck.py`: `.csv`, `.tsv` or `.json` |
| `data` | | The columns written inline, instead of `src` |
| `kind` | `ChartKind.BAR` | `BAR`, `LINE`, `AREA`, `SCATTER` or `PIE` (a plain `"line"` works too) |
| `x` | first column | The column of categories (a scatter's x values, a pie's slices) |
| `y` | every other numeric column | The columns plotted, one series each (a pie uses the first) |
| `title` | none | A heading above the plot |
| `stacked` | `False` | Pile the series up (bar and area) |
| `horizontal` | `False` | Bars along the y axis, categories top to bottom |
| `labels` | `False` | Write each value at its bar, point or slice (a pie: its share) |
| `legend` | automatic | Shown when there is more than one series, and for a pie |
| `donut` | `False` | Cut the middle out of a pie |
| `y_min`, `y_max` | from the data | The value axis's ends (horizontal bars: the bottom axis) |
| `y2` | none | Columns plotted against a second value axis on the right |
| `y2_min`, `y2_max` | from the data | The right axis's ends |

Bars and areas always start at zero; lines and dots span their data. Axis
ticks are round numbers (steps of 1, 2 or 5 times a power of ten), written
compactly (`20K`, `1.5M`) once an axis reaches ten thousand.

### The axis range

`y_min` and `y_max` fix either end of the value axis; the other end still
follows the data. A fixed end is labelled with its own value, the round ticks
in between are kept, and whatever lies beyond it is cut off at the plot's edge
rather than drawn over the labels. Use it to zoom into a narrow band
(`y_min=90` for values between 92 and 98), or to give several charts the same
scale.

### A second axis

Two measures of different size (revenue in thousands, a margin in percent)
share a chart when the smaller one gets its own axis on the right:

```python
Chart(
    "data/sales.csv",
    kind=ChartKind.LINE,
    y=["revenue", "margin"],
    y2=["margin"],
    y2_min=0,
    y2_max=100,
)
```

`y2` names the columns measured on the right axis (they are plotted too, `y`
or not); the others stay on the left. In the legend each of them reads
`margin (right)`. Lines, areas, dots and bars side by side can have one;
stacked bars or areas and horizontal bars cannot (a stack has one scale), and
at least one series has to stay on the left.

### Data written inline

For a handful of numbers, skip the file:

```python
Chart(
    data={"year": [2022, 2023, 2024], "users": [120, 340, 910]},
    kind=ChartKind.LINE,
)
```

### JSON

A JSON file is either a list of records or a map of columns:

```json
[
    {"quarter": "Q1", "revenue": 120},
    {"quarter": "Q2", "revenue": 148}
]
```

```json
{"quarter": ["Q1", "Q2"], "revenue": [120, 148]}
```

## A chart in Markdown

A fenced block with the language `chart` draws a chart right in a slide's
Markdown. Its lines are `key: value` options (the same names as above, `y` as
a comma-separated list), and its data is a file (`data:`, relative to the
Markdown file) or a Markdown table written in the block. The axis options
are written `y_min: 0` or `y-min: 0`, and `y2: margin, rate` lists columns
like `y`:

````markdown
# Where it runs

```chart
kind: pie
donut: true
labels: true
| platform | share |
|----------|-------|
| Linux    | 48    |
| macOS    | 31    |
| Windows  | 21    |
```
````

````markdown
```chart
kind: line
x: month
y: visits, signups
title: Growth
data: ../data/growth.csv
```
````

The chart fills the zone's width and keeps a 16:9 shape; `aspect: 4:3` (or
`2`, `21/9`) gives it another. Two more options exist only here: `id`, the
chart's id (see below; default `chart`, `chart-2`… on one slide), and `aspect`.

A problem (a missing file, a column that is not there, an unknown option) is
drawn in the chart's place and reported like any other build warning, so the
slide still builds.

## Revealing series one by one

Every series is a group with a stable id, `<zone>-series-<column>`: the zone's
name, then the column's name in lowercase with anything but letters and digits
turned into `-` (letters, digits and `_` stay). A pie's slices are `<zone>-slice-<category>`. Animate them like
any other element:

```python
Slide(
    "two-cols",
    zones={"right": Chart("data/sales.csv")},
    animations=[
        animations.FadeIn("right-series-revenue"),
        animations.FadeIn("right-series-cost"),
    ],
)
```

A series' group holds its bars or line, its value labels and its legend entry,
so the legend fills in as the series appear. In Markdown, the chart's `id`
takes the zone's place (`chart-series-visits`). The axes are `<zone>-axes`.

## Editing the data

Change the file and the slide redraws: `inkflow serve` watches the whole deck
folder. In the [visual editor](../editor/index.md#charts), double-click a chart
to edit its data in a grid, or open its file in a spreadsheet with **Open ▾**.
