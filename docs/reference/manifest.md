# Manifest reference

Classes exported from `inkflow` and usable in `deck.py`. Animation types live in the
`inkflow.animations` namespace (`from inkflow import animations`); transition types live in
the `inkflow.transitions` namespace (`from inkflow import transitions`); everything else is
imported directly from `inkflow`.

## `Deck`

The top-level container.
Define a `main() -> Deck` function in `deck.py`; Inkflow calls it at serve time.

```python
def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),   # default transition for all slides
        theme="./my-theme",                   # path to theme directory
        mode=ColorMode.DARK,                  # data-theme attribute on <html>
        style="styles.css",                   # CSS file injected into every slide
        font_size=36,                         # base font size for zone content (px)
        slides=[...],
    )
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `slides` | `list[Slide]` | `[]` | The slide list |
| `transition` | `Transition \| None` | `None` | Default transition. `Cut` if unset |
| `theme` | `str \| None` | `None` | Path to theme directory |
| `mode` | `ColorMode` | `ColorMode.DARK` | Sets `data-theme` on `<html>` |
| `style` | `Content` | `None` | CSS injected into every slide. A bare `str` is a file path; `Inline(...)` is a literal CSS string |
| `font_size` | `int` | `36` | Base font size for zone content (px) |
| `embed_fonts` | `bool` | `True` | Auto-discover and embed fonts used in slides. See [Font embedding](../guides/fonts.md) |

**Deck → Slide inheritance rules:**

- `transition`, `font_size` — **override**: a `Slide` value replaces the `Deck` default. `None` on the slide means "inherit from deck."
- `style` / `extra_style` — **additive**: `Deck.style` is emitted first; `Slide.extra_style` is appended. The slide CSS wins on equal-specificity rules via cascade order. Set `Slide.extra_style` to `None` (the default) to add nothing.
- `theme`, `mode`, `embed_fonts` — deck-only; no per-slide override.

---

## `Slide`

A slide. Pass an SVG path for a pure SVG slide, or a layout name with `md=` for a Markdown-backed slide.

```python
# SVG slide with animations
Slide(
    "slides/01-title.svg",
    animations=[animations.FadeIn("#headline", step=1)],
    transition=transitions.Crossfade(),
    extra_style=Inline("#headline { fill: hotpink; }"),
)

