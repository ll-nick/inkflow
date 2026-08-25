<div align="center" style="padding: 2rem 0 0.5rem;">
  <img src="assets/logo-dark-landscape.svg" alt="Inkflow" class="inkflow-logo-light" style="max-width: 500px; width: 70%;">
  <img src="assets/logo-light-landscape.svg" alt="Inkflow" class="inkflow-logo-dark" style="max-width: 500px; width: 70%;">
</div>

<p align="center"><strong>Beautiful slides from SVG. Your editor, your style.</strong></p>

---

## The idea in under 40 seconds

<video controls muted playsinline style="max-width: 100%;">
  <source src="assets/teaser.mp4" type="video/mp4">
</video>

??? note "Too fast? Too small? Click here for an explanation."
    At first, `inkflow serve` is launched in the terminal in the bottom left.
    It builds the slide deck and serves it to the browser.
    Using the `o` key, the browser in the middle of the screen opens to the presentation.

    After navigating to the second slide, the Inkscape editor on the right is used to edit the SVG the slide is based on.
    The slide is automatically reloaded in the browser upon saving the file.

    Using a morph transition, we move on to the third slide.
    This one makes use of Markdown to fill in a predefined content zone in the SVG.

    The terminal on the top left (*I use Neovim by the way*) shows the `deck.py` file.
    It is where things like slide order, transitions, animations, and Markdown content are defined.
    I then switch to the Markdown file referenced for slide three for a quick edit—hot reloading the slide in the browser just like before.

    That's it!
    Take a look at the [demo](demo/index.html) for some more advanced examples you can try at your own pace.

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
open formats, plain text, not tied to any software or service—fully compatible with version control and your favorite coding agent.

## How it works

1. **Draw each slide as an SVG.** Use Inkscape, Figma, or any editor that exports SVG.
   No special markup, no plugin—draw exactly as you normally would.
2. **List your slides in `deck.py`.** A small Python file says which slides to show,
   in what order, and which elements animate or transition in.
3. **Run `inkflow serve`.** A browser tab opens with your presentation. Save a change
   in your editor and it appears instantly, without losing your place.

That's the core loop—the rest is there once you need it:
reusable layouts that inherit from each other like master slides,
Markdown-filled zones for text-heavy slides,
a presenter view with speaker notes,
one-command export to static HTML or PDF,
and more.
Browse the [guides](guides/slides.md) or read [Concepts](concepts.md) for the full picture.

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

---

<div align="center" markdown>
[Demo](demo/index.html){ .md-button .md-button--primary }
[Get started](getting-started.md){ .md-button }
</div>

---

!!! note
    All guides are currently AI-generated drafts and may contain inaccuracies or incomplete information.
    I'll review them once the API stabilizes 

