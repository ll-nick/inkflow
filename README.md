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
I then switch to the Markdown file referenced for slide three for a quick edit—hot reloading the slide in the browser just like before.

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
open formats, plain text, not tied to any software or service—fully compatible with version control and your favorite coding agent.

## How it works

1. **Draw each slide as an SVG.** Use Inkscape, Figma, or any editor that exports SVG.
   No special markup, no plugin—draw exactly as you normally would.
2. **List your slides in `deck.py`.** A small Python file says which slides to show,
   in what order, and which elements animate or transition in.
3. **Run `inkflow serve`.** A browser tab opens with your presentation. Save a change
   in your editor and it appears instantly, without losing your place.

Prefer to click and drag? **`inkflow edit`** opens a [visual editor](#the-visual-editor)
in the browser that writes every change straight back to the same files.

That's the core loop—the rest is there once you need it:
reusable layouts that inherit from each other like master slides,
Markdown-filled zones for text-heavy slides,
a presenter view with speaker notes,
one-command export to a single self-contained HTML file or a PDF,
and more.
Inkflow ships its fonts (Inter, JetBrains Mono, STIX Two Math for formulas,
Twemoji for emoji) and embeds every font a deck uses,
so a deck looks the same on every computer, offline included.

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

## The visual editor

<p align="center">
  <img src="docs/assets/editor.png" alt="The inkflow editor: the slide list, a diagram slide with a selected box and the arrows attached to it, the properties panel with its animation, and the speaker notes" width="100%">
</p>

`inkflow edit` opens a slide editor in the browser, in the spirit of PowerPoint and Google Slides.
There is no project format of its own: every change goes straight back into the deck's
SVG, Markdown and `deck.py` files, so Inkscape, your text editor and
[Claude Code](https://ll-nick.github.io/inkflow/editor/claude-code/) work on the same deck
at the same time and see each other's changes live.

- **Draw and arrange.** Shapes, text boxes that wrap, lines and arrows that stay attached to
  their shapes (straight, elbow or curved), smart guides, groups, copy-by-dragging and a
  format painter. Pictures with crop, figures straight from a PDF page (a paper backing
  keeps a black-on-white plot readable on a dark slide); videos of any size and, with
  ffmpeg, any format. Bigger diagrams open in [draw.io](https://www.drawio.com), kept as
  editable SVG and drawn into the slide in the theme's font and colours.
- **Charts from data.** Bar, line, area, scatter and pie charts plotted from a CSV kept in
  the deck, edited in a spreadsheet-like grid with a live preview, drawn in the theme's
  colours, with fixed axis ranges and a second axis when you need them.
- **Draw with a pen.** Pressure-sensitive ink, highlighter and eraser, on the slide in the
  editor or live while presenting; kept as plain vector paths in the deck, or gone when you
  move on.
- **Type on the slide.** Rich text with lists, tables, links and LaTeX formulas, saved as Markdown.
- **Any size, posters too.** 16:9, 4:3, phone-shaped 9:16, or paper from A0 to letter:
  poster layouts with a print type scale, checks for text and pictures too small for print,
  and a PDF at the exact printed size, with bleed and crop marks when a print shop asks.
- **Layouts and themes.** Start slides from a layout gallery, edit the shared layouts, pick
  one of three built-in themes (the Catppuccin default, quiet white *Paper*, big-type
  *Stage*) and set the deck's colours and fonts in a theme dialog.
- **Animations, transitions and notes** from the properties panel; preview each build step,
  then present from the current slide (and come back with <kbd>Shift</kbd>+<kbd>E</kbd>).
- **Decks and git.** A start page for new and recent decks, commit/push/pull with Git LFS
  for media, export to HTML or PDF, copy slides between decks, find and replace, and undo
  for every change.

```bash
inkflow edit             # the deck in this folder (or: --deck path/to/deck.py)
inkflow edit --start     # no deck yet: create one, open one, or pick a recent one
inkflow setup-desktop    # add Inkflow to your application menu
```

See the [editor guide](https://ll-nick.github.io/inkflow/editor/) for everything it does.

A coding agent gets the same deck through the command line: `inkflow outline` sums it up
in a few lines per slide, `inkflow slide add/move/delete …` changes the slide list with
every file it touches (an undoable step in the open editor), `inkflow shape …` draws
shapes, text boxes and attached arrows exactly as the editor does, and `inkflow render --check`
reports text that overflows its box or objects off the slide, with `--sheet` for all
slides in one image ([Editing with Claude Code](https://ll-nick.github.io/inkflow/editor/claude-code/)).

## Quick start

```bash
uvx inkflow init my-deck # or: pip install inkflow && inkflow init my-deck
cd my-deck
uv run inkflow serve # or, without uv: inkflow serve
# press "o" in the tui to open http://localhost:7777 in your browser,
# press ? in the presenter for keyboard shortcuts
uv run inkflow edit  # or open the visual editor instead
```

To try the bundled demo:

```bash
git clone https://github.com/ll-nick/inkflow
cd inkflow/demo
uv run inkflow serve
```

**PDF figures** from a paper go on a slide as they are (vector, with their own fonts).
The easiest way to show them is the `pdf` extra, one install on any system:
`pip install "inkflow[pdf]"` (or `uv add "inkflow[pdf]"` in a deck's folder).
It brings in PyMuPDF, which is AGPL-3.0 (or commercially licensed by Artifex);
Inkflow itself stays MIT and never requires it. Poppler's `pdftocairo`, MuPDF's
`mutool` or Inkscape work instead, with nothing to add.
See [PDF figures](https://ll-nick.github.io/inkflow/authoring/pdf-figures/).

No SVG editor is invoked at serve time. Inkscape or any other tool writes the files, Inkflow reads them.
Saving a slide reloads the presenter automatically.

## Acknowledgements

[Slidev](https://sli.dev) is an excellent presentation tool and a direct inspiration for this project.

Inkflow ships these fonts, each under its own licence (see `src/inkflow/theme/fonts/`):
[Inter](https://rsms.me/inter/) by Rasmus Andersson and
[JetBrains Mono](https://www.jetbrains.com/lp/mono/) by JetBrains (both SIL OFL 1.1),
[STIX Two Math](https://www.stixfonts.org/) by the STIX Fonts Project (SIL OFL 1.1), and
[Twemoji](https://github.com/twitter/twemoji) by Twitter, Inc and other contributors
(graphics CC BY 4.0, in [Mozilla's COLR font build](https://github.com/mozilla/twemoji-colr)).

This project was built making heavy use of coding agents and would not have been possible without them.
