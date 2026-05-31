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

### Supported element types

Morph interpolates geometry attributes directly in SVG user units:

| Element | Interpolated attributes |
|---|---|
| `<rect>` | `x`, `y`, `width`, `height`, `rx` |
| `<circle>` | `cx`, `cy`, `r` |
| `<ellipse>` | `cx`, `cy`, `rx`, `ry` |

Colors (CSS `fill`, `stroke`) are lerped channel-by-channel.

`<path>`, `<polygon>`, and `<g>` fall back to an instant cut.
For groups where you want the whole group to enter/exit together,
place the animation ID on the `<g>` element.
It will be cloned and faded as a unit.

### Backward navigation

When navigating backward (pressing `←`), Morph plays in reverse automatically.
The outgoing slide's transition is passed to `loadSlide()`
so the reverse morph uses the same duration.

### Tips for Morph slides

- Keep element IDs stable between slides.
  The morph links outgoing and incoming elements by matching ID.
- Elements that should morph must be primitive shapes (`<rect>`, `<circle>`, `<ellipse>`).
  If you're morphing a complex object, wrap it in a `<g>`
  (it will fade rather than morph, but the motion will still be smooth).
- For dramatic reveal effects, try a slow `Morph(duration=1.5)` combined with repositioned elements.
