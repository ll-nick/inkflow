# Overlays

[Inheritance](layouts.md#inheritance) answers "what am I built on"
and composites *behind* a slide.

A logo, a footer, a conference badge ask a different question:
"what goes on top of every slide, whatever it is built on".
That is an **overlay**, and it is the second composition axis.

Keeping them separate is what lets chrome reach every layout
without a duplicate layout for each combination.

## Using one

An overlay is an SVG at slide dimensions, drawn above the finished slide.
Declare them on the deck:

```python
from inkflow import Deck, Overlay, Slide

Deck(
    overlays=[Overlay("footer"), Overlay("logo")],
    slides=[
        Slide("title.svg", overlays=[]),  # a bare title, no chrome
        Slide("content", md="intro"),  # inherits the deck's two
    ],
)
```

List order is paint order.

Resolution runs `Slide.overlays` → `Deck.overlays` → `Theme.overlays`.
Each level **overrides** rather than merges:
`None` inherits the level above, and `[]` means no chrome at all.
That is the same rule as `transition` and `font_size`.

## What overlays can do

Overlays are composited before slide numbering and content injection,
so they behave like any other part of the slide:

- A `zone-slide-number` inside a footer is filled like any other zone.
- A zone the overlay declares can be filled from `zones={...}` on a slide,
  and is pruned on slides that leave it empty.
- Animations can target elements inside an overlay,
  so chrome can be revealed on a step.

They also travel with the slide during a transition.
A footer slides along with a `Push` and dips through a `Crossfade`.

## Finding an overlay by name

Overlays live in `overlays/` and use the same three-level search
and prefix grammar as [layouts](layouts.md#finding-a-layout-by-name),
against `overlays/` instead of `layouts/`:

| Written as | Resolves to |
|---|---|
| `"footer"` | The three-level search |
| `"local:footer"` | `{project}/overlays/footer.svg` |
| `"theme:footer"` | `{theme}/overlays/footer.svg` |
| `"builtin:footer"` | A built-in overlay |
| `"./chrome/footer.svg"` | Relative to the project directory |

Layouts and overlays are separate namespaces,
so a bare name resolves to one or the other and never both.

## Overlays can inherit

`inkflow:parent` on an overlay means "drawn behind me, within this overlay".
The overlay as a whole still lands on top of the slide,
so the two axes stay independent:

```
overlays/brand.svg     the rule line and the mark
overlays/chrome.svg    inkflow:parent="brand", adds the event name
```

This is how a theme ships `theme:brand` that a project extends
without copying it.

A bare name in an overlay's `inkflow:parent` resolves in the overlay namespace,
so chrome can only ever inherit chrome.

!!! warning "Do not point an overlay's parent at a layout"
    Layouts paint a full-bleed background.
    On top of a slide, that hides the entire deck.

    A bare name cannot reach a layout from an overlay,
    so this needs an explicit path to happen at all.
    [`inkflow verify`](../authoring/inkscape.md#checking-a-deck-verify)
    reports it as an error and names the file.

## Shipping chrome with a theme

Set `overlays` on the theme class and every deck using it gets the chrome:

```python
class Corporate(Theme):
    overlays = [Overlay("theme:brand")]
```

A deck opts out with `Deck(overlays=[])`, a slide with `Slide(overlays=[])`.

## Drawing one

An overlay file previews differently from a slide,
since it has no idea what it will land on.
See [drawing an overlay](../authoring/inkscape.md#drawing-an-overlay)
for the backdrop attribute that makes it workable in Inkscape.