# Layout-backed slide with Markdown content
Slide(
    "default",
    md="slides/02-bullets.md",
    zones={"media": Media("assets/photo.jpg")},
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `src` | `str` | required | SVG file path, or bare layout name (e.g. `"default"`) |
| `id` | `str \| None` | `None` | Stable identifier for this slide. Auto-inferred from the `.md` filename stem (e.g. `"08-markdown"`) or the `src` stem if not set. Must be unique across the deck; collisions are resolved by appending `-2`, `-3`, etc. Set explicitly for stable cross-slide links |
| `md` | `Content` | `None` | Path to `.md` file, or `Inline("# heading\n\nbody")` for inline Markdown. Makes `src` resolve as a layout name |
| `zones` | `dict[str, str \| Media \| TextBox]` | `{}` | Per-zone overrides. Keys are zone names without the `zone-` prefix. `str` values are rendered as inline Markdown; `TextBox` values give explicit alignment/padding control; `Media` values inject an image or video |
| `animations` | `list[Animation]` | `[]` | Animation declarations |
| `transition` | `Transition \| None` | `None` | Overrides deck-level transition |
| `extra_style` | `Content` | `None` | CSS appended to the deck style for this slide. A bare `str` is a file path; `Inline(...)` is a literal CSS string |
| `title` | `str \| None` | `None` | Optional slide title. Auto-inferred from filename or leading `# heading` |
| `notes` | `Content` | `None` | Speaker notes rendered as Markdown. A bare `str` is a file path; `Inline("...")` is literal content. Concatenated with any `::notes::` marker in the Markdown file |
| `font_size` | `int \| None` | `None` | Per-slide font size override (px). Inherits from `Deck.font_size` when `None` |
| `visible` | `bool` | `True` | When `False`, the slide is excluded from the presentation entirely |

**`step_count`** (property): the highest `step` value across all animations.
This is the number of keypresses before advancing.

---

## `Inline`

A string subclass that marks a value as literal content rather than a file path.

```python
from inkflow import Inline

# notes from a file (bare str = path)
notes="slides/04-notes.md"

# notes as inline content (Inline = literal)
notes=Inline("Welcome the audience.\n\nPress `p` for presenter view.")

# CSS inline vs from file
extra_style=Inline("#headline { fill: hotpink; }")
extra_style="slides/overrides.css"
```

`Inline` is a subclass of `str`, so `isinstance(Inline("x"), str)` is `True` and it
compares equal to its content. The distinction only matters at pipeline resolution time.

---

## `Content`

Type alias used for fields that accept either a file path or literal content:

```python
Content = str | Inline | None
```

Used by `Slide.md`, `Slide.notes`, `Slide.extra_style`, and `Deck.style`.

---

## `Media`

A media asset (image or video) for injection into a zone.

```python
Media(
    src="assets/screenshot.png",
    fit=MediaFit.CONTAIN,   # CSS object-fit
    align=MediaAlign.CENTER, # object-position
    x=0.0,                  # horizontal offset (px)
    y=0.0,                  # vertical offset (px)
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `src` | `str` | required | Path to image or video file, or a URL |
| `alt_src` | `str \| None` | `None` | Alternative source for the other color mode |
| `fit` | `MediaFit` | `MediaFit.CONTAIN` | CSS `object-fit` value |
| `align` | `MediaAlign` | `MediaAlign.CENTER` | CSS `object-position` preset |
| `x` | `float` | `0.0` | Horizontal offset in pixels |
| `y` | `float` | `0.0` | Vertical offset in pixels |

Pass it as a value in the `zones` dict to inject it into a named zone:

```python
Slide("media-right", md="slides/03-feature.md", zones={"media": Media("assets/demo.mp4")})
```

---

## `TextBox`

Injects text into a named zone element in an SVG slide.

```python
from inkflow import Align, VAlign, TextBox

TextBox(
    text="<p>My content</p>",
    align=Align.CENTER,
    valign=VAlign.CENTER,
    padding=40,
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `text` | `str \| None` | `None` | HTML content to inject |
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

## `Direction`

Direction for animations and transitions that move along an axis.

| Value | CSS class / wire value |
|---|---|
| `Direction.LEFT` | `"left"` |
| `Direction.RIGHT` | `"right"` |
| `Direction.UP` | `"up"` |
| `Direction.DOWN` | `"down"` |

Used by `SlideIn`, `SlideOut`, `Push`, `Cover`, and `Wipe`.

---

## `MediaFit`

CSS `object-fit` preset for `Media`.

| Value | CSS value |
|---|---|
| `MediaFit.CONTAIN` | `"contain"` |
| `MediaFit.COVER` | `"cover"` |
| `MediaFit.FILL` | `"fill"` |
| `MediaFit.NONE` | `"none"` |
| `MediaFit.SCALE_DOWN` | `"scale-down"` |

---

## `MediaAlign`

`object-position` preset for `Media`. Maps to a percentage position pair.

| Value | Position |
|---|---|
| `MediaAlign.CENTER` | 50% 50% |
| `MediaAlign.TOP` | 50% 0% |
| `MediaAlign.BOTTOM` | 50% 100% |
| `MediaAlign.LEFT` | 0% 50% |
| `MediaAlign.RIGHT` | 100% 50% |
| `MediaAlign.TOP_LEFT` | 0% 0% |
| `MediaAlign.TOP_RIGHT` | 100% 0% |
| `MediaAlign.BOTTOM_LEFT` | 0% 100% |
| `MediaAlign.BOTTOM_RIGHT` | 100% 100% |

---

## `ColorMode`

Color mode for the presentation. Controls the `data-theme` attribute on `<html>`.

| Value | Effect |
|---|---|
| `ColorMode.DARK` | `data-theme=""` (dark theme CSS active) |
| `ColorMode.LIGHT` | `data-theme="light"` (light theme CSS active) |

---

## `ZoneContent`

Type alias for the values accepted in `Slide.zones`:

```python
ZoneContent = str | Media | TextBox
```

`str` is rendered as inline Markdown. `TextBox` gives explicit alignment and padding control. `Media` injects an image or video.

---

## Animations

Animation types live in the `inkflow.animations` namespace:

```python
from inkflow import animations, Direction

Slide("slides/01.svg", animations=[
    animations.FadeIn("#headline", step=1),
    animations.SlideIn("#box", step=2, direction=Direction.LEFT, duration=0.6),
])
```

### Shared parameters

Every animation type takes these:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `element` | `str` | required | CSS ID selector, e.g. `"#headline"` |
| `step` | `int` | `1` | The keypress on which it plays |
| `duration` | `float \| None` | `None` | Seconds. `None` keeps the CSS default |
| `easing` | `str \| None` | `None` | Any CSS easing (`"ease"`, `"ease-in-out"`, `"cubic-bezier(...)"`, `"linear"`) |
| `delay` | `float \| None` | `None` | Seconds before it starts |

`duration`, `easing`, and `delay` are keyword-only. A value of `None` means the
animation's built-in CSS default is used, so you only set what you want to override.

### Types

| Type | Extra parameters | Effect |
|---|---|---|
| `FadeIn` | — | Element starts hidden, fades in on its step |
| `FadeOut` | — | Element starts visible, fades out on its step |
| `Bounce` | — | Appears with a scale-pulse bounce |
| `SlideIn` | `direction: Direction` (default `LEFT`), `distance` (user units) | Slides in from an edge while fading |
| `SlideOut` | `direction: Direction`, `distance` | Slides out toward an edge while fading |
| `ZoomIn` | `scale` (starting scale, e.g. `0.6`) | Scales up into place |
| `ZoomOut` | `scale` (ending scale) | Scales down out of place |
| `Highlight` | `color` (CSS color), `passes` (pulse count) | Pulses a glow without hiding the element |

```python
animations.ZoomIn("#box-pipeline", step=3, scale=0.6)
animations.Highlight("#headline", step=1, color="#cba6f7", passes=2)
```

### `Animation` (base class)

`inkflow.manifest.Animation` is the data-only base class every type above subclasses.
Define a custom animation by subclassing it directly in `deck.py` — no changes to inkflow
are needed.

**How it works:**

- The CSS class is derived from the type name: `MyGlow` → `anim-my-glow`.
- Any extra fields you add become `--anim-<field>` CSS custom properties on the element.
- The base timing params (`duration`, `easing`, `delay`) are always emitted when set.
- Put the matching CSS rules in a `styles.css` file next to your `deck.py` — the server loads it automatically.

```python
# deck.py
from dataclasses import dataclass
from inkflow import Animation

@dataclass
class MyGlow(Animation):
    intensity: float | None = None   # → --anim-intensity on the element
```

```css
/* styles.css — next to deck.py */
@keyframes my-glow-pulse {
    50% { filter: drop-shadow(0 0 calc(var(--anim-intensity, 8) * 1px) gold); }
}
.anim-my-glow { }
.anim-my-glow.active {
    animation: my-glow-pulse var(--anim-duration, 0.6s) var(--anim-easing, ease)
        var(--anim-delay, 0s) forwards;
}
```

```python
Slide("slides/01.svg", animations=[
    MyGlow("#headline", step=1, intensity=12, duration=0.8),
])
```

Authoring `class="anim-my-glow" data-step="1"` directly in the SVG works too — the
presenter reads `data-step` from the DOM regardless of whether the element is listed in
`deck.py`.

---

## Transitions

Transition types live in the `inkflow.transitions` namespace:

```python
from inkflow import transitions, Direction

Slide("slides/01.svg", transition=transitions.Push(direction=Direction.RIGHT))
```

### Shared parameters

Every transition type takes these:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `duration` | `float` | `0.5` (`Cut` is `0.0`) | Seconds |
| `easing` | `str \| None` | `None` | Any CSS easing string. `None` keeps the handler's built-in default |

`easing` is keyword-only. A value of `None` means the handler's own default is used.

### Types

| Type | Extra parameters | Effect |
|---|---|---|
| `Cut` | — | Instant switch, no animation |
| `Crossfade` | — | Outgoing dissolves into incoming |
| `Push` | `direction: Direction` | Both slides move — outgoing exits, incoming enters from the opposite edge |
| `Cover` | `direction: Direction` | Incoming slide covers the outgoing one, which stays put |
| `Zoom` | `amount` | Outgoing scales out, incoming scales in |
| `Fade` | `color` | Outgoing fades to a solid colour, then incoming fades in from it |
| `Wipe` | `direction: Direction` | Incoming is progressively revealed from one edge over the outgoing slide |
| `Morph` | — | Matching SVG elements interpolate by ID; unmatched content crossfades |

`direction` defaults to `Direction.LEFT` for all directional types.

```python
transitions.Push(direction=Direction.RIGHT, easing="ease-in-out")
transitions.Cover(duration=0.6, direction=Direction.UP)
transitions.Fade(color="#1a1a2e")
transitions.Wipe(direction=Direction.RIGHT, duration=0.7)
transitions.Morph(duration=1.2)
```

Every type defaults to `0.5 s`, except `Cut` which is `0.0 s` (instant).

### `Transition` (base class)

`inkflow.manifest.Transition` is the data-only base class every type above subclasses.
Define a custom transition by subclassing it in `deck.py` — the type name becomes the JS
handler key automatically (`MyWarp` → `"my-warp"`). It inherits the animating `0.5 s`
`duration` default, so it works without overriding anything. Register the matching JS
handler from a `scripts.js` file next to `deck.py` (loaded automatically):

```python
# deck.py
from dataclasses import dataclass
from inkflow.manifest import Transition

@dataclass
class MyWarp(Transition):
    intensity: float = 1.0   # serialized as {"intensity": 1.0} in TransitionData
```

Most transitions are a single render function: given the two layers and a progress
value (`0` = old slide shown, `1` = new shown), paint that frame. The framework owns
the `requestAnimationFrame` loop, the easing, and mid-flight reversal — reversing
direction is automatic, the render never has to handle it.

```js
// scripts.js, loaded after the presenter bundle
window.inkflow.registerProgressTransition(
    "my-warp",
    (context, progress, params) => {
        // context = { stage, oldLayer, newLayer }; params has duration, intensity, easing.
        context.oldLayer.style.opacity = String(1 - progress);
        context.newLayer.style.transform = `scale(${1 + params.intensity * (1 - progress)})`;
    },
    { easing: "ease-in-out" }, // optional default curve used when params.easing is unset
);
```

`progress` arrives already eased. The same render plays forward and, re-targeted,
backward, so a transition reversed mid-flight picks up smoothly from its current
frame with no extra code.

For full control there is a lower-level escape hatch,
`window.inkflow.registerTransition(name, factory)`, where `factory` returns an object
with a required async `start` and optional `prepare` / `cancel` / `reverse` methods.
This is how the built-in `cut` and `morph` are implemented.
