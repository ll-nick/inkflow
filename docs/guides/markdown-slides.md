# Markdown slides

`MarkdownSlide` lets you write text content in Markdown instead of placing text inside the SVG.
A layout SVG defines where the content goes (the zones).
A `.md` file provides what goes there.

This is the right choice for slides that are primarily text:
bullet lists, code blocks, prose,
or anything you'd rather edit in a text editor than in Inkscape.

## Minimal example

```python
from inkflow import Deck, MarkdownSlide

deck = Deck()
deck.slides = [
    MarkdownSlide("default", content="slides/01-intro.md"),
]
```

`"default"` is the name of a built-in layout.
`content` points to a Markdown file relative to the deck.

## How content is placed

The pipeline inspects the Markdown file for two things:

**Auto-extraction** (no markers needed):
if the file starts with a `# H1`, it is extracted into `zone-title`.
An `## H2` immediately following goes to `zone-subtitle`.
Everything else goes to `zone-content`.

```markdown
# My slide title
## Optional subtitle

The body content goes here.
```

**Explicit zone markers**: use `::zone-name::` to route content to a specific zone.
Anything after the marker goes to that zone until the next marker.

```markdown
::left::

## Left column

Content for the left side.

::right::

## Right column

Content for the right side.
```

Explicit markers always override auto-extraction.

## Step markers

`::step::` inserts an animation step boundary within a zone.
Content before the first `::step::` is visible from the start.
Each marker reveals the next chunk on keypress.

```markdown
# Build up a concept

First point — visible immediately.

::step::

Second point — revealed on first keypress.

::step::

Third point — revealed on second keypress.
```

Enable stepping on the slide with `steps=True`:

```python
MarkdownSlide("default", content="slides/02-bullets.md", steps=True)
```

## Media

Pass an image or video alongside the text content
using keyword arguments that match zone names in the layout:

```python
from inkflow import Media, MarkdownSlide

MarkdownSlide(
    "media-right",
    content="slides/03-feature.md",
    media=Media("assets/screenshot.png", fit="cover"),
)
```

`Media` accepts:

| Parameter | Default | Description |
|---|---|---|
| `src` | required | Path to the image or video file |
| `fit` | `"contain"` | CSS `object-fit`: `"contain"` or `"cover"` |
| `align` | `"center"` | CSS `object-position` value |
| `x`, `y` | `0.0` | Fine-tune position offset (px) |

For videos, pass the path string directly (shorthand for `Media(src=...)`):

```python
MarkdownSlide("media-right", content="slides/04-demo.md", media="assets/demo.mp4")
```

## Built-in layouts

The built-in theme ships these layouts:

| Name | Zones | Use for |
|---|---|---|
| `cover` | title, subtitle | Title / opening slide |
| `section` | title | Section divider |
| `default` | title, content | Standard text slide |
| `center` | title, content | Centered content |
| `two-cols` | title, left, right | Two-column comparison |
| `two-cols-header` | title, left, right | Two columns with wide header |
| `fact` | title, content | Big number or key fact |
| `quote` | title, content | Pull quote |
| `statement` | title, content | Bold statement |
| `media-left` | title, content, media | Text + image/video (image left) |
| `media-right` | title, content, media | Text + image/video (image right) |
| `end` | title, content | Thank-you / closing slide |

## Using a custom layout

Pass a path instead of a bare name:

```python
MarkdownSlide("layouts/my-layout.svg", content="slides/05-custom.md")
```

See [Layout system](layout-system.md) for how to build your own layouts.

## Animations on Markdown slides

`MarkdownSlide` supports the same `animations` list as `Slide`.
The step counter is shared:
`::step::` markers in the Markdown file continue from wherever SVG animations end.

```python
MarkdownSlide(
    "default",
    content="slides/06-mixed.md",
    steps=True,
    animations=[
        FadeIn("#extra-element", step=1),
    ],
)
```
