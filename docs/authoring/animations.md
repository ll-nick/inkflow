# Animations

An animation reveals, hides, or emphasizes a single element as you advance through a slide.
Each one targets an element by its `id`, with no leading `#`:

```python
from inkflow import Slide, animations

Slide(
    "title",
    animations=[
        animations.FadeIn("headline"),
        animations.FadeIn("subtitle"),
        animations.FadeIn("byline"),
    ],
)
```

The three fades take one keypress each.
*When* a cue fires is decided by its [trigger](steps.md#animation-triggers),
and this page is about *what* it does.

Elements with no animation declared start **visible**.
An element targeted by an entrance animation starts **hidden**
and appears when its step arrives.
Stepping backward plays each animation in reverse.

## The built-in types

Every type accepts `duration`, `easing`, `delay` and `iterations` as keyword arguments.
`element` and `trigger` are the two positional slots.
The [animations reference](../reference/animations.md) has the full signatures.

| Class | Effect | Starts |
|---|---|---|
| `FadeIn` | Opacity 0 to 1, with a subtle upward drift | Hidden |
| `FadeOut` | Opacity 1 to 0 | Visible |
| `Bounce` | Springs up into place from just below (`distance`) | Hidden |
| `SlideIn` / `SlideOut` | Travels from or to an edge (`direction`, `distance`) | Hidden / Visible |
| `ZoomIn` / `ZoomOut` | Scales into or out of place (`scale`) | Hidden / Visible |
| `Highlight` | Pulses a glow (`color`, `iterations`) without hiding | Visible |

```python
from inkflow import Direction, animations

animations.SlideIn("box", direction=Direction.LEFT, duration=0.6)
animations.ZoomIn("logo", scale=0.6)
animations.Highlight("total", color="#cba6f7", iterations=2)
```

## Enter, exit, emphasis

Every type has a **kind**, fixed by the semantic base it subclasses:

- **`Enter`** reveals the element and leaves it visible.
- **`Exit`** hides it and leaves it hidden.
- **`Emphasis`** fires momentarily without changing visibility.

The kind is what lets one element carry several cues across a slide.
It can enter, be emphasized, leave, and come back, each on its own step:

```python
animations = [
    animations.FadeIn("hero"),  # step 1: enters
    animations.Highlight("hero"),  # step 2: emphasized
    animations.SlideOut("hero", direction=Direction.DOWN),  # step 3: exits
    animations.Bounce("hero"),  # step 4: returns
]
```

At any step the element is shown or hidden by its most recent enter or exit,
while emphasis cues just pulse.

Two enters, or two exits, on one element with no opposing cue between them
is almost always a mistake.
inkflow warns about it when it builds the slide.

## Playing a video

`PlayVideo` is a cue with no animation of its own.
It starts a [`Video`](slides.md#video-playback) on a step
instead of on load, targeting the video's zone key:

```python
from inkflow import Slide, Video, animations

Slide(
    "media-right",
    zones={"media": Video("assets/demo.mp4")},
    animations=[animations.PlayVideo("media")],
)
```

It takes a trigger like any other cue.

## Writing your own

A custom animation is a dataclass and a `@keyframes` rule.
No JavaScript is involved.

Subclass one of the semantic bases and name the keyframes `anim-<slug>`,
where the slug is the kebab-cased class name (`Glow` becomes `anim-glow`):

```python
from dataclasses import dataclass
from inkflow import animations


@dataclass
class Glow(animations.Emphasis):
    intensity: float = 1.0
```

```css
/* styles.css, next to deck.py */
@keyframes anim-glow {
    50% {
        filter: drop-shadow(0 0 calc(8px * var(--anim-intensity)) var(--inkflow-accent));
    }
}
```

The step engine reads the keyframes and drives them.
Any extra field on the class is substituted wherever it appears
as `var(--anim-<field>)`, so `intensity=2.0` on one cue
and `intensity=0.5` on another reuse the same rule.

A `styles.css` next to `deck.py` is loaded automatically.
Your class is usable straight away, in `deck.py`
and as a [`type=`](steps.md#choosing-the-animation-with-type) in a Markdown reveal.
