# Themes reference

Themes are Python classes.
Subclass `Theme`, set a typed `Palette` per color mode plus an optional `Typography`,
and pass an instance to `Deck(theme=...)`:

```python
from dataclasses import replace

from inkflow import Deck, Palette, Theme, Typography


class MyTheme(Theme):
    dark = Palette(bg="#1e1e2e", accent="#cba6f7")
    light = replace(Theme.light, accent="#8839ef")
    typography = Typography(heading_font="Inter")


Deck(theme=MyTheme())
```

See the [Themes guide](../guides/themes.md) for the full workflow, including how a
theme ships its own layouts and fonts.

::: inkflow.themes.Theme

::: inkflow.themes.Palette

::: inkflow.themes.Typography

::: inkflow.themes.Builtin
