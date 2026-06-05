# Transitions

A transition controls how a slide enters from the previous one.
Inkflow has three built-in transition types.

## Setting transitions

Set a default transition for the whole deck on the `Deck` object,
and override per slide as needed:

```python
from inkflow import Crossfade, Cut, Deck, Morph, Slide

deck = Deck(transition=Crossfade())  # default

deck.slides = [
    Slide("slides/01-title.svg"),                         # Crossfade (default)
    Slide("slides/02-diagram.svg", transition=Cut()),      # override: instant cut
    Slide("slides/03-morph.svg", transition=Morph(1.0)),   # override: morph
]
```

If no transition is set on the deck and none on the slide, the default is `Cut()`.

## Cut

An instant, no-animation switch between slides.

```python
from inkflow import Cut

Cut()
```

Use `Cut` when the visual change between slides is so significant that a transition would be distracting,
or when you want a deliberate hard-cut feel.

## Crossfade

Dissolves the outgoing slide out while fading the incoming slide in.

```python
from inkflow import Crossfade

Crossfade()              # default 0.4s
Crossfade(duration=0.6)  # slower fade
```

| Parameter | Default | Description |
|---|---|---|
| `duration` | `0.4` | Fade duration in seconds |

Crossfade works well between slides that share a similar visual structure.
It reads as "same context, new content."

## Morph

Smoothly interpolates matching elements between two slides.
Elements with the same ID in the outgoing and incoming slides move and reshape to their new positions.
Elements that exist only in the outgoing slide fade out.
Elements only in the incoming slide fade in.

```python
from inkflow import Morph

Morph()              # default 0.5s
Morph(duration=1.0)  # slower morph
```

| Parameter | Default | Description |
|---|---|---|
| `duration` | `0.5` | Animation duration in seconds |

### What morphs

Each element is matched to its counterpart in the other slide by `id` and
interpolated by its resolved on-screen pose — position, size, and rotation — so it
animates correctly even inside translated, scaled, or rotated groups.

Any leaf shape can morph:

| Element | Morphs |
|---|---|
| `<rect>` | position, size, rotation, corner radius (`rx`/`ry`) |
| `<circle>`, `<ellipse>` | position, size |
| `<line>` | endpoints |
| `<path>`, `<polygon>`, `<image>`, … | position, size, rotation (bounding box) |
| `<text>` | position, rotation, and font size — glyphs never stretch or shear |

Colors (`fill`, `stroke`) and opacities are interpolated too.
Stroke width and corner radius keep their shape under a non-uniform resize
(a stretched box keeps round corners and an even outline).

### Groups

A `<g>` is never animated as a rigid block — it only decides *what to match*.
Give the **group** an `id` and the elements inside it morph individually to their
new positions (a `<g id="card">` of a rectangle plus a label morphs the rectangle
and re-places the label, with the label staying crisp). Give an **individual
element** an `id` to morph just that element.

Content with no matched `id` (and that isn't identical between slides) crossfades:
elements only in the outgoing slide fade out, elements only in the incoming slide
fade in. Unchanged chrome (backgrounds, footers) is left untouched.

### Backward navigation

When navigating backward (pressing `←`), Morph plays in reverse automatically.
The outgoing slide's transition is passed to `loadSlide()`
so the reverse morph uses the same duration.

### Tips for Morph slides

- Keep element IDs stable between slides — the morph links elements by matching `id`.
- `id` a `<text>` element to morph it (it moves, rotates, and changes size); leave it
  un-`id`'d to crossfade it instead.
- For a card-like object (a shape with a label), group them and put the `id` on the
  `<g>` so they travel together while each stays crisp.
- For dramatic reveal effects, try a slow `Morph(duration=1.5)` combined with
  repositioned elements.
