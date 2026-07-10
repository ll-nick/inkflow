# Markdown slides

`Slide` with an `md` field lets you write text content in Markdown instead of placing text inside the SVG.
A layout SVG defines where the content goes (the zones).
A `.md` file provides what goes there.

This is the right choice for slides that are primarily text:
bullet lists, code blocks, prose,
or anything you'd rather edit in a text editor than in Inkscape.

## Minimal example

```python
from inkflow import Deck, Slide

def main() -> Deck:
    return Deck(slides=[
        Slide("default", md="slides/01-intro.md"),
    ])
```

`"default"` is the name of a built-in layout.
`md` points to a Markdown file relative to the deck.

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

## Zone alignment parameters

Zone markers accept optional `key=value` parameters that control how content is
positioned inside the zone.

```markdown
::content align=center valign=center padding=60::

This text is horizontally and vertically centered, with 60 SVG units of padding.
```

| Parameter | Values | Description |
|---|---|---|
| `align` | `left`, `center`, `right`, `justify` | Horizontal text alignment |
| `valign` | `top`, `center`, `bottom` | Vertical alignment of the content block within the zone |
| `padding` | number (SVG user units) | Inner spacing on all sides |

All three are optional and can be combined freely.
Parameters on the marker override CSS variables set in the layout SVG,
which in turn override the built-in defaults (`align: left`, `valign: top`, `padding: 0`).

For persistent defaults that apply to every slide using a layout,
set CSS variables directly in the layout SVG's `<defs><style>` (see [Layout system](layout-system.md)):

```css
#zone-title   { --inkflow-valign: center; }
#zone-content { --inkflow-padding: 40px; }
```

For programmatic control from `deck.py`, pass `align`, `valign`, and `padding` directly to `TextBox`.
See the [manifest reference](../reference/manifest.md#inkflow.manifest.TextBox).

## Step markers

### Explicit steps with `::step::`

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

### Auto-stepping with `::steps::`

`::steps::` opens a block where each list item and each paragraph reveals individually,
without needing a `::step::` before every bullet.

```markdown
# Why inkflow?

Intro text — always visible.

::steps::

- First bullet reveals on keypress 1.
- Second bullet reveals on keypress 2.

A paragraph inside the block also steps.

::steps end::

Footer text — always visible again.
```

`::steps end::` is optional.
If omitted, the block extends to the end of the zone — everything after `::steps::` steps.

```markdown
# All bullets step

::steps::

- One
- Two
- Three
```

`::step::` markers inside a `::steps::` block are ignored — every item already steps.

## Code blocks

All fenced code blocks are syntax-highlighted automatically using Pygments.
No configuration is needed — just write standard Markdown fences with a language tag.

````markdown
```python
def greet(name: str) -> str:
    return f"Hello, {name}!"
```
````

### Step-based line highlighting

Add a `{…}` spec after the language name to highlight specific lines on each keypress.
Each `|`-separated stage is one step.

````markdown
```python {1|2-3|all}
def greet(name: str) -> str:
    message = f"Hello, {name}!"
    return message

print(greet("world"))
```
````

On slide entry the first stage is active (line 1 highlighted, others dimmed).
Each keypress advances to the next stage.
When the spec ends, subsequent keypresses continue with whatever comes next in the slide.

**Stage syntax:**

| Stage | Effect |
|---|---|
| `1` | Single line highlighted, others dimmed |
| `1,3,5` | Comma-separated lines highlighted |
| `2-4` | Inclusive range highlighted |
| `all` or `*` | No dimming — all lines at full opacity |
| `none` | All lines dimmed |

Stages can be combined: `1,3-5` highlights lines 1, 3, 4, and 5.

### Step counter integration

Code block stages consume steps from the shared slide counter.
A block with three stages (`{1|2-3|all}`) uses two extra steps beyond its entry step.
`::step::` markers and `::steps::` blocks that follow pick up after the code block's last stage.

````markdown
# Walk through the code

```python {1|2-3}
def foo():
    return 42
```

::step::

This paragraph appears after the code block's second highlight stage.
````

A code block without a `{…}` spec gets syntax colouring but adds no steps.

## Speaker notes

Add a `::notes::` marker to route content to speaker notes instead of the slide body.
Notes are not rendered on the slide — they are available in the presenter view.

```markdown
# My slide title

The visible slide body goes here.

::notes::

These are my private notes. They support **markdown** and are only shown
in the presenter view.
```

You can also set notes directly on `Slide` via the `notes=` parameter:

```python
Slide("slides/01-title.svg", notes="Remember to greet the audience.")
Slide("default", md="slides/02-bullets.md", notes=Path("notes/02.md"))
```

`str` is used as-is (inline HTML/text). `Path` pointing to a `.md` file is rendered as Markdown; any other extension is read as-is.
When both `notes=` and `::notes::` are present, they are concatenated (`notes=` first, then `::notes::`).

## Images

Reference an image from Markdown with standard syntax:

```markdown
![A diagram](assets/diagram.png)
```

Image paths are resolved relative to the **project root** (the directory that holds `deck.py`), not relative to the `.md` file. So `![](assets/diagram.png)` always points at `<project>/assets/diagram.png` no matter where the Markdown file lives. The same rule applies to `<image href="...">` references inside SVG slides.

Local image paths are copied into the output of `inkflow build` and `inkflow export`. Remote (`https://`) and `data:` URIs are left as they are.

## Media

Pass an image or video into a zone using the `zones` dict:

```python
from inkflow import Media, Slide

Slide(
    "media-right",
    md="slides/03-feature.md",
    zones={"media": Media("assets/screenshot.png", fit="cover")},
)
```

`zones` keys are zone names (without the `zone-` prefix).
`Media` values are injected as images or videos.
`str` values are rendered as inline Markdown.
`TextBox` values give you explicit control over alignment and padding from Python.

`Media` accepts:

| Parameter | Default | Description |
|---|---|---|
| `src` | required | Path to the image or video file |
| `fit` | `"contain"` | CSS `object-fit`: `"contain"` or `"cover"` |
| `align` | `"center"` | CSS `object-position` value |
| `x`, `y` | `0.0` | Fine-tune position offset (px) |

```python
Slide("media-right", md="slides/04-demo.md", zones={"media": Media("assets/demo.mp4")})
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
Slide("layouts/my-layout.svg", md="slides/05-custom.md")
```

See [Layout system](layout-system.md) for how to build your own layouts.

## Mixing animations and Markdown steps

The step counter is shared across the whole slide.
`::step::` markers and `::steps::` blocks in Markdown continue from wherever SVG animations left off.

```python
from inkflow import animations, Deck, Slide

Slide(
    "default",
    md="slides/06-mixed.md",
    animations=[
        animations.FadeIn("#extra-element", step=1),
    ],
)
```

```markdown
Visible from the start.

::steps::

- Revealed at step 2 (step 1 was the SVG animation above).
- Revealed at step 3.
```
