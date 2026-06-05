# Manifest reference

All classes exported from `inkflow` and usable in `deck.py`.

## `Deck`

The top-level container.
Assign a `Deck` instance to the module-level `deck` variable in `deck.py`.

```python
deck = Deck(
    transition=Crossfade(),   # default transition for all slides
    theme="./my-theme",       # path to theme directory
    dark_mode=True,           # data-theme="dark" on <html>
    style="",                 # CSS injected into every slide
    font_size=36,             # base font size for MarkdownSlide content (px)
)
deck.slides = [...]
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `transition` | `Transition \| None` | `None` | Default transition. `Cut` if unset |
| `theme` | `str \| None` | `None` | Path to theme directory |
| `dark_mode` | `bool` | `True` | Sets `data-theme` on `<html>` |
| `style` | `str` | `""` | CSS string injected into every slide |
| `font_size` | `int` | `36` | Base font size for `MarkdownSlide` (px) |

---

## `Slide`

An SVG-backed slide.

```python
Slide(
    "slides/01-title.svg",
    animations=[FadeIn("#headline", step=1)],
    transition=Crossfade(),
    content=[TextBox(element="zone-title", text="My title")],
    style="",
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `src` | `str` | required | Path to SVG file, relative to `deck.py` |
| `animations` | `list[Animation]` | `[]` | Animation declarations |
| `transition` | `Transition \| None` | `None` | Overrides deck-level transition |
| `content` | `list[Content]` | `[]` | `TextBox` or `Media` injections into named zone elements |
| `style` | `str` | `""` | CSS string injected into this slide |
| `title` | `str \| None` | `None` | Optional slide title; auto-inferred from filename if not set |
| `notes` | `str \| Path \| None` | `None` | Speaker notes. A string is rendered as Markdown. A `Path` to a `.md` file is rendered as Markdown; other suffixes are read as raw HTML |

**`step_count`** (property): the highest `step` value across all animations.
This is the number of keypresses before advancing.

---

## `MarkdownSlide`

A layout-backed slide with content injected from a Markdown file.

```python
MarkdownSlide(
    "default",                        # layout name or path
    content="slides/02-bullets.md",   # Markdown file
    steps=True,                       # enable ::step:: markers
    animations=[],
    transition=None,
    style="",
    media=Media("assets/photo.jpg"),  # keyword: matches zone name
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `template` | `str` | required | Layout name or path |
| `content` | `str \| None` | `None` | Path to `.md` file, relative to `deck.py` |
| `steps` | `bool` | `False` | Enable `::step::` markers in Markdown |
| `animations` | `list[Animation]` | `[]` | Additional animation declarations |
| `transition` | `Transition \| None` | `None` | Overrides deck-level transition |
| `style` | `str` | `""` | CSS string injected into this slide |
| `title` | `str \| None` | `None` | Optional slide title. Auto-inferred from leading `# heading` if not set |
| `notes` | `str \| Path \| None` | `None` | Speaker notes. Concatenated with any `::notes::` zone in the Markdown file |
| `**kwargs` | `str \| Media` | — | Extra content routed to matching zones |

---

## `Media`

A media asset (image or video) for use with `Slide` or `MarkdownSlide`.

```python
Media(
    src="assets/screenshot.png",
    fit="contain",    # CSS object-fit
    align="center",   # CSS object-position
    x=0.0,            # horizontal offset (px)
    y=0.0,            # vertical offset (px)
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `src` | `str` | required | Path to image or video file |
| `fit` | `str` | `"contain"` | `"contain"` or `"cover"` |
| `align` | `str` | `"center"` | CSS `object-position` value |
| `x` | `float` | `0.0` | Horizontal offset in pixels |
| `y` | `float` | `0.0` | Vertical offset in pixels |

For video files, you can pass the path string directly as a shorthand:
`media="assets/demo.mp4"`.

---

## `TextBox`

Injects text into a named zone element in an SVG slide.

```python
from inkflow import Align, VAlign, TextBox

TextBox(
    element="#zone-content",
    text="<p>My content</p>",
    align=Align.CENTER,
    valign=VAlign.CENTER,
    padding=40,
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `element` | `str` | required | CSS ID selector for the target zone element |
| `text` | `str \| None` | `None` | HTML content to inject |
| `steps` | `bool` | `False` | Enable step-based reveal within the text |
| `align` | `Align \| None` | `None` | Horizontal text alignment. `None` defers to the layout CSS variable |
| `valign` | `VAlign \| None` | `None` | Vertical alignment of the content block. `None` defers to the layout CSS variable |
| `padding` | `float \| None` | `None` | Inner padding in SVG user units. `None` defers to the layout CSS variable |

---

## `Align`

Horizontal text alignment for `TextBox`.

| Value | Effect |
|---|---|
| `Align.LEFT` | Left-aligned (default when no override is set) |
| `Align.CENTER` | Centred |
| `Align.RIGHT` | Right-aligned |
| `Align.JUSTIFY` | Justified |

---

## `VAlign`

Vertical alignment of the content block inside a `TextBox` zone.

| Value | Effect |
|---|---|
| `VAlign.TOP` | Content anchored to the top of the zone (default when no override is set) |
| `VAlign.CENTER` | Content centred vertically |
| `VAlign.BOTTOM` | Content anchored to the bottom of the zone |

---

## Animations

All animation classes take `element` (a CSS ID selector like `"#headline"`)
and `step` (an integer ≥ 1).

### `FadeIn`

Element starts hidden. Fades in with a subtle upward drift on its step.

```python
FadeIn("#headline", step=1)
```

### `FadeOut`

Element starts visible. Fades out on its step.

```python
FadeOut("#old-label", step=2)
```

### `Bounce`

Element starts hidden. Appears with a scale-pulse bounce on its step.

```python
Bounce("#box-pipeline", step=3)
```

### `Animation` (protocol)

A structural protocol: any object with `element: str` and `step: int` is a valid animation.
You can define custom animation types that satisfy this protocol.

---

## Transitions

### `Cut`

Instant slide switch, no animation.

```python
Cut()
```

### `Crossfade`

Dissolve between slides.

```python
Crossfade(duration=0.4)
```

| Parameter | Default |
|---|---|
| `duration` | `0.4` |

### `Morph`

Interpolates matching elements by ID between slides.
Supports `<rect>`, `<circle>`, `<ellipse>`.
Other elements fall back to fade.

```python
Morph(duration=0.5)
```

| Parameter | Default |
|---|---|
| `duration` | `0.5` |

### `Transition` (protocol)

Any object with `duration: float` is a valid transition.
