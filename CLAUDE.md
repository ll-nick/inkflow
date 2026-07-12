# Inkflow — codebase guide

## Running

```bash
uv run inkflow serve --deck demo/deck.py   # start server at localhost:7777
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
    __init__.py       exports: Deck, Slide, Image, Video, Media, TextBox, Animation,
                               Transition, Align, VAlign, Direction, Inline, Content,
                               ZoneContent, ColorMode, MediaFit, MediaAlign, Muted
                               and the `animations` and `transitions` namespaces
    manifest.py       dataclasses for the deck DSL; Animation/Transition base.
                               Media is a `_MediaBase` shared by Image + Video; `Media`
                               is the `Image | Video` union alias (not callable).
                               Video adds playback fields (controls, autoplay, muted,
                               loop, poster, start, end, play_on_step)
                               Deck params: slides, transition, theme, mode: ColorMode,
                               style, font_size, embed_fonts
                               Slide params: src, id, md, zones, animations, transition,
                               extra_style, title, notes, visible, font_size
    enums.py          shared enums (Direction, Align, VAlign, MediaFit, MediaAlign,
                               ColorMode, Muted); `_KebabStrEnum` base emits CSS token
                               values (Muted is a plain Enum, resolved in Python)
    animations.py     concrete animation types (FadeIn, FadeOut, Bounce, SlideIn/Out,
                               ZoomIn/Out, Highlight) subclassing manifest.Animation
    transitions.py    concrete transition types (Cut, Crossfade, Morph, Push, Cover,
                               Zoom, Fade, Wipe) subclassing manifest.Transition
    pipeline.py       animation annotation + layout inlining
    content.py        TextBox / Image / Video injection into zone rects, with alignment
                               support; Video emits data-* playback attrs (driven by video.ts)
    layout.py         parent inject/set/strip: layout chain resolution and Inkscape layer writing
    markdown.py       markdown-it-py rendering only: code-fence highlighting, LaTeX math,
                               HTML->well-formed-XML normalization (no inkflow-specific grammar)
    zones.py          ::zone:: / ::step:: marker grammar, zone param extraction, and slide
                               assembly (parsed markdown -> per-zone TextBox/Media)
    server.py         HTTP server, WebSocket server, file watcher, build pipeline
    export.py         static HTML export (inkflow build) and PDF export (inkflow export)
    cli/              CLI package (entry point inkflow.cli:main). _common.py holds the
                               `main` group, shared options, and the Project/Target helpers;
                               commands are grouped by area: project.py (init, setup-git,
                               completion), present.py (serve, build, export), authoring.py
                               (clean, add, parent group, sync, layouts), color.py (colorize,
                               palette), verify.py. Submodules register on `main` by import.
    clean.py          SVG Inkscape metadata stripping (used by cli and pre-commit hook)
    colors.py         CSS color token extraction, hex→class mapping, SVG colorization, GPL palette
    git_setup.py      git hook + SVG diff driver setup
    init.py           project scaffolding (inkflow init)
    loaders.py        deck style / script loading helpers
    logging.py        unified log sink over stdlib logging: `logger`, shared Rich
                               `console`, `report` (cargo-style status), `collect_logs`
                               (per-rebuild capture), and three independent sinks
                               (console/file/browser), each a level, resolved by
                               `resolve_levels` (`--log-level*` flags + INKFLOW_LOG_LEVEL*
                               env, `off` disables) and installed by `configure`
    svg.py            SVG tree utilities (ensure_defs, with_namespaces, compose_with_ancestors)
    svgio.py          SVG parse/serialize primitives: one hardened parser, SvgElement alias
    verify.py         slide authoring checks (inkflow verify)
    ns.py             XML namespace constants
    tui.py            terminal UI (Rich)
    presenter.html    shell template — inlined with CSS/JS at serve time
    pdf.html          PDF export template
    bundles/          pre-built JS/CSS output (committed; no Node needed at install time)
      presenter.js    navigation, transitions, WebSocket, presenter panel
      presenter.css   all presenter styles including the sidebar panel
    theme/            built-in theme: main.svg, layouts/*.svg, styles.css
  ts/                 TypeScript source
    globals.d.ts      ambient declarations for Python-injected globals (__SLIDES_JSON__ etc.)
    shared/           types, step logic, step-ring SVG builder, cubic-bezier easing
    presenter/        main presenter modules — navigation, transitions (progress-driven
                      via progress-driver.ts), overview, picker, websocket, status bar,
                      keyboard, syncmenu.ts (sync-mode status-bar control),
                      pv.ts (presenter panel sidebar), and video.ts (step-driven
                      <video> playback, wired in via status.ts)
  css/                CSS source
    shared/           theme variables, animation keyframes
    presenter/        presenter partials including pv.css (sidebar panel)
demo/
  deck.py             11-slide demo deck (SVG slides, some filling zones with Markdown via md=)
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
When files change the server sends `{"type":"update","slides":[...],"transitions":[...],"logs":[{"level","message"},...]}` and the presenter swaps content in place, preserving the current slide index.
Non-fatal records collected during the rebuild (`inkflow.logging.collect_logs`, filtered to the browser sink's level) ride along on the `update` message and show as a dismissible `#warning-banner`, each entry styled by level via a `log-<level>` class (dismissal sticks across rebuilds until the log set changes, keyed on a signature in `ui.ts`); a fatal build error is sent separately as `{"type":"error","message":"..."}` and displayed as the full-screen overlay (also logged to the file sink). Static `build` sends no logs to the page (they go to the CLI instead).
The HTTP response includes `Cache-Control: no-store` so hard refreshes always get fresh content.

