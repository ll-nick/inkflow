# Morph in depth

Morph animates the difference between two slides.
Elements with the same `id` on both sides travel to their new position, size and colour.
Elements only in the outgoing slide fade out,
elements only in the incoming slide fade in.

```python
from inkflow import Slide, transitions

Slide("architecture-2", transition=transitions.Morph(duration=1.0))
```

It is the one transition that depends on how you drew the slides,
which is why it gets its own page.
For the other seven, see [Transitions](transitions.md).

## The rule

**Matching is by `id`, and nothing else.**

Give the same `id` to the "same" thing on two consecutive slides
and it becomes one object that moves between them.
Leave an element un-`id`'d and it crossfades.

Each matched pair is interpolated by its resolved on-screen pose:
position, size and rotation.
That resolution is what makes it work inside translated, scaled or rotated groups,
rather than only at the top level of the document.

## What can morph

Any leaf shape:

| Element | Interpolates |
|---|---|
| `<rect>` | position, size, rotation, corner radius (`rx`/`ry`) |
| `<circle>`, `<ellipse>` | position, size |
| `<line>` | endpoints |
| `<path>`, `<polygon>`, `<image>`, … | position, size, rotation of the bounding box |
| `<text>` | position, rotation and font size, with no stretching or shearing of glyphs |

`fill`, `stroke` and opacity are interpolated on all of them.

## Groups

A `<g>` is never animated as a rigid block.
It only decides **what to match**.

- `id` on the **group**: the elements inside it morph individually to their new positions.
- `id` on an **individual element**: only that element morphs.

For a card, meaning a shape with a label on top of it,
group the two and put the `id` on the `<g>`.
They travel together while each stays crisp,
because the text is still typeset rather than scaled.

Unchanged chrome such as backgrounds and footers is left untouched entirely.

## Naming elements for Morph

Morph needs stable ids across two files,
which is exactly the thing Inkscape's UI makes awkward:
the Layers & Objects panel edits an element's *label*, not its `id`.

[`inkflow label2id`](inkscape.md#naming-elements-label2id) closes that gap.
Name a group "headline" in the panel on both slides, run it, and both get `id="headline"`.

## Going backward

Pressing <kbd>←</kbd> replays the morph in reverse automatically.
There is nothing to declare for it.

## Tips

- Keep ids stable between the two slides.
  A renamed id turns a morph into a crossfade with no error,
  which is the usual reason "the morph stopped working".
- `id` a `<text>` element to move it, leave it un-`id`'d to crossfade it.
- Build a sequence by copying the slide and editing the copy,
  so ids survive by default instead of being retyped.
- A slow morph reads as deliberate.
  `transitions.Morph(duration=1.5)` across a big repositioning is a reveal in itself.
- [`inkflow verify`](inkscape.md#checking-a-deck-verify) will not catch an
  unmatched id, since a crossfade is valid.
  Step through the pair to check.
