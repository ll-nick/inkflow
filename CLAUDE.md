# Inkflow — codebase guide

## Running

```bash
uv sync                                   # install deps into .venv
uv run inkflow serve example/deck.py      # start server at localhost:7777
```

## Git setup (one-time, per clone)

```bash
uv run inkflow setup-git
```

Configures two things:
- **Pre-commit hook** (`.githooks/pre-commit`) — strips Inkscape editor metadata from staged SVGs before every commit, so viewport pan/zoom/window state never lands in history
- **SVG diff driver** — `git diff`, `git log -p`, and GitHub's diff view show only visual changes even for SVGs that haven't been cleaned in-place

Git won't run this automatically on clone — that's an intentional git security boundary — so it needs to be run once. After that it's invisible.

SVG source files should be kept clean (no Inkscape metadata) in the repository. Run `uv run inkflow clean example/slides/*.svg` to clean any files committed before the hook was in place.

## Project layout

```
src/inkflow/
  __init__.py       exports: Deck, Slide, FadeIn, FadeOut, Bounce, Cut, Crossfade, Morph
  manifest.py       dataclasses for the deck DSL
  pipeline.py       SVG cleaning (lxml) + animation annotation
  server.py         HTTP server, WebSocket server, file watcher, build pipeline
  cli.py            CLI entry point
  presenter.html    shell template — inlined with CSS/JS at serve time
  presenter.css     presenter styles
  presenter.js      presenter logic (navigation, transitions, WS)
example/
  deck.py           4-slide example deck
  slides/           source SVGs (Inkscape-authored)
```

## Key architecture decisions

**No Inkscape subprocess at serve time.** Inkscape is only used by the human author in the GUI. The pipeline reads SVG files directly with lxml, strips Inkscape/Sodipodi editor namespaces, and annotates elements with animation classes. This avoids GUI window flashes and is instant.

**Live reload pushes slides over WebSocket, not `location.reload()`.** When files change the server sends `{"type":"update","slides":[...],"transitions":[...]}` and the presenter swaps content in place, preserving the current slide index. Errors are sent as `{"type":"error","message":"..."}` and displayed as an overlay. The HTTP response includes `Cache-Control: no-store` so hard refreshes always get fresh content.

**`loadSlide()` vs `applyStep()` in the presenter JS.** Step advances within a slide must NOT re-render `stage.innerHTML` — that would make CSS transitions invisible because the browser only paints once per JS task. `loadSlide()` sets innerHTML (elements start at opacity 0). Subsequent `applyStep()` calls only toggle `.active` on existing DOM elements, triggering CSS transitions.

**`deck.py` is a Python module, not YAML/TOML.** Loaded via `importlib.util.spec_from_file_location`. Must define a module-level `deck` variable of type `Deck`.

**Morph transition uses a rAF loop over SVG attributes, not CSS transforms.** CSS `transform: translate(Xpx)` on SVG elements is interpreted in SVG user units, not CSS viewport pixels — FLIP-based approaches produce a coordinate gap proportional to the viewBox scale. Instead, `morphSlide()` snapshots raw geometry attributes (`x`, `y`, `width`, `height`, `rx` for rects; `cx`, `cy`, `r` for circles) before the innerHTML swap, then drives a `requestAnimationFrame` loop that calls `setAttribute` each frame in SVG user units. Colors are lerped channel-by-channel. Exit-only elements are reconstructed as ghost nodes in the new SVG and faded out. Backward navigation passes the outgoing slide's transition to `loadSlide()` so the morph plays in reverse.

**`presenter.html`/`css`/`js` are inlined at serve time.** `_build_html()` in `server.py` reads all three files and substitutes `__CSS__`, `__JS__`, `__SLIDES_JSON__`, `__TRANSITIONS_JSON__`, `__WS_PORT__`, `__ERROR_JSON__` tokens. Edit the source files and reload the browser to see changes.

## Server

- HTTP on port 7777 (asyncio streams, custom handler)
- WebSocket on port 7778 (websockets 16.0 — uses `websockets.asyncio.server.serve`, not the legacy `websockets.serve`)
- File watcher: `watchfiles.awatch` (async generator)
- Both run inside an `asyncio.TaskGroup`

## Animation pipeline

`pipeline.py`:
1. `clean_inkscape_svg(src)` — parse with lxml, remove elements/attrs in `http://www.inkscape.org/namespaces/inkscape` and `http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd`, call `etree.cleanup_namespaces()`, serialize to string
2. `annotate_svg(svg_str, animations)` — find elements by id (stripping leading `#`), set `class` and `data-step` attributes

CSS class map: `Fade → anim-fade-in`, `FadeOut → anim-fade-out`, `Bounce → anim-bounce`

## Dependencies

```
lxml>=5.0        SVG processing
websockets>=12.0 WebSocket server (uses 16.x asyncio API)
watchfiles>=0.21 inotify-based file watcher
```

## Not yet implemented

- Template chain inlining (`inkflow:parent` resolution, `inject-master`, `inkflow new`) — see ROADMAP.md
- Font embedding (fonttools)
- Morph for non-primitive shapes: `<path>` and `<polygon>` fall back to instant cut; `<g>` groups are cloned and faded as a unit — put the ID on the `<g>` (not on individual children) when you want a shape+label pair to enter/exit together