**Position sync is a dumb relay with client-side authority + modes.**
Clients send `{"type":"nav","slideIndex","step"}` (validated + clamped server-side by `_coerce_nav_position`); the server stores the last position and rebroadcasts it as `{"type":"position",...}` to the *other* clients, and pushes it once to each newly connected client. A window that booted from a deep link (URL slide segment, captured by `readURL()` before `syncURL()` rewrites the bar) or reconnected asserts its own position and ignores that first push; a bare window adopts it. Each client also has a per-tab **sync mode** (`two-way`/`present`/`follow`/`solo`, `shared/types.ts`) deciding locally whether it broadcasts nav (`sends()`) and applies incoming positions (`receives()`) — the server knows nothing about modes. `s` cycles the mode; `syncmenu.ts` owns the status-bar widget, `websocket.ts` the network/state. Switching into a receiving mode sends `{"type":"sync-request"}` to catch up. Persisted in `sessionStorage`.

**`loadSlide()` vs `applyStep()` in the presenter JS.**
Step advances within a slide must NOT re-render `stage.innerHTML` — that would make CSS transitions invisible because the browser only paints once per JS task.
`loadSlide()` sets innerHTML (elements start at opacity 0).
Subsequent `applyStep()` calls only toggle `.active` on existing DOM elements, triggering CSS transitions.

**`deck.py` is a Python module, not YAML/TOML.**
Loaded via `importlib.util.spec_from_file_location`. Must define a `main() -> Deck` function.

**Morph transition uses a rAF loop over SVG attributes, not CSS transforms.**
CSS `transform: translate(Xpx)` on SVG elements is interpreted in SVG user units, not CSS viewport pixels — FLIP-based approaches produce a coordinate gap proportional to the viewBox scale.
Instead, `morphSlide()` snapshots raw geometry attributes (`x`, `y`, `width`, `height`, `rx` for rects; `cx`, `cy`, `r` for circles) before the innerHTML swap, then drives a `requestAnimationFrame` loop that calls `setAttribute` each frame in SVG user units.
Colors are lerped channel-by-channel.
Exit-only elements are reconstructed as ghost nodes in the new SVG and faded out.
Backward navigation passes the outgoing slide's transition to `loadSlide()` so the morph plays in reverse.

**`presenter.html`/`css`/`js` are inlined at serve time.**
`build_html()` in `server.py` reads the template and the two bundles, substituting `__CSS__`, `__JS__`, `__STYLES__`, `__DATA_THEME__`, `__SLIDES_JSON__`, `__TRANSITIONS_JSON__`, `__WS_PORT__`, `__ERROR_JSON__` tokens.
Edit the source files, run `mise run bundle`, and reload the browser to see changes.

**The presenter panel is a sidebar inside the single presenter page, not a separate route.**
`<aside id="pv">` lives in `presenter.html` and is hidden (`width: 0`) by default.
Pressing `p` toggles `body.pv-open`, which CSS-transitions the sidebar to 30% width while the stage flexes back.
`pv.ts` owns all panel logic (clock, next-preview, notes); it reads directly from `state.slides` so no second WS connection or position sync is needed.
For second-screen use, open the same URL in two windows and toggle the panel in one.

**Font embedding is automatic and zero-config.**
After `process_deck()`, `fonts.embed_fonts_css()` (serve) or `fonts.embed_fonts_css_subsetted()`
(build/export) scans every slide SVG for named `font-family` values, discovers matching font
files, and injects `@font-face` blocks (base64 data-URI) into the global CSS via `__STYLES__`.
Generic families (`sans-serif`, `serif`, `monospace`, etc.) are always skipped.

Font search order: `<project_dir>/fonts/` → user font dirs → system font dirs (all OS-specific).
Committing fonts in `fonts/` gives fully reproducible output independent of the host system.

For serve: full font files are embedded; the font index is cached at module level so only the
first rebuild in a session pays the directory-scan cost. For build/export: fonts are subsetted
to only the codepoints present in the slides (via `fonttools`), typically 10–30 KB per variant.
`brotli` is a required dependency, so subsetted fonts are always emitted as WOFF2. If subsetting fails for a given font (for example a corrupt or unreadable file), the full font file is embedded instead.

