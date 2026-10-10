# Inkflow — codebase guide

## Running

```bash
uv run inkflow serve --deck demo/deck.py   # start server at localhost:7777
uv run inkflow edit --deck demo/deck.py    # same server, opens the visual editor at /edit
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
                               MediaAlign, Muted, Overlay, Chart, ChartKind, PageSize, Section,
                               Palette, Theme, Typography, the shipped themes Paper + Stage,
                               and the `animations` and `transitions` namespaces
                               (`Animation` is NOT top-level — it lives in `animations`)
    manifest.py       dataclasses for the deck DSL; Cue/Transition base.
                               `Cue` (element, trigger) is the timeline base for `Animation`
                               (in animations.py) and `PlayVideo`; `Slide.animations`
                               is `list[Cue]`. Media is a `_MediaBase` shared by Image +
                               Video; `Media` is the `Image | Video` union alias (not
                               callable). Video adds playback fields (controls, autoplay,
                               muted, loop, poster, start, end). `Chart` is the third zone
                               value kind (data file `src` or inline `data`, kind, x, y…).
                               `Slugged` mixin (kebab slug from class name) is shared by
                               Animation + Transition
                               Deck params: slides, transition, overlays, theme,
                               mode: ColorMode, style, font_size, embed_fonts,
                               size (a PageSize; None = each slide its own, new
                               slides 16:9). `effective_size`, `is_print`; a print
                               deck defaults to light mode (unless the theme set a
                               mode) and `effective_font_size` = `base_font`.
                               `Section(name, slides=[...])` entries in `slides=`
                               (after the unsectioned leading slides) are flattened
                               by the `_SlideList` data descriptor: `deck.slides`
                               stays `list[Slide]` everywhere, `deck.sections` /
                               `section_ranges()` / `section_of(i)` record the groups
                               Slide params: src, id, md, zones, animations, transition,
                               overlays, extra_style, title, notes, visible, font_size, ink
    sizes.py          `PageSize`: a str value object naming a deck size ("16:9", "4:3",
                               "9:16"/phone, "a0".."a5" [-landscape], letter/legal/
                               tabloid, WxH mm/cm/in/pt or px; constructors .mm/.cm/
                               .inches/.px) with `canvas` (user units), `page_pt`/
                               `page_css` (the printed page), `is_print`, `base_font`
                               (screens: theme size x short/1080; paper:
                               `print_body_pt` = short side / 80, >= 10 pt) and
                               `chart_text_scale` (0.6 screen, 1.0 paper). Screens
                               keep 1080 units on the short side; the A sizes share
                               A0's canvas (3179x4494 at 1 unit = 1 CSS px) so a
                               poster prints at any A size; other sheets are 1 unit
                               = 1 CSS px. `same_aspect` (1%), `parse_view_box`,
                               `physical_length_pt` (an SVG root's 841mm)
    enums.py          shared enums (Direction, Align, VAlign, MediaFit, MediaAlign,
                               ColorMode, Muted, Trigger, AnimationKind, ChartKind);
                               `_KebabStrEnum`
                               base emits CSS token values (Muted is a plain Enum, resolved
                               in Python). `AnimationKind` (enter/exit/emphasis) is the
                               animation lifecycle role.
                               `Easing`/`Trigger` are str value objects with named presets
                               plus a constructor (`Easing.cubic_bezier(...)`, `Trigger.at(n)`)
    animations.py     the `Animation` base (moved here from manifest) + the semantic bases
                               `Enter`/`Exit`/`Emphasis` (they fix `kind`), the concrete types
                               (FadeIn, FadeOut, Bounce, SlideIn/Out, ScaleIn/Out, Highlight)
                               subclassing those, plus `PlayVideo` (subclasses `Cue`
                               directly, no timing) — starts a `Video` on a step, not on load
    transitions.py    concrete transition types (Cut, Crossfade, Morph, Push, Cover,
                               Zoom, Fade, Wipe) subclassing manifest.Transition
    pipeline.py       animation annotation + layout inlining
    content.py        TextBox / Image / Video / chart injection into zone rects, with
                               alignment support; Video emits data-* playback attrs (driven
                               by video.ts); a chart is a nested <svg> in the zone's box
    charts.py         charts from data: `Table` read from CSV/TSV/JSON/a Markdown table
                               (`read_table`, cell text kept as typed by `read_text_rows` /
                               `serialize_rows`), `resolve` (a Chart's data, its path against
                               the file it is written in), `render` (bar/line/area/scatter/
                               pie SVG in theme tokens, `nice_ticks`), and the ```chart
                               fence (`parse_fence`, `expand_fences` over markdown.py's
                               placeholder)
    layout.py         parent inject/set/strip: layout chain resolution and Inkscape layer
                               writing. `AssetKind` (layouts/overlays) selects the searched
                               subdir, so `resolve_parent_path`/`resolve_chain` serve both
                               namespaces with one grammar. `inject_preview_layers` /
                               `are_preview_layers_current` take a `PreviewLayers`
                               (`behind` + `overlays` + css), each layer a
                               `PreviewLayer(path, ref)` — refs come from the caller since
                               a backdrop or an overlay is not named by an inkflow:parent.
                               Layer digests are canonical (c14n, whitespace-stripped), so a
                               synced ancestor does not read as stale forever.
                               The preview `<style>` also paints unstyled zone shapes as
                               dashed outlines (`zone_placeholder_css`): unfilled, Inkscape
                               would paint them black over the slide
    overlay.py        the `Overlay` DSL type (src only). Its own module because both
                               `themes` and `manifest` reference it, same as `Transition`
    markdown.py       markdown-it-py rendering only: code-fence highlighting, LaTeX math,
                               HTML->well-formed-XML normalization (inline <svg> keeps its
                               camelCase names); a ```chart fence becomes a placeholder
                               charts.py draws (no inkflow-specific grammar)
    steps.py          `StepResolver` — the trigger-resolution rule (ON_CLICK/WITH_PREVIOUS/
                               Trigger.at) shared by pipeline.py (the animations=[...] list)
                               and zones.py (markdown reveals)
    zones.py          ::zone:: / ::step:: marker grammar, zone param extraction, and slide
                               assembly (parsed markdown -> per-zone TextBox/Media)
    server.py         HTTP server, WebSocket server, file watcher, build pipeline;
                               `load_deck` turns any failure in deck.py into `DeckError`
                               (`deck.py:42: NameError: …` + the line), which the CLI's
                               `_Group` prints as one error line instead of a traceback
    edit.py           launching external programs on source files: INKFLOW_EDIT_CMD*
                               resolution (extension > kind > default) for the presenter's
                               edit menu, and the editor's "Open" catalog (`open_choices`)
    export.py         static HTML export (inkflow build) and PDF export (inkflow export);
                               `pdf_pages`: each slide's page (the --size override,
                               else the deck's size, else the slide's own: physical
                               width/height, else viewBox px), every distinct size a
                               named `@page` the slide's box selects (`page:`), so
                               mixed sizes print each on its own sheet; `--bleed`
                               (`extend_backgrounds`: canvas-covering rects/images
                               grown into it) and `--crop-marks`;
                               PDF/PNG pages reach Chromium over a loopback HTTP server
                               (`served`), never file:// (a snap/Flatpak Chromium has a
                               private /tmp), and `_run_chromium` checks the written file
                               and reports Chromium's stderr (`cdp.chromium_said`)
    pdfboxes.py       `set_page_boxes`: Chromium writes page sizes on a ~1/75 in grid, so
                               each page's MediaBox is rewritten to the exact size
                               (aligned with the content hung from the top-left),
                               plus TrimBox/BleedBox with bleed; the file is
                               re-assembled from its xref table (left alone when
                               it is not a classic-xref PDF)
    render.py         `inkflow render`: one headless Chromium for every slide (cdp.py),
                               viewport set to the slide's exact size; each slide page
                               resolves `window.inkflowRendered` to its layout findings
                               (src/ts/render/measure.ts), parsed into `Finding`s
                               (`message()`, `is_problem`: small text is a hint);
                               a printed slide (`print_checks`: a print deck, or an
                               SVG in mm without a deck size) gets `__RENDER_PRINT__`
                               (`print_check`: pt per unit, text below 0.6 of the
                               sheet's body size a hint, body text below 0.8) and
                               raster pictures checked at their printed dpi
                               (`low-res`: <150 hint, <100 problem);
                               `--check` = no output path; the contact sheet
                               (`sheet_layout`/`sheet_pages`/`sheet_html`: ≤1600 px wide,
                               ≤16 slides per image) is one more page screenshot of the
                               slide shots, each taken at its cell's size;
                               `render_comparison` (`inkflow compare --sheet`) shoots both
                               decks' differing slides in the same browser, each with its
                               own deck's page (`_page_template`), onto pair sheets
                               `--boxes`: `window.inkflowBoxes()` (src/ts/render/boxes.ts)
                               read back as `SlideBoxes` of `ElementBox` (every element
                               with an id, zones with content extent + `free` height,
                               `zone-x/N` text blocks with their text's extent), no PNG
                               unless `-o`; `render_json` is `--json`
                               contrast (default on, `--no-contrast`): `_contrast` shoots
                               the slide as shown and after `window.inkflowHideText()`
                               (fast PNGs, `Page.screenshot_base64`), and
                               `window.inkflowContrast(shown, hidden)` returns `contrast`
                               findings (`ratio`/`needs`/`color`/`background`; below 3:1
                               a problem, 3–4.5:1 for small text a hint)
                               (`pair_sheet_layout`/`pair_sheet_html`, boxes outlined)
    cdp.py            minimal DevTools client over `websockets`: `Browser.launch`
                               (--remote-debugging-port=0, port read from the profile's
                               DevToolsActivePort, socket opened directly so no proxy
                               applies), `Page` (navigate → load event, evaluate awaiting
                               promises, viewport, screenshot)
    assets.py         asset reference resolution. `AssetRoots` holds the allowed roots
                               (project dir, theme asset dir, and the PDF page cache
                               `.inkflow/cache/pdf/` as `_pdf/`) and converts between an
                               absolute path and a canonical ref both ways; `AssetSource`
                               resolves the refs written in one file; `svg_reader` is the
                               composition reader that canonicalises each SVG as it is read
    editor/           visual editor backend (see "The visual editor" below):
                               provenance.py (data-ink locators stamped on the composed
                               SVG + `locate`), svgops.py (write-back ops on one SVG:
                               attrs/style/paint/text/insert/delete/duplicate/order/group),
                               deckedit.py (libcst edits of deck.py: slide list, Slide(...)
                               args, animations=[...], zones={...}, imports; keeps comments;
                               the slide list is read as `Group`s (unsectioned + one per
                               Section) and every list edit is `restructure(groups)`: pure
                               `move_in_groups`/`add_section`/`remove_section`/
                               `move_section`, slides reindented to their new list),
                               codegen.py (DSL object -> shortest constructor source; field
                               schemas for the property panels), session.py (one request ->
                               one undoable whole-file step; EditorSession/History; the
                               `fonts` action (report / bundle / set) and the `pack`
                               action (check / plan / apply, `gitPaths` for the commit);
                               `_Txn.copy` = a file copied in without its bytes; a video
                               inserted anywhere is a new zone-video rect + a Video(...)
                               zones= entry in one step; the `ink` action adds / erases /
                               clears strokes, local only, and slide-list edits move a
                               slide's ink file when its id changes: `_follow_ink`; the
                               `slide` action's ops: new (optional `md` text) / delete
                               (`files`: also the drawing/md/notes/ink no remaining slide
                               uses) / duplicate / move (`slides` for several, `section`
                               target) / hide / title / id (ink and
                               `slide:` links follow) / detach / layout / font-size /
                               transition / section-add / -rename / -remove / -move
                               (`follow`: deck index whose new place comes back as
                               `select`); a request's `agent` text labels its step
                               "Agent: …" and `deckHash` must match the build; each
                               result lists `changes` and the step's `seq`, which
                               `undo` may name to take back only that step; the
                               `rename` action (`from`/`to`, or `slide`/`stem`, `dryRun`
                               returns the plan) records file moves as `_Move`s without
                               their bytes and removes the folders a step empties),
                               remote.py (one request from the CLI, any session action:
                               through the server serving the deck over the WebSocket,
                               waiting on `build-status` before and after, else an
                               offline EditorSession),
                               shapes.py (`inkflow shape`'s commands, run by the session's
                               `shape` action (`EditorSession._shapes`): each command runs
                               the editor's own actions (`svg` ops, `insert-textbox`,
                               `shape-text` (`zone`: a requested zone name),
                               `insert-chart` (`src`: an existing data file), `zone-text`,
                               `slide` detach) as requests of their own under one
                               `coalesce` key, so a batch is one History step that sees
                               its own earlier writes, taken back whole when a command is
                               refused; deck.py changed meanwhile is reloaded as
                               `_inkflow_shape_deck`, `shape_deck_hash` passing the build
                               check; a command object's first key names it),
                               scene.py (the slide composed from source as the canvas
                               shows it, own file key 0, + canvas.ts's connector logic:
                               corners/sites, `connector_path`, `is_stale`,
                               `with_connectors`, `move_ops`/`movingTogether`),
                               bbox.py (getBBox/getScreenCTM on lxml: transforms, nested
                               svg viewport+viewBox+preserveAspectRatio, zones as
                               `content.zone_box`, path tight bounds, `<use>`; `<text>`
                               estimated, so arrows never attach to plain text),
                               routing.py + geometry.py (ports of connectors.ts and
                               geom.ts with JS rounding/number printing; held to them by
                               tests/data/connector_routes.json, written from the TS by
                               make_connector_routes.mjs and checked by both
                               connectors.fixture.test.ts and tests/test_routing.py),
                               model.py (build_model: per-slide sources, zones, cues for the
                               editor), drawioedit.py (a drawn-in diagram's shapes edited
                               on the slide: geometry/label/style/delete in its source,
                               the picture patched until draw.io redraws it), context.py (.inkflow/context.json for agents),
                               outline.py (`inkflow outline`: `## <section>` lines, per-slide files, layout chain,
                               zones with their origin and text, animations and clicks, read
                               off `build_model` + the editor build; `--slide N` adds zone
                               boxes, canvas size and the slide SVG's named ids; with
                               `--boxes` also the rendered boxes of `render --boxes`),
                               transfer.py (clipboard bundles: copy slides/objects with their
                               files, paste into any project; pasted Slide(...) must pass the
                               `check_slide_code` allowlist, never arbitrary Python),
                               chartedit.py (the chart actions' checks: settings and grid
                               tables from the browser, `chart_json` for the model, the next
                               `data/chart-N.csv`),
                               compare.py (pure: `normalize_svg`, `pair_slides`,
                               `element_changes`, `compare_decks` over `DeckFacts`, the
                               CLI's text/JSON), comparesrc.py (compare sides: `Source`,
                               commits materialized into `.inkflow/cache/compare/<sha>/`,
                               worktrees, `build_side` with an injected loader,
                               `deck_facts`, `shadow_css`, `display_svg`), comparehub.py
                               (the server's compare views: shared sides, live rebuilds,
                               folder watchers, `/_cmp/<token>/` assets, `take_request`,
                               `compare-sources`; see "The compare view" below),
                               filerename.py (rename/move a project file with every
                               reference following: `plan_rename` (no writes) resolves
                               each reference against the file it is written in (SVG
                               href/src/poster, CSS url(), inkflow:parent and preview-layer
                               markers via `_Chains`, Markdown images/links/chart `data:`,
                               deck.py literals via libcst) and re-expresses it in the same
                               style (bare layout name, `local:`, path); ids inferred from
                               renamed files follow (ink moved, `slide:` links rewritten);
                               `plan_slide_rename` = a slide's own files to one stem;
                               `reference_counts`/`project_files` for the Files view;
                               `plan_copy_in` = every file named outside the deck or
                               through a symlink copied in (assets/, layouts/,
                               overlays/, slides/) and its references re-expressed
                               relative by the same `_World` (`relative=True`), for
                               `inkflow pack`),
                               previews.py (layout gallery renders; like the model's
                               layout list, `layout.layouts_for`: built-in layouts
                               in the deck's shape, the project's own always),
                               themeedit.py (Theme
                               dialog: token overrides as one marked block in the project's
                               styles.css, values validated, never raw CSS; the session's
                               `theme-set` also takes `theme` = a `THEMES` name, written
                               as `Deck(theme=Paper())`), findreplace.py
                               (find/replace over SVG text, Markdown and deck.py author-text
                               literals only; `deckSlide` keeps deck.py to one slide's
                               text, the dialog's "This slide"), gitops.py (the Git menu: status, commit,
                               push/pull, discard, undo commit, branches, deck-scoped log,
                               view/revert/restore a commit, `lfs_status` = media
                               no LFS rule covers or committed as full copies, `lfs_track`
                               / `lfs_off`; shells out to git with GIT_TERMINAL_PROMPT=0),
                               worktrees.py (the session's `worktree` action and
                               `inkflow worktree`: `list_worktrees` = every worktree with
                               the deck.py at the same relative path, ahead/behind the
                               deck's branch, dirty, `main`; `add` = branch `deck/<name>`
                               in `<main worktree>/.inkflow/worktrees/<name>`, ignored by
                               git and unwatched, with a `note` when uncommitted deck
                               changes stay behind; `merge` = ff or a "Merge X into Y"
                               commit, refused while the deck is dirty, a conflict
                               aborted and named; `remove` refuses dirty/unmerged unless
                               forced, deletes only merged (or forced) `deck/` branches),
                               projects.py (new deck in one of seven
                               looks, each with `preview` colours for its thumbnail,
                               folder browsing, recent decks), places.py (favourite
                               folders + the default deck location, user config dir),
                               nativedialog.py (the OS folder/file chooser shown by the
                               server: zenity/kdialog, osascript, PowerShell; `system-pick`,
                               local only), media.py (files of any
                               size: by path (`import_path`, local only) or in chunks
                               (`Uploads`), staged in .inkflow/incoming/ and moved into
                               assets/ in one rename; both return an `Arrival`, which
                               says `convert=True` for a video browsers cannot play but
                               ffmpeg can read (by path: converted from where it is;
                               uploaded: kept in incoming/<id>/ until converted, then
                               `discard_source`); `probe` (ffprobe), `issues`, `plan`
                               (ffmpeg MP4/WebM command + rough size, or `fmt="copy"`:
                               remux via `remux_target`, sound re-encoded only if it
                               does not fit), `Conversions` (background ffmpeg jobs,
                               also staged))
    cli/              CLI package (entry point inkflow.cli:main). _common.py holds the
                               `main` group, shared options, and the Project/Target helpers;
                               commands are grouped by area: project.py (init, setup-git,
                               setup-pages, completion), present.py (serve, edit, build, export), agent.py
                               (outline, context, render, goto, select, setup-claude),
                               compare.py (`inkflow compare [LEFT] RIGHT`), slides.py
                               (the `slide` group: add, delete, duplicate, move, hide, show,
                               rename, title, and `slide section` add/rename/move/remove;
                               SLIDE = presentation number or id, SECTION = name or
                               1-based position; runs the
                               session's `slide` action via editor/remote.py, so with an
                               editor open it is an undoable "Agent: …" step there),
                               shapes.py (the `shape` group over editor/shapes.py: add,
                               connect, sites, reroute, move, resize, align, distribute,
                               style, text, delete, duplicate, group, ungroup, order,
                               rename, lock/unlock, hide/show, link, batch, list; `-s`
                               defaults to the editor's slide in a fresh context.json),
                               _edits.py (`DeckSlides`, `apply_edit`: what slide, shape,
                               text and anim share),
                               text.py (`find`/`replace`: the session's `find`
                               and `replace` actions over the files `build_model` lists
                               per slide, as the Find dialog sends them; `-s` sends
                               `deckSlide`, deck.py text of that Slide(...) only),
                               anim.py (the `anim` group: `list` = the slide built alone
                               (hidden ones as if shown), Markdown reveals read off its
                               `inkflow-step-*` data-cues and code highlight stages, then
                               `resolve_steps(animations, reveal max)`; add/set/move/
                               remove send the session's `anim` action (Animation panel
                               ops; `remove` takes `indices` for several in one step),
                               types from inkflow.animations + the deck module, targets
                               from the built slide's ids, nearest names on a miss),
                               fonts.py (`inkflow fonts [--json]` = the fontreport
                               table; `fonts bundle`/`fonts set` send the session's
                               `fonts` action, `inkflow pack [--zip] [-n]
                               [--with-pdf-pages]` its `pack` action, all through
                               editor/remote.py, then zips locally),
                               files.py (`inkflow mv OLD NEW [-n]`: the session's
                               `rename` action, through editor/remote.py; slides.py adds
                               `slide rename-files`),
                               authoring.py
                               (clean, label2id, add, parent group, sync, layouts), color.py (colorize,
                               palette), verify.py, worktree.py (the `worktree` group: add,
                               list, merge, remove over editor/worktrees.py; `add` prints
                               `path:`/`deck:` on stdout). Submodules register on `main` by import.
    launcher.py       `inkflow setup-desktop`: an application-menu launcher (Linux
                               .desktop + icon, macOS ~/Applications/Inkflow.app, Windows
                               Start menu .lnk) running `<this python> -m inkflow edit
                               --start --quit-when-idle=60` hidden (pythonw on Windows;
                               `__main__.py` gives a console-less process devnull
                               streams), or in a terminal with `--terminal`
    instances.py      one server per deck: each server records {pid, host, ports, deck}
                               in the user state dir (`register`/`unregister`, by
                               `_serve_deck`); `serving(deck)` finds the live one, trusting
                               a record only when `/_inkflow/instance` answers with its
                               pid (stale ones are deleted). Used by `inkflow edit/serve`
                               (open that server instead) and the session's open-deck
                               (returns `redirect`, the page goes there)
    drawio.py         draw.io editable SVGs (*.drawio.svg): the `<mxfile>` source in the
                               root's `content` attribute; `source`/`normalize` store it
                               uncompressed (inflate + unquote per page), `size`,
                               `textconv` (what `inkflow clean --stdout`, git's SVG diff
                               driver, prints for one; `clean` never rewrites one)
    drawio_inline.py  a draw.io picture drawn into its slide: `inkflow:drawio="inline"`
                               or `"themed"` on the `<image>` (`DiagramMode`; none = picture)
                               makes `process_slide` (before annotation) swap it for a
                               nested `<svg>` with the image's box, id, transform and
                               provenance (`data-ink-tag="image"`, `data-drawio`, class
                               `inkflow-diagram`), every id inside prefixed and each
                               `data-cell-id` cell named `<image id>-<cell id>` so cues
                               and connectors target shapes (`data-cell-kind` vertex/
                               edge/label/other from the source); Helvetica (draw.io's default) becomes
                               `var(--inkflow-body-font)`; "themed" maps colours to theme
                               tokens (draw.io's palette by name, else hue/lightness;
                               `light-dark()` by its light half) and moves recoloured
                               presentation attributes into style (no var() there).
                               contract.css sets its `color-scheme` from `data-theme`
    pdf.py            PDF figures: a picture naming a PDF (`plot.pdf#page=2`; `Image(...,
                               page=2)` is kept as that fragment) shows its page converted
                               to SVG by the first converter available: PyMuPDF (the
                               optional `pdf` extra, AGPL, imported by name only here),
                               then pdftocairo, mutool, Inkscape (`converter`, `CONVERTERS`).
                               `convert` caches by content hash + page + converter;
                               `PdfPages` (one per build, in `DeckContext`) rewrites every
                               `<image>`/`<img>` after content injection, keeping the PDF
                               ref in `data-inkflow-pdf`, or draws a placeholder (one
                               warning per build, `install_hint`); `page_count` for
                               the editor's page picker and `verify`. A page committed
                               beside its PDF (`committed_path`: `figure.pdf.p1.svg`,
                               written by `pack --with-pdf-pages`, root stamped with
                               the PDF's hash `data-inkflow-pdf-digest`) is used
                               instead while the hash matches (`committed_page`), so
                               references keep naming the PDF
    backgrounds.py    a background behind a picture (`Image(background=...)`,
                               `inkflow:background` on an `<image>` or a drawn-in diagram):
                               `background_paint` (paper = white in any mode, surface,
                               a theme colour, #hex); a zone `<img>` gets CSS, a slide's
                               own picture a pipeline-only `<rect>` behind it (margin 4%
                               of its shorter side, `pointer-events: none`)
    clean.py          SVG Inkscape metadata stripping (used by cli and pre-commit hook)
    ink.py            pen ink: `ink_path` (ink/<slide id>.svg or Slide(ink=)),
                               `compose_ink` (the file's strokes as the slide's last
                               `<g class="inkflow-ink">`, stretched if its viewBox differs),
                               `Stroke` (a page's stroke validated field by field into a
                               filled `<path>`), `add_strokes` / `erase_strokes` (the file
                               as bytes, laid out as `inkflow clean` would write it)
    label2id.py       `inkflow label2id`: promote each element's inkscape:label to its
                               SVG id (Inkscape convenience for Morph/animation targets).
                               Slugifies non-id labels, skips clashes and preview-layer
                               elements, rewrites ids by text substitution to keep diffs small
    colors.py         CSS color token extraction, hex→class mapping, SVG colorization, GPL palette
    git_setup.py      git hook + SVG diff driver setup; `init_project_git`
                               bootstraps a fresh project (git init + .gitignore +
                               hooks), and steps aside when already inside a repo;
                               either way `setup_lfs` writes the deck's LFS section
    lfs.py            Git LFS for decks: media extensions (PATTERNS), the
                               .gitattributes section (rules, or the committed
                               `# inkflow: lfs off` git-only opt-out), `mode` (on/off/none
                               from the deck's .gitattributes up to the repo root)
    publish.py        GitHub Pages / GitLab Pages (`inkflow setup-pages`, `init --pages`,
                               the editor's Git → Publish…, session action `publish`
                               ops status/setup, setup local only, one History step
                               though the files sit at the repo root): renders
                               templates/ci/ (pages.yml, release.yml, gitlab-ci.yml
                               + gitlab-release.yml; `__TOKEN__` placeholders) for the
                               deck's `layout` (repo root, deck folder → `--deck`,
                               nearest pyproject.toml → `uv run --project`, else
                               `--with inkflow~=…`; GitHub branch = origin's HEAD or
                               the current one, GitLab uses $CI_DEFAULT_BRANCH). LFS
                               and PDF converter are handled at run time (checkout
                               `lfs: true`; GitLab `git grep filter=lfs`; poppler when
                               `git ls-files '<deck>/*.pdf'`), so the files do not
                               depend on them; release names use the repo name at run
                               time. `parse_remote`/`pages_url`/`settings_url` (user
                               sites, GitLab subgroups; self-hosted → no URL),
                               `detect` (the marker `inkflow setup-pages` in the file;
                               git status's `pages`), `plan` (conflicts: refuses
                               unless force), `font_warnings` (fonts.font_sources:
                               fonts outside the project's/theme's fonts/)
    fontreport.py     where each font family the deck uses comes from (`font_report`:
                               effective token values from the styles cascade, other
                               CSS font-family, every font in the built slides; faces
                               used, body bold/italic from the HTML): `Where` project /
                               theme (the active theme's or inkflow's fonts/) /
                               machine / missing / generic (a generic family first);
                               its own uncached index over fonts._font_dirs;
                               `licence_of` (licence files beside the font, name IDs
                               13/14/0, fsType, `_SYSTEM_FONTS` with open
                               alternatives); `plan_bundle` (machine fonts' used
                               files, or a variable font, to fonts/<family>/ with
                               licences + fonts/README.md table, warnings never
                               refusals); `token_value` (what `fonts set` writes)
    pack.py           `inkflow pack`: `plan_pack` = fonts bundle + `plan_copy_in` +
                               `plan_pyproject` (pin inkflow and a pip-installed theme,
                               nearest pyproject.toml or a new one) + uv.lock
                               (`run_uv_lock`, patched out in tests by conftest) +
                               `plan_attributes` (LF rules one per pattern, SVG diff
                               line, LFS block or missing font rules, lfs-off kept) +
                               committed PDF pages; `Item`s (key, message,
                               consequence, fixable) are what `verify_portable`, the
                               commit question and the CLI report read; `make_zip`
                               (git ls-files or .gitignore, LFS smudged);
                               `ensure_text_rules`/`bundle_fonts_now`/`lock_new_deck`
                               for `init` and the editor's new decks
    init.py           project scaffolding (inkflow init): copies templates/ into
                               slides/ + notes/, writes a 3-slide deck.py and a bare
                               pyproject.toml pinning inkflow (`~=` compatible release);
                               command refuses a non-empty target (dotfiles ignored)
                               unless --force. `scaffold_poster` (init --poster
                               [--size], the editor's Poster look): templates/poster/
                               (poster.md, figures/, data/results.csv) on poster-3col
                               (poster-landscape-3col for a landscape sheet).
                               `with_theme` (init --theme, the Paper/Stage looks):
                               `theme=Paper()` + its import in the scaffolded deck.py
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
                               `PreviewPlan.swept` (whether a whole-deck sync keeps a file
                               current, and so whether verify may call it stale: a bare
                               slide only once it carries the preview style block),
                               `sync_slides`; shared by the `sync` command and `init`
                               (run live after scaffolding)
    logging.py        unified log sink over stdlib logging: `logger`, shared Rich
                               `console`, `report` (cargo-style status), `collect_logs`
                               (per-rebuild capture), and three independent sinks
                               (console/file/browser), each a level, resolved by
                               `resolve_levels` (`--log-level*` flags + INKFLOW_LOG_LEVEL*
                               env, `off` disables) and installed by `configure`.
                               `configure` also claims the root logger (`_ForeignHandler`)
                               so a dependency's records land in these sinks at their own
                               level instead of stdlib's lastResort stderr
    svg.py            SVG tree utilities (ensure_defs, with_namespaces,
                               compose_with_ancestors, compose_overlays,
                               duplicate_zone_ids, is_full_canvas_fill)
    svgio.py          SVG parse/serialize primitives: one hardened parser, SvgElement alias
    verify.py         slide authoring checks (inkflow verify; arrows whose shapes moved: editor/scene.py);
                               `verify_portable` = the deck-wide "deck" lines from
                               pack's items (machine/missing/generic fonts, outside
                               files, web pictures, pyproject, uv.lock, eol rules;
                               `--no-portable`); `render --check` does not repeat them
    ns.py             XML namespace constants
    tui.py            terminal UI (Rich)
    presenter.html    shell template — inlined with CSS/JS at serve time
    editor.html       visual editor shell, served at /edit (editor bundle + deck styles)
    render.html       single-slide page `inkflow render` measures and screenshots
    claude/SKILL.md   the inkflow skill `inkflow setup-claude` installs into a project
    pdf.html          PDF export template
    bundles/          pre-built JS/CSS output (committed; no Node needed at install time)
      presenter.js    navigation, transitions, WebSocket, presenter panel
      presenter.css   all presenter styles including the sidebar panel
      editor.js/.css  the visual editor (src/ts/editor, src/css/editor)
      render.js       single-slide renderer + layout measurement (src/ts/render)
    theme/            built-in theme: layouts/*.svg (the 16:9 ones, and poster-base/
                               poster-landscape-base with poster-2col/-3col/
                               -landscape-3col/-4col on the A canvas: zones title,
                               authors, affiliations, logos, col-N, references,
                               contact), icon.svg, showcase/, and
                               styles.css (per-layout zone styling for those layouts,
                               loaded for every deck — keep its rules `.layout-*`-scoped)
    builtin_themes/   the themes shipped besides the default (`Builtin`, themes.py):
                               `Paper` (quiet white document look, light by default) and
                               `Stage` (big-type keynote look, black on screen; leaves
                               `mode` unset so a printed deck is still light), `THEMES`
                               (default/paper/stage: init --theme, the Theme dialog's
                               selector) + `theme_id`. Each: palettes for both modes
                               (contrast checked in tests/test_builtin_themes.py),
                               `replace(Builtin.typography, ...)` (never their own font
                               families), `fonts_dir` = the default theme's fonts,
                               `asset_dir` = paper/ or stage/ here even for a subclass,
                               holding only a styles.css: unscoped text rules plus
                               `.layout-*` refinements of the built-in layouts
                               (decorative layout shapes matched by exact geometry,
                               e.g. `rect.inkflow-fill-accent[y="0"][height="8"]`)
    templates/        inkflow init starter files (title.svg, diagram.svg, guide.md,
                               diagram.md, notes/*.md) copied verbatim into new projects;
                               example/ is the demo deck's look (footer overlay + styles)
                               for the editor's "Inkflow example" new deck; ci/ is
                               publish.py's CI templates
  ts/                 TypeScript source
    globals.d.ts      ambient declarations for Python-injected globals (__SLIDES_JSON__ etc.)
                      shared/viewbox.ts falls back to the deck canvas (`setDeckCanvas`,
                      from the editor model's `deckSize`, which also sets the
                      thumbnails' `--deck-ar`); shared/ink.ts `inkScale` sizes
                      pen strokes by max(w/1920, h/1080)
    shared/           types, step engine (step.ts: WAAPI cue driver + elementActions),
                      sections.ts (section runs of the presented slides, which carry
                      `SlideData.section`; `verticalNeighbor` for wrapped grids),
                      keyframes.ts (reads @keyframes + per-cue var substitution),
                      step-ring SVG builder, cubic-bezier easing; ink (presenter and
                      editor alike): ink.ts (pure: perfect-freehand options, outline ->
                      path data, Douglas-Peucker `simplify`, eraser hit test, relay
                      validation), inksettings.ts (pure palette state), inkpad.ts
                      (pointer input -> strokes: coalesced + predicted samples, one
                      redraw per frame, eraser, palm and click swallowing),
                      inkpalette.ts (the floating palette); zoom gestures (both
                      pages): gestures.ts (pure: wheel delta -> zoom factor with
                      deltaMode, `ZoomAnchor`, the `TouchTracker` state machine;
                      tested), gesturepad.ts (`GesturePad`: the DOM glue, one per
                      page), zoom-camera.ts (the presenter camera's viewBox maths)
    presenter/        main presenter modules — navigation, transitions (progress-driven
                      via progress-driver.ts), overview, picker, websocket, status bar,
                      keyboard, syncmenu.ts (sync-mode status-bar control),
                      pv.ts (presenter panel sidebar; current section under the
                      strip), overview.ts (grid with a heading per section, up/down
                      by geometry), picker.ts (sections match too), video.ts (step-driven
                      <video> playback, wired in via status.ts), toeditor.ts (back to
                      /edit at this slide: the opener editor tab when there is one;
                      hidden in a static build), ink.ts (ink mode: strokes held per
                      slide in inkstore.ts, mounted into the slide's <svg> through
                      slidehooks.ts, relayed as `ink` messages, saved with "Keep"
                      through the session's `ink` edit-op), and deck-url.ts
                      (pure position<->fragment codec behind syncURL/readURL; the
                      only module reading location.pathname/search/hash)
    editor/           visual editor: canvas.ts (render, hit-testing, handles, drag ->
                      attribute plans), geom.ts (pure matrices + move/resize/rotate plans),
                      snap.ts (smart guides), textedit.ts, insert.ts (tools, images,
                      paste), sorter.ts (slide list rows + the drag model shared
                      with grid.ts), sections.ts (pure: rows, drop targets, move
                      requests), sectionui.ts (section headers, collapse state in
                      localStorage, section menu, rename, section-* edits), props.ts, notes.ts, toolbar.ts (shortcuts),
                      context.ts (agent context + goto/select), net.ts (edit-op requests),
                      animpreview.ts (▶ Play in the Animation order list and an
                      animation's panel: shared/step.ts runs played on the canvas
                      click by click, in preview mode; Esc/a click/a re-render
                      stops it), animsteps.ts (`cueSteps`: each listed
                      animation's click, read off the built slide's data-cues),
                      clipboard.ts (system-clipboard copy/paste of slides and objects),
                      richtext.ts (zone HTML <-> Markdown for in-place rich editing; throws
                      Unsupported rather than drop content), crop.ts, objects.ts (Objects
                      tab: hide/lock), gallery.ts, grid.ts (grid view of all slides;
                      shares sorter.ts's Thumbs cache class and slide menu), theme.ts
                      (its Fonts section: the session's `fonts` report colour-coded,
                      Bundle fonts into the deck with the licence warnings in a
                      confirm; font fields send `fonts` op `set`),
                      find.ts, exportdlg.ts, openwith.ts ("Open ▾" in other programs),
                      decks.ts ("deck ▾": new/open/recent decks, start page),
                      folderpicker.ts (the folder picker those and the video picker
                      share: Tab completion, type-to-filter, keyboard list, places,
                      Browse… = system dialog; its pure path maths in pathtext.ts),
                      rename.ts ("Rename…" beside a file's Open ▾, "Rename files…"
                      for a slide, the deck menu's "Files…" view: a dialog that
                      previews the session's `rename` dry run as the name is
                      typed; path maths in pathtext.ts),
                      git.ts (Git menu; its Worktrees section: rows with
                      Compare = `inkflow:compare` CustomEvent {kind: "path",
                      deck, label} for the compare view, a dialog with what to
                      tell the agent (worktreetext.ts, pure + tested), Merge,
                      Remove with a force retry, New worktree for an agent…;
                      "Published at <url>" + Publish… → publish.ts: host,
                      release, README link, files to write, then commit + next
                      steps; its pure parts in publishtext.ts, tested; Pack deck…
                      and Commit's pack question → pack.ts: `pack` op `check`
                      first, "Pack and commit" (focused) = op `apply` then commit
                      the ticked paths + its `gitPaths` in the same commit,
                      "Commit without packing (not recommended)"; its words in
                      packtext.ts, tested),
                      canvasmenu.ts (right-click menu on the canvas; text fields and
                      Shift+right-click keep the browser's), videopreview.ts (canvas
                      videos lose controls + pointer events so they select and drag;
                      "Play preview" plays one in place; the presenter is unaffected),
                      videocheck.ts (Video check after insert: browser decode test +
                      ffprobe issues; Convert dialog with remux/presets/quality/
                      estimate; `convertForInsert` makes it mandatory for formats
                      only ffmpeg reads),
                      drawioshapes.ts (a drawn-in diagram's shapes for the
                      Shapes/Animate list),
                      pdfpages.ts (a PDF figure's page: `choosePage` dialog of
                      thumbnails from the `pdf-pages`/`pdf-page` session actions;
                      `sourceRef` = `data-inkflow-pdf` or the href, what the panel,
                      Open ▾ and copy write back),
                      drawio.ts (draw.io embed mode in a full-screen iframe, JSON
                      postMessage protocol checked by source + origin: configure
                      → load → save → export xmlsvg → `drawio-save`; a new diagram's
                      picture is placed on first save via insert.insertDiagramImage),
                      stylecopy.ts (format painter: Copy/Paste style, Ctrl+Alt+C/V;
                      theme colours go through the server's `paint` op),
                      dialog.ts (the one modal), connectors.ts (connection sites
                      and straight/elbow/curved routes, pure + tested),
                      chart.ts (the chart dialog: data grid, settings, server-drawn
                      preview; insert-chart / chart-save-data) over chartgrid.ts
                      (pure: TSV paste, grid edits, series settings; tested),
                      ink.ts (the pen tool: one session `ink` step per stroke /
                      erase / clear), touchzoom.ts (the canvas's `GesturePad`:
                      pinch / Ctrl+wheel -> canvas.zoomAbout, one finger
                      deferred), compare.ts (the compare view: paired list,
                      side by side / slider / difference, outlines, notes diff,
                      picker, Take this slide, Merge branch) over comparelib.ts
                      (pure: rows, jumps, badges, word diff, take/merge rules;
                      tested)
    render/           the single-slide page behind `inkflow render`: main.ts (step,
                      waits for load/fonts/first video frames), measure.ts (zone
                      text vs its foreignObject box, code blocks cut off, drawn
                      objects vs the viewBox — skipping clipped/masked content,
                      unpainted shapes and anything spanning the slide — and text
                      below 1/80 of the slide height; all in slide units),
                      boxes.ts (`--boxes`: each id'd element's box after
                      transforms, zone content extent/free space, text blocks)
                      contrast.ts (each text run vs the hidden-text shot's pixels
                      where its glyphs are, worst tenth decides; halo strokes,
                      shadows that help, alpha blended; pure WCAG maths tested)
  css/                CSS source
    shared/           theme variables, animation keyframes, ink.css (the ink palette)
    presenter/        presenter partials including pv.css (sidebar panel)
themes-tour/          a theme on every layout with text, code, a table and charts
                      (INKFLOW_TOUR_THEME / INKFLOW_TOUR_MODE): the built-in themes
                      page's screenshots (docs/built-in-theme/img/)
demo/
  deck.py             12-slide demo deck (SVG slides, some filling zones with Markdown via md=)
  slides/             source SVGs and Markdown content files
  data/               chart data (sales.csv)
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
Clients send `{"type":"nav","slideIndex","step"}` (validated + clamped server-side by `_coerce_nav_position`); the server stores the last position and rebroadcasts it as `{"type":"position",...}` to the *other* clients, and pushes it once to each newly connected client. A window that booted from a deep link (a slide named in the URL, captured by `readURL()` before `syncURL()` rewrites the bar) or reconnected asserts its own position and ignores that first push; a bare window adopts it. Each client also has a per-tab **sync mode** (`two-way`/`present`/`follow`/`solo`, `shared/types.ts`) deciding locally whether it broadcasts nav (`sends()`) and applies incoming positions (`receives()`) — the server knows nothing about modes. `s` cycles the mode; `syncmenu.ts` owns the status-bar widget, `websocket.ts` the network/state. Switching into a receiving mode sends `{"type":"sync-request"}` to catch up. Persisted in `sessionStorage`.

**Ink is drawn into the slide, held per slide, and saved to a file of its own.**
A stroke is perfect-freehand's outline around the pen's track (`shared/ink.ts`), written as one filled `<path>` so it renders anywhere without inkflow. `shared/inkpad.ts` turns pointer input into strokes for both pages: every coalesced sample is kept, the live stroke is one path redrawn once per animation frame (plus the browser's predicted samples) straight into the slide's own `<svg>`, so it is in slide units through the zoom camera, resizes and transitions; a pen's real pressure is used, a mouse's or finger's is simulated. By default only a pen draws (a mouse click and a swipe stay navigation, a palm near a pen is swallowed), and the click a gesture ends with never reaches the page. In the presenter (`presenter/ink.ts`, key `i`) ink is held per slide id (`inkstore.ts`, with undo) and re-mounted as `g.inkflow-live-ink` whenever `transitions.ts` mounts a slide (`slidehooks.ts`, which keeps transitions.ts and its tests free of ink). Other windows get it as `{"type":"ink","op":"draw"|"add"|"erase"|"abandon"|"request"|"state",...}`, relayed by the server untouched (or over the window link in a static build) and gated by the same `sends()`/`receives()` as the position; receivers validate every field (`strokeFrom`). With "Keep", a stroke also goes to the session as `edit-op` action `ink`, which `_local_only` restricts to loopback peers, so an audience screen never writes files. Saved ink is `ink/<slide id>.svg` (or `Slide(ink=)`), strokes directly under its root so each is an editor object (source role `ink`, selectable and movable like the slide's own shapes); `process_slide` composes it right after the overlays and before annotation (a cue can reveal a stroke). A slide's id is inferred from file names, so `EditorSession._follow_ink` renames, copies or deletes ink files in the same step as a slide edit that changes ids, never overwriting a file nothing vacates. `serialize_ink` writes exactly what `inkflow clean` would, so the pre-commit hook leaves ink files alone.

**Zoom gestures are one shared layer; a pinch never leaves a trace of its first finger.**
`shared/gestures.ts` holds the pure parts and `shared/gesturepad.ts` (`GesturePad`) the DOM glue; the presenter (`presenter/zoom.ts`, the viewBox camera) and the editor (`editor/touchzoom.ts` → `canvas.zoomAbout`, which lays the paper out at the new size and scrolls the canvas so the anchored slide point lands where it belongs) each give it a host saying what a zoom, a pan and a cancelled finger mean. Ctrl/⌘+wheel (Chrome/Firefox's trackpad pinch) zooms by exp(-deltaY/100), each event's step bounded to ×1.2 so a mouse notch (100 px, 3 lines, a page; `wheelPixels` normalises `deltaMode`) is one even step; Safari's `gesturechange` zooms by its `scale` ratio; everything is summed and applied once per animation frame (`zoom(factor, from, to)`: about `from`, moved to `to`, so a pinch's midpoint pans as it zooms). Over the surface the page `preventDefault`s Ctrl+wheel and gesture events and sets `touch-action: none` (`#stage-wrap`, `#canvas`); elsewhere the browser keeps its page zoom. A plain wheel is the page's: the presenter pans the camera with it only while zoomed in (otherwise it does nothing, as before, so a trackpad's inertial tail never navigates), the editor scrolls natively. While zoomed the editor pads `#canvas` by half its size on every side (`layoutPaper`), so the paper can sit off-centre and the anchor always holds; `ZoomAnchor` keeps the anchored slide point across a gesture's frames so whole-pixel layout and scroll rounding never accumulate (per-frame layout measured at 1–4 ms median on the demo, so no CSS-transform stand-in).
Touch is read in the window's capture phase, before every other handler. `TouchTracker` decides: a lone finger passes through; a second finger landing while the first is not yet *committed* (moved past a 10 px slop **and** 200 ms passed) makes a pinch — the first finger's action is cancelled and every later event of both fingers is stopped, so the page never sees them; a second finger after the first committed is ignored (stopped) and the first carries on; after a pinch the finger left over is inert until it lifts (no drag, no swipe, no tap); a third finger is ignored; a finger landing beside a leftover resumes the pinch. Clicks are swallowed while a sequence is claimed and for 400 ms after a multi-finger one ends; `multiTouch` tells `keyboard.ts`'s swipe to stand down. Two ways to cancel, chosen per page: the **presenter rolls back** (`cancelSingle` → `onTouchCancel` subscribers: `InkPad.cancel()`, whose `onAbandon` relays `abandon` so other windows drop the half stroke, and the laser's `abortDraw`), because ink must start without latency and swipe/tap are decided at the end anyway; the **editor defers** (`defer`): a lone finger's events are held until it commits, then replayed as synthetic pointer events at the original target (pointerdown, plus a move to where it is), or on release replayed whole (a tap; a flick quicker than the window gets its move too), or dropped if a second finger makes a pinch — so selection, drags, marquees and insert tools need no rollback code and nothing reaches the session. `canvas.ts`/`insert.ts` wrap `setPointerCapture` in try (a replayed tap's pointer may already be gone). The editor's pen tool with *Hand* on is not deferred (ink latency) and is cancelled like the presenter's. A touch while a pen is down or was near in the last 1.5 s is a palm: not the gesture's, left to `InkPad`'s palm rejection. A double tap (or double-click) on empty area resets the presenter camera / fits the editor's slide; Chrome also fires a native `dblclick` for a touch double tap, both are idempotent.

**The deck position lives in the URL fragment, `#slide=7&steps=2` (`deck-url.ts`).**
The fragment never reaches a server, so nothing has to route it and rewriting it is a same-document change every browser permits. The path segment this used to write (`/7`) only ever worked under `serve`, whose catch-all answers any path with the presenter: a static host 404s it on reload (the docs demo included), and a `file://` deck cannot have it at all — the browser rejects the rewrite (`history.replaceState` throws `SecurityError`; Firefox logs "Content at …/index.html may not load data from …/7"). The fragment is the only form: nothing writes a path segment any more and nothing reads one, so the position has exactly one representation. `deck-url.ts` is the only module that touches `location.hash`, and its two functions are pure over a `URL` so every case is unit-tested; `status.ts` supplies `window.location` and keeps a `try/catch` around `replaceState`.

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

**Renaming a file rewrites every reference to it, by the same rule.**
`editor/filerename.py` finds references where they are written and resolves each against its own file (never by matching a name across the project), then writes the new one in the style it was written: a bare layout name stays a name (`local:` when a `slides/` file would shadow it), a path stays a path relative to its file, a `#page=` stays. SVGs are rewritten by a small tokenizer (only the attribute values change), contents of preview layers are copies and left alone, but their markers are followed through the chain that declared them (`_Chains`: an ancestor's parent is relative to that ancestor). The session applies the plan as one step whose moves are kept without bytes (videos), so undo moves files back and restores the folders; the extension never changes; `styles.css`, `deck.py` and files in hidden folders are refused. `inkflow mv` and `inkflow slide rename-files` are the same action from the CLI.

**A deck is portable when a clone of its folder looks the same anywhere.**
Only the deck's own files and the pinned inkflow/theme travel with a `git clone`, so `fontreport.py` classifies every font as project / theme (portable) or machine / missing / generic, and `pack.py` lists everything else that ties the deck to this computer as `Item`s (fixable or not): outside or symlinked files (`filerename.plan_copy_in`, references rewritten by the rename machinery, never string-replaced), pyproject pin + uv.lock, `.gitattributes` LF/diff/LFS rules, PDF pages. The same plan feeds `inkflow fonts`/`pack`, `verify`'s "deck" warnings, the Theme dialog's Fonts section and the commit's pack question, so they cannot disagree. Writes go through the session (`fonts`, `pack` actions; `pack` and copying fonts are local only) as one undoable step; `_Txn.copy` records a file copied in from anywhere without holding its bytes (undo deletes it, redo copies again, emptied folders are pruned), and `pack` runs `uv lock` after the commit and adds the lock file's change to the same step. Licences warn, never refuse. The other agent's fonts.py owns embedding; fontreport only reads its discovery (`_font_dirs`, `_read_font_record`) with its own uncached index, so a just-bundled font is seen at once.

**PDF figures are a derived asset, converted at build time and never committed.**
Browsers show no PDF in `<image>`/`<img>`, so `pdf.PdfPages.apply` (a pipeline step after content injection, so SVG pictures, `Image` zones and Markdown images are covered alike) points each PDF reference at its page converted to SVG in `.inkflow/cache/pdf/` (git-ignored, unwatched; named by content hash + page + converter, so a saved PDF converts again and the watcher's rebuild shows it). The cache is a third `AssetRoots` root with the canonical prefix `_pdf/`, reserved like `_theme/`: `serve`, `build` (copied to `out/_pdf/`, not a hidden folder static hosts may refuse), `--inline-assets` and `export` handle a converted page exactly as any picture, with no special case. The PDF reference survives beside it as `data-inkflow-pdf`, which the editor reads instead of the href (`pdfpages.sourceRef`), so nothing it writes back (page change, replace, copy/paste) ever names the cache; moves and crops edit the source SVG, whose href is the PDF. PyMuPDF is optional (`inkflow[pdf]`) and loaded with `importlib` so inkflow stays MIT and type-checks without it; the system tools are the fallback. With no converter the picture becomes a placeholder data URI and the build warns once.

**A deck's size is a canvas plus a page, and the A sizes share one canvas.**
`Deck(size=)` (`sizes.PageSize`) names both: the user units new slides get and the sheet a PDF page is. A slide's own size stays its `viewBox`; the deck size only decides what is created (blank slides, editor inserts, ink scale, thumbnails' shape, the layouts the gallery offers) and what is printed (`export.pdf_pages` fits each viewBox onto the page, letterboxing another shape, which `verify` warns about). All A sizes share A0's canvas so one poster design and the `poster-*` layouts serve every A sheet, and text scales with the sheet (`base_font`: 1/80 of the short side, 30 pt on A0); `render` measures printed slides in points and dpi against that same sheet size (`print_body_pt`), so the default type scale and the check cannot disagree. `None` keeps the pre-size behaviour exactly (per-slide pages, 16:9 new slides, theme mode and font).

`build --inline-assets` swaps the copy for `_inline_assets`, which rewrites each reference to a `data:` URI through `assets.rewrite_references` — the same `REFERENCE_PATTERNS` the scan uses, so both halves learn a new reference kind at once. It runs *after* `embed_fonts_css_subsetted`, because the subsetter scans these very slide strings for used characters and base64 would pin the whole font. `assets.MIME_TYPES` is the shared table naming what `serve` sends and what the data URI claims; a suffix missing from it is copied out and warned about rather than dropped, so the build can fall short of one file but never loses an asset. Each reference is inlined where it stands, so a shared asset is carried once per use — the reason this is a flag and not the default.

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

**Charts are drawn at build time from data files, in theme tokens.**
A `Chart` zone value or a ```` ```chart ```` Markdown fence is turned into plain SVG by `charts.py` while the deck builds, so serve, the static build, the PDF export, editor thumbnails and `inkflow render` show the same chart and nothing runs in the browser. The data is a CSV/TSV/JSON file (or inline `data={...}` / a Markdown table), its path resolving against the file it is written in like any asset; it is inlined into the slide, so nothing is copied or versioned, and the watcher's rebuild on any project file is what redraws a chart when its data changes. `zones.build_slide_content` resolves a deck chart to a `ResolvedChart` (data read, or the error to draw in its place) and expands fence placeholders with the Markdown file's `AssetSource`; `content.py` swaps the zone shape for a nested `<svg>` with the zone's box and user units (provenance carried, so the editor moves and resizes it as the zone rect). `y_min`/`y_max` fix the value axis's ends (`_bounded`: the fixed end is the first/last tick, round ticks too close to it dropped) and `y2` puts columns on a second axis on the right (`_Series.axis`, with `y2_min`/`y2_max`; refused for stacked or horizontal bars); with any end fixed the marks are clipped to the plot (`<id>-clip`). Marks are painted with the palette tokens (`charts.PALETTE`, the chromatic part of `colors.SVG_TOKENS` in a fixed order) in `style` (never presentation attributes, where `var()` is invalid) and text with the text tokens, so charts follow the theme and colour mode. Every series is a `<g id="<zone>-series-<slug>">` holding its marks, value labels and legend entry (pie slices `-slice-`), which is what `animations=[...]` targets to reveal them one by one (`verify` draws a slide's charts to know those ids, and reports unreadable data). A fence chart is inline SVG inside a zone's HTML: `html_fragment_to_xml` restores the camelCase names lxml's HTML parser lowercases, and `_replace_with_foreignobject` attaches the foreignObject before its content because lxml otherwise drops the inline `<svg>`'s xmlns as "redundant" with the slide root's. In the editor a placed chart is a `zone-chart` rect plus a `Chart(...)` zones= entry plus `data/chart-N.csv`, written in one step by `insert-chart`; `chart-preview` renders the dialog's unsaved settings and grid with the same `render`, and `chart-save-data` writes the grid back in the file's own format, cells as typed.

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

**The visual editor writes the deck's own files; it has no document model of its own.**
`inkflow edit` (or `/edit` on any `serve`) is a second page on the same server. The server builds with `process_deck(editor=True)`, which stamps every element read from a source file with `data-ink="<source index>:<child path>"` — the child path counted on the tree *as parsed from disk*, before cleaning (`clean_inkscape_tree(before_clean=...)`), so `provenance.locate` finds the same node when an edit is written back. `SlideData.edit` carries the source list, the pruned empty zones and where each zone's content was written; the presenter copy drops it (`_without_edit`), the editor gets it inside `build_model`'s model (`editor-model` message, sent after each `update` to clients that said `hello` as editors).
The browser never writes a file: it sends `{"type":"edit-op", "action": ...}` and `editor.session.EditorSession` turns that into new bytes for SVGs (lxml, only touched nodes change), Markdown (`zones.zone_spans` mirrors the parser to replace one zone's section) or `deck.py` (libcst via `deckedit`, values generated by `codegen` from the real DSL object so the dataclass validates them). Each request is one `History` step of whole-file before/after snapshots; undo refuses if a file changed outside the editor. So an agent changes the slide list through the session too: `inkflow slide` (`cli/slides.py` → `editor/remote.py`) sends the same `edit-op` to the server serving the deck (found with `instances.serving`), with `agent` (the step becomes "Agent: …") and `deckHash` (the deck.py it numbered slides against; refused unless that is the build), and polls `{"type":"build-status"}` (`deckHash`/`failedHash` of the last build) until the build caught up, before and after; the server then tells every editor `{"type":"agent-edit", label, step, undoLabel…}`, shown as a toast whose Undo sends `undo` with that `step` (refused once another step followed). With no server it applies the request with a fresh `EditorSession`. Undo/Redo buttons are titled with `undoLabel`/`redoLabel` (in each result and in `editor-model`'s `history`). An SVG request carries the file hash the client rendered from and is refused when stale; results return new hashes so quick consecutive edits chain. Writes go through the normal watcher → rebuild → push, which is also how the editor, Inkscape and an agent see each other's changes. `load_deck` compiles deck.py from source each time (the bytecode cache's whole-second mtime check loads stale code after a same-size edit such as a slide reorder).
The client previews a drag by setting attributes on the live DOM and sends the same plan (`geom.ts`: x/y/width/height for rects/images/rect-backed zones, cx/cy for ellipses, endpoints for lines, a merged leading translate for everything else, a matrix for resize/rotate of transformed elements). Objects from layouts/overlays and slides drawn straight from a shared layout are not selectable outside "Edit layout"; drawing on such a slide first gives it its own `slides/<id>.svg` built on that layout (never named like a layout, which would shadow it). `.inkflow/` (editor context, renders) ignores itself in git and is excluded from the watcher.
Everything the editor adds is plain deck source, so Inkscape, an agent and the presenter need no editor knowledge: a **text box** or a **video placed anywhere** is a `zone-text`/`zone-video` rect in the slide's own SVG filled through the slide's Markdown or `zones={...}` (deleting or duplicating such a rect takes its content along — `_svg` with `zoneSlide`); **rich text** is edited as the zone's rendered HTML and written back by `richtext.ts`, only when serializing the zone as rendered gives back its source (`sameMarkdown`), otherwise the Markdown pane opens; a **crop** is a nested `<svg x y width height viewBox>` frame around the `<image>` (the canvas measures it by its viewport, not getBBox); a **connector** (line/arrow; four tools: line, arrow, elbow, curve) is a `<path>` with `inkflow:connector="straight|elbow|curved"` and `inkflow:connect-start/-end="<id>:<site>"`, a site being a side (`top`, its middle) or `side@fraction` (`top@0.25`, clockwise from the side's first corner) — a shape's `inkflow:sites="N"` only decides how many points per side are *offered* (copied onto a zone's foreignObject by `content.py`), a named site is always computable, so fewer points later never detaches an arrow; an elbow's adjustable segment is `inkflow:bend="x:640"` (axis and slide-unit coordinate, ignored when the route's axis changes) with a drag handle; `connectors.ts` holds the pure site/route maths, `canvas.withConnectors` re-routes attached connectors inside every `sendSvgOps` (so drags, nudges and geometry fields all carry them in the same step), connector moves detach ends whose shapes do not move along (`movingTogether`), and an id rename rewrites `connect-*` references (`svgops._rename_connections`); a shape moved elsewhere leaves its arrow until "Re-route all" (or `inkflow shape reroute`, the Python port in editor/scene.py; `verify` warns about such arrows); a **link** is an `<a href>` wrapper that provenance treats as transparent (`is_link_wrapper`: the object inside stays the selectable one), and `pipeline.resolve_links` turns `slide:<id>` into `data-inkflow-slide` and gives web links `target="_blank"`; **slide text goes to Markdown**: a zone write on a slide with no `.md` (`_slide_markdown`) creates `slides/<slide-id>.md` named after the slide's *current* id (ids are inferred from the md stem, so `slide:` links survive; `id=` is written when the name is taken), sets `md=`, and moves the slide's plain-string `zones={...}` into it in the same step; `TextBox` and `md=Inline` stay in deck.py (the `to-markdown` action converts those on request); **text in a shape** is that shape renamed to a `zone-text*` zone plus `inkflow:show-shape="true"` (centred both ways via `--inkflow-align/-valign` in its style unless already set), which makes `content.zone_shape_css` paint the shape's own fill/stroke/rx as the text box's CSS (without it a zone shape stays an unpainted placeholder; `--inkflow-padding/-align/-valign` in its style carry over either way); a **formula** in rich text is a chip around the rendered `<math data-latex>` (`markdown._math_to_mathml` stamps the source), edited through the `math` session action, which renders exactly as the build does; **lock** is `inkflow:locked` (survives the pre-commit cleaner, unlike `sodipodi:insensitive`), **hide** is `display:none`; **theme** edits are one marked block in `styles.css`. A rebuild pushes the deck stylesheet and colour mode on `update` only when they changed (`styles`/`mode` keys, `shared/deck-styles.ts`), so theme edits restyle open pages without a reload. **Open ▾** (`openwith.ts`) asks the session for `open-apps` (`edit.open_choices`: the configured `INKFLOW_EDIT_CMD*` command, installed programs for the file's kind, the system opener) and launches with `open-file`, which only takes project files of a known kind and only from a loopback peer (`server._is_loopback` sets `_local` on every edit-op, overwriting the client's); for an SVG it first brings the Inkscape preview (layout layers + theme CSS, what `sync` writes) up to date as one History step, and `_new_slide_file` writes it on creation, since Inkscape draws only what is in the file. **Ctrl+drag** copies: `canvas.ts` previews by moving the originals with stand-in clones (`showGhosts`) left in place, and drops `duplicate` ops whose `set`/`kids` carry the move's attributes for the copy (resolved before any op runs); `apply_ops` re-attaches connectors copied together with their shapes. **draw.io diagrams**: `drawio-load` (source + `INKFLOW_DRAWIO_URL`, default embed.diagrams.net) / `drawio-save` (normalized SVG; no path = new `diagrams/diagram-N.drawio.svg`; `image` = the slide's picture keeps its width and takes the new height, same History step); without internet (`navigator.onLine` false, or no `configure`/`init` from the frame within 15 s) `drawio.ts` offers draw.io desktop: `drawio-new` writes `drawio.blank()` (an empty source behind a placeholder picture), the picture is placed, and `open-file` launches the app (`edit` kind DIAGRAM; Open ▾ never writes Inkscape preview layers into a `.drawio.svg`). "Show as" in a diagram's panel sets `inkflow:drawio` (plus `ensure-id`); a drawn-in diagram (`drawio.drawnDiagram`) selects, moves, resizes and rotates as its `<image>`, and `selectById` climbs from a shape to it. Its vertex cells (`data-cell-kind`, read from the source by `drawio.cells`) are connector targets too (`canvas.attachables`/`attachTargetAt`, sites on `drawioshapes.cellShape`, not the label); renaming the picture renames `<id>-*` connections and cues (`OpResult.renamed_prefixes`); a save through the editor re-routes the arrows into it in the same step (`coalesce`), and the slide panel counts arrows whose ends no longer meet their shapes (`canvas.isStale`). **Editing a diagram's shapes on the slide** (`inkflow:drawio-edit="shapes"`, "Edit shapes here"): editor builds stamp vertex cells `data-ink="<k>:#<cell>"` (and layers, so `enterGroup` survives re-renders) into a source of role `diagram`, plus `data-cell-geometry` (the page box the drawing shows); double-click enters the layer, `canvas.diagramPlans` turns plans into `cell-geometry` (the shape's measured page box: drawn box − `drawioshapes.pageOffset`, the median of drawn − geometry), `cell-delete`; the panel sends `cell-label`/`cell-style`; the session routes a `.drawio.svg` `svg` action to `editor/drawioedit.apply_cell_ops`, which edits the mxGraphModel and patches the picture meanwhile (moved shapes under a transform, `data-drawn-geometry`). `hooks.diagramEdited` → `drawio.diagramEdited` debounces a redraw: a hidden, `inert` draw.io frame loads the source and exports xmlsvg, `alignedBox` measures how the page moved (median per shape, rendered off-screen) so unmoved shapes keep their place, and `drawio-save` (`box`, `expect` = the hash `drawio-load` returned, `coalesce` = the edit's step) writes both in the edit's undo step. **Quitting**: the `quit` action (local only, "Quit Inkflow") sets `_editor["shutdown"]`; `serve(quit_when_idle=…)` adds `_quit_when_idle`, which stops the server once `ws_clients` has been empty that long. **Start mode**: `serve(None)` / `EditorSession(None)` (`has_deck=False`) serves only the editor's start page at any path (`decks.showStart`), allowing just the project actions; opening a deck switches the server as usual and the page goes to `/edit`. An empty zone's **+** label writes the zone's name as its text and opens it for rich editing with that text selected (`afterRender.placeholder`); finishing with it untouched or empty, or Escape, undoes that write. **Decks and git**: `serve()` loops over `_serve_deck`, which returns the deck.py the editor asked for (`EditorSession.switch_to`, set by `open-deck`/`new-deck` and signalled through `_editor["switch"]`) and starts again on the same ports; an editor page reloads when a model for a different `deckPath` arrives. Git operations, folder browsing and deck creation go through the same session (`git`, `browse`, `new-deck`, …); push/pull, `git init` and anything touching paths outside the deck are refused unless the request is local, and operations that rewrite files reset the editor's History (the result carries `historyCleared`; `git.ts` warns once per session before the first one). **Worktrees** (`{"action":"worktree","op":"list"|"add"|"remove"|"merge"}`, editor/worktrees.py; add/remove/merge local only) let an agent work on branch `deck/<name>` in `.inkflow/worktrees/<name>` while the author edits on: list → `{worktrees:[{name,path,branch,head,deck,dirty,ahead,behind,main}]}`, add → `{worktree, note?}`, merge → `{message, files, historyCleared}` (only when files changed), remove (`force`) → `{message}`; every result also carries the fresh `worktrees`. The agent's own server for its worktree deck is a second server on the next free ports. Exports run through `Exporters` the CLI hands to `serve()` (export.py imports server.py, so the session cannot import it) and are downloadable at `/_export/<token>/…`, which serves only what the session exported.

**The compare view builds both decks in one server (`editor/comparehub.py`).**
A side is a `comparesrc.Source`: `{"kind":"live"}`, `{"kind":"commit","rev"}` (any rev git resolves; refused if it starts with `-`), `{"kind":"path","deck"}` (a deck.py or its folder; outside the project only for a local request), `{"kind":"branch","name"}` (its worktree when one has it checked out, the live deck if that is this one, else its commit; a remote request falls back to the commit), plus `{"kind":"spec","spec"}` for `?compare=` (`inkflow edit --compare REV|PATH`) and the CLI, resolved by `spec_source`. A commit is materialized into `.inkflow/cache/compare/<sha>/` (ignored, unwatched) with a throwaway `GIT_INDEX_FILE`: `read-tree` + `checkout-index` of the deck's folder only, so filters run (LFS smudged; `filter.lfs.required=false`) and nothing is registered as a worktree; a pointer left over is replaced by the working copy's file when its sha256 is the pointer's oid (`missing` lists the rest); `prune` keeps the 6 most recent plus those in use. Other decks load as their own module (`load_deck(path, module)`, `build_model(deck_module=…)`), never `_inkflow_deck`, so the served deck's custom classes stay the session's; comparesrc/comparehub cannot import server.py (a cycle), so the loader is handed in (`CompareHub(deck, load_deck)`). The live side is the server's own build (`side_build_from` after every `rebuild`), never rebuilt by the hub. Protocol: `{"type":"compare-open","view":n,"left":src,"right":src}` → `{"type":"compare-model","view":n,"left":side,"right":side,"deck":[…],"pairs":[pair_json…]}`, where a side carries `kind/label/branch/sha/live/deckPath/token/missing/error/source`, `css` (its `load_deck_styles` with `:root` aimed at `.cmp-root`, `@font-face` split off into `fonts` for the document; `shadow_css`) and `slides` (`display_svg`: no `data-ink*`, pictures at `/_cmp/<token>/<ref>?v=<mtime>`, plus plain-text `notes`); re-sent to every page comparing a side whenever it rebuilds (live: each rebuild; a path side: its own `awatch`, ignoring its `.inkflow/`/`build/`/`.git`; a commit: never). `{"type":"compare-close"}` (or disconnecting) drops sides nobody compares, their tokens and modules. `{"type":"compare-sources"}` → commits, branches and worktrees for the picker; failures answer `{"type":"compare-error","for","view","message"}`. `/_cmp/<token>/<ref>` resolves with that side's own `AssetRoots.locate` and the served-suffix list, so it reaches nothing outside that deck's roots. Pairing (`compare.pair_slides`): ids that name a slide whatever its place (explicit, or an inferred id no other slide shares), then the file it is written in (`key_file`: its Markdown, or its own unshared SVG), then identical normalized SVG+notes, then the remaining ids (`content-2` numbering), then what is left by order between pairs kept in order, only when built on the same layout or file (`_related`); rows follow the right deck, a slide only on the left before what was added in its place; `moved` = outside the longest in-order run. Normalization drops `data-ink*`/`data-cell-geometry`/`data-drawn-geometry`, `?v=` stamps, the root's `inkflow-slide-N` id and its `@scope`, and the slide number/total texts. A pair is `changed` when the normalized SVG, the notes text, the slide's settings (`_slide_settings`: hidden, layout, id, title, md, notes file, transition, animations, zones, overlays, style, font size; model JSON minus `custom`/`path`/chart columns) or its files (sources by role, md, notes, ink, chart data, pictures) differ. `element_changes` matches elements with an id by id, the rest as sequences under their nearest named ancestor (`difflib`), leaf units being SVG shapes and HTML blocks; boxes are approximate server-side (transforms, path points, a foreignObject's box for its HTML) and the page measures the element at the same child-index `path` in the shadow DOM instead when it finds it. The page draws each slide in a shadow root with the side's constructed stylesheet (both in the colour mode the editor's light/dark button shows), so neither deck's CSS reaches the other or the editor. "Take this slide" is the edit-op `compare-take` (`pair`, `left`, `right` must match the hub's current pair): the server pops any client `_take` and puts the hub's `take_request` there (`export_slides` of the other deck, `replace` = the live index or `after`, `inPlace` when every file can keep its path, its ink), and the session's `_compare_take` writes it as one History step (`transfer.plan_slide_replace` writes files at their own paths; else `plan_slide_paste`). "Merge branch" sends `{"action":"worktree","op":"merge","branch"}` (the worktrees session action) and shows its error; `document` event `inkflow:compare` (`{kind:"path",deck,label}`) opens the view on a deck. While the view is open, keys other than its own and Ctrl+Z/Y stop in its capture listener, and the toolbar's tools are disabled (`body.compare-mode`).

## Server

- HTTP on port 7777 (asyncio streams, custom handler); assets are streamed in
  chunks with byte-range support (`_send_file`, 206/416), which Safari needs for video.
  Served slides stamp each local asset reference with its file's mtime
  (`_versioned`: `assets/x.png?v=…`; `_resolve_asset` drops the query), because a
  page keeps pictures it loaded by URL: a diagram or picture changed on disk is
  then a changed slide at a new URL. build/export never stamp; the editor drops
  the stamp before writing anything back (`pathtext.assetRef`, `cleanForPaste`)
- `/_cmp/<token>/<ref>`: a compared deck's picture (comparehub.py), 404 when the
  token is unknown or the ref leaves that deck's roots
- WebSocket on port 7778 (websockets 16.0 — uses `websockets.asyncio.server.serve`, not the legacy `websockets.serve`)
- Ports: without `--port`/`--ws-port`, `pick_ports` takes the first free pair from
  7777 up (`_port_free` tries every address the host names, ::1 too) and the CLI
  says so when 7777 was taken; `serve(auto_ports=True)` picks again if a port is
  lost to a server starting at the same moment (`_PortBusy`). One server per deck
  still holds: `instances.serving` finds the deck's server first
- File watcher: `watchfiles.awatch` (async generator); `_WatchFilter(root)` skips
  `.inkflow/` and `build/` *below the deck's folder* only, so a deck living in a
  worktree under `.inkflow/worktrees/` is watched normally
- Both run inside an `asyncio.TaskGroup`

## Animation pipeline

`pipeline.py` processes each slide as a single lxml tree: parsed once via the hardened parser in `svgio.py`, threaded through the pipeline, serialized once at the end. `SlideSvg` wraps the tree and each pipeline step is a method that mutates it in place (like `list.sort()`), delegating the DOM work to `content.py`/`svg.py` functions that take and return the root element. Key steps:
1. `clean_inkscape_tree(src)` — parse with the hardened lxml parser, remove elements/attrs in `http://www.inkscape.org/namespaces/inkscape` and `http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd`, call `etree.cleanup_namespaces()`. (`clean_inkscape_svg` wraps this and serializes to a pretty-printed string for the CLI/pre-commit hook.)
2. `annotate_svg(root, cues)` — `cues` are `(Cue, step)` pairs already resolved to concrete step numbers (see below). Finds elements by plain id (no leading `#`); `Animation` cues are **grouped per target element** (an element may carry several) and written as one `data-cues` JSON array (sorted by step) via `_cue_entry` — each entry is `{step, kind, name, opts, vars}`, where `opts` are the base `Animation` fields as element.animate() options (`duration`/`delay`/`easing`/`iterations`) and `vars` are ready strings (slide direction+distance → `from-x`/`from-y`, `scale`/`color`/custom fields) substituted for `var(--anim-<key>)` in the keyframes. Enter-first elements also get an `anim-pending` class (initial-hidden guard); two same-kind cues with no opposing kind between them warn. A `PlayVideo` cue still sets `data-play-on-step` on the target zone's `<video>`.

**Steps are inferred from triggers, never written by hand.** Every `Animation`/`PlayVideo` cue carries a `Trigger` (`ON_CLICK`, `WITH_PREVIOUS`, or a `Trigger.at(n)` pin). `steps.py`'s `StepResolver` walks a cue sequence in order and assigns concrete step numbers — `pipeline.resolve_steps` for the deck's `animations=[...]` list, the reveal counter in `zones.py` for markdown `::step::`/`::steps::` reveals. A slide's markdown reveals number first (the `.md` file, then `zones={...}` Markdown strings, which go through the same `_split_steps`/`chunks_to_html`), then the `animations=[...]` list continues the count, so all form one timeline.

**Autoplay vs. a `PlayVideo` cue.** If a `Video` sets `autoplay=True` and is also targeted by a `PlayVideo` cue, the cue wins: `process_slide` suppresses `autoplay` before content injection (so `Muted.AUTO` resolves to unmuted) and logs a warning.

The cue's `name` is the kebab-cased type name (`Slugged.slug()`, the mixin in `manifest.py`, shared by `Animation`/`Transition`): `FadeIn → fade-in`, driving `@keyframes anim-fade-in`. There is no per-type registry and no `--anim-*` style — timing/visual params travel in `data-cues` (the old `_anim_style`/`_anim_classes` are gone). Each animated element does still carry an `anim-<slug>` class per cue type, but only as a **styling hook** (the engine drives animation from `data-cues`, not the class): built-in CSS uses it solely for constant styles a keyframe cannot hold at the right cascade origin — `.anim-scale-in`/`.anim-scale-out` set `transform-box: fill-box` there so the morph transition's inline `view-box` pin can beat it by ordinary cascade instead of `!important`. Custom animations author a `@keyframes anim-<slug>` (no JS) and may hook their own static styles on `.anim-<slug>`; the engine reads the keyframes and substitutes the cue's `vars`. All built-in animation/transition defaults are concrete Python dataclass field defaults — no CSS `var(--anim-x, default)` fallback. `@keyframes` in `src/css/shared/animations.css` are global (in the presenter bundle); custom `@keyframes` from `Deck(style=...)` are lifted out of the per-slide `@scope` wrapper by `_scope_slide_styles`/`_extract_keyframes` so they stay globally discoverable.

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
libcst>=1.9          deck.py edits from the visual editor (formatting-preserving)
```
