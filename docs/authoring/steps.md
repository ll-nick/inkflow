# Steps

A **slide** is one SVG file.
A **step** is one keypress within it.

Steps are what makes a slide build itself:
a bullet appears, a box fades in, a code walkthrough moves to the next line.
You never write step numbers by hand.
You declare *when* each thing should happen and inkflow works out the numbering.

Three things create steps, and they all feed the same counter:

| Source | Written in | Covered below |
|---|---|---|
| Markdown reveals | the `.md` file | [Markdown reveals](#markdown-reveals) |
| Code walkthrough stages | a fenced code block | [Code walkthroughs](#code-walkthroughs) |
| Animation cues | `animations=[...]` in `deck.py` | [Animation triggers](#animation-triggers) |

Because they share one counter, a slide can mix all three.
How they interleave is [the last section](#one-timeline).

## Markdown reveals

### One chunk at a time with `::step::`

`::step::` marks a boundary inside a zone.
Content before the first marker is visible on arrival,
and each marker reveals the next chunk:

```markdown
# Build up a concept

First point, visible immediately.

::step::

Second point, revealed on the first keypress.

::step::

Third point, revealed on the second keypress.
```

### Every item at once with `::steps::`

`::steps::` opens a block where each list item and each paragraph steps on its own,
so you do not write a marker before every bullet:

```markdown
# Why inkflow?

Intro text, always visible.

::steps::

- First bullet reveals on keypress 1.
- Second bullet reveals on keypress 2.

A paragraph inside the block steps too.

::steps end::

Footer text, visible from the start again.
```

`::steps end::` is optional.
Without it the block runs to the end of the zone.

A `::step::` inside a `::steps::` block is ignored, since every item already steps.

### Choosing the animation with `type=`

A reveal fades in by default.
`type=<ClassName>` picks a different one,
using the same class and parameter names you would write in `deck.py`:

```markdown
::step type=SlideIn direction=right distance=200::

Slides in from the right.

::step type=Bounce::

Bounces in.
```

The same grammar works on `::steps::`,
where the type applies to every item in the block:

```markdown
::steps type=SlideIn direction=up::

- Each bullet slides up
- one after another
::steps end::
```

`type=` resolves against the [built-in animations](../reference/animations.md)
and any `Animation` subclass your `deck.py` defines, matched by class name.
Parameters are coerced to each field's type,
so `distance=200` becomes a number and `direction=right` becomes a `Direction`.

Values cannot contain spaces,
so `easing=ease-in-out` works in a marker
while a `cubic-bezier(...)` curve is a `deck.py`-only thing.

### Changing the step with `trigger=`

A reveal takes its own keypress by default.
`trigger=` changes that, with the same meanings as the
[animation triggers](#animation-triggers) below:

```markdown
::step::
First point.

::step trigger=with-previous::
Appears together with the first point.

::step trigger=after-previous::
Reveals on its own, right after the first point finishes.

::step trigger=3::
Pinned to step 3.
```

## Code walkthroughs

A `{…}` spec after the language name highlights different lines on each keypress.
Each `|`-separated stage is one step:

````markdown
```python {1|2-3|all}
def greet(name: str) -> str:
    message = f"Hello, {name}!"
    return message

print(greet("world"))
```
````

On arrival the first stage is active, with line 1 highlighted and the rest dimmed.
Each keypress moves to the next stage.

| Stage | Effect |
|---|---|
| `1` | That line highlighted, the rest dimmed |
| `1,3,5` | Several lines highlighted |
| `2-4` | An inclusive range |
| `1,3-5` | Lines and ranges combined |
| `all` or `*` | No dimming, every line at full opacity |
| `none` | Every line dimmed |

A block with three stages uses two steps beyond the one it arrives on.
Whatever follows in the slide picks up after the last stage:

````markdown
# Walk through the code

```python {1|2-3}
def foo():
    return 42
```

::step::

This paragraph appears after the block's second stage.
````

A code block with no `{…}` spec is still syntax-highlighted.
It just adds no steps.

## Animation triggers

Every cue in `animations=[...]` carries a `Trigger` that decides its step.
`trigger` is the second positional argument, after the element id:

```python
from inkflow import Trigger, animations

animations = [
    animations.FadeIn("left-panel"),  # step 1
    animations.FadeIn("right-panel", Trigger.WITH_PREVIOUS),  # step 1, together
    animations.FadeIn("caption", Trigger.AFTER_PREVIOUS),  # step 1, then on its own
    animations.FadeIn("footnote"),  # step 2
]
```

| Trigger | Meaning |
|---|---|
| `Trigger.ON_CLICK` (default) | Takes the next step and waits for a keypress |
| `Trigger.WITH_PREVIOUS` | Shares the previous cue's step, firing at the same moment |
| `Trigger.AFTER_PREVIOUS` | Shares the previous cue's step, playing once the previous one finishes |
| `Trigger.at(n)` | Pins the cue to step `n` |

### Building on arrival

A `WITH_PREVIOUS` or `AFTER_PREVIOUS` cue that comes *first* in the list
falls to the slide-entry step.
It is not shown in its resting state and then animated.
It animates on entry, right after the transition settles,
so a slide can build itself the moment you arrive with no keypress at all.

### Self-playing sequences

`AFTER_PREVIOUS` turns one keypress into a cascade.
The cues share a step and play as a single run along one timeline:
the first fires on the press, and each following cue starts as the one before it ends.

One press forward plays the whole cascade.
A second press while it is still running snaps it to the end.
One press back mirrors it, last stage out first.

## One timeline

When a slide has both Markdown reveals and an `animations=[...]` list,
they number in one continuous sequence.
**Markdown reveals come first, in reading order, then the animation list continues.**

With two reveals and two animations, the reveals take steps 1 and 2
and the animations take 3 and 4:

```python
from inkflow import Trigger, animations

Slide(
    "mixed",
    md="bullets",  # two ::steps:: bullets → steps 1, 2
    animations=[
        animations.FadeIn("badge-a"),  # step 3
        animations.FadeIn("badge-b", Trigger.at(5)),  # pinned to step 5
    ],
)
```

`Trigger.WITH_PREVIOUS` works across that boundary too.
A first-in-list animation carrying it fires together with the last bullet.

To land an animation on a specific reveal's step, pin it with `Trigger.at(n)`.

!!! tip "Checking the numbering"
    [`inkflow verify`](inkscape.md#checking-a-deck-verify) warns when a slide's steps
    are not contiguous from 1, which usually means a `Trigger.at(n)` has drifted
    after content was added or removed above it.
