# Export

Inkflow can export your deck to a self-contained HTML file or a PDF.
Both commands work from the same `deck.py` you use for live presenting.

## Static HTML (`inkflow build`)

`inkflow build` produces a self-contained directory with an `index.html` that embeds all slides inline.
No server required. Open it in any browser, put it on a USB drive, host it on any static file server.

```bash
inkflow build deck.py
# → build/index.html
```

Output to a custom location:

```bash
inkflow build deck.py --output ./dist
```

The build output is the same presenter you see during `inkflow serve`, packaged for offline use.
All assets (media, fonts) referenced by the deck are copied into the output directory.

!!! tip "Live demo in these docs"
    The interactive demo on this site was produced with `inkflow build` and embedded as an `<iframe>`.
    See the [Demo](../demo/index.md) page.

## PDF export (`inkflow export`)

`inkflow export` renders each slide to a PDF page via headless Chromium.
One page per slide, no animations.
A static snapshot suitable for sharing with conference organisers or archiving.

```bash
inkflow export deck.py
# → deck.pdf
```

Output to a custom path:

```bash
inkflow export deck.py --output my-talk.pdf
```

### Chromium path

Inkflow auto-detects `chromium`, `chromium-browser`, and `google-chrome` on `PATH`.
If your binary is elsewhere:

```bash
inkflow export deck.py --chromium /usr/bin/chromium-browser
```

### Slide dimensions

The PDF page size is auto-detected from the first slide's `viewBox`.
No configuration needed for standard decks.

To override — for example when mixing slide sizes or forcing a specific output resolution:

```bash
inkflow export deck.py --size 1280x720
```

### Running as root or in Docker

Pass `--no-sandbox` when Chromium refuses to start due to sandbox restrictions:

```bash
inkflow export deck.py --no-sandbox
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
cmd = "inkflow build src/inkflow/theme/showcase/deck.py --output docs/demo"
```

Then run `poe docs-build-demo` before `mkdocs build` or `mkdocs gh-deploy`.
