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

Git won't run this automatically on clone — that's an intentional git security boundary — so it needs to be run once. After that it's invisible. (`inkflow init` already does this for a freshly created project via `git_setup.init_project_git`; `setup-git` is the manual path for existing clones and teammates.)

SVG source files should be kept clean (no Inkscape metadata) in the repository. Run `uv run inkflow clean demo/slides/*.svg` to clean any files committed before the hook was in place.

## Project layout

```
src/
  inkflow/
    __init__.py       exports: Deck, Slide, Image, Video, Media, TextBox,
                               Cue, Transition, Align, VAlign, Direction, Easing,
                               AnimationKind, Trigger, Inline, Content, ZoneContent,
                               ColorMode, MediaFit,
                               MediaAlign, Muted, Overlay
                               and the `animations` and `transitions` namespaces
                               (`Animation` is NOT top-level — it lives in `animations`)
    manifest.py       dataclasses for the deck DSL; Cue/Transition base.
                               `Cue` (element, trigger) is the timeline base for `Animation`
                               (in animations.py) and `PlayVideo`; `Slide.animations`
                               is `list[Cue]`. Media is a `_MediaBase` shared by Image +
                               Video; `Media` is the `Image | Video` union alias (not
                               callable). Video adds playback fields (controls, autoplay,
                               muted, loop, poster, start, end). `Slugged` mixin (kebab slug
                               from class name) is shared by Animation + Transition
                               Deck params: slides, transition, overlays, theme,
                               mode: ColorMode, style, font_size, embed_fonts
                               Slide params: src, id, md, zones, animations, transition,
                               overlays, extra_style, title, notes, visible, font_size
    enums.py          shared enums (Direction, Align, VAlign, MediaFit, MediaAlign,
                               ColorMode, Muted, Trigger, AnimationKind); `_KebabStrEnum`
                               base emits CSS token values (Muted is a plain Enum, resolved
                               in Python). `AnimationKind` (enter/exit/emphasis) is the
                               animation lifecycle role.
                               `Easing`/`Trigger` are str value objects with named presets
                               plus a constructor (`Easing.cubic_bezier(...)`, `Trigger.at(n)`)
    animations.py     the `Animation` base (moved here from manifest) + the semantic bases
                               `Enter`/`Exit`/`Emphasis` (they fix `kind`), the concrete types
                               (FadeIn, FadeOut, Bounce, SlideIn/Out, ZoomIn/Out, Highlight)
                               subclassing those, plus `PlayVideo` (subclasses `Cue`
                               directly, no timing) — starts a `Video` on a step, not on load
    transitions.py    concrete transition types (Cut, Crossfade, Morph, Push, Cover,
                               Zoom, Fade, Wipe) subclassing manifest.Transition
    pipeline.py       animation annotation + layout inlining
    content.py        TextBox / Image / Video injection into zone rects, with alignment
                               support; Video emits data-* playback attrs (driven by video.ts)
    layout.py         parent inject/set/strip: layout chain resolution and Inkscape layer
                               writing. `AssetKind` (layouts/overlays) selects the searched
                               subdir, so `resolve_parent_path`/`resolve_chain` serve both
                               namespaces with one grammar. `inject_preview_layers` /
                               `are_preview_layers_current` take a `PreviewLayers`
                               (`behind` + `overlays` + css), each layer a
                               `PreviewLayer(path, ref)` — refs come from the caller since
                               a backdrop or an overlay is not named by an inkflow:parent.
                               Layer digests are canonical (c14n, whitespace-stripped), so a
                               synced ancestor does not read as stale forever
    overlay.py        the `Overlay` DSL type (src only). Its own module because both
                               `themes` and `manifest` reference it, same as `Transition`
    markdown.py       markdown-it-py rendering only: code-fence highlighting, LaTeX math,
                               HTML->well-formed-XML normalization (no inkflow-specific grammar)
    steps.py          `StepResolver` — the trigger-resolution rule (ON_CLICK/WITH_PREVIOUS/
                               Trigger.at) shared by pipeline.py (the animations=[...] list)
                               and zones.py (markdown reveals)
    zones.py          ::zone:: / ::step:: marker grammar, zone param extraction, and slide
                               assembly (parsed markdown -> per-zone TextBox/Media)
    server.py         HTTP server, WebSocket server, file watcher, build pipeline
    export.py         static HTML export (inkflow build) and PDF export (inkflow export)
    assets.py         asset reference resolution. `AssetRoots` holds the allowed roots
                               (project dir, theme asset dir) and converts between an
                               absolute path and a canonical ref both ways; `AssetSource`
                               resolves the refs written in one file; `svg_reader` is the
                               composition reader that canonicalises each SVG as it is read
    cli/              CLI package (entry point inkflow.cli:main). _common.py holds the
                               `main` group, shared options, and the Project/Target helpers;
                               commands are grouped by area: project.py (init, setup-git,
                               completion), present.py (serve, build, export), authoring.py
                               (clean, add, parent group, sync, layouts), color.py (colorize,
                               palette), verify.py. Submodules register on `main` by import.
    clean.py          SVG Inkscape metadata stripping (used by cli and pre-commit hook)
    colors.py         CSS color token extraction, hex→class mapping, SVG colorization, GPL palette
    git_setup.py      git hook + SVG diff driver setup; `init_project_git`
                               bootstraps a fresh project (git init + .gitignore +
                               hooks), and steps aside when already inside a repo
    init.py           project scaffolding (inkflow init): copies templates/ into
                               slides/ + notes/, writes a 3-slide deck.py and a bare
                               pyproject.toml pinning inkflow (`~=` compatible release);
                               command refuses a non-empty target (dotfiles ignored)
                               unless --force
    loaders.py        deck style / script loading helpers. `load_deck_styles` emits the
                               CSS cascade: contract.css → active theme tokens → the
                               *built-in* theme's styles.css (always, since any theme may
                               fall through to the built-in layouts; skipped when the
                               built-in is itself active) → active theme styles.css →
                               project styles.css
    sync.py           reusable preview sync: `PreviewContext` (deck-derived data resolved
                               once per run: preview CSS, slides-by-file, overlay files),
                               `plan_preview` (the single answer to "what does this file
                               preview", shared by `sync`, `sync --check` and `verify`),
                               `PreviewRule` (which of the three overlay rules fired),
                               `sync_slides`; shared by the `sync` command and `init`
                               (run live after scaffolding)
    logging.py        unified log sink over stdlib logging: `logger`, shared Rich
                               `console`, `report` (cargo-style status), `collect_logs`
                               (per-rebuild capture), and three independent sinks
                               (console/file/browser), each a level, resolved by
                               `resolve_levels` (`--log-level*` flags + INKFLOW_LOG_LEVEL*
                               env, `off` disables) and installed by `configure`
    svg.py            SVG tree utilities (ensure_defs, with_namespaces,
                               compose_with_ancestors, compose_overlays,
                               duplicate_zone_ids, is_full_canvas_fill)
    svgio.py          SVG parse/serialize primitives: one hardened parser, SvgElement alias
    verify.py         slide authoring checks (inkflow verify)
    ns.py             XML namespace constants
    tui.py            terminal UI (Rich)
    presenter.html    shell template — inlined with CSS/JS at serve time
    pdf.html          PDF export template
    bundles/          pre-built JS/CSS output (committed; no Node needed at install time)
      presenter.js    navigation, transitions, WebSocket, presenter panel
      presenter.css   all presenter styles including the sidebar panel
    theme/            built-in theme: layouts/*.svg, icon.svg, showcase/, and
                               styles.css (per-layout zone styling for those layouts,
                               loaded for every deck — keep its rules `.layout-*`-scoped)
    templates/        inkflow init starter files (title.svg, diagram.svg, guide.md,
                               diagram.md, notes/*.md) copied verbatim into new projects
  ts/                 TypeScript source
    globals.d.ts      ambient declarations for Python-injected globals (__SLIDES_JSON__ etc.)
    shared/           types, step engine (step.ts: WAAPI cue driver + elementActions),
                      keyframes.ts (reads @keyframes + per-cue var substitution),
                      step-ring SVG builder, cubic-bezier easing
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
pnpm-lock.yaml        pnpm lockfile (JS deps); package manager is pnpm, not npm
pnpm-workspace.yaml   pnpm settings: allowlists esbuild's postinstall build script
biome.json            Biome lint + format config (4-space indent, noUnusedVariables=error)
tsconfig.json         TypeScript config (noEmit, verbatimModuleSyntax — tsc as type-checker only)
```

