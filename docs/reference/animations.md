# Animations reference

Animation types live in the `inkflow.animations` namespace. Each takes the shared
[`Cue`](#cue-base) params (`element`, `trigger`) plus the
[`Animation`](#animation-base) timing params (`duration`, `easing`, `delay`) and
any of its own. `element` is the target's `id`; `trigger` is a
[`Trigger`](enums.md#inkflow.enums.Trigger) that decides the cue's step.
`direction` fields use the [`Direction`](enums.md#inkflow.enums.Direction)
enum and `easing` the [`Easing`](enums.md#inkflow.enums.Easing) type.

```python
from inkflow import animations, Direction, Trigger

Slide("01.svg", animations=[
    animations.FadeIn("headline"),
    animations.SlideIn("box", Trigger.WITH_PREVIOUS, direction=Direction.LEFT, duration=0.6),
])
```

The `animations` namespace also holds [`PlayVideo`](#inkflow.animations.PlayVideo),
a non-animating cue that starts a `Video` on a step.

::: inkflow.animations
    options:
      show_root_heading: false
      heading_level: 2

## Cue (base) { #cue-base }

::: inkflow.manifest.Cue
    options:
      show_root_heading: false
      show_root_toc_entry: false
      heading_level: 3

## Animation (base) { #animation-base }

::: inkflow.manifest.Animation
    options:
      show_root_heading: false
      show_root_toc_entry: false
      heading_level: 3
