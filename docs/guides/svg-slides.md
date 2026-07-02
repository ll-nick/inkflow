# SVG slides

A `Slide` is the basic building block.
It wraps a single SVG file and declares which elements to animate
and how to transition in from the previous slide.

## Minimal example

```python
from inkflow import Deck, Slide

def main() -> Deck:
    return Deck(slides=[
        Slide("slides/01-title.svg"),
    ])
```

The SVG file is loaded as-is, stripped of editor metadata, and served.
No animations, no transition. Just the slide.

## Authoring in your SVG editor

The only convention slides must follow:
**any element you want to animate needs an ID.**

Set the ID via the XML editor (<kbd>Ctrl+Shift+X</kbd>) or the Object Properties dialog in Inkscape,
or the equivalent in any other editor.
IDs can be anything: `headline`, `box-a`, `arrow-pipeline`.
Avoid spaces. Hyphens and underscores are fine.

No other markup is required.
The SVG is a standard vector file.

## Animations

Animations reveal (or hide) elements on successive keypresses.
Each animation targets a single element by CSS selector (the `#id` form):

```python
from inkflow import Slide, animations

Slide("slides/01-title.svg", animations=[
    animations.FadeIn("#headline", step=1),
    animations.FadeIn("#subtitle", step=2),
    animations.FadeIn("#byline", step=3),
])
```

Elements with no animation declaration start **visible**.
Elements targeted by an entrance animation (`FadeIn`, `Bounce`, `SlideIn`, `ZoomIn`) start
**invisible** and appear when their step is reached.

### Animation types

Every type accepts `duration`, `easing`, and `delay` (keyword-only); some add their own
parameters. See the [manifest reference](../reference/manifest.md#animations) for the full
table.

| Class | Effect | Starting state |
|---|---|---|
| `FadeIn` | Opacity 0 → 1, subtle upward drift | Hidden |
| `FadeOut` | Opacity 1 → 0 | Visible |
| `Bounce` | Scale pulse on entry | Hidden |
| `SlideIn` / `SlideOut` | Slide from/to an edge (`direction`, `distance`) | Hidden / Visible |
| `ZoomIn` / `ZoomOut` | Scale into/out of place (`scale`) | Hidden / Visible |
| `Highlight` | Pulse a glow (`color`, `passes`), without hiding | Visible |

```python
animations.SlideIn("#box", step=1, direction="left", duration=0.6)
animations.ZoomIn("#logo", step=2, scale=0.6)
animations.Highlight("#total", step=3, color="#cba6f7", passes=2)
```

### The step model

Steps are integers starting at 1.
Multiple elements can share the same step and animate simultaneously:

```python
animations=[
    animations.FadeIn("#left-panel", step=1),
    animations.FadeIn("#right-panel", step=1),  # same step → animate together
    animations.FadeIn("#caption", step=2),
]
```

Step 0 (or omitting `step`) means the element is visible from the start
and participates in no animation.

## Transitions

A transition controls how the slide enters from the previous one.
Set it per slide, or set a default on the `Deck`:

```python
from inkflow import Deck, Slide, transitions

def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),  # default for all slides
        slides=[
            Slide("slides/01-title.svg"),                                   # uses Crossfade
            Slide("slides/02-diagram.svg", transition=transitions.Morph()), # overrides to Morph
        ],
    )
```

See [Transitions](transitions.md) for details on each type.

## Content injection

SVG slides support `zones` for injecting text or media into named zone elements.
This is useful when the SVG carries the visual design
but some text or media should live outside the SVG file:

```python
from inkflow import Media, Slide

Slide(
    "slides/01-title.svg",
    zones={
        "title": "My talk title",
        "media": Media("assets/headshot.jpg", fit="cover"),
    },
)
```

Keys in `zones` are zone names without the `zone-` prefix.
A `str` value is rendered as inline Markdown.
A `TextBox` value gives explicit control over alignment and padding from Python.
A `Media` value injects an image or video.
The pipeline replaces the matching `zone-*` rect with the injected content at build time.

## Per-slide styling

The `style` parameter injects a CSS `<style>` block into the slide's SVG at render time.
Use it as an escape hatch for one-off tweaks.
For systematic visual changes, use a theme.

```python
Slide("slides/01-title.svg", style="""
    #headline { font-size: 72px; fill: var(--inkflow-accent); }
""")
```

## Slide dimensions

Inkflow does not enforce a fixed canvas size.
Design your slides at whatever dimensions suit your presentation:
16:9, 4:3, square, portrait — the presenter scales to fill the available screen area automatically.

The built-in theme layouts are authored at **1920 × 1080** (16:9).
Slides that use them must share that coordinate space.
If you need a different aspect ratio, create layout SVGs at matching dimensions in your SVG editor;
the pipeline treats them identically.

PDF export auto-detects the page size from the first slide's `viewBox`.
You can override it if needed:

```bash
inkflow export --size 2560x1440
```

## Tips

- Keep element IDs short and semantic: `#title`, `#diagram-step-1`, `#callout`.
- Elements that should never animate don't need IDs.
- The pipeline strips editor metadata on every load.
  No need to clean manually if you have the git hook set up.
- SVGs from any editor (Figma export, Affinity Designer, hand-coded) work without pre-processing.
