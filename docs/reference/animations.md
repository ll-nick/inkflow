# Animations reference

Animation types live in the `inkflow.animations` namespace. Each takes the shared
[`Cue`](#cue-base) params (`element`, `trigger`) plus the
[`Animation`](#animation-base) timing/playback params (`duration`, `easing`, `delay`,
`iterations`) and any of its own. `element` is the target's `id`; `trigger` is a
[`Trigger`](enums.md#inkflow.enums.Trigger) that decides the cue's step.
`direction` fields use the [`Direction`](enums.md#inkflow.enums.Direction)
enum and `easing` the [`Easing`](enums.md#inkflow.enums.Easing) type.

```python
from inkflow import animations, Direction, Trigger

Slide(
    "01.svg",
    animations=[
        animations.FadeIn("headline"),
        animations.SlideIn(
            "box", Trigger.WITH_PREVIOUS, direction=Direction.LEFT, duration=0.6
        ),
    ],
)
```

Every built-in subclasses one of the semantic bases [`Enter`](#inkflow.animations.Enter),
[`Exit`](#inkflow.animations.Exit), or [`Emphasis`](#inkflow.animations.Emphasis), which
fix its [`AnimationKind`](enums.md#inkflow.enums.AnimationKind). The kind lets several cues target one
element and compose into a single lifecycle: an element can enter, be emphasized, and
exit at different steps, and re-enter after an exit. Enters reveal, exits hide, and
emphasis fires momentarily without changing visibility.

**Custom animations** subclass a semantic base and write a matching
`@keyframes anim-<slug>` rule (the kebab-cased type name) in a `styles.css` next to
`deck.py`. No JavaScript is involved: the step engine reads the keyframes and drives
them. Any extra field is substituted wherever it appears as `var(--anim-<field>)`.

```python
from dataclasses import dataclass
from inkflow import animations


@dataclass
class Glow(animations.Emphasis):
    intensity: float = 1.0  # → var(--anim-intensity) in @keyframes anim-glow
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

::: inkflow.animations.Animation
    options:
      show_root_heading: false
      show_root_toc_entry: false
      heading_level: 3
