# Layout system

Layouts are reusable SVG templates.
They define the visual frame (background, typography regions, brand elements)
while leaving named rectangular **zones** for content to be injected at build time.

## Zones

A zone is any SVG shape with an `id` that starts with `zone-`.
`<rect>` is the most common:

```xml
<rect id="zone-content" x="120" y="200" width="1680" height="760"/>
```

At build time the pipeline replaces each zone element with a `<foreignObject>`
sized to the shape's bounding box, containing the rendered HTML.
Zone elements that aren't filled by the slide are silently removed.

Inkscape's Layers & Objects panel edits an element's *label*, not its `id`.
Label the rect `zone-content` there and run `inkflow label2id` to promote the
label to the `id` (see [Transitions](transitions.md#naming-elements-from-inkscape)).

### Non-rectangular zones

`<polygon>`, `<ellipse>`, `<circle>`, and `<path>` are also valid zone shapes.
For **Media zones**, the pipeline auto-generates a `<clipPath>` from the exact shape
and applies it to the `<foreignObject>`, so images and videos are cropped to the
zone boundary.

For **TextBox zones**, only the bounding box is used.
Text reflows in a rectangle regardless of zone shape, and no clip is applied.

Alignment CSS variables set on a non-rect zone id work the same as on a rect:

```css
#zone-media { --inkflow-valign: center; }
```

### Reserved zone names

| ID | Pipeline behaviour |
|---|---|
| `zone-title` | Receives the leading `# H1` from Markdown auto-extraction (when the zone exists) |
| `zone-subtitle` | Receives the `## H2` immediately after the title (when the zone exists) |
| `zone-slide-number` | `<text>` element. Replaced with the current slide number |
| `zone-slide-total` | `<text>` element. Replaced with the total slide count |

Any `zone-*` name beyond these is valid.
Name it to match what your Markdown files use (`zone-content`, `zone-left`, `zone-right`, `zone-media`, etc.).

### Default zone

The **default zone** receives all unrouted Markdown content — everything not claimed
by an explicit `::zone-name::` marker or by `zone-title` / `zone-subtitle` auto-extraction.

Layouts declare their default zone with the `inkflow:default-zone` attribute:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     inkflow:default-zone="content"
     viewBox="0 0 1920 1080" width="1920" height="1080">
  <rect id="zone-content" x="120" y="200" width="1680" height="720"/>
</svg>
```

When the layout contains `zone-content`, that zone is the implicit default and
the attribute is not needed.
Set `inkflow:default-zone` only when you want a different zone to be the default
(e.g. `zone-quote`, `zone-left`).

Layouts that have no text content zone at all — like `cover.svg` (media + title/subtitle)
or `section.svg` (title/subtitle only) — do not need the attribute.

If a slide's Markdown contains unrouted content and the layout has no `inkflow:default-zone`,
the pipeline raises an error and shows a red overlay in the browser.

#### Auto-extraction fall-through

When `zone-title` or `zone-subtitle` are **absent** from a layout, any leading
`# H1` / `## H2` auto-extracted from the Markdown falls through to the default zone
as rendered HTML, rather than being silently discarded.

```markdown
# This is a Quote
And this is the attribution line.
```

On the `quote` layout (`inkflow:default-zone="quote"`, no `zone-title`),
both lines above land in `zone-quote`.
On the `content` layout (`inkflow:default-zone="content"`, has `zone-title`),
`# H1` still routes to `zone-title` as usual.

To route content to a specific zone regardless of the default, use an explicit marker:

```markdown
::quote::
This text always goes to zone-quote.
::attribution::
— Author name
```

## Layout inheritance

Layouts chain to their parents via an `inkflow:parent` attribute on the SVG root:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="https://inkflow.dev/ns"
     inkflow:parent="theme:main"
     viewBox="0 0 1920 1080" width="1920" height="1080">
  <!-- layout-specific zones -->
</svg>
```

A typical chain looks like:

```
slides/bullets.svg
  └─ inkflow:parent="content"         → layouts/content.svg
       └─ inkflow:parent="theme:main" → theme/main.svg  (chain terminates — no parent)
```

The pipeline resolves the full chain and composites all layers from root to leaf.
The SVG files on disk stay unmodified.

## Overlays

`inkflow:parent` answers "what am I built on" and composites *behind* a slide.
Chrome that cuts across layouts asks a different question:
"what goes on top of every slide, regardless of what it is built on".
A logo, a footer, a header.
That is an **overlay**.

An overlay is an SVG at slide dimensions,
composited above the finished slide:

```python
from inkflow import Deck, Overlay, Slide

Deck(
    overlays=[Overlay("footer"), Overlay("logo")],
    slides=[
        Slide("title.svg", overlays=[]),  # bare title, no chrome
        Slide("content", md="intro.md"),  # inherits the deck's two
    ],
)
```

List order is paint order.
Resolution runs `Slide.overlays` → `Deck.overlays` → `Theme.overlays`,
each an override rather than a merge:
`None` inherits the next level up,
and `[]` means no chrome at all.

Because overlays composite before zone numbering and content injection,
three things follow without extra work:

- A `zone-slide-number` inside a footer overlay is filled like any other.
- A zone the overlay declares can be filled from `zones={...}` on a slide,
  and is pruned on slides that leave it empty.
- Animations can target elements inside an overlay,
  so chrome can be revealed on a step.

Overlays live in their own `overlays/` directory
and resolve through the same three-level search and prefix grammar as layouts,
against `overlays/` instead of `layouts/`:

| Syntax | Resolves to |
|---|---|
| `"footer"` | Three-level search for `overlays/footer.svg` |
| `"local:footer"` | `{project}/overlays/footer.svg` |
| `"theme:footer"` | `{theme_dir}/overlays/footer.svg` |
| `"builtin:footer"` | Inkflow built-in overlays |
| `"./chrome/footer.svg"` | Relative to the project directory |

Layouts and overlays are separate namespaces,
so a bare name always means one or the other and never both.

`inkflow sync` previews chrome in your SVG editor too,
see [Which overlays a file previews](#which-overlays-a-file-previews).

### Overlays can inherit too

`inkflow:parent` on an overlay means "drawn behind me *within this overlay*".
The overlay as a whole still lands on top of the slide,
so the two axes stay independent:

```
overlays/brand.svg           the rule line and mark
overlays/chrome.svg          inkflow:parent="brand", adds the event name
```

This is how a theme can ship `theme:brand`
that a project extends locally without copying it.
Bare names in an overlay's `inkflow:parent` resolve in the overlay namespace,
so chrome can only ever inherit chrome.

!!! warning "Do not point an overlay's parent at a layout"

    Layouts paint a full-bleed background,
    which on top of a slide hides the entire deck.
    Bare names cannot reach a layout from an overlay,
    so this takes an explicit path to trigger.
    `inkflow verify` reports it as an error and names the offending file.

### Removing an element from a layout

There is no mechanism for this, because it is styling rather than structure.
Hide it with CSS, which is already scoped per slide:

```python
Slide("content", extra_style=Inline("#logo { display: none }"))
```

## Path resolution

Inkflow resolves layout names using a three-level search:

1. Project `layouts/` directory
2. Active theme `layouts/` directory (if `Deck(theme=...)` is set)
3. Inkflow built-in layouts

First match wins.
Prefixes bypass the search entirely:

| Syntax | Resolves to |
|---|---|
| `"content"` | Three-level search for `content.svg` |
| `"local:content"` | `{project}/layouts/content.svg` |
| `"theme:content"` | `{theme_dir}/layouts/content.svg` |
| `"builtin:content"` | Inkflow built-in layouts |
| `"./relative/path.svg"` | Relative to the current SVG file |

## Creating a new slide from a layout

The `inkflow add` command creates a new SVG file, optionally wired to a layout
parent via `-p/--parent`:

```bash
inkflow add slides/new.svg -p content
```

This creates `slides/new.svg` with `inkflow:parent="content"` set,
then automatically runs `inkflow sync` to add preview layers.
Omit `-p` to create a blank slide with no parent.

Add it to the `slides` list in `deck.py`:

```python
Slide("slides/new.svg")
```

## Changing or removing a parent

To rewire an existing slide to a different layout:

```bash
inkflow parent set slides/new.svg builtin:content
```

To detach a slide from all layout parents:

```bash
inkflow parent strip slides/new.svg
```

## Previewing layouts in Inkscape

`inkflow sync` writes each ancestor as a locked layer into the slide SVG,
and the overlays the slide gets at runtime as locked layers on top of it,
so you can see the inherited background, the zone positions,
and how much room the chrome needs while editing in your SVG editor:

```bash
inkflow sync
```

Bottom to top, a synced slide holds the ancestor chain, its own content, then the overlays.
These layers are for authoring reference only.
The pipeline strips them before serving. They never appear in the browser.

To check if any layers are stale without rewriting:

```bash
inkflow sync --check
```

Exits with code 1 if any files need updating (useful in CI).

### Which overlays a file previews

`sync` works on files, overlays are declared on slides,
and one file can back many slides that disagree,
so the answer is resolved in three steps:

1. An explicit `inkflow:preview-overlays` attribute on the file wins.
   Space-separated names, `""` for none.
2. Otherwise, if every slide backed by this file agrees, that.
   A slide backs its own `src` and every layout in that file's chain.
3. Otherwise the deck default.

`sync` prints which rule fired next to each file,
so step 3 is never silent:

```
    Injected  slides/intro.svg (1 overlay layer, slides agree)
    Injected  layouts/content.svg (1 overlay layer, deck default overlays)
    Injected  overlays/footer.svg (overlay file)
```

Step 3 is a guess, and it deliberately errs toward *showing* chrome:
the question you are answering in Inkscape is how much room to leave,
and a preview showing chrome a slide will not have costs you some empty space,
while the opposite causes overlap.
When the guess is wrong for a given file, pin it with the attribute:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="content"
     inkflow:preview-overlays="footer logo"
     viewBox="0 0 1920 1080">
```

### Authoring an overlay itself

An overlay file never receives chrome,
otherwise `sync` would stamp the deck's footer onto the footer you are drawing.
It can name a *backdrop* instead:
something rendered behind it purely as reference,
so you are not positioning chrome against a checkerboard.

```xml
<!-- overlays/footer.svg -->
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:preview="content"
     viewBox="0 0 1920 1080">
```

`inkflow:preview` takes a layout name, any of the prefixes,
or a relative path.
A path is the useful form for a deck of hand-drawn SVGs with no layouts at all,
where the honest backdrop is a real slide:

```xml
     inkflow:preview="../slides/01-title.svg"
```

The slide's own layout chain comes along with it,
exactly as when you edit that slide.

There is **no default**.
Without the attribute an overlay gets the preview styles and nothing behind it,
and `sync` says so:

```
    Injected  overlays/footer.svg (overlay file, no backdrop)
    Injected  overlays/logo.svg (overlay file, backdrop: content)
```

An overlay cannot know what it lands on,
and guessing at the theme's `base` would be wrong in exactly the case that matters:
a deck built on no layouts gets chrome positioned against a canvas of the wrong size
in a background colour the deck never paints.

The name says what it is: a preview choice, not a structural claim.
Picking `content` as a backdrop while the overlay lands on `two-cols` at runtime
is not a contradiction.

Both attributes are authoring hints.
Neither is ever read by the serve or build pipeline.

A file counts as an overlay when it lives in an `overlays/` directory
or the deck references it as an overlay.
The first half covers drafts not yet added to `deck.py`,
the second covers overlays parked outside the convention by a relative path.

## Authoring a theme

Theme layouts live outside any project and have no `deck.py`.
Within a theme, layouts may still chain to each other or to built-in layouts —
but `local:` and `theme:` references are not available (they require a project context).
Use `builtin:` or relative paths instead:

```xml
<!-- theme/layouts/content.svg -->
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     viewBox="0 0 1920 1080" width="1920" height="1080">
  ...
</svg>
```

To refresh injected layout layers while working on theme files, use `--no-deck`:

```bash
inkflow sync --no-deck layouts/*.svg
```

Attempting to use `local:` or `theme:` with `--no-deck` raises an error immediately.

With no deck there is no slide-to-overlay mapping to derive,
so overlay previews come from `inkflow:preview-overlays` alone
and every other file is synced without chrome.
A theme overlay still gets whatever backdrop it names.

## Writing a custom layout

1. Create `layouts/my-layout.svg` in your project directory.
2. Set `inkflow:parent` to point at your base theme or another layout.
3. Add `<rect id="zone-*">` elements where you want content (or any supported shape — see [Non-rectangular zones](#non-rectangular-zones)).
4. Set `inkflow:default-zone` to the zone that should receive unrouted Markdown text.
5. Reference it in `deck.py`:

```python
Slide("my-layout", md="custom")
```

### Example layout

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     inkflow:default-zone="content"
     viewBox="0 0 1920 1080" width="1920" height="1080">

  <!-- Narrower content column; unrouted Markdown goes here -->
  <rect id="zone-content" x="300" y="200" width="1320" height="720"/>
</svg>
```

### Two-column layout example

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:content"
     inkflow:default-zone="left"
     viewBox="0 0 1920 1080" width="1920" height="1080">

  <!-- Unrouted content goes left; use ::right:: to route to the right column -->
  <rect id="zone-left"  x="80"   y="200" width="840" height="720"/>
  <rect id="zone-right" x="1000" y="200" width="840" height="720"/>
</svg>
```

In Markdown, unmarked text goes to `zone-left` automatically:

```markdown
# Two Columns

Left column content here.

::right::
Right column content here.
```
