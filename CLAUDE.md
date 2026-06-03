# Inkflow — codebase guide

## Running

```bash
uv run inkflow serve demo/deck.py   # start server at localhost:7777
mise run check                      # lint + format + typecheck + test (Python and JS)
mise run bundle                     # rebuild JS/CSS bundles from src/ts/ and src/css/
```

## Git setup (one-time, per clone)

```bash
uv run inkflow setup-git
```

Configures two things:
- **Pre-commit hook** (`.githooks/pre-commit`) — strips Inkscape editor metadata from staged SVGs before every commit, so viewport pan/zoom/window state never lands in history
- **SVG diff driver** — `git diff`, `git log -p`, and GitHub's diff view show only visual changes even for SVGs that haven't been cleaned in-place

Git won't run this automatically on clone — that's an intentional git security boundary — so it needs to be run once. After that it's invisible.

SVG source files should be kept clean (no Inkscape metadata) in the repository. Run `uv run inkflow clean demo/slides/*.svg` to clean any files committed before the hook was in place.

## Project layout

```
src/
  inkflow/
    __init__.py       exports: Deck, Slide, MarkdownSlide, Media, TextBox,
                               FadeIn, FadeOut, Bounce, Cut, Crossfade, Morph,
                               Animation, Transition
    manifest.py       dataclasses for the deck DSL
    pipeline.py       SVG cleaning (lxml) + animation annotation + layout inlining
    content.py        TextBox / Media injection into zone rects
    layout.py         parent inject/set/strip: layout chain resolution and Inkscape layer writing
    markdown.py       markdown-it-py rendering + ::zone:: / ::step:: marker parsing
    server.py         HTTP server, WebSocket server, file watcher, build pipeline
    export.py         static HTML export (inkflow build) and PDF export (inkflow export)
    cli.py            CLI entry point
    ns.py             XML namespace constants
    tui.py            terminal UI (Rich)
    presenter.html    shell template — inlined with CSS/JS at serve time
    presenter.css     presenter styles
    presenter.js      presenter logic (navigation, transitions, WS)
    pdf.html          PDF export template
    theme/            built-in theme: main.svg, layouts/*.svg, styles.css
  ts/                 TypeScript source (split into modules in PR 2)
    globals.d.ts      ambient declarations for Python-injected globals (__SLIDES_JSON__ etc.)
  css/                CSS source (split into partials in PR 2)
demo/
  deck.py             7-slide demo deck (SVG slides + MarkdownSlides)
  slides/             source SVGs and Markdown content files
mise.toml             task runner + tool versions (replaces poethepoet)
package.json          JS devDependencies: biome, esbuild, typescript
biome.json            Biome lint + format config (4-space indent, noUnusedVariables=error)
tsconfig.json         TypeScript config (noEmit, verbatimModuleSyntax — tsc as type-checker only)
```

## Key architecture decisions

**No SVG editor subprocess at serve time.**
Any SVG editor writes the files; the pipeline reads them directly with lxml,
strips Inkscape/Sodipodi editor namespaces, and annotates elements with animation classes.
No GUI window flashes, instant processing.

**Live reload pushes slides over WebSocket, not `location.reload()`.**
When files change the server sends `{"type":"update","slides":[...],"transitions":[...]}` and the presenter swaps content in place, preserving the current slide index.
Errors are sent as `{"type":"error","message":"..."}` and displayed as an overlay.
The HTTP response includes `Cache-Control: no-store` so hard refreshes always get fresh content.

**`loadSlide()` vs `applyStep()` in the presenter JS.**
Step advances within a slide must NOT re-render `stage.innerHTML` — that would make CSS transitions invisible because the browser only paints once per JS task.
`loadSlide()` sets innerHTML (elements start at opacity 0).
Subsequent `applyStep()` calls only toggle `.active` on existing DOM elements, triggering CSS transitions.

**`deck.py` is a Python module, not YAML/TOML.**
Loaded via `importlib.util.spec_from_file_location`. Must define a module-level `deck` variable of type `Deck`.

**Morph transition uses a rAF loop over SVG attributes, not CSS transforms.**
CSS `transform: translate(Xpx)` on SVG elements is interpreted in SVG user units, not CSS viewport pixels — FLIP-based approaches produce a coordinate gap proportional to the viewBox scale.
Instead, `morphSlide()` snapshots raw geometry attributes (`x`, `y`, `width`, `height`, `rx` for rects; `cx`, `cy`, `r` for circles) before the innerHTML swap, then drives a `requestAnimationFrame` loop that calls `setAttribute` each frame in SVG user units.
Colors are lerped channel-by-channel.
Exit-only elements are reconstructed as ghost nodes in the new SVG and faded out.
Backward navigation passes the outgoing slide's transition to `loadSlide()` so the morph plays in reverse.

**`presenter.html`/`css`/`js` are inlined at serve time.**
`_build_html()` in `server.py` reads all three files and substitutes `__CSS__`, `__JS__`, `__SLIDES_JSON__`, `__TRANSITIONS_JSON__`, `__WS_PORT__`, `__ERROR_JSON__` tokens.
Edit the source files and reload the browser to see changes.

**MarkdownSlide content injection uses `<foreignObject>`.**
Markdown is rendered to HTML via `markdown-it-py`.
Zone `<rect>` elements in the layout SVG are replaced with `<foreignObject>` of the same geometry containing the rendered HTML.
Typography and color come from the CSS cascade (`theme/styles.css` + per-deck/per-slide `style=`) injected into the `<foreignObject>` HTML head.

**Layout chain resolution at build time, not on disk.**
`inject-layout` writes locked Inkscape preview layers into SVGs for authoring reference,
but the pipeline resolves `inkflow:parent` chains in memory and composites layers on the fly.
SVG files on disk are never modified by the serve/build pipeline.

## Server

- HTTP on port 7777 (asyncio streams, custom handler)
- WebSocket on port 7778 (websockets 16.0 — uses `websockets.asyncio.server.serve`, not the legacy `websockets.serve`)
- File watcher: `watchfiles.awatch` (async generator)
- Both run inside an `asyncio.TaskGroup`

## Animation pipeline

`pipeline.py`:
1. `clean_inkscape_svg(src)` — parse with lxml, remove elements/attrs in `http://www.inkscape.org/namespaces/inkscape` and `http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd`, call `etree.cleanup_namespaces()`, serialize to string
2. `annotate_svg(svg_str, animations)` — find elements by id (stripping leading `#`), set `class` and `data-step` attributes

CSS class map: `FadeIn → anim-fade-in`, `FadeOut → anim-fade-out`, `Bounce → anim-bounce`

## JS toolchain

Three tools, each with a distinct role:

- **Biome** — linter and formatter for TypeScript and CSS. Run via `mise run lint-js`. Config in `biome.json`.
- **tsc** — type-checker only (`noEmit: true`). Never emits files; esbuild does that. Run via `mise run typecheck-js`.
- **esbuild** — bundler. Produces committed bundles in `src/inkflow/bundles/` that the Python inlining pipeline reads at serve/build time. Run via `mise run bundle`.

`pip install inkflow` ships the pre-built bundles — no Node at install time.

`verbatimModuleSyntax: true` in tsconfig enforces `import type` for type-only imports, which esbuild requires since it transpiles files individually without type information.

## Dependencies

```
click>=8.0           CLI
lxml>=5.0            SVG processing
markdown-it-py>=3.0  Markdown rendering
rich>=15.0           terminal UI
watchfiles>=0.21     inotify-based file watcher
websockets>=12.0     WebSocket server (uses 16.x asyncio API)
```
