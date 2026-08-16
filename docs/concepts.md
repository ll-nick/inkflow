# Concepts

This page explains the mental model behind Inkflow.
Reading it first makes everything else click faster.

## Your project has two things

**Your drawings:** SVG files, one per slide.
Open them in any editor, draw freely, save.
Plain `Slide` files carry no Inkflow-specific markup at all.
The one exception is slides that use the layout system: they carry an `inkflow:parent` attribute on the SVG root
that tells Inkflow which layout SVG to inherit from.
This is covered in the layout system section below.

**Your deck:** `deck.py`, a plain Python file.
It says which slides to show, in what order, and which elements to animate.
It references SVGs by path and elements by ID.
The SVG files themselves are not modified.

Inkflow reads both at serve time and connects them in memory.
Nothing on disk changes.

## The deck manifest

`deck.py` is a plain Python module that defines a `main()` function returning a `Deck`.
Inkflow calls it with `importlib` at serve time.
This means you get full Python: loops, conditionals, variables, imports.

```python
from inkflow import Deck, Slide, animations


def main() -> Deck:
    return Deck(
        slides=[
            Slide(
                "title.svg",
                animations=[
                    animations.FadeIn("headline"),
                    animations.FadeIn("subtitle"),
                ],
            ),
        ]
    )
```

The above example is a single slide with two animated elements: `headline` and `subtitle`.

!!! warning "Decks are executable code"
    A `deck.py` is a Python program that Inkflow imports and runs. Serving,
    building, or exporting a deck executes it. Only run decks you trust.

## Slides and steps

A **slide** maps to one SVG file.
A **step** is a keypress within a slide.
Each animation declares a `Trigger` (the default `ON_CLICK` takes the next
step, `WITH_PREVIOUS` shares the previous one, `AFTER_PREVIOUS` shares it but
plays itself once the previous cue finishes), and Inkflow works out the step
numbers from the triggers and order.

## Zones and Markdown

`Slide.src` always points at an SVG file.
The simplest slide is just that SVG: you draw everything in your editor, and
Inkflow serves it as-is.

Two things SVG editors do not handle well: formatted text and video.
Text reflow, bullet lists, tables, and code blocks have no equivalent in SVG.
Video is simply not something an SVG file contains.
For both cases, Inkflow lets you mark an area in the SVG as a zone
by giving it an ID like `zone-title` or `zone-content`.
Inkflow replaces that element with your content at build time.
You fill zones from `deck.py` using `TextBox`, `Image`, or `Video` objects
that specify the content for each zone:

```python
Slide(
    "content.svg",
    zones={
        "title": TextBox("Hello world"),
        "content": Image("assets/photo.jpg"),
    },
)
```

One shortcut for slides with mostly `TextBox` content is to use the `md=` parameter on `Slide`:

```python
Slide("content", md="intro")
```

This uses `slides/intro.md` to fill the zones defined in a slide or layout (see below) called `content.svg`.
See the [guide](guides/slides.md) for details on what these Markdown files can contain and how they map to zones.

## The layout system

Layouts are reusable SVG templates, similar to master slides in PowerPoint or Keynote.
A slide points to a parent layout SVG via the `inkflow:parent` attribute on the root `<svg>` element.
During the build process, Inkflow adds the layout as a background layer of the slide.
Inkflow's layout system is hierarchical: a layout can itself inherit from another layout.
```
slides/some-slide.svg   ← your slide, with content and animations
  ↑ inkflow:parent
layouts/content.svg     ← defines zone-title, zone-content
  ↑ inkflow:parent
theme/main.svg          ← background, brand elements (chain ends here)
```

Inkflow resolves the full chain at build time and composites the layers in memory.
The SVG files on disk are not modified.
[`inkflow sync`](reference/cli.md#inkflow-sync) can optionally write locked preview layers into each SVG
so you can see the inherited background while editing in Inkscape.

## Overlays

Inheritance answers "what am I built on", and composites behind a slide.
Elements that cut across layouts, such as a brand logo, ask a different question:
"what goes on top of every slide, regardless of what it is built on".

Overlays are that second axis.
They live in `overlays/`, are listed on the deck, and composite above the finished slide:

```python
Deck(
    overlays=[Overlay("footer"), Overlay("logo")],
    slides=[Slide("title.svg", overlays=[]), Slide("content", md="intro.md")],
)
```

Overlays can inherit from other overlays.
See the [layout system guide](guides/layout-system.md#overlays) for the full picture.

## Themes

A theme bundles a color palette, typography setting, a set of layouts,
overlays, a CSS stylesheet, and/or custom JavaScript.
It's a regular Python class that subclasses `inkflow.themes.Theme`.
By default, a deck uses the built-in theme.
To use your own, point `Deck` at it:

```python
from my_package import MyTheme

Deck(theme=MyTheme())
```

The CSS stylesheet is injected into every slide.
You can override individual variables or rules at the deck using the `style` parameter,
or at the slide level using the `extra_style` parameter,
without touching the theme files.
Themes can opt-in to provide light/dark-mode variants which can be toggled in the presenter.

## The pipeline

When you run `inkflow serve`, Inkflow reads `deck.py` to get the slide list,
then processes each SVG in memory: stripping editor metadata, resolving the layout chain,
injecting zone content, and annotating animated elements.
The result is served to the browser.
Nothing on disk is touched.

## No SVG editor at runtime

The pipeline reads plain SVG with lxml.
No editor subprocess, no GUI window, no spawned processes.
Any SVG editor that exports well-formed SVG works as an authoring environment.

## The presenter

The browser presenter is a single HTML file with vanilla JavaScript.
No framework is used.
Slides are embedded as JSON.
Navigation and step animation are handled client-side.
The WebSocket connection listens for file changes and swaps slide content in place
(preserving the current slide index) without a full page reload.
Launching multiple browser windows connects them all to the same WebSocket and stay in sync by default.
Open a second window and press `p` to see the presenter view with notes and upcoming slides.
