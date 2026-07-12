# Enums reference

Shared value types used across Inkflow.
All are imported from the top-level `inkflow` package:

```python
from inkflow import (
    Align, ColorMode, Direction, Easing, MediaAlign, MediaFit, Muted, VAlign
)
```

Most are fixed sets of choices. `Easing` also accepts custom curves, so
alongside its named presets (`Easing.EASE_IN_OUT`) it offers
`Easing.cubic_bezier(...)` and `Easing.raw(...)`.

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
