<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark-landscape.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light-landscape.svg">
    <img src="assets/logo-light-landscape.svg" width="80%">
  </picture>
</p>

# Inkflow

**Beautiful slides from SVG. Your editor, your style.**

## What is Inkflow?

Inkflow is early-stage but functional: the full pipeline works end-to-end, step animations run,
a couple of transitions are implemented, and live reload is in place.
It's still missing quite a few key features and the config spec is far from final
so you should probably not be using this tool at the current stage.

## The idea

Existing presentation tools on Linux all make the same tradeoff: either you get a nice visual authoring environment (LibreOffice Impress, Google Slides) or you get something that plays well with version control and plaintext workflows (Beamer, Slidev, reveal.js). You rarely get both, and you almost never get freeform visual design with git-friendly source files and animated, sequenced output.

Inkflow tries to bridge that gap. The authoring environment is **Inkscape** — a full vector editor where you can draw anything you want. The presentation layer is a **Python pipeline** that turns those SVG files into an animated, browser-based presenter. The source files are SVGs and a Python config file: plaintext, diffable, git-trackable.

## How it works

```
my-talk/
  deck.py             ← the manifest: slide order, animations, steps
  slides/
    01-title.svg
    02-diagram.svg
  out/                ← build artifacts, gitignored
```

`deck.py` is a plain Python file that declares the deck:

```python
from inkflow import Bounce, Crossfade, Cut, Deck, FadeIn, Morph, Slide

deck = Deck(main=None)
deck.slides = [
    Slide("slides/01-title.svg", animations=[
        FadeIn("#headline", step=1),
        FadeIn("#subtitle", step=2),
    ]),
    Slide("slides/02-diagram.svg", transition=Cut(), animations=[
        Bounce("#box-a", step=1),
        Bounce("#box-b", step=2),
    ]),
    Slide("slides/03-chart.svg", transition=Crossfade()),
    Slide("slides/04-summary.svg", transition=Morph(duration=0.7)),
]
```

Running `inkflow serve deck.py` starts a local server, opens the presenter in the browser, and watches the project directory. Saving a slide in Inkscape reloads the presenter automatically.

The presenter handles keyboard navigation and step-based animation.

## Architecture

- **`deck.py`** — Python manifest; gives you autocomplete and programmatic slide generation for free
- **SVG pipeline** — lxml strips Inkscape editor metadata from saved SVGs, then annotates elements with CSS animation classes and `data-step` attributes based on the manifest
- **Local server** — asyncio HTTP server serves the presenter HTML with slides embedded as JSON; a WebSocket server pushes live-reload signals when files change
- **Browser presenter** — vanilla HTML/JS/CSS, Catppuccin Mocha color scheme, no framework

## Running the example

```bash
git clone ...
cd inkflow
uv run inkflow serve example/deck.py
# open http://localhost:7777
```

Type `?` in the presenter for keyboard shortcuts.

Inkscape is the authoring environment; it is not invoked at serve time.

## Tech stack

- Python 3.11+, [uv](https://docs.astral.sh/uv/)
- [lxml](https://lxml.de/) for SVG processing
- [watchfiles](https://watchfiles.helpmanual.io/) for file watching
- [websockets](https://websockets.readthedocs.io/) for live reload
- Vanilla HTML/JS/CSS for the browser presenter
