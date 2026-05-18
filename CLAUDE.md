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
  __init__.py       exports: Deck, Slide, Fade, FadeOut, Bounce, Morph
  manifest.py       dataclasses for the deck DSL
  pipeline.py       SVG cleaning (lxml) + animation annotation
  cli.py            CLI entry point, HTTP server, WebSocket server, file watcher
  presenter.html    browser presenter template — served at / with slides injected
example/
  deck.py           2-slide example deck
  slides/           source SVGs (Inkscape-authored)
```

## Key architecture decisions

**No Inkscape subprocess at serve time.** Inkscape is only used by the human author in the GUI. The pipeline reads SVG files directly with lxml, strips Inkscape/Sodipodi editor namespaces, and annotates elements with animation classes. This avoids GUI window flashes and is instant.

**Live reload via `location.reload()`, not WS-pushed SVG.** When files change, the WS server sends the string `"reload"` and the browser reloads the page. The server re-GETs `/` with the newly built slide JSON embedded. Simpler than streaming SVG over WS. The HTTP response includes `Cache-Control: no-store` so reloads always get fresh content.

**`loadSlide()` vs `applyStep()` in the presenter JS.** Step advances within a slide must NOT re-render `stage.innerHTML` — that would make CSS transitions invisible because the browser only paints once per JS task. `loadSlide()` sets innerHTML (elements start at opacity 0). Subsequent `applyStep()` calls only toggle `.active` on existing DOM elements, triggering CSS transitions.

**`deck.py` is a Python module, not YAML/TOML.** Loaded via `importlib.util.spec_from_file_location`. Must define a module-level `deck` variable of type `Deck`.

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

- `Morph` animations (class exists as a stub)
- `main.svg` template inlining (shared slide layout)
- Font embedding (fonttools)
