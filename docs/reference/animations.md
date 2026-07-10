# Animations reference

Animation types live in the `inkflow.animations` namespace. Each takes the shared
[`Animation`](#animation-base) params (`element`, `step`, `duration`, `easing`,
`delay`) plus any of its own. `direction` fields use the [`Direction`](enums.md#inkflow.enums.Direction) enum.

```python
from inkflow import animations, Direction

Slide("01.svg", animations=[
    animations.FadeIn("#headline", step=1),
    animations.SlideIn("#box", step=2, direction=Direction.LEFT, duration=0.6),
])
```

::: inkflow.animations
    options:
      show_root_heading: false
      heading_level: 2

## Animation (base) { #animation-base }

::: inkflow.manifest.Animation
    options:
      show_root_heading: false
      show_root_toc_entry: false
      heading_level: 3
