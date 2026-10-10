# Export

Inkflow can export your deck to a self-contained HTML file or a PDF.
Both commands work from the same `deck.py` you use for live presenting.

## Static HTML (`inkflow build`)

`inkflow build` writes the deck as **one self-contained HTML file**:
every slide, picture, video and font is inside `index.html`.
No server and no network required: open it in any browser, from a file picker,
a chat window or a USB stick, mail it, put it on any web host.
It makes no request at all, so it looks the same offline and on any computer.

```bash
inkflow build
# → build/index.html (3.1 MB)
```

Output to a custom location:

```bash
inkflow build --output ./dist
```

The build is the same presenter you see during `inkflow serve`, packaged for offline use.
Everything the deck references is inlined as a `data:` URI:
`Image`/`Video` zones, images in Markdown (`![](...)`) and SVG (`<image href>`),
video posters, PDF figures, and `url()` references in `styles.css`.
The fonts are embedded subset to the characters the deck uses
(the deck's own and those of the presenter's interface; see [Fonts](../design/fonts.md)).
Pictures on the web (`https://…`) stay links: the build names each one,
since it shows nothing offline; download them into the project to make the deck whole.

Every reference is resolved relative to the file it was written in
(see [Images](../authoring/markdown.md#images)).
A reference that resolves to no file is reported as a warning and skipped rather than dropped silently,
and one that points outside both the project and the theme is reported when it is resolved.
An asset whose file extension names no known media type is copied out beside `index.html` and reported.

The trade-offs of one file:

- **Size.** The file grows by roughly a third of each asset (base64 overhead),
  counted once per *reference* rather than once per file,
  so an asset that appears on ten slides is carried ten times.
- **Startup.** Every asset is part of the HTML, so all of it loads before the first slide renders.
  Inkflow warns when it inlines a large video, and when `index.html` passes 50 MB,
  naming the largest assets.

### Media in a folder (`--assets-folder`)

For a large deck, videos above all, on a web host:

```bash
inkflow build --assets-folder
# → build/index.html + build/slides/…, build/assets/… (the deck's media)
```

`--assets-folder` copies the pictures and videos into the output directory beside `index.html`
instead of inlining them, mirroring the source tree (a theme's own assets go under `_theme/`,
converted PDF pages under `_pdf/`).
The first slide shows at once, each video streams when its slide needs it,
and the browser caches each file on its own.
The folder must travel whole. Fonts are inside `index.html` either way.
The [publishing workflows](publish.md) build GitHub and GitLab Pages this way.

`--inline-assets`, the flag that used to ask for the single file, is still accepted
and does nothing: that is the default now.

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

### Page size

Each page is the deck's size, [`Deck(size=...)`](../authoring/posters.md#sizes):
`size="a0"` prints every page at exactly 841 x 1189 mm, `"16:9"` at
1920 x 1080 px (20 x 11.25 in). Each slide's `viewBox` is scaled onto the page,
so a poster drawn on the A0 canvas prints on A1 when the deck says `"a1"`, and a
slide of another shape is letterboxed (`inkflow verify` warns about it).

A deck without a size prints each slide at its own size: the `width` and
`height` of its SVG when they are lengths in `mm`, `cm`, `in`, `pt` or `pc` (an
Inkscape A0 page is `width="841mm" height="1189mm"`), else its `viewBox` at
1 unit = 1 px. Slides of different sizes each get their own page size in the
same PDF.

`--size` prints every page at one size instead, by name, as a physical size,
or in px as before:

```bash
inkflow export --size a1               # A1 portrait
inkflow export --size a0-landscape
inkflow export --size 841x1189mm       # also cm, in: 36x48in
inkflow export --size 1280x720         # px
```

The page boxes are exact: Chromium prints page sizes on a grid of about
1/75 in, so inkflow writes each page's box to the size asked for afterwards
(an A0 page is 2383.94 x 3370.39 pt). Text stays text (selectable, with its
font embedded), drawings stay vector, and pictures keep their own pixels.

### Bleed and crop marks

A print shop that asks for bleed wants the background to run past the edge
where the sheet is cut:

```bash
inkflow export --bleed 3mm --crop-marks
```

`--bleed` (`3mm`, `0.125in`; a bare number is mm) makes each page that much
larger on every side and extends every background that covers the whole slide
(a rectangle or a picture) into it. `--crop-marks` marks the corners of the
finished page in a margin outside the bleed. With bleed, the PDF's `TrimBox`
and `BleedBox` say where the finished page is. The editor's Export dialog
offers both for a print deck ("3 mm bleed and crop marks").

### Running as root or in Docker

Running as root, inkflow passes `--no-sandbox` on its own. Otherwise pass it when Chromium refuses to start due to sandbox restrictions:

```bash
inkflow export --no-sandbox
```

### Snap and Flatpak browsers

Ubuntu's `chromium` is a snap, and snaps and Flatpaks run in a confinement that
cannot see the rest of the system's `/tmp`. Inkflow therefore hands the slides to
the browser from a short-lived local web server on `127.0.0.1`, never as a file,
so any install works. The browser still writes the PDF itself, though, and a
confined one may only write inside your home folder (not in `/tmp` or a hidden
folder such as `~/.cache`). If it cannot, the export stops with that message;
pick an output path in your home folder, or point `--chromium` at another
browser. Whatever Chromium printed on failure is shown with the error.

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

Build the deck into place before building the site,
so the embedded demo is always current:

```bash
inkflow build --deck deck.py --output docs/demo
mkdocs build
```

Wire that pair into whichever task runner your project already uses.
These docs do it with [mise](https://mise.jdx.dev/):

```toml
[tasks.docs-build]
run = [
  "uv run inkflow build --deck demo/deck.py --output docs/demo",
  "uv run mkdocs build",
]
```
