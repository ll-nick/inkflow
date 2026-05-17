# Inkflow

*A Linux-native presentation tool for people who live in the terminal.*

## What is Inkflow?

At this stage, Inkflow is more of an idea than a product. There is a working prototype that proves the pipeline end-to-end, but it is rough and missing most of what would make it genuinely usable. Whether it grows into something more is an open question.

If the concept resonates with you anyway, here it is:

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
from inkflow import Deck, Slide, Fade, Bounce

deck = Deck()
deck.slides = [
    Slide("slides/01-title.svg", animations=[
        Fade("#headline", step=1),
        Fade("#subtitle", step=2),
    ]),
    Slide("slides/02-diagram.svg", animations=[
        Bounce("#box-a", step=1),
        Bounce("#box-b", step=2),
    ]),
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
# Space / → : next step or slide
# ← / Backspace : previous slide
```

Requires Inkscape installed (used as the authoring environment, not invoked at serve time).

## Tech stack

- Python 3.11+, [uv](https://docs.astral.sh/uv/)
- [lxml](https://lxml.de/) for SVG processing
- [watchfiles](https://watchfiles.helpmanual.io/) for file watching
- [websockets](https://websockets.readthedocs.io/) for live reload
- Vanilla HTML/JS/CSS for the browser presenter
