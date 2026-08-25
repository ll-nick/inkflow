<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-light-landscape.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-dark-landscape.svg">
    <img src="docs/assets/logo-dark-landscape.svg" width="80%">
  </picture>
</p>

<p align="center"><strong>Beautiful slides from SVG. Your editor, your style.</strong></p>

<p align="center">
  <a href="https://ll-nick.github.io/inkflow/demo/"><img src="docs/assets/demo-button.svg" alt="Try the live demo"></a>
  <a href="https://ll-nick.github.io/inkflow/"><img src="docs/assets/docs-button.svg" alt="Read the docs"></a>
</p>

> **Early-stage software.**
> Expect bugs, missing features, and breaking changes.

## The idea in under 40 seconds

[Watch on GitHub](https://github.com/user-attachments/assets/426628b3-817b-4861-b4eb-974bf9fdaf37)

<details>
<summary>Too fast? Too small? Click here for an explanation.</summary>

At first, `inkflow serve` is launched in the terminal in the bottom left.
It builds the slide deck and serves it to the browser.
Using the `o` key, the browser in the middle of the screen opens to the presentation.

After navigating to the second slide, the Inkscape editor on the right is used to edit the SVG the slide is based on.
The slide is automatically reloaded in the browser upon saving the file.

Using a morph transition, we move on to the third slide.
This one makes use of Markdown to fill in a predefined content zone in the SVG.

The terminal on the top left (*I use Neovim by the way*) shows the `deck.py` file.
It is where things like slide order, transitions, animations, and Markdown content are defined.
I then switch to the Markdown file referenced for slide three for a quick edit --- hot reloading the slide in the browser just like before.

That's it!
Take a look at the [demo](https://ll-nick.github.io/inkflow/demo/) for some more advanced examples you can try at your own pace.

</details>

## Why Inkflow?

Every presentation tool makes you choose.

**Visual editors** (PowerPoint, Keynote, Google Slides) give you a canvas.
Drag shapes, tweak spacing, iterate until it looks right.
But your work lives in proprietary formats tied to a platform or subscription,
and exporting to anything else means fighting a lossy conversion.

**Code-based tools** (Beamer, Slidev, reveal.js) keep everything as plain text.
Diffable, version-controlled, editor-agnostic.
But you describe layout in markup instead of drawing it.
Creativity suffers when moving a box means editing a number.

**Inkflow gives you both.**
Your authoring environment is a proper vector editor.
Draw freely, iterate visually.
Your source files are SVG, Markdown, and Python:
open formats, plain text, not tied to any software or service ---
fully compatible with version control and your favorite coding agent.

## How it works

1. **Draw each slide as an SVG.** Use Inkscape, Figma, or any editor that exports SVG.
   No special markup, no plugin — draw exactly as you normally would.
2. **List your slides in `deck.py`.** A small Python file says which slides to show,
   in what order, and which elements animate or transition in.
3. **Run `inkflow serve`.** A browser tab opens with your presentation. Save a change
   in your editor and it appears instantly, without losing your place.

That's the core loop --- the rest is there once you need it:
reusable layouts that inherit from each other like master slides,
Markdown-filled zones for text-heavy slides,
a presenter view with speaker notes,
one-command export to static HTML or PDF,
and more.

### An example `deck.py`

```python
from inkflow import (
    Deck,
    Image,
    MediaFit,
    Overlay,
    Slide,
    Video,
    animations,
    transitions,
)


def main() -> Deck:
    return Deck(
        # Elements, such as a logo, composited on top of every slide
        overlays=[Overlay("footer")],
        slides=[
            # SVG slide: draw freely in any editor, animate elements by id
            Slide(
                "title.svg",
                # Opt a single slide out of the deck's overlays
                overlays=[],
                # Animate individual elements by id
                animations=[
                    animations.FadeIn("headline"),
                    animations.FadeIn("subtitle"),
                ],
            ),
            Slide(
                "diagram.svg",
                # Fill predefined content zones using Markdown
                md="diagram.md",
                # Set a transition for this slide
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
                # Fill a named zone with an image or a video
                zones={"media": Image("assets/photo.jpg", fit=MediaFit.COVER)},
            ),
            Slide(
                "media-left",
                md="clip.md",
                zones={"media": Video("assets/demo.mp4", autoplay=True, loop=True)},
            ),
        ],
    )
```

```bash
inkflow serve   # open http://localhost:7777
```

When you run `inkflow serve`,
Inkflow reads the slides as defined in the Python file
and processes them into a web-based presentation.
It will inject the Markdown and media files into the SVGs,
apply the transitions and animations,
and serve the result to your browser.

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
cd inkflow/demo
uv run inkflow serve
```

No SVG editor is invoked at serve time. Inkscape or any other tool writes the files, Inkflow reads them.
Saving a slide reloads the presenter automatically.

## Acknowledgements

[Slidev](https://sli.dev) is an excellent presentation tool and a direct inspiration for this project.

This project was built making heavy use of coding agents and would not have been possible without them.
