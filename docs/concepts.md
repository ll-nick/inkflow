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
    return Deck(slides=[
        Slide("slides/01-title.svg", animations=[
            animations.FadeIn("#headline", step=1),
            animations.FadeIn("#subtitle", step=2),
        ]),
    ])
```

The manifest records intent, not rendering.
"Fade in element `#headline` at step 1" is a declaration.
The pipeline handles the CSS classes and timing.

## Slides and steps

A **slide** maps to one SVG file.
A **step** is a keypress within a slide.
Elements targeted by an animation start hidden and appear when their step is reached.

## SVG slides vs Markdown slides

The simplest slide is just an SVG file.
You draw everything in your editor, and Inkflow serves it as-is.

Two things SVG editors do not handle well: formatted text and video.
Text reflow, bullet lists, tables, and code blocks have no equivalent in SVG.
Video is simply not something an SVG file contains.
For both cases, Inkflow lets you mark a rectangular area in the SVG as a zone
by giving it an ID like `zone-title` or `zone-content`.
Inkflow replaces that rectangle with your content at build time.
You fill zones from `deck.py` using `TextBox` for text or `Media` for images and video.

When most of the slide content is text, pass a layout name and a `.md` file path to `Slide`:

```python
Slide("default", md="slides/02-intro.md")
```

Instead of a source SVG, the `src` is a layout name (or path) that defines zones but little else.
Inkflow renders the Markdown and fills the zones automatically.
Within the Markdown file, `::zone-name::` markers route sections to different zones,
and `::step::` markers split content into reveal steps.

Use `Slide` with an SVG path when the visual design is the point.
Use `Slide` with `md=` when the text content is the point.

## The layout system

Layouts are reusable SVG templates, similar to master slides in PowerPoint or Keynote.
A slide points to a parent layout SVG via the `inkflow:parent` attribute on the root `<svg>` element.
During the build process, Inkflow adds the layout as a background layer of the slide.
Inkflow's layout system is hierarchical: a layout can itself inherit from another layout.
```
slides/05-some-slide.svg   ← your slide, with content and animations
  ↑ inkflow:parent
layouts/content.svg         ← defines zone-title, zone-content
  ↑ inkflow:parent
theme/main.svg              ← background, brand elements (chain ends here)
```

Inkflow resolves the full chain at build time and composites the layers in memory.
The SVG files on disk are not modified.
`inject-layout` can optionally write locked preview layers into each SVG
so you can see the inherited background while editing in Inkscape.

## Themes

A theme is a directory that bundles a set of layouts and a CSS stylesheet.
It defines the visual identity of a deck: background, color palette, typography.
Inkflow ships with a built-in theme.
To use your own, point `Deck` at the directory:

```python
Deck(theme="./my-theme")
```

The CSS stylesheet is injected into every slide.
You can override individual variables or rules at the deck or slide level using the `style` parameter,
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

The browser presenter is a single HTML file with vanilla JS. No framework is used.
Slides are embedded as JSON.
Navigation and step animation are handled client-side.
The WebSocket connection listens for file changes and swaps slide content in place
(preserving the current slide index) without a full page reload.
