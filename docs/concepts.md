# Concepts

This page explains the mental model behind Inkflow.
Reading it first makes everything else click faster.

## The three-layer model

An Inkflow project has three layers:

```
deck.py          ← what to show, in what order, with what animations
slides/*.svg     ← the visual content (your drawings)
pipeline         ← connects the two: strips editor metadata, injects animation hooks, serves
```

None of these layers knows too much about the others.
The SVGs are plain vector files. No Inkflow-specific markup is required.
The `deck.py` references elements by their SVG ID.
The pipeline is invisible during authoring.

## The deck manifest

`deck.py` is a plain Python module that assigns a `Deck` instance to the module-level variable `deck`.
Inkflow loads it with `importlib` at serve time.
This means you get full Python: loops, conditionals, variables, imports.

```python
from inkflow import Deck, FadeIn, Slide

deck = Deck()
deck.slides = [
    Slide("slides/01-title.svg", animations=[
        FadeIn("#headline", step=1),
        FadeIn("#subtitle", step=2),
    ]),
]
```

The manifest records intent, not rendering.
"Fade in element `#headline` at step 1" is a declaration.
The pipeline handles the CSS classes and timing.

## Slides and steps

A **slide** maps to one SVG file.
A **step** is a keypress within a slide.
Elements start invisible and become visible on their declared step.

```
Slide 1 — initial state: nothing visible
Slide 1, step 1: #headline fades in
Slide 1, step 2: #subtitle fades in
→ (advance past step 2) → Slide 2
```

The last step on a slide and the first step on the next slide are separated by the same keypress.
Inkflow handles the transition automatically.

## SVG slides vs Markdown slides

There are two slide types:

**`Slide`**: a raw SVG file.
You draw everything in your editor.
Animations target elements by ID.

**`MarkdownSlide`**: an SVG *template* (called a layout) with named rectangular placeholder zones.
You write the text content in a `.md` file.
The pipeline injects it as HTML into the zones at build time.

Use `Slide` when the visual design is the point (diagrams, custom layouts, illustration-heavy slides).
Use `MarkdownSlide` when you're writing prose, bullet lists, or code blocks
and want the text to live outside the SVG.

## The layout system

Layouts are reusable SVG templates.
A layout defines **zones**: `<rect>` elements with `id="zone-title"`, `id="zone-content"`, etc.,
that mark where content will be placed.
The pipeline replaces each zone rect with a `<foreignObject>` containing the rendered HTML.

Layouts can inherit from other layouts via the `inkflow:parent` attribute on the SVG root:

```
slides/05-bullets.svg
  ↑ inkflow:parent
layouts/content.svg         ← defines zone-title, zone-content
  ↑ inkflow:parent
theme/main.svg              ← background, brand elements (no parent — chain terminates)
```

The pipeline resolves the full chain at build time.
The SVG files on disk stay clean.
`inject-layout` can optionally write locked preview layers into each SVG
so you can see the inherited background while editing.

## The pipeline

When you run `inkflow serve deck.py`, the pipeline:

1. Loads `deck.py` to get the slide list.
2. For each slide:
    - Parses the SVG with lxml.
    - Strips Inkscape/Sodipodi editor namespaces.
    - Resolves the layout chain and inlines ancestor layers.
    - For `MarkdownSlide`, renders the `.md` file and injects HTML into zone rects.
    - Adds `class` and `data-step` attributes to animated elements.
3. Serialises each SVG to a string.
4. Embeds all slides as JSON in the presenter HTML.
5. Serves via HTTP on port 7777, with live WebSocket updates on port 7778.

The SVG files on disk are never modified by the pipeline.
All transformations happen in memory.

## No SVG editor at runtime

The pipeline reads plain SVG with lxml. No editor subprocess, no GUI window, no spawned processes.
Any SVG editor that exports well-formed SVG works as an authoring environment.

## The presenter

The browser presenter is a single HTML file with vanilla JS. No framework is used.
Slides are embedded as JSON.
Navigation and step animation are handled client-side.
The WebSocket connection listens for file changes and swaps slide content in place
(preserving the current slide index) without a full page reload.

Transitions are CSS-based (Cut, Crossfade) or rAF-loop-based (Morph).
The Morph transition interpolates SVG geometry attributes directly in SVG user units rather than CSS pixels,
which avoids coordinate gaps from viewBox scaling.
Interpolated attributes are `x`, `y`, `width`, `height`, `rx` for rects and `cx`, `cy`, `r` for circles.
