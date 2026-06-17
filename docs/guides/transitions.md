# Transitions

A transition controls how a slide enters from the previous one.

## Setting transitions

Set a default transition for the whole deck on the `Deck` object,
and override per slide as needed:

```python
from inkflow import Deck, Direction, Slide, transitions

def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),  # default
        slides=[
            Slide("slides/01-title.svg"),                                    # Crossfade (default)
            Slide("slides/02-diagram.svg", transition=transitions.Cut()),    # override: instant cut
            Slide("slides/03-morph.svg", transition=transitions.Morph(1.0)), # override: morph
        ],
    )
```

If no transition is set on the deck and none on the slide, the default is `Cut` (instant).

All transition types share two parameters:

| Parameter | Default | Description |
|---|---|---|
| `duration` | `0.5` | Duration in seconds (`Cut` defaults to `0.0`) |
| `easing` | `None` | Any CSS easing string. `None` keeps the handler's built-in default |

## Cut

An instant, no-animation switch between slides.

```python
transitions.Cut()
```

Use `Cut` when the visual change between slides is so significant that a transition would be distracting,
or when you want a deliberate hard-cut feel.

## Crossfade

Dissolves the outgoing slide out while fading the incoming slide in.

```python
transitions.Crossfade()              # default 0.5s
transitions.Crossfade(duration=0.6)  # slower fade
```

Crossfade works well between slides that share a similar visual structure.
It reads as "same context, new content."

## Push

Both slides move together — the outgoing slide exits in one direction while the incoming slide
enters from the opposite edge.

```python
transitions.Push()                                    # default: left, 0.5s
transitions.Push(direction=Direction.RIGHT)           # slides move right
transitions.Push(direction=Direction.UP, duration=0.4)
```

| Parameter | Default | Description |
|---|---|---|
| `direction` | `Direction.LEFT` | Direction the slides travel |

## Cover

The incoming slide covers the outgoing one, which stays fixed in place.

```python
transitions.Cover()                              # default: left, 0.5s
transitions.Cover(direction=Direction.UP)
```

| Parameter | Default | Description |
|---|---|---|
| `direction` | `Direction.LEFT` | Direction the incoming slide enters from |

## Zoom

The outgoing slide scales out to nothing while the incoming slide scales in from nothing.

```python
transitions.Zoom()
transitions.Zoom(duration=0.6, easing="ease-in-out")
```

## Fade

The outgoing slide fades to a solid colour, then the incoming slide fades in from it.
Useful for dramatic scene changes.

```python
transitions.Fade()                          # fades through black
transitions.Fade(color="#1a1a2e")           # fades through a custom colour
transitions.Fade(color="#ffffff", duration=0.8)
```

| Parameter | Default | Description |
|---|---|---|
| `color` | `"#000000"` | The intermediate colour |

## Wipe

The incoming slide is progressively revealed from one edge, sliding over the outgoing slide.

```python
transitions.Wipe()                                    # default: left-to-right reveal, 0.5s
transitions.Wipe(direction=Direction.RIGHT)           # reveal from right
transitions.Wipe(direction=Direction.UP, duration=0.7)
```

| Parameter | Default | Description |
|---|---|---|
| `direction` | `Direction.LEFT` | Edge the incoming slide enters from |

## Morph

Smoothly interpolates matching elements between two slides.
Elements with the same ID in the outgoing and incoming slides move and reshape to their new positions.
Elements that exist only in the outgoing slide fade out.
Elements only in the incoming slide fade in.

```python
transitions.Morph()              # default 0.5s
transitions.Morph(duration=1.0)  # slower morph
```

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

### Groups

A `<g>` is never animated as a rigid block — it only decides *what to match*.
Give the **group** an `id` and the elements inside it morph individually to their
new positions. Give an **individual element** an `id` to morph just that element.

Content with no matched `id` crossfades: elements only in the outgoing slide fade out,
elements only in the incoming slide fade in. Unchanged chrome (backgrounds, footers) is left untouched.

### Backward navigation

When navigating backward (pressing `←`), Morph plays in reverse automatically.

### Tips for Morph slides

- Keep element IDs stable between slides — the morph links elements by matching `id`.
- `id` a `<text>` element to morph it (it moves, rotates, and changes size); leave it
  un-`id`'d to crossfade it instead.
- For a card-like object (a shape with a label), group them and put the `id` on the
  `<g>` so they travel together while each stays crisp.
- For dramatic reveal effects, try a slow `transitions.Morph(duration=1.5)` combined with
  repositioned elements.
