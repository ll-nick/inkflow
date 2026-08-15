# Enums reference

Shared value types used across Inkflow.
All are imported from the top-level `inkflow` package:

```python
from inkflow import (
    Align,
    AnimationKind,
    ColorMode,
    Direction,
    Easing,
    MediaAlign,
    MediaFit,
    Muted,
    Trigger,
    VAlign,
)
```

Most are fixed sets of choices. `Easing` also accepts custom curves, so
alongside its named presets (`Easing.EASE_IN_OUT`) it offers
`Easing.cubic_bezier(...)` and `Easing.raw(...)`. `Trigger` follows the same
value-object shape: presets (`Trigger.ON_CLICK`, `Trigger.WITH_PREVIOUS`,
`Trigger.AFTER_PREVIOUS`) plus a `Trigger.at(n)` constructor to pin an absolute step.

::: inkflow.enums.Direction
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.Easing
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.Trigger
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.AnimationKind
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.Align
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.VAlign
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.MediaFit
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.MediaAlign
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.Muted
    options:
      docstring_section_style: spacy
      summary:
        attributes: true

::: inkflow.enums.ColorMode
    options:
      docstring_section_style: spacy
      summary:
        attributes: true
