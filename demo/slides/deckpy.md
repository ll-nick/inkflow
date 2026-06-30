# Declaring a Slide Deck

```python {1-2|3-4|5-6|7-8|9-13|all}
# A deck is just a python script that returns a Deck object
def main() -> Deck:
    # A deck is a list of slides
    return Deck(slides=[ 
        # A slide can just be an SVG file you drew
        Slide("01-title.svg"), 
        # Or a layout injected with Markdown content
        Slide("builtin:content", md="02-overview.md"),
        # This is how you define the transition and animations for a slide
        Slide("slides/04-diagram.svg",
              transition=transitions.Crossfade(),
              animations=[animations.FadeIn("#box-deck", step=1)]
        ),
    ])
```