## Key architecture decisions

**No SVG editor subprocess at serve time.**
Any SVG editor writes the files; the pipeline reads them directly with lxml,
strips Inkscape/Sodipodi editor namespaces, and annotates elements with `data-cues` for the step engine.
No GUI window flashes, instant processing.

**Live reload pushes slides over WebSocket, not `location.reload()`.**
When files change the server sends `{"type":"update","slides":[...],"transitions":[...],"logs":[{"level","message"},...]}` and the presenter swaps content in place, preserving the current slide index.
Non-fatal records collected during the rebuild (`inkflow.logging.collect_logs`, filtered to the browser sink's level) ride along on the `update` message and show as a dismissible `#warning-banner`, each entry styled by level via a `log-<level>` class (dismissal sticks across rebuilds until the log set changes, keyed on a signature in `ui.ts`); a fatal build error is sent separately as `{"type":"error","message":"..."}` and displayed as the full-screen overlay (also logged to the file sink). Static `build` sends no logs to the page (they go to the CLI instead).
The HTTP response includes `Cache-Control: no-store` so hard refreshes always get fresh content.

**Position sync is a dumb relay with client-side authority + modes.**
Clients send `{"type":"nav","slideIndex","step"}` (validated + clamped server-side by `_coerce_nav_position`); the server stores the last position and rebroadcasts it as `{"type":"position",...}` to the *other* clients, and pushes it once to each newly connected client. A window that booted from a deep link (URL slide segment, captured by `readURL()` before `syncURL()` rewrites the bar) or reconnected asserts its own position and ignores that first push; a bare window adopts it. Each client also has a per-tab **sync mode** (`two-way`/`present`/`follow`/`solo`, `shared/types.ts`) deciding locally whether it broadcasts nav (`sends()`) and applies incoming positions (`receives()`) — the server knows nothing about modes. `s` cycles the mode; `syncmenu.ts` owns the status-bar widget, `websocket.ts` the network/state. Switching into a receiving mode sends `{"type":"sync-request"}` to catch up. Persisted in `sessionStorage`.

**`loadSlide()` vs `applyStep()` in the presenter JS.**
Step advances within a slide must NOT re-render `stage.innerHTML` — that would recreate the Web Animations API animations and lose their state.
`loadSlide()` sets innerHTML (enter-first elements start hidden via the `.anim-pending` guard).
Subsequent `applyStep()` calls drive each element's per-cue WAAPI animations (play/hold/reverse/cancel) on the existing DOM. The step engine (`shared/step.ts`) reads each element's `data-cues`, creates one paused `Animation` per cue (keyframes from `keyframes.ts`), and per step lets the **governing** enter/exit (the last one reached) own visibility — held at its resting end — while every other enter/exit is cancelled, so the result never depends on WAAPI composite order across several held animations. A single step back across the governing boundary plays the outgoing cue in reverse (it lands on its start frame, which equals the new governing cue's resting value, and the next step cancels it). `applyStepInstant` lands the resting state with no playback (load, jumps, backward entry) and never fires emphasis. The pure `elementActions(cues, step, prev, instant)` is the testable decision at the core.
Because the step state is held by live WAAPI animation objects (not classes/inline styles), it does not survive a DOM snapshot. So before a transition captures the outgoing slide (`stage.innerHTML` for the layer transitions, cloned nodes for morph), `loadSlide` calls `commitStepStyles(stage)` to bake the held values into inline styles — otherwise the outgoing slide reverts to its authored base (entered elements vanish, exited ones reappear) the instant the transition starts.

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

**An asset reference resolves against the file it was written in.**
`assets.py` owns the rule and both halves of it. An `<image href>` resolves against its SVG, a Markdown `![](…)` against its `.md`, an `Image`/`Video`/`Inline` against `deck.py` — what every editor already assumes. The pipeline canonicalises each reference exactly once, while its declaring file is still known (`svg_reader` at each `clean_inkscape_tree` site, `AssetSource.html`/`.ref` for Markdown and zone values), into a path relative to the presentation root. `AssetRoots.locate` is the inverse, and it is the single answer both `server._resolve_asset` and `export._copy_assets` use, so serve and build cannot disagree about what a reference means. On-disk SVGs are never rewritten — only the in-memory tree — so a slide keeps rendering in Inkscape.

An asset must live under an allowed root: the project dir (canonical prefix `""`), or the active theme's `asset_dir()` (prefix `_theme/`, so a pip-installed theme can ship branding). `locate` matches longest prefix first, which reserves `_theme/` at the project root. A reference that escapes every root is warned about and left as written rather than re-anchored somewhere it never pointed at — the server has always refused paths outside the project, so it was never reachable. Symlink the directory in to bring it back inside; containment collapses `..` without resolving symlinks precisely so that works.

`build`/`export` copy every referenced local file into the output dir, mirroring the source tree; a canonical ref is relative and `..`-free by construction, so `out_dir / ref` always lands inside and needs no rewriting. `_slide_refs` scans the *emitted* SVG and notes rather than walking the deck, so a pruned zone takes its asset with it. A reference that resolves to nothing is a `logger.warning`, not a silent skip. `serve` streams the same refs on demand instead of copying.

**Markdown content injection (`md=`) uses `<foreignObject>`.**
Markdown is rendered to HTML via `markdown-it-py`.
Zone `<rect>` elements in the layout SVG are replaced with `<foreignObject>` of the same geometry containing the rendered HTML.
Typography and color come from the CSS cascade (`contract.css` + theme tokens + `theme/styles.css` + per-deck/per-slide `style=`, see `loaders.load_deck_styles`) injected into the `<foreignObject>` HTML head.

**Text zone alignment — three layers, increasing specificity.**

*1. Layout SVG CSS variables* — set once, applies to every slide that uses the layout:
```css
/* inside the layout SVG's <defs><style> */
#zone-title   { --inkflow-valign: center; }
#zone-content { --inkflow-padding: 40px; }
```
`--inkflow-align` (`left`/`center`/`right`/`justify`), `--inkflow-valign` (`start`/`center`/`end`), and `--inkflow-padding` (any CSS length) are consumed by `.inkflow-wrapper` and `.inkflow-content` in `contract.css` via `var()`. No pipeline extraction; pure browser cascade.

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
    zones={
        "content": TextBox(
            text="...", align=Align.CENTER, valign=VAlign.TOP, padding=40
        )
    },
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

**Overlays are the second composition axis, not multiple inheritance.**
`inkflow:parent` means "what am I built on" and composites *behind* a slide; an `Overlay` means "what goes on top regardless of what I'm built on" and composites *above* it. That keeps each axis single-purpose, and it is why chrome (a logo, a footer) reaches every layout without a wrapper layout per layout. `process_slide` calls `compose_overlays` right after `compose_ancestors` and *before* numbering/injection/annotation, so an overlay's `zone-slide-number` is filled, an overlay-declared zone can be targeted by `zones={...}` (and is pruned when unfilled), and cues can animate overlay elements — all for free. Resolution is `Slide.overlays` → `Deck.overlays` → `Theme.overlays`, each an override (`None` inherits, `[]` means none), matching `effective_transition`.

Overlays live in `overlays/` and resolve through `resolve_parent_path(..., AssetKind.OVERLAY)`, the same grammar against a different subdir. The separate namespace is load-bearing: a bare `inkflow:parent` on an overlay can only find another overlay, so it cannot silently pull in a layout, whose full-bleed background rect would paint over the entire deck. `verify` catches the explicit-path version of that mistake via `is_full_canvas_fill` and names the offending file in the chain. Front-composition (rather than a "universal root ancestor", which would be a one-line change to `resolve_chain`) is forced by exactly that background rect: `theme/layouts/base.svg` is a single full-canvas `<rect>`, so chrome at the root of the chain would be painted over.

Overlays become part of the slide SVG, so they travel with it during a transition (chrome slides with a `Push`, dips mid-`Crossfade`; `Cut`/`Morph` are unaffected). Accepted and documented; a persistent chrome layer outside the stage would be the alternative if it ever grates.

**Overlay preview in `sync` resolves a file→overlays mapping that has no single right answer.** `sync` works on files, overlays are declared on slides, so a shared layout is backed by slides that may disagree. `sync.plan_preview` decides in three steps: an explicit `inkflow:preview-overlays` attribute on the file → what every slide backing it agrees on → the deck default. The last is a guess and biases toward *showing* chrome (over-reserved space beats overlap), so the fired rule is printed per file (`PreviewRule`) and points at the attribute when the guess is wrong. `--no-deck` has no mapping to derive and uses the attribute only. A file that is itself an overlay (in an `overlays/` dir **or** referenced as one by the deck — the union covers drafts and off-convention paths) gets no chrome, only whatever `inkflow:preview` names as a backdrop (a layout, or a relative path to a real slide). There is deliberately **no default backdrop**: an overlay cannot know what it lands on, and falling back to the theme's `base` previews chrome against the wrong canvas size and a background colour the deck never paints whenever the deck is built on raw SVGs rather than layouts. `sync` reports `no backdrop` so the omission is visible. Both attributes are authoring-only and never read by the pipeline.

Layer classes: `inkflow:layout-src`/`-hash` marks what goes *behind* (backdrop + ancestor chain), `inkflow:overlay-src`/`-hash` what goes on top. `clean.strip_preview_layers` removes both, which is what keeps a synced slide from painting its chrome twice (once from the preview, once from runtime composition) and keeps an ancestor's own overlay layers from leaking into every child. `verify` shares `plan_preview` (so it cannot disagree about staleness) and skips files outside the project dir, which `sync` would never write.

## Server

- HTTP on port 7777 (asyncio streams, custom handler)
- WebSocket on port 7778 (websockets 16.0 — uses `websockets.asyncio.server.serve`, not the legacy `websockets.serve`)
- File watcher: `watchfiles.awatch` (async generator)
- Both run inside an `asyncio.TaskGroup`

## Animation pipeline

`pipeline.py` processes each slide as a single lxml tree: parsed once via the hardened parser in `svgio.py`, threaded through the pipeline, serialized once at the end. `SlideSvg` wraps the tree and each pipeline step is a method that mutates it in place (like `list.sort()`), delegating the DOM work to `content.py`/`svg.py` functions that take and return the root element. Key steps:
1. `clean_inkscape_tree(src)` — parse with the hardened lxml parser, remove elements/attrs in `http://www.inkscape.org/namespaces/inkscape` and `http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd`, call `etree.cleanup_namespaces()`. (`clean_inkscape_svg` wraps this and serializes to a pretty-printed string for the CLI/pre-commit hook.)
2. `annotate_svg(root, cues)` — `cues` are `(Cue, step)` pairs already resolved to concrete step numbers (see below). Finds elements by plain id (no leading `#`); `Animation` cues are **grouped per target element** (an element may carry several) and written as one `data-cues` JSON array (sorted by step) via `_cue_entry` — each entry is `{step, kind, name, opts, vars}`, where `opts` are the base `Animation` fields as element.animate() options (`duration`/`delay`/`easing`/`iterations`) and `vars` are ready strings (slide direction+distance → `from-x`/`from-y`, `scale`/`color`/custom fields) substituted for `var(--anim-<key>)` in the keyframes. Enter-first elements also get an `anim-pending` class (initial-hidden guard); two same-kind cues with no opposing kind between them warn. A `PlayVideo` cue still sets `data-play-on-step` on the target zone's `<video>`.

**Steps are inferred from triggers, never written by hand.** Every `Animation`/`PlayVideo` cue carries a `Trigger` (`ON_CLICK`, `WITH_PREVIOUS`, or a `Trigger.at(n)` pin). `steps.py`'s `StepResolver` walks a cue sequence in order and assigns concrete step numbers — `pipeline.resolve_steps` for the deck's `animations=[...]` list, the reveal counter in `zones.py` for markdown `::step::`/`::steps::` reveals. A slide's markdown reveals number first, then the `animations=[...]` list continues the count, so both form one timeline.

**Autoplay vs. a `PlayVideo` cue.** If a `Video` sets `autoplay=True` and is also targeted by a `PlayVideo` cue, the cue wins: `process_slide` suppresses `autoplay` before content injection (so `Muted.AUTO` resolves to unmuted) and logs a warning.

The cue's `name` is the kebab-cased type name (`Slugged.slug()`, the mixin in `manifest.py`, shared by `Animation`/`Transition`): `FadeIn → fade-in`, driving `@keyframes anim-fade-in`. There is no per-type registry and no `--anim-*` style — timing/visual params travel in `data-cues` (the old `_anim_style`/`_anim_classes` are gone). Each animated element does still carry an `anim-<slug>` class per cue type, but only as a **styling hook** (the engine drives animation from `data-cues`, not the class): built-in CSS uses it solely for constant styles a keyframe cannot hold at the right cascade origin — `.anim-zoom-in`/`.anim-zoom-out` set `transform-box: fill-box` there so the morph transition's inline `view-box` pin can beat it by ordinary cascade instead of `!important`. Custom animations author a `@keyframes anim-<slug>` (no JS) and may hook their own static styles on `.anim-<slug>`; the engine reads the keyframes and substitutes the cue's `vars`. All built-in animation/transition defaults are concrete Python dataclass field defaults — no CSS `var(--anim-x, default)` fallback. `@keyframes` in `src/css/shared/animations.css` are global (in the presenter bundle); custom `@keyframes` from `Deck(style=...)` are lifted out of the per-slide `@scope` wrapper by `_scope_slide_styles`/`_extract_keyframes` so they stay globally discoverable.

All SVG parsing routes through `svgio.py` (`parse_svg`, `parse_svg_file`, `serialize_svg`), which uses one hardened parser config (`resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False`, constructed per call since lxml parsers are not thread-safe). This is defense-in-depth plus crash-robustness: an SVG referencing an external/DTD entity degrades to an inert node instead of crashing the rebuild. `svgio.py` also exports the `SvgElement` type alias used across the backend.

## JS toolchain

Three tools, each with a distinct role:

- **Biome** — linter and formatter for TypeScript and CSS. Run via `mise run lint-js`. Config in `biome.json`.
- **tsc** — type-checker only (`noEmit: true`). Never emits files; esbuild does that. Run via `mise run typecheck-js`.
- **esbuild** — bundler. Produces committed bundles in `src/inkflow/bundles/` that the Python inlining pipeline reads at serve/build time. Run via `mise run bundle`.

JS dependencies are managed with **pnpm** (`pnpm-lock.yaml`). Every JS task depends on an `install-js` task that runs `pnpm install`, so `node_modules` stays in sync with the lockfile on each `mise run` and cannot drift (CI uses `pnpm install --frozen-lockfile`). `pnpm-workspace.yaml` allowlists esbuild's postinstall build script, which pnpm blocks by default.

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
