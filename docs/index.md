<div align="center" style="padding: 2rem 0 0.5rem;">
  <img src="assets/logo-dark-landscape.svg" alt="Inkflow" class="inkflow-logo-light" style="max-width: 500px; width: 70%;">
  <img src="assets/logo-light-landscape.svg" alt="Inkflow" class="inkflow-logo-dark" style="max-width: 500px; width: 70%;">
</div>

<p align="center"><strong>Beautiful slides from SVG. Your editor, your style.</strong></p>

---

## Why Inkflow?

Every presentation tool makes you choose.

**Visual editors** (PowerPoint, Keynote, Google Slides) give you a canvas.
Drag shapes, tweak spacing, iterate until it looks right.
But your work lives in proprietary formats tied to a platform or subscription.

**Code-based tools** (Beamer, Slidev, reveal.js) keep everything as plain text.
Diffable, version-controlled, editor-agnostic.
But you describe layout in markup instead of drawing it.
Creativity suffers when moving a box means editing a number.

**Inkflow gives you both.**
Draw in any SVG editor.
Keep everything in plain text.

## How it works

1. **Draw each slide as an SVG.** Use Inkscape, Figma, or any editor that exports SVG.
   No special markup, no plugin — draw exactly as you normally would.
2. **List your slides in `deck.py`.** A small Python file says which slides to show,
   in what order, and which elements animate or transition in.
3. **Run `inkflow serve`.** A browser tab opens with your presentation. Save a change
   in your editor and it appears instantly, without losing your place.

That's the core loop — the rest is there once you need it:
reusable layouts that inherit from each other like master slides,
Markdown-filled zones for text-heavy slides,
a presenter view with speaker notes,
one-command export to static HTML or PDF,
and more.
Browse the [guides](guides/svg-slides.md) or read [Concepts](concepts.md) for the full picture.

## Quick example

```python
from inkflow import Deck, Slide, animations, transitions

def main() -> Deck:
    return Deck(slides=[
        Slide("title.svg", animations=[
            animations.FadeIn("#headline", step=1),
            animations.FadeIn("#subtitle", step=2),
        ]),
        Slide("diagram.svg", animations=[
            animations.Bounce("#box-a", step=1),
            animations.Bounce("#box-b", step=2),
        ], transition=transitions.Crossfade()),
        Slide("summary.svg", transition=transitions.Morph(duration=0.7)),
    ])
```

```bash
inkflow serve   # open http://localhost:7777
```

---

<div align="center" markdown>
[Demo](demo/index.md){ .md-button .md-button--primary }
[Get started](getting-started.md){ .md-button }
</div>

---

!!! note
    All guides are currently AI-generated drafts and may contain inaccuracies or incomplete information.
    I'll review them once the API stabilizes 

