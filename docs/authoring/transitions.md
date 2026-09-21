# Transitions

A transition controls how a slide enters from the previous one.

| Transition | Effect | Own parameters |
|---|---|---|
| [`Cut`](#cut) | Instant switch | |
| [`Crossfade`](#crossfade) | Dissolves one slide into the other | |
| [`Push`](#push) | Both slides travel together | `direction` |
| [`Cover`](#cover) | The new slide slides over the old one | `direction` |
| [`Wipe`](#wipe) | The new slide is revealed from an edge | `direction` |
| [`Zoom`](#zoom) | Scales one slide out and the other in | `amount` |
| [`Fade`](#fade) | Fades through a solid colour | `color` |
| [`Morph`](#morph) | Matching elements travel to their new positions | |

## Setting transitions

Set a default transition for the whole deck on the `Deck` object,
and override per slide as needed:

```python
from inkflow import Deck, Direction, Slide, transitions


def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),  # default
        slides=[
            Slide("title"),  # Crossfade (default)
            Slide("diagram", transition=transitions.Cut()),  # override: instant cut
            Slide("morph", transition=transitions.Morph(1.0)),  # override: morph
        ],
    )
```

If no transition is set on the deck and none on the slide, the default is `Cut` (instant).

All transition types share two parameters:

| Parameter | Default | Description |
|---|---|---|
| `duration` | `0.5` | Duration in seconds (`Cut` defaults to `0.0`) |
| `easing` | `Easing.EASE` | An [`Easing`](../reference/enums.md) preset, or a custom curve via `Easing.cubic_bezier(...)`. `Push`, `Cover`, `Zoom`, and `Wipe` default to `Easing.EASE_IN_OUT` |

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
transitions.Crossfade()  # default 0.5s
transitions.Crossfade(duration=0.6)  # slower fade
```

Crossfade works well between slides that share a similar visual structure.
It reads as "same context, new content."

## Push

Both slides move together — the outgoing slide exits in one direction while the incoming slide
enters from the opposite edge.

```python
transitions.Push()  # default: left, 0.5s
transitions.Push(direction=Direction.RIGHT)  # slides move right
transitions.Push(direction=Direction.UP, duration=0.4)
```

| Parameter | Default | Description |
|---|---|---|
| `direction` | `Direction.LEFT` | Direction the slides travel |

## Cover

The incoming slide covers the outgoing one, which stays fixed in place.

```python
transitions.Cover()  # default: left, 0.5s
transitions.Cover(direction=Direction.UP)
```

| Parameter | Default | Description |
|---|---|---|
| `direction` | `Direction.LEFT` | Direction the incoming slide enters from |

## Zoom

The incoming slide scales into place while the outgoing slide keeps zooming past.
`amount` controls how far they scale past their normal size.

```python
from inkflow import Easing

transitions.Zoom()
transitions.Zoom(amount=0.4)  # gentler
transitions.Zoom(amount=0.6, duration=0.6, easing=Easing.EASE_IN_OUT)
```

| Parameter | Default | Description |
|---|---|---|
| `amount` | `0.6` | How far the slides scale past 1 (0.6 → 0.4x in, 1.6x out) |

## Fade

The outgoing slide fades to a solid colour, then the incoming slide fades in from it.
Useful for dramatic scene changes. The colour fills the slide area only — the
letterbox bars around the slide stay black throughout.

```python
transitions.Fade()  # fades through black
transitions.Fade(color="#1a1a2e")  # fades through a custom colour
transitions.Fade(color="#ffffff", duration=0.8)
```

| Parameter | Default | Description |
|---|---|---|
| `color` | `"#000000"` | The intermediate colour |

## Wipe

The incoming slide is progressively revealed from one edge, sliding over the outgoing slide.

```python
transitions.Wipe()  # default: left-to-right reveal, 0.5s
transitions.Wipe(direction=Direction.RIGHT)  # reveal from right
transitions.Wipe(direction=Direction.UP, duration=0.7)
```

| Parameter | Default | Description |
|---|---|---|
| `direction` | `Direction.LEFT` | Edge the incoming slide enters from |

## Morph

Interpolates matching elements between the two slides.
Anything with the same `id` on both sides travels to its new position, size and colour,
and anything unmatched crossfades.

```python
transitions.Morph()  # default 0.5s
transitions.Morph(duration=1.0)  # slower
```

Morph is the one transition that depends on how the slides themselves are drawn,
so it has a page of its own: **[Morph in depth](morph.md)**.

## Writing your own

A custom transition is a Python dataclass plus a render function in JavaScript.

Subclass `Transition` in `deck.py`.
Every field you add is serialized and handed to the render function,
and the kebab-cased class name becomes the handler key (`MyWarp` becomes `my-warp`):

```python
from dataclasses import dataclass
from inkflow import transitions


@dataclass
class MyWarp(transitions.Transition):
    twist: float = 1.0
```

Register the matching handler from a `scripts.js` next to `deck.py`,
which is loaded automatically:

```javascript
// scripts.js
window.inkflow.registerProgressTransition("my-warp", (ctx, progress, params) => {
    // progress runs 0 (old slide shown) to 1 (new slide shown), already eased.
    // ctx.oldLayer sits on top of ctx.newLayer.
    ctx.oldLayer.style.opacity = String(1 - progress);
    ctx.oldLayer.style.transform = `rotate(${progress * params.twist * 20}deg)`;
});
```

The render function is called once per frame with the eased progress,
so it only has to paint a single still frame.
Reversing, interrupting and settling are handled for you.

Use it like any built-in:

```python
Slide("diagram", transition=MyWarp(twist=2.0, duration=0.8))
```
