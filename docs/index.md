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

## Core ideas

| Concept | What it means |
|---|---|
| **SVG source** | One SVG file per slide. Works with Inkscape, Figma, or any other SVG editor. |
| **`deck.py` manifest** | A plain Python file that declares slide order, animations, and transitions. |
| **Pipeline** | Strips editor metadata, injects animation classes, serves everything over HTTP + WebSocket. |
| **Live reload** | Save a file in your editor. The browser updates in place, preserving your slide position. |
| **Layouts** | Reusable SVG templates with content zones. Write the text in Markdown, not in the SVG. |

## Quick example

```python
from inkflow import Deck, Slide, animations, transitions

def main() -> Deck:
    return Deck(slides=[
        Slide("slides/01-title.svg", animations=[
            animations.FadeIn("#headline", step=1),
            animations.FadeIn("#subtitle", step=2),
        ]),
        Slide("slides/02-diagram.svg", animations=[
            animations.Bounce("#box-a", step=1),
            animations.Bounce("#box-b", step=2),
        ], transition=transitions.Crossfade()),
        Slide("slides/03-summary.svg", transition=transitions.Morph(duration=0.7)),
    ])
```

```bash
inkflow serve deck.py   # open http://localhost:7777
```

---

!!! note
    The Guides and Reference sections are currently AI-generated drafts and may contain inaccuracies or incomplete information.
    I'll review and update them at some point.
    The getting-started guide and the concepts page have been reviewed and are accurate.

[Get started →](getting-started.md){ .md-button .md-button--primary }
[Read the concepts →](concepts.md){ .md-button }
