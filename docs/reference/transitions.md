# Transitions reference

Transition types live in the `inkflow.transitions` namespace. Each takes the shared
[`Transition`](#transition-base) params (`duration`, `easing`) plus any of its own.
`direction` fields use the [`Direction`](manifest.md#enums) enum from the
[manifest reference](manifest.md).

```python
from inkflow import transitions, Direction

Slide("01.svg", transition=transitions.Push(direction=Direction.RIGHT))
```

::: inkflow.transitions
    options:
      show_root_heading: false
      heading_level: 2

## Transition (base) { #transition-base }

::: inkflow.manifest.Transition
    options:
      show_root_heading: false
      show_root_toc_entry: false
      heading_level: 3
