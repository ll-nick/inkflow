# SVG slides

A `Slide` is the basic building block.
It wraps a single SVG file and declares which elements to animate
and how to transition in from the previous slide.

## Minimal example

```python
from inkflow import Deck, Slide

deck = Deck()
deck.slides = [
    Slide("slides/01-title.svg"),
]
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
from inkflow import Crossfade, Deck, Morph, Slide

deck = Deck(transition=Crossfade())  # default for all slides

deck.slides = [
    Slide("slides/01-title.svg"),                        # uses Crossfade
    Slide("slides/02-diagram.svg", transition=Morph()),  # overrides to Morph
]
```

See [Transitions](transitions.md) for details on each type.

## Content injection

SVG slides support the same `TextBox` and `Media` content injection as `MarkdownSlide`.
This is useful when the SVG carries the visual design
but some text or media should live outside the SVG file:

```python
from inkflow import Media, Slide, TextBox

Slide(
    "slides/01-title.svg",
    content=[
        TextBox(element="zone-title", text="My talk title"),
        Media("assets/headshot.jpg", fit="cover", element="zone-media"),
    ],
)
```

The `element` field on `TextBox` and `Media` targets a `zone-*` rect in the SVG by ID.
The pipeline replaces it with a `<foreignObject>` (for text) or an `<img>`/`<video>` (for media) at build time.

## Per-slide styling

The `style` parameter injects a CSS `<style>` block into the slide's SVG at render time.
Use it as an escape hatch for one-off tweaks.
For systematic visual changes, use a theme.

```python
Slide("slides/01-title.svg", style="""
    #headline { font-size: 72px; fill: var(--inkflow-accent); }
""")
```

## Tips

- Keep element IDs short and semantic: `#title`, `#diagram-step-1`, `#callout`.
- Elements that should never animate don't need IDs.
- The pipeline strips editor metadata on every load.
  No need to clean manually if you have the git hook set up.
- SVGs from any editor (Figma export, Affinity Designer, hand-coded) work without pre-processing.
