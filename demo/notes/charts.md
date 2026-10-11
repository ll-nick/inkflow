Both charts are drawn at build time from data in git-friendly files, in the
deck's own colours: switch to light mode and they follow.

The donut on the left is a ```` ```chart ```` fence in `slides/charts.md`, its
data a Markdown table right there. The bars on the right are
`Chart("data/sales.csv")` in `deck.py` filling the layout's `right` zone, and
each series is revealed by a `FadeIn("right-series-revenue")` cue: every series is a group with its own id.

Edit `data/sales.csv` (or double-click the chart in the editor) and the slide
redraws.