Unresolvable fonts produce a yellow TUI warning and fall back to system rendering.
Opt out per-deck: `Deck(embed_fonts=False)`.

**Markdown content injection (`md=`) uses `<foreignObject>`.**
Markdown is rendered to HTML via `markdown-it-py`.
Zone `<rect>` elements in the layout SVG are replaced with `<foreignObject>` of the same geometry containing the rendered HTML.
Typography and color come from the CSS cascade (`theme/styles.css` + per-deck/per-slide `style=`) injected into the `<foreignObject>` HTML head.

**Text zone alignment — three layers, increasing specificity.**

*1. Layout SVG CSS variables* — set once, applies to every slide that uses the layout:
```css
/* inside the layout SVG's <defs><style> */
#zone-title   { --inkflow-valign: center; }
#zone-content { --inkflow-padding: 40px; }
```
`--inkflow-align` (`left`/`center`/`right`/`justify`), `--inkflow-valign` (`start`/`center`/`end`), and `--inkflow-padding` (any CSS length) are consumed by `.inkflow-wrapper` and `.inkflow-content` in `theme/styles.css` via `var()`. No pipeline extraction; pure browser cascade.

*2. Markdown zone marker parameters* — per-zone, per-slide, directly in the `.md` file:
```
::content align=center valign=center padding=60::
```
`align`, `valign`, and `padding` are the supported keys. `valign` accepts `top`/`center`/`bottom` (mapped to flexbox `start`/`center`/`end`). `padding` is in SVG user units. These translate to inline `style` attributes on the generated `<foreignObject>` wrapper and content divs, overriding CSS variables.

*3. Python `TextBox` explicit params* — in `deck.py`:
```python
from inkflow import Align, Slide, TextBox, VAlign
Slide(
    "layout.svg",
    zones={"content": TextBox(text="...", align=Align.CENTER, valign=VAlign.TOP, padding=40)},
)
```
The target zone is the `zones` dict key (`"content"` → `zone-content`); `TextBox` has no selector argument, its first positional is `text`. `Align` and `VAlign` are `StrEnum`s exported from the top-level package. `None` (the default) means "defer to CSS variable".

**foreignObject DOM structure after injection:**
```
<foreignObject>
  <div class="inkflow-wrapper" [style="justify-content:…;padding:…;"]>
    <div class="inkflow-content" [style="text-align:…;"]>
      {rendered HTML}
    </div>
  </div>
</foreignObject>
```
Inline styles are only emitted when the corresponding param is non-`None`; CSS variables handle layout-level defaults without touching the element's `style`.

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

`pipeline.py` processes each slide as a single lxml tree: parsed once via the hardened parser in `svgio.py`, threaded through the pipeline, serialized once at the end. `SlideSvg` wraps the tree and each pipeline step is a method that mutates it in place (like `list.sort()`), delegating the DOM work to `content.py`/`svg.py` functions that take and return the root element. Key steps:
1. `clean_inkscape_tree(src)` — parse with the hardened lxml parser, remove elements/attrs in `http://www.inkscape.org/namespaces/inkscape` and `http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd`, call `etree.cleanup_namespaces()`. (`clean_inkscape_svg` wraps this and serializes to a pretty-printed string for the CLI/pre-commit hook.)
2. `annotate_svg(root, animations)` — find elements by id (stripping leading `#`), set `class`, `data-step`, and merge `--anim-*` custom properties into `style`

The CSS class is `anim-<slug>`, where the slug is the kebab-cased type name (`Animation.slug()` / `Transition.slug()`, a `_Slugged` mixin in `manifest.py`): `FadeIn → anim-fade-in`, `SlideIn → anim-slide-in`, `Highlight → anim-highlight`. There is no per-type registry. `_anim_style` emits one `--anim-<field>` custom property per non-`None` parameter (via the shared `_set_fields` field-walk, with a unit table for `duration`/`delay`/`distance`); the `direction` field instead becomes an `anim-from-<value>` modifier class (`_anim_classes`). CSS in `src/css/shared/animations.css` consumes the custom props via `var(--anim-…, default)`.

All SVG parsing routes through `svgio.py` (`parse_svg`, `parse_svg_file`, `serialize_svg`), which uses one hardened parser config (`resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False`, constructed per call since lxml parsers are not thread-safe). This is defense-in-depth plus crash-robustness: an SVG referencing an external/DTD entity degrades to an inert node instead of crashing the rebuild. `svgio.py` also exports the `SvgElement` type alias used across the backend.

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
platformdirs>=4.0    per-user log + font directories (inkflow.logging, fonts.py)
rich>=15.0           terminal UI
watchfiles>=0.21     inotify-based file watcher
websockets>=12.0     WebSocket server (uses 16.x asyncio API)
```
