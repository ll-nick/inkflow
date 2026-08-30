# Export

Inkflow can export your deck to a self-contained HTML file or a PDF.
Both commands work from the same `deck.py` you use for live presenting.

## Static HTML (`inkflow build`)

`inkflow build` produces a self-contained directory with an `index.html` that embeds all slides inline.
No server required. Open it in any browser, put it on a USB drive, host it on any static file server.

```bash
inkflow build
# → build/index.html
```

Output to a custom location:

```bash
inkflow build --output ./dist
```

The build output is the same presenter you see during `inkflow serve`, packaged for offline use.
All local assets referenced by the deck are copied into the output directory: `Media` zones plus images referenced from Markdown (`![](...)`) or SVG (`<image href>`). Remote (`https://`) and `data:` URIs are left untouched. Fonts are embedded directly into the HTML, so they need no separate files.

Every reference is resolved relative to the file it was written in
(see [Images](slides.md#images)),
and the source tree is mirrored inside the output directory,
so the build stays self-contained wherever it is copied.
A theme's own assets are copied under `_theme/`.
A reference that resolves to no file is reported as a warning and skipped rather than dropped silently,
and one that points outside both the project and the theme is reported when it is resolved.

!!! tip "Live demo in these docs"
    The interactive demo linked from this site was produced with `inkflow build` and
    served as a static build. See the [Demo](../demo/index.html) page.

## PDF export (`inkflow export`)

`inkflow export` renders each slide to a PDF page via headless Chromium.
One page per slide, no animations.
A static snapshot suitable for sharing with conference organisers or archiving.

```bash
inkflow export
# → deck.pdf
```

Output to a custom path:

```bash
inkflow export --output my-talk.pdf
```

### Chromium path

Inkflow auto-detects `chromium`, `chromium-browser`, and `google-chrome` on `PATH`.
If your binary is elsewhere:

```bash
inkflow export --chromium /usr/bin/chromium-browser
```

### Slide dimensions

The PDF page size is auto-detected from the first slide's `viewBox`.
No configuration needed for standard decks.

To override — for example when mixing slide sizes or forcing a specific output resolution:

```bash
inkflow export --size 1280x720
```

### Running as root or in Docker

Pass `--no-sandbox` when Chromium refuses to start due to sandbox restrictions:

```bash
inkflow export --no-sandbox
```

### Requirements

PDF export requires a Chromium-based browser.
It is not available in sandboxed environments that block subprocess execution.

## Using the HTML export as a demo

The `inkflow build` output is a fully interactive presenter.
Navigation, animations, and transitions all work.
This makes it ideal for embedding in documentation.

To embed in an MkDocs page, place the built output in `docs/demo/` and add an iframe:

```markdown
<iframe
  src="../demo/index.html"
  width="100%"
  style="aspect-ratio: 16/9; border: none; border-radius: 8px;"
  allowfullscreen>
</iframe>
```

To generate and place the demo as part of your docs build,
add a `poe` task:

```toml
[tool.poe.tasks.docs-build-demo]
cmd = "inkflow build --deck src/inkflow/theme/showcase/deck.py --output docs/demo"
```

Then run `poe docs-build-demo` before `mkdocs build` or `mkdocs gh-deploy`.
