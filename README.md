<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-light-landscape.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-dark-landscape.svg">
    <img src="docs/assets/logo-dark-landscape.svg" width="80%">
  </picture>
</p>

<p align="center"><strong>Beautiful slides from SVG. Your editor, your style.</strong></p>

> **Early-stage software.**
> The core pipeline works end-to-end:
> animations, transitions, live reload, markdown slides, static export.
> The API is not stable and key features are still missing.
> Use at your own risk.

## The idea

Every presentation tool makes you choose.

**Visual editors** (PowerPoint, Keynote, Google Slides) give you a canvas.
Drag shapes, resize freely, iterate until it looks right.
But your work lives in proprietary formats tied to a platform or subscription,
and exporting to anything else means fighting a lossy conversion.

**Code-based tools** (Beamer, Slidev, reveal.js) keep everything as plain text.
Files are diffable, version-controlled, reproducible.
But you describe layout in markup instead of drawing it.
Creativity suffers when moving a box means editing a coordinate.
The blank page is a text cursor, not a canvas.

**Inkflow gives you both.**
Your authoring environment is a proper vector editor.
Draw freely, iterate visually.
Your source files are SVG, Markdown, and Python: open formats, plain text, not tied to any software or service.

## How it works

A deck is a plain Python file:

```python
from inkflow import Bounce, Crossfade, Cut, Deck, FadeIn, MarkdownSlide, Media, Morph, Slide

deck = Deck()

deck.slides = [
    # SVG slide: draw freely in Inkscape, animate elements by id
    Slide(
        "slides/01-title.svg",
        animations=[
            FadeIn("#headline", step=1),
            FadeIn("#subtitle", step=2),
        ],
    ),
    Slide("slides/02-diagram.svg", transition=Crossfade(), animations=[
        Bounce("#box-a", step=1),
        Bounce("#box-b", step=2),
    ]),
    Slide("slides/03-chart.svg", transition=Morph(duration=0.7)),

    # Markdown slide: write content in .md, render into a layout SVG
    MarkdownSlide("layouts/content.svg", content="slides/04-notes.md"),
    MarkdownSlide(
        "layouts/media-right.svg",
        content="slides/05-image.md",
        media=Media("assets/photo.jpg", fit="cover"),
    ),
]
```

Both slide types support injecting content into named SVG elements:
`TextBox` to fill a text placeholder, `Media` to embed an image or video.
`Slide` is SVG-first: the SVG carries the design, with optional content slots for dynamic parts.
`MarkdownSlide` is layout-first: a template SVG defines the structure,
a Markdown file provides the text, and named kwargs fill any additional slots.
It is shorthand for the common case, built on the same injection mechanism.

## Quick start

```bash
uv add inkflow # or: pip install inkflow
inkflow serve deck.py
# press "o" in the tui to open http://localhost:7777 in your browser,
# press ? in the presenter for keyboard shortcuts
```

To try the bundled demo:

```bash
git clone https://github.com/ll-nick/inkflow
cd inkflow
uv run inkflow serve demo/deck.py
```

No SVG editor is invoked at serve time. Inkscape or any other tool writes the files, Inkflow reads them.
Saving a slide reloads the presenter automatically.

## Commands

| Command | Description |
|---|---|
| `inkflow serve deck.py` | Start the live-reload presenter |
| `inkflow build deck.py` | Export a self-contained HTML directory for offline use |
| `inkflow export deck.py` | Export a PDF via headless Chromium |

## Architecture

- **`deck.py`:** Python manifest. Gives you autocomplete and programmatic slide generation for free
- **SVG pipeline:** lxml strips Inkscape editor metadata,
  then annotates elements with CSS animation classes and `data-step` attributes based on the manifest
- **Layout system:** `MarkdownSlide` injects Markdown content into layout SVGs.
  Built-in theme layouts cover common slide types
- **Local server:** asyncio HTTP server serves the presenter HTML with slides embedded as JSON.
  A WebSocket server pushes live-reload signals when files change
- **Browser presenter:** vanilla HTML/JS/CSS, no framework

## Acknowledgements

[Slidev](https://sli.dev) is an excellent presentation tool and a direct inspiration for this project.
It's built on Vue and is capable of making full use of your browser's features
including many things Inkflow will never do.

This project was built making heavy use of coding agents.
Does that make it "slopware"?
I'll let you be the judge of that, but every architectural decision is mine
and every line of code has been reviewed in good old-fashioned manual labor.
(Take the latter with a grain of salt:
When it comes to frontend stuff,
I really have no clue what I'm doing)
