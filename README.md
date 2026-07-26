<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-light-landscape.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-dark-landscape.svg">
    <img src="docs/assets/logo-dark-landscape.svg" width="80%">
  </picture>
</p>

<p align="center"><strong>Beautiful slides from SVG. Your editor, your style.</strong></p>

<p align="center">
  <a href="https://ll-nick.github.io/inkflow/demo/">
    <img src="docs/assets/demo-button.svg" alt="Try the live demo">
  </a>
</p>

> **Early-stage software.**
> Expect bugs, missing features, and breaking changes.

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
from inkflow import Deck, Image, MediaFit, Slide, Video, animations, transitions


def main() -> Deck:
    return Deck(
        slides=[
            # SVG slide: draw freely in Inkscape, animate elements by id
            Slide(
                "title.svg",
                # Each cue's Trigger decides when it fires (default: on next click)
                animations=[
                    animations.FadeIn("headline"),
                    animations.FadeIn("subtitle"),
                ],
            ),
            Slide(
                "diagram.svg",
                # Fill predefined content zones using Markdown
                md="diagram.md",
                # Set a transition for the whole slide, and multiple animations for individual elements
                transition=transitions.Crossfade(),
                animations=[
                    animations.Bounce("box-a"),
                    animations.Bounce("box-b"),
                ],
            ),
            Slide(
                # Reuse a built-in, theme or project-local layout
                "media-right",
                md="image.md",
                # Fill a named zone with an image, or a video with playback control
                # (autoplay, loop, mute, trim, and a PlayVideo cue to start on a step)
                zones={"media": Image("assets/photo.jpg", fit=MediaFit.COVER)},
            ),
            Slide(
                "media-left",
                md="clip.md",
                zones={"media": Video("assets/demo.mp4", autoplay=True, loop=True)},
            ),
        ]
    )
```

When you run `inkflow serve`, Inkflow reads the slides as defined in the Python file
and processes them into a web-based presentation.
It will inject the Markdown and media files into the SVGs, apply the transitions and animations, and serve the result to your browser.

## Quick start

```bash
uvx inkflow init my-deck # or: pip install inkflow && inkflow init my-deck
cd my-deck
uv run inkflow serve # or, without uv: inkflow serve
# press "o" in the tui to open http://localhost:7777 in your browser,
# press ? in the presenter for keyboard shortcuts
```

To try the bundled demo:

```bash
git clone https://github.com/ll-nick/inkflow
cd inkflow
uv run inkflow serve --deck demo/deck.py
```

No SVG editor is invoked at serve time. Inkscape or any other tool writes the files, Inkflow reads them.
Saving a slide reloads the presenter automatically.

## Acknowledgements

[Slidev](https://sli.dev) is an excellent presentation tool and a direct inspiration for this project.
It's a Node.js project with a very different architecture and feature set,
including many things Inkflow will never do.

This project was built making heavy use of coding agents and would not have been possible without them.
Does that make it "slopware"?
I'll let you be the judge of that but I can say that I try my best to keep the agents in check.
Every architectural decision is mine, there's a CI to ensure a certain level of code quality,
and before merging, I spend a good amount of time reviewing all changes in good old-fashioned manual labor.
