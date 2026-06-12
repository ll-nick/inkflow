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
| `zone-title` | Receives the leading `# H1` from Markdown auto-extraction |
| `zone-subtitle` | Receives the `## H2` immediately after the title |
| `zone-content` | Default content zone (everything not routed elsewhere) |
| `zone-slide-number` | `<text>` element. Replaced with the current slide number |
| `zone-slide-total` | `<text>` element. Replaced with the total slide count |

Any `zone-*` name beyond these is valid.
Name it to match what your Markdown files use (`zone-left`, `zone-right`, `zone-media`, etc.).

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
slides/05-bullets.svg
  └─ inkflow:parent="content"         → layouts/content.svg
       └─ inkflow:parent="theme:main" → theme/main.svg  (chain terminates — no parent)
```

The pipeline resolves the full chain and composites all layers from root to leaf.
The SVG files on disk stay unmodified.

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

The `inkflow add` command creates a new SVG file wired to a layout parent:

```bash
inkflow add content slides/07-new.svg
```

This creates `slides/07-new.svg` with `inkflow:parent="content"` set,
then automatically runs `parent inject` to add preview layers.

Add it to `deck.py`:

```python
Slide("slides/07-new.svg"),
```

## Changing or removing a parent

To rewire an existing slide to a different layout:

```bash
inkflow parent set slides/07-new.svg builtin:content
```

To detach a slide from all layout parents:

```bash
inkflow parent strip slides/07-new.svg
```

## Previewing layouts in Inkscape

`inkflow parent inject` writes each ancestor as a locked layer into the slide SVG,
so you can see the inherited background and zone positions while editing in your SVG editor:

```bash
inkflow parent inject
```

These layers are for authoring reference only.
The pipeline strips them before serving. They never appear in the browser.

To check if any layers are stale without rewriting:

```bash
inkflow parent inject --check
```

Exits with code 1 if any files need updating (useful in CI).

## Authoring a theme

Theme layouts live outside any project and have no `deck.py`.
Within a theme, layouts may still chain to each other or to built-in layouts —
but `local:` and `theme:` references are not available (they require a project context).
Use `builtin:` or relative paths instead:

```xml
<!-- theme/layouts/content.svg -->
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="builtin:default"
     viewBox="0 0 1920 1080" width="1920" height="1080">
  ...
</svg>
```

To refresh injected layout layers while working on theme files, use `--no-deck`:

```bash
inkflow parent inject --no-deck layouts/*.svg
```

Attempting to use `local:` or `theme:` with `--no-deck` raises an error immediately.

## Writing a custom layout

1. Create `layouts/my-layout.svg` in your project directory.
2. Set `inkflow:parent` to point at your base theme or another layout.
3. Add `<rect id="zone-*">` elements where you want content (or any supported shape — see [Non-rectangular zones](#non-rectangular-zones)).
4. Reference it in `deck.py`:

```python
Slide("my-layout", md="slides/03-custom.md")
```

### Example layout

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="https://inkflow.dev/ns"
     inkflow:parent="builtin:default"
     viewBox="0 0 1920 1080" width="1920" height="1080">

  <!-- Override the default content zone with a narrower column -->
  <rect id="zone-content" x="300" y="200" width="1320" height="720"/>
</svg>
```
