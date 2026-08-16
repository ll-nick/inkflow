# Authoring slides

Every slide is a single SVG file.
`Slide` wraps that SVG, declares which elements to animate,
and sets how the slide transitions in from the previous one.

You draw a slide in your SVG editor and serve it as-is.
When part of a slide should hold formatted text, images, or video,
mark a rectangular area in the SVG as a **zone** and fill it at build time —
from `deck.py` with `TextBox`, `Image`, or `Video`, or by pointing `md=` at a Markdown file.
A single slide can freely combine hand-drawn artwork, animated elements, and
zones filled with Markdown.

## Minimal example

```python
from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(
        slides=[
            Slide("title"),
        ]
    )
```

A bare name like `"title"` is looked up in `slides/` first (as `slides/title.svg`),
then searched across layouts if not found there — see the
[`Slide.src`](../reference/manifest.md#inkflow.manifest.Slide) reference for the
full order. You can also write the path out in full, or point elsewhere entirely.
The SVG file is loaded as-is, stripped of editor metadata, and served.
No animations, no transition. Just the slide.

## Authoring in your SVG editor

The only convention slides must follow:
**any element you want to animate needs an ID.**

Set the ID via the XML editor (<kbd>Ctrl+Shift+X</kbd>)
or the Object Properties dialog (<kbd>Ctrl+Shift+O</kbd>) in Inkscape,
or the equivalent in any other editor.
IDs can be anything: `headline`, `box-a`, `arrow-pipeline`.
Avoid spaces. Hyphens and underscores are fine.

No other markup is required.
The SVG is a standard vector file.

## Animations

Animations reveal (or hide) elements on successive keypresses.
Each animation targets a single element by its `id` (no leading `#`):

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

Each cue's `trigger` says *when* it fires, and inkflow works out the concrete
steps from the triggers and the order of the list. The default trigger is
`ON_CLICK`, so the three fades above take steps 1, 2, 3 — one per keypress.

Elements with no animation declaration start **visible**.
Elements targeted by an entrance animation (`FadeIn`, `Bounce`, `SlideIn`, `ZoomIn`) start
**invisible** and appear when their step is reached.

Every type has a **kind** — `enter`, `exit`, or `emphasis` — set by the semantic base
it subclasses (`animations.Enter` / `Exit` / `Emphasis`). Enters reveal, exits hide, and
emphasis (like `Highlight`) fires momentarily without changing visibility. Stepping
backward plays each animation in reverse, mirroring the forward order.

### Animation types

Every type accepts `duration`, `easing`, `delay`, and `iterations` (keyword-only); some
add their own parameters. `element` and `trigger` are the two shared positional slots. See
the [animations reference](../reference/animations.md) for the full table.

| Class | Effect | Starting state |
|---|---|---|
| `FadeIn` | Opacity 0 → 1, subtle upward drift | Hidden |
| `FadeOut` | Opacity 1 → 0 | Visible |
| `Bounce` | Spring up into place from just below (`distance`) | Hidden |
| `SlideIn` / `SlideOut` | Slide from/to an edge (`direction`, `distance`) | Hidden / Visible |
| `ZoomIn` / `ZoomOut` | Scale into/out of place (`scale`) | Hidden / Visible |
| `Highlight` | Pulse a glow (`color`, `iterations`), without hiding | Visible |

```python
animations.SlideIn("box", direction="left", duration=0.6)
animations.ZoomIn("logo", scale=0.6)
animations.Highlight("total", color="#cba6f7", iterations=2)
```

### Multiple animations on one element

Because each cue is driven independently, one element can carry several across the
slide — it can enter, be emphasized, exit, and even re-enter, each on its own step:

```python
animations = [
    animations.FadeIn("hero"),  # step 1: enters
    animations.Highlight("hero"),  # step 2: emphasized
    animations.SlideOut("hero", direction="down"),  # step 3: exits
    animations.Bounce("hero"),  # step 4: returns
]
```

The kinds decide how they compose: at any step the element is shown or hidden by its
most recent enter/exit, while emphasis cues just pulse. Two enters (or two exits) on one
element with no opposing cue between them is almost always a mistake, and inkflow warns
about it at build time.

### Custom animations

Subclass a semantic base and write a matching `@keyframes anim-<slug>` (the kebab-cased
type name) in a `styles.css` next to `deck.py`. No JavaScript: the step engine reads the
keyframes and drives them, substituting each cue's own fields wherever they appear as
`var(--anim-<field>)`.

```python
from dataclasses import dataclass
from inkflow import animations


@dataclass
class Glow(animations.Emphasis):
    intensity: float = 1.0  # → var(--anim-intensity)
```

```css
/* styles.css */
@keyframes anim-glow {
    50% { filter: drop-shadow(0 0 calc(8px * var(--anim-intensity)) var(--accent)); }
}
```

### Triggers — the step model

Each cue carries a `Trigger` that decides its step:

| Trigger | Meaning |
|---|---|
| `Trigger.ON_CLICK` (default) | Takes the next step, needs a keypress |
| `Trigger.WITH_PREVIOUS` | Shares the previous cue's step, firing together |
| `Trigger.AFTER_PREVIOUS` | Shares the previous cue's step, then plays automatically once it finishes (no keypress) |
| `Trigger.at(n)` | Pins the cue to an absolute step `n` |

`trigger` is the second positional argument (after `element`):

```python
from inkflow import Trigger

animations = [
    animations.FadeIn("left-panel"),  # step 1
    animations.FadeIn("right-panel", Trigger.WITH_PREVIOUS),  # step 1, together
    animations.FadeIn("caption", Trigger.AFTER_PREVIOUS),  # step 1, after right-panel
    animations.FadeIn("footnote"),  # step 2
]
```

A first-in-order `WITH_PREVIOUS` or `AFTER_PREVIOUS` falls to the slide-entry step.
It is not shown pre-resting:
it animates on entry, right after the slide transition settles,
so a slide can build itself the moment you arrive with no keypress.

`AFTER_PREVIOUS` turns one keypress into a self-playing sequence.
The cues share one step and play as a single atomic run,
scrubbed along one 0-to-1 timeline:
the first cue fires on the press (or on entry, if it is first in order),
and each following `AFTER_PREVIOUS` cue starts as the one before it finishes.
So one press forward plays the whole cascade,
a forward press while it is still playing snaps it to the end,
and one press back mirrors it (last stage out first).
`Trigger.at(n)` is the escape hatch for aligning cues on
the shared step axis (see [combining reveals and animations](#combining-markdown-reveals-with-animations)).

## Transitions

A transition controls how the slide enters from the previous one.
Set it per slide, or set a default on the `Deck`:

```python
from inkflow import Deck, Slide, transitions


def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),  # default for all slides
        slides=[
            Slide("title"),  # uses Crossfade
            Slide("diagram", transition=transitions.Morph()),  # overrides to Morph
        ],
    )
```

See [Transitions](transitions.md) for details on each type.

## Filling zones with content

A **zone** is any SVG shape whose `id` starts with `zone-` (see
[Layout system](layout-system.md) for the full rules).
It marks an area the pipeline replaces with injected content at build time.
This is how a slide carries what SVG editors handle poorly —
reflowing text, bullet lists, tables, code blocks — and what an SVG can't hold at all, like video.

Any SVG can define zones, whether it's a one-off slide file or a shared layout.
Fill them the same way in either case.

### From `deck.py` with the `zones` dict

Pass content into named zones directly:

```python
from inkflow import Image, Slide

Slide(
    "title",
    zones={
        "title": "My talk title",
        "media": Image("assets/headshot.jpg", fit="cover"),
    },
)
```

Keys in `zones` are zone names without the `zone-` prefix.
A `str` value is rendered as inline Markdown.
A `TextBox` value gives explicit control over alignment and padding from Python.
An `Image` or `Video` value injects media.
The pipeline replaces the matching `zone-*` element with the injected content at build time.

### From a Markdown file with `md=`

When most of a slide's content is text, it's easier to write it in a `.md` file
than to fill each zone by hand.
Point `md=` at a Markdown file and the pipeline routes its sections into the slide's zones:

```python
from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(
        slides=[
            Slide("content", md="intro"),
        ]
    )
```

`"content"` is the name of a built-in layout — an SVG that defines zones and little
else (see [Built-in layouts](#built-in-layouts) below).
`md` takes the same kind of path as `Slide.src`: a bare name like `"intro"` resolves
to `slides/intro.md`, or write the path out in full.
Nothing about `md=` is special to layouts, though: it fills whatever zones the
referenced SVG defines, one-off slide file or shared layout alike.

## Writing Markdown content

The rest of this section covers the Markdown routing grammar —
how content in a `.md` file lands in the right zones, splits into steps, and more.

### How content is placed

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

### Zone alignment parameters

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

### Step markers

#### Explicit steps with `::step::`

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

#### Auto-stepping with `::steps::`

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

#### Choosing the animation with `type=`

By default a reveal fades in. Give a marker a `type=<ClassName>` plus any of that
type's parameters to use a different animation — the same class names and
parameter names you'd write in `deck.py`:

```markdown
::step type=SlideIn direction=right distance=200::

Slides in from the right.

::step type=Bounce::

Bounces in.
```

The same grammar works on `::steps::`, where the type and parameters apply to
every item in the block:

```markdown
::steps type=SlideIn direction=up::

- Each bullet slides up
- one after another
::steps end::
```

`type=` resolves against the [built-in animation types](../reference/animations.md)
and any custom `Animation` subclass your `deck.py` defines (matched by class
name). Parameters are coerced to each field's type, so `distance=200` becomes a
number and `direction=right` becomes the [`Direction`](../reference/enums.md)
value. Values cannot contain spaces, so an `easing=ease-in-out` preset works in a
marker but a `cubic-bezier(...)` curve is a `deck.py`-only thing.

#### Controlling the step with `trigger=`

A reveal defaults to `ON_CLICK` (one keypress per reveal). Set `trigger=` to
change that:
`with-previous` fires a reveal together with the one before it,
`after-previous` lets it reveal itself once the one before it finishes,
and a number pins it to an absolute step:

```markdown
::step::
First point.

::step trigger=with-previous::
Appears together with the first point.

::step trigger=after-previous::
Reveals on its own, right after the first point.

::step trigger=3::
Pinned to step 3.
```

### Code blocks

All fenced code blocks are syntax-highlighted automatically using Pygments.
No configuration is needed — just write standard Markdown fences with a language tag.

````markdown
```python
def greet(name: str) -> str:
    return f"Hello, {name}!"
```
````

#### Step-based line highlighting

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

#### Step counter integration

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

### Speaker notes

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
Slide("title", notes="Remember to greet the audience.")
Slide("content", md="bullets", notes=Path("notes/bullets.md"))
```

`str` is used as-is (inline HTML/text). `Path` pointing to a `.md` file is rendered as Markdown; any other extension is read as-is.
When both `notes=` and `::notes::` are present, they are concatenated (`notes=` first, then `::notes::`).

### Images

Reference an image from Markdown with standard syntax:

```markdown
![A diagram](assets/diagram.png)
```

Image paths are resolved relative to the **project root** (the directory that holds `deck.py`), not relative to the `.md` file. So `![](assets/diagram.png)` always points at `<project>/assets/diagram.png` no matter where the Markdown file lives. The same rule applies to `<image href="...">` references inside the SVG.

Local image paths are copied into the output of `inkflow build` and `inkflow export`. Remote (`https://`) and `data:` URIs are left as they are.

## Media zones

For images and video that should fill a zone (rather than sit inline in text),
pass an `Image` or a `Video` through the `zones` dict:

```python
from inkflow import Image, Slide

Slide(
    "media-right",
    md="feature",
    zones={"media": Image("assets/screenshot.png", fit="cover")},
)
```

`Image` and `Video` share placement fields (`fit`, `align`, `x`, `y`, `alt_src`);
see the [manifest reference](../reference/manifest.md#inkflow.manifest.Image) for
the full list.

### Video playback

`Video` adds playback control on top of those fields:

```python
from inkflow import Muted, Slide, Video

Slide(
    "media-right",
    md="demo",
    zones={"media": Video("assets/demo.mp4", autoplay=True, loop=True)},
)
```

See the [manifest reference](../reference/manifest.md#inkflow.manifest.Video) for
the full list of playback parameters (`controls`, `autoplay`, `muted`, `loop`,
`poster`, `start`/`end`).

**Play on a step.** To start a clip on a step rather than on load, add an
`animations.PlayVideo` cue targeting the video's zone key to the slide's
`animations=[...]`. It joins the step timeline like any other cue:

```python
from inkflow import Slide, Trigger, Video, animations

Slide(
    "media-right",
    zones={"media": Video("assets/demo.mp4")},
    animations=[animations.PlayVideo("media")],  # plays on the next click
)
```

Leaving a slide pauses and rewinds its video, and stepping back below the cue's
step resets it to the start. A video that both `autoplay`s and is targeted by a
`PlayVideo` cue is contradictory — the cue wins (autoplay is dropped, with a
warning), so the clip waits for its step and plays audibly on the gesture.

**Muting and autoplay.** Browsers block autoplaying video with sound unless the
user has interacted with the page. `Muted.AUTO` (the default) sidesteps that by
muting a clip **only** when it autoplays, so autoplay always works and everything
else (controls, a `PlayVideo` cue) keeps its sound. `Muted.ON` always mutes;
`Muted.OFF` never mutes — with `autoplay=True` that clip may be blocked on a cold
load, which you accept by opting in explicitly.

!!! note "Zones only"
    Playback control applies to `Video` passed through the `zones` dict. A video
    embedded from Markdown with `![](clip.mp4)` renders as a plain, uncontrolled
    element.

## Built-in layouts

Layout names like `"content"` above resolve to reusable layout SVGs.
The built-in theme ships these:

| Name | Zones | Use for |
|---|---|---|
| `cover` | title, subtitle, media | Title / opening slide |
| `section` | title, subtitle | Section divider |
| `title` | title | Bare title, no content zone |
| `content` | title, content | Standard text slide |
| `center` | content | Centered content |
| `two-cols` | title, left, right | Two-column comparison |
| `fact` | fact, caption | Big number or key fact |
| `quote` | quote, attribution | Pull quote |
| `media-left` | title, content, media | Text + image/video (image left) |
| `media-right` | title, content, media | Text + image/video (image right) |
| `end` | title, subtitle | Thank-you / closing slide |

### Referencing project layouts

Add layout SVGs to your project's own `layouts/` directory and reference them the
same way as built-ins — by bare name, which shadows a built-in layout of the same
name, or pin explicitly with `local:`/`theme:`/`builtin:`, or point at a path
directly:

```python
Slide("local:my-layout", md="custom")
```

See [Layout system](layout-system.md#path-resolution) for the full resolution rules
and how to build your own layouts.

## Combining Markdown reveals with animations

When a slide has both Markdown reveals and a deck `animations=[...]` list, they
form **one continuous timeline**: the Markdown reveals number first (in reading
order), then the `animations=[...]` list continues from there.

So with two reveals and two animations, the reveals take steps 1–2 and the
animations take steps 3–4:

```python
from inkflow import animations, Slide, Trigger

Slide(
    "mixed",
    md="bullets",  # two ::steps:: bullets → steps 1, 2
    animations=[
        animations.FadeIn("badge-a"),  # step 3
        animations.FadeIn("badge-b", Trigger.at(5)),  # pinned to step 5
    ],
)
```

`Trigger.WITH_PREVIOUS` works across the boundary too — a first-in-list animation
with it fires together with the last bullet. To place an animation at a specific
reveal's step, pin it with `Trigger.at(n)`.

## Per-slide styling

The `style` parameter injects a CSS `<style>` block into the slide's SVG at render time.
Use it as an escape hatch for one-off tweaks.
For systematic visual changes, use a theme.

```python
Slide(
    "title",
    style="""
    #headline { font-size: 72px; fill: var(--inkflow-accent); }
""",
)
```

## Slide dimensions

Inkflow does not enforce a fixed canvas size.
Design your slides at whatever dimensions suit your presentation:
16:9, 4:3, square, portrait — the presenter scales to fill the available screen area automatically.

The built-in theme layouts are authored at **1920 × 1080** (16:9).
Slides that use them must share that coordinate space.
If you need a different aspect ratio, create layout SVGs at matching dimensions in your SVG editor;
the pipeline treats them identically.

PDF export auto-detects the page size from the first slide's `viewBox`.
You can override it if needed:

```bash
inkflow export --size 2560x1440
```

## Tips

- Keep element IDs short and semantic: `title`, `diagram-step-1`, `callout`.
- Elements that should never animate don't need IDs.
- The pipeline strips editor metadata on every load.
  No need to clean manually if you have the git hook set up.
- SVGs from any editor (Figma export, Affinity Designer, hand-coded) work without pre-processing.
