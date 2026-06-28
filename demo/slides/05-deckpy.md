# A deck is just Python

```python {1|3|4-5|6-9|all}
from inkflow import Deck, Slide, animations, transitions

deck = Deck(slides=[
    Slide("slides/01-title.svg"),
    Slide("slides/02-overview.svg", transition=transitions.Crossfade()),
    Slide("slides/04-diagram.svg", animations=[
        animations.FadeIn("#box-deck", step=1),
        animations.ZoomIn("#box-pipeline", step=2),
    ]),
])
```

No YAML, no proprietary format — you get autocomplete and real loops for free.
Press `→` to step through the highlights.
