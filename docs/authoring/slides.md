# Slides

Every slide is one SVG file.
You draw it in your editor and inkflow serves it as-is.

`Slide` is how `deck.py` refers to that file.
It also carries everything inkflow adds on top:
content injected into zones,
animations on individual elements,
and the transition into the slide.

## The smallest deck

```python
from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(
        slides=[
            Slide("title"),
        ]
    )
```

A bare name like `"title"` is looked up in `slides/` first, as `slides/title.svg`.
If it is not there, inkflow searches the layouts
(see [Layouts](../design/layouts.md#finding-a-layout-by-name)).
You can also write a full path, or point anywhere else.

That is a complete slide.
The SVG is loaded, stripped of editor metadata, and served.

## Element IDs

The one convention a slide must follow:
**anything you want to animate or morph needs an `id`.**

In Inkscape, set it in the XML editor (<kbd>Ctrl+Shift+X</kbd>)
or in Object Properties (<kbd>Ctrl+Shift+O</kbd>).
Other editors have an equivalent field.

IDs can be anything without spaces.
`headline`, `box-a`, `arrow-pipeline` are all fine.
Elements you never animate do not need one.

!!! tip "Naming many elements at once"
    Inkscape's Layers & Objects panel edits an element's *label*, not its `id`.
    Label things there and run [`inkflow label2id`](inkscape.md#naming-elements-label2id)
    to promote every label to an `id` in one pass.

Nothing else is required.
The file stays a standard vector graphic that opens anywhere.

## Zones

Two things SVG editors handle badly: formatted text and video.
Text reflow, bullet lists, tables and code blocks have no real SVG equivalent,
and video is not something an SVG file can hold at all.

A **zone** is how you leave room for both.
Give any shape in the SVG an `id` starting with `zone-`,
and inkflow replaces that shape with your content when it builds the slide:

```xml
<rect id="zone-content" x="120" y="200" width="1680" height="760"/>
```

Any SVG can define zones,
whether it is a one-off slide or a [layout](../design/layouts.md) shared by many slides.
The full zone rules, including non-rectangular shapes and reserved names,
live on the [Layouts](../design/layouts.md#zones) page.

### Filling zones from `deck.py`

Pass content into named zones with the `zones` dict.
Keys are zone names *without* the `zone-` prefix:

```python
from inkflow import Image, MediaFit, Slide

Slide(
    "title",
    zones={
        "title": "My talk title",
        "media": Image("assets/headshot.jpg", fit=MediaFit.COVER),
    },
)
```

| Value | Result |
|---|---|
| `str` | Rendered as inline Markdown |
| `TextBox` | Text with explicit `align`, `valign` and `padding` |
| `Image` / `Video` | Media, fitted and cropped to the zone |

A zone the slide never fills is removed from the output rather than left empty.

### Filling zones from Markdown

When most of a slide is text, writing it in a `.md` file beats filling zones by hand.
Point `md=` at one and inkflow routes its sections into the slide's zones:

```python
Slide("content", md="intro")
```

That is the subject of its own page: [Markdown content](markdown.md).

## Media zones

For an image or a video that should *fill* a zone rather than sit inline in text,
pass `Image` or `Video` through `zones`:

```python
from inkflow import Image, MediaFit, Slide

Slide(
    "media-right",
    md="feature",
    zones={"media": Image("assets/screenshot.png", fit=MediaFit.COVER)},
)
```

Both share the same placement fields:
`fit`, `align`, `x`, `y`, and `alt_src` (a different file for the other color mode).
The [manifest reference](../reference/manifest.md#inkflow.manifest.Image) lists them all.

### Video playback

`Video` adds playback control on top of those:

```python
from inkflow import Slide, Video

Slide(
    "media-right",
    md="demo",
    zones={"media": Video("assets/demo.mp4", autoplay=True, loop=True)},
)
```

`controls`, `autoplay`, `muted`, `loop`, `poster`, and `start`/`end` trim points
are all documented in the
[manifest reference](../reference/manifest.md#inkflow.manifest.Video).

**Starting a clip on a step.**
To play a video partway through a slide instead of on load,
add a `PlayVideo` cue targeting the video's zone key:

```python
from inkflow import Slide, Video, animations

Slide(
    "media-right",
    zones={"media": Video("assets/demo.mp4")},
    animations=[animations.PlayVideo("media")],  # plays on the next click
)
```

It joins the [step timeline](steps.md) like any other cue.
Leaving the slide pauses and rewinds the clip,
and stepping back past the cue resets it to the start.

**Muting.**
Browsers refuse to autoplay video with sound until the viewer has interacted with the page.
`Muted.AUTO`, the default, mutes a clip *only* when it autoplays,
so autoplay always works while a `PlayVideo` cue keeps its audio.
`Muted.ON` always mutes.
`Muted.OFF` never does, which means an autoplaying clip may be blocked on a cold load.

!!! note "Zones only"
    Playback control applies to `Video` passed through `zones`.
    A video written into Markdown as `![](clip.mp4)` renders as a plain element.

## Slide dimensions

inkflow does not enforce a canvas size.
Draw at whatever suits the talk: 16:9, 4:3, square, portrait.
The presenter scales the slide to fill the available screen area.

The built-in layouts are authored at **1920 × 1080**,
so slides built on them share that coordinate space.
For a different aspect ratio, draw your own layouts at matching dimensions.
The pipeline treats them identically.

PDF export reads the page size from the first slide's `viewBox`,
and [`--size`](../presenting/export.md#slide-dimensions) overrides it.

## Per-slide CSS

`extra_style` injects a `<style>` block into one slide.
Use it for one-off tweaks.
For anything systematic, use a [theme](../design/themes.md).

A bare string is read as a **path to a CSS file**,
so wrap literal CSS in `Inline(...)`:

```python
from inkflow import Inline, Slide

Slide(
    "title",
    extra_style=Inline("#headline { font-size: 72px; fill: var(--inkflow-accent); }"),
)

Slide("diagram", extra_style="styles/diagram.css")  # a path, relative to deck.py
```

The same rule holds for `Deck(style=...)`, `Slide(md=...)` and `Slide(notes=...)`:
a bare `str` is a path, `Inline(...)` is the content itself.

## Hiding a slide

`visible=False` drops a slide from the presentation without deleting it:

```python
Slide("backup-numbers", md="numbers", visible=False)
```

Useful for backup slides and for cutting a section down to time.
[`inkflow verify`](inkscape.md#checking-a-deck-verify) skips hidden slides
unless you pass `--all`.

## Tips

- Keep IDs short and semantic: `title`, `diagram-step-1`, `callout`.
- The pipeline strips editor metadata on every load,
  so there is nothing to clean up by hand.
- SVGs from any editor work without pre-processing:
  Figma exports, Affinity Designer, hand-written files.
