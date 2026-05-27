# Roadmap

Things that would need to exist before this is a tool someone would actually give a talk with.

Items are roughly ordered by how much they matter. The first two sections are load-bearing — without them the tool is a toy. Everything after is about closing the gap to a real presenter experience. The final section is honest about what is out of scope or architecturally not possible.

---

## Decided: design questions

**SVG editor agnosticism**  
The tool has no hard dependency on Inkscape at runtime. The pipeline only reads and writes standard SVG; it never spawns Inkscape as a subprocess. Any vector editor that exports well-formed SVG — Inkscape, Figma, Affinity Designer, Sketch, or hand-coded files — works as an authoring tool. `clean_svg()` strips Inkscape/Sodipodi editor metadata if present, and is a no-op on files from other tools.

The one Inkscape-specific feature is `inject-layout`: it writes `inkscape:groupmode="layer"` and `sodipodi:insensitive` attributes so Inkscape's GUI renders the injected preview layers correctly. These attributes are harmless in any other tool. A future refinement is to make the Inkscape layer attributes opt-in and write only `data-inkflow-*` attributes by default.

**One file per slide vs multi-page SVG**  
Staying with one file per slide. Inkscape's multi-page SVG format uses `inkscape:page` elements that are not standard SVG; parsing them would tightly couple the tool to Inkscape's internal implementation. One-file-per-slide produces cleaner git diffs and maps to the standard SVG model. Worth revisiting only if Inkscape formalises the format.

**Markdown slide types: foreignObject**  
An existing Markdown library (`markdown-it-py`) converts content to HTML in one call — no custom Markdown parsing. The HTML is injected into a `<foreignObject>` at the placeholder zone's geometry. Typography and color come from the CSS cascade (theme `styles.css` + project `styles.css`) injected into the HTML `<head>`, which cascades into all `<foreignObject>` content. The SVG text generation approach is not pursued: it cannot support tables, images, or nested lists and hits a ceiling quickly.

**Zone naming convention**  
Content placeholder zones in layout SVGs are `<rect>` elements with `id="zone-{name}"`. The `zone-` prefix is the single naming rule authors need to learn. Zone rects must carry explicit `x`, `y`, `width`, `height` attributes.

Standard zone names with reserved pipeline behaviour:
- `zone-title` — receives the leading `# H1` auto-extracted from a markdown file
- `zone-subtitle` — receives the `## H2` immediately following the title, before any body content
- `zone-content` — default content zone; receives everything not routed elsewhere
- `zone-slide-number` — a `<text>` element; text content replaced with the current slide number at pipeline time
- `zone-slide-total` — a `<text>` element; text content replaced with the total slide count

Unreferenced zone rects — zones present in a layout but not filled by the slide — are silently removed from the output.

**Markdown file format**  
`MarkdownSlide` reads a single `.md` file per slide. Custom syntax is limited to two block markers using the same `::name::` form:

- `::zone-name::` — routes all content from this point to the named zone until the next marker
- `::step::` — inserts an animation step boundary within the current zone; the step counter continues from wherever the slide's SVG animations left off

Auto-extraction applies when the file contains no explicit `::` markers:
1. A leading `# H1` is extracted into `zone-title`, if the layout has that zone
2. A `## H2` immediately following (before any body content) is extracted into `zone-subtitle`
3. Everything else goes to `zone-content`

Explicit markers always override auto-extraction. Single-zone layouts need no markers at all.

**Layout path resolution**  
Prefix syntaxes bypass the search entirely:
- `local:foo` — `{project_root}/layouts/foo.svg`, error if not found
- `theme:foo` — `{theme_dir}/layouts/foo.svg`, error if not found or no theme set
- `builtin:foo` — inkflow built-in layouts
- `./foo`, `../foo` — relative to the current SVG file's location (used by theme-internal chains)
- `/absolute/path` — literal filesystem path

Bare single-part names (no prefix, no `/`) are resolved by a three-level search in order: project `layouts/` → active theme `layouts/` → inkflow built-in `layouts/`. First match wins.

This resolution applies uniformly wherever a layout name appears: the first argument of `MarkdownSlide`, the `inkflow:parent` attribute on any SVG, and `inkflow new`.

---

## Open design questions

**Layout overrides**  
Some layouts visually override the base layout frame — a section divider or full-bleed title slide typically drops the footer and page number. The mechanism for opting out (per-layout or per-slide) is not yet decided. Candidates: a flag attribute on the layout SVG root (`inkflow:no-layout="true"`), or a `layout_zones` exclusion list in `deck.py`. This affects both inject-layout (which layers to inject) and the pipeline (which elements to include).

---

## Layout inheritance

The layout system uses a general parent/child model. Each SVG file can declare its parent via an `inkflow:parent` attribute on the root `<svg>` element. This creates an arbitrary-depth chain. A typical deck has three levels:

```
slides/05-bullets.svg
  ↑ inkflow:parent
layouts/bullets.svg           ← layout: content zone positions
  ↑ inkflow:parent
theme/numbered-main.svg       ← adds zone-slide-number / zone-slide-total
  ↑ inkflow:parent
theme/main.svg                ← base: background, brand elements (no parent — chain terminates)
```

The `inkflow:parent` attribute is set by tooling (`inkflow new`, `inject-layout`), not by hand.

**`inject-layout` command**  
`inkflow inject-layout` resolves the parent chain for each file and injects each ancestor as a separate locked Inkscape layer below the slide's own content, providing a spatial reference during authoring. The command is idempotent: it compares `inkflow:layout-hash` on existing layers against current file content and only rewrites stale entries. The pipeline strips all layout layers before serving; they never appear in the browser.

`inkflow inject-layout --check` reports stale files without rewriting. `inkflow new <layout> <path>` calls `inject-layout` automatically after creating the file.

---

## Pipeline completeness

**Font embedding**  
SVGs reference fonts by name. On the authoring machine this works; on any other machine it may not. Use fonttools to resolve fonts via fontconfig, base64-encode them, and inline `@font-face` declarations inside a `<defs>` block. Makes each output SVG self-contained without converting text to paths.

**PDF export**  
Distinct from static HTML export. PDF is how you share slides with conference organizers, submit to proceedings, and post a permanent copy online. The cleanest path: build the static HTML, then print it to PDF via headless Chromium (`--print-to-pdf`). Each slide needs to map to exactly one PDF page, which requires a print stylesheet that shows one slide at a time.

**Static HTML export**  
`inkflow build deck.py` produces a single self-contained HTML file — all slides inlined, fonts embedded, no server required. How you present from an unfamiliar machine and the intermediate step before PDF export.

---

## Presenter experience

**Slide picker**  
`g` currently enters a numeric goto buffer (`g: 12_`, Enter jumps, Escape cancels). The next step is replacing this with a full picker overlay: a modal where typing digits narrows by slide number and Enter or click jumps. Requires an optional `title` field on `Slide` in `deck.py`; the manifest field is cleaner than auto-extracting from SVG.

**Hidden / draft slides**  
`Slide("...", visible=False)` keeps a slide in `deck.py` and its SVG on disk but excludes it from the presentation. Essential for working decks where you trim slides depending on audience or time without deleting anything.

**Presenter view**  
A second window (or `/presenter` URL) showing the current slide, the next slide preview, step counter, and a running clock. The two windows stay in sync via the same WebSocket connection. Essential for any talk longer than ten minutes.

**Remote control**  
A `/remote` URL serving a minimal forward/back interface designed for a phone browser. Sends the same advance/retreat messages the keyboard sends. The WebSocket architecture makes this nearly free to implement.

**Speaker notes**  
A `notes` field on `Slide` that appears in the presenter view but not the main display. Plain string in `deck.py`; rendered as markdown in the presenter window.

**Drawing and annotation mode**  
During Q&A, freehand drawing on the current slide is more useful than a laser pointer. A toggle (e.g. D key) that overlays a canvas element and lets you draw with the mouse or stylus. Drawings are ephemeral — they don't persist between slides.

**Laser pointer**  
A coloured dot that follows the mouse while a modifier key is held.

---

## Content features

**Per-step code line highlighting**  
In technical presentations, stepping through a code block with specific lines highlighted per keypress is one of the most-used Slidev features. A `CodeSlide` template (or a `Highlight` animation that targets line ranges) that dims non-highlighted lines and brightens the relevant ones on each step.

**Math / LaTeX**  
Enable the `dollarmath` plugin in `markdown-it-py` (emits `<span class="math-inline">` / `<div class="math-block">`), and load KaTeX in the presenter to render those spans client-side. Since `<foreignObject>` content is real HTML in the browser, KaTeX's auto-render works there without modification.

**Section dividers and table of contents**  
A `SectionSlide("title")` type that marks a section boundary. The pipeline can auto-generate a TOC slide from all section boundaries, and section titles can appear in the presenter status bar.

---

## Authoring experience

**`inkflow set-parent <file> <parent>` command**  
Updates `inkflow:parent` on an existing slide SVG and re-runs `inject-layout` on that file. Use when changing a slide's layout after initial creation.

**Element ID validation**  
When `deck.py` references `#headline` but the SVG has no matching element, this should be a hard build error: name the slide file and the missing ID, stop the build. Currently a silent skip.

**Watch-only mode**  
`inkflow watch deck.py` rebuilds on change but doesn't open a browser or run a server. Useful for catching `deck.py` errors immediately during authoring.

**Custom slide dimensions**  
Currently hardcoded 1920×1080. Should be a per-deck setting on `Deck(width=..., height=...)`, used by the pipeline to set the SVG viewport and by the presenter to size the stage correctly.

**Inkscape layer conventions for Morph**  
For within-slide morphing, the two element states need to live somewhere in the SVG. A layer naming convention needs to be documented with a worked example.

---

## Theme

**Implement the default theme**  
The current built-in theme (`src/inkflow/theme/`) is a visual placeholder — bare zone rects on a flat background with no typography, brand, or decoration. It needs to become a real, polished default that demonstrates what inkflow can look like out of the box:
- A proper background with a coherent color palette using the `--inkflow-*` CSS variables
- Styled layout SVGs using the semantic CSS classes (`theme-accent`, `theme-surface`, etc.)
- Readable typography for headings, body text, and code blocks defined in `styles.css`
- Light and dark variants that both look intentional, not just inverted
- The showcase deck should serve as an example of a well-designed presentation, not just a test harness for every layout type

**Named theme support**  
`_resolve_theme_dir` currently raises an error for bare theme names like `Deck(theme="catppuccin-mocha")`. Explicit path themes (`Deck(theme="./my-theme")`) work today. Named resolution requires a discovery mechanism — most naturally, a pip package naming convention (`inkflow-theme-{name}`).

**Pip-installable themes**  
Auto-discovery via a naming convention would allow `Deck(theme="catppuccin-mocha")` to just work after `pip install inkflow-theme-catppuccin-mocha`, with no `deck.py` path configuration.

**Theme eject**  
`inkflow eject-theme` copies a theme into the project directory and updates `deck.py` to point at the local copy. Useful for heavy customisation without forking the theme package.

---

## Documentation

The minimum bar is a small set of markdown files in the repository — a `README.md` that covers installation and a five-minute example, and a `docs/` folder with focused pages on the layout system, zone substitutions, `MarkdownSlide`, animations, and transitions.

The preferred target is a static site on GitHub Pages, auto-built on every push to `main`. The right tool is **MkDocs with the Material theme** (zero Node.js dependency, fits naturally in a Python project) or **VitePress** (what Slidev itself uses, requires Node.js but produces a better look with interactive demos).

Minimum page set:
- **Getting started** — installation, `inkflow serve example/deck.py`, first custom slide
- **Layout system** — `inkflow:parent`, zone rects, `inject-layout`, layout chains, path resolution
- **MarkdownSlide** — `::zone::` / `::step::` syntax, auto-extraction, `image=` / `video=` kwargs
- **Animations** — `FadeIn`, `FadeOut`, `Bounce`, step model, `steps=True`
- **Transitions** — Cut, Crossfade, Morph; per-slide and deck-level
- **`deck.py` reference** — all `Deck`, `Slide`, `MarkdownSlide` fields in one place
- **Themes** — directory structure, `styles.css` cascade, semantic CSS classes, `Deck(theme=...)`

---

## Reliability and packaging

**Port conflict handling**  
If 7777 or 7778 are already in use the server crashes with an OS error. Should auto-detect a free port or give a useful message.

**CLI polish**  
`--no-browser` flag to suppress auto-opening a tab. `--host` for presenting from a remote machine over SSH forwarding. `--version`. Better `--help` output.

**Packaging**  
A PyPI release so `uvx inkflow serve deck.py` works without a checkout. Possibly a Nix flake. Right now you need to clone the repo and `uv sync`.

---

## Nice to have

- **More animation types** — `Scale`, `Rotate`, `Draw` (stroke-dashoffset path drawing), `Highlight` (brief colour pulse)
- **Morph for paths and groups** — the current morph interpolates geometry attributes for `<rect>`, `<circle>`, and `<ellipse>`; `<path>`, `<polygon>`, `<g>`, and `<text>` fall back to an instant cut
- **Auto-advance** — timed slides for kiosk or lightning-talk use
- **Slide overview** — press Escape for a thumbnail grid, click to jump
- **Hyperlinks** — SVG `<a>` elements open in a new tab during presentation
- **Within-slide Morph** — an element changes shape as part of a step sequence on a single slide, distinct from the cross-slide morph
- **Configurable keybindings** — a `keybindings` dict on `Deck` that overrides the defaults, injected into the presenter as JSON

---

## Out of scope and hard limits

**Auto-reflow and bullet lists for Inkscape-authored text**  
Inkscape is a drawing tool that supports text, not a text layout tool. It has no native bullet list feature — you place bullet characters manually and indent by hand. Inkscape 1.2 added SVG 2.0 `shape-inside` text wrapping, but browser support is absent in Firefox and experimental in Chrome, so the pipeline cannot rely on it. In practice this is not a problem: if you need bullet lists or reflowing text, use a `TextBox` placeholder in Inkscape and write the content as Markdown in `deck.py`.

**PPTX export**  
SVG is arbitrary vector geometry; PPTX has its own shape/text model. Conversion fidelity for anything non-trivial would be poor. If you need a PPTX, use PowerPoint.

**WYSIWYG layout preview in Inkscape**  
A structural consequence of the pipeline-inlining approach: if the layout chain is resolved at build time, Inkscape cannot show it during authoring without `inject-layout`. The tool commits to this model — the injected layers are a spatial reference, not a live preview.

**Real-time collaboration**  
SVG files on disk and a local Python server are the wrong substrate. Git handles version history already.

**Interaction-triggered animations**  
Hover effects or click-a-specific-element-to-reveal. The step model advances globally on keypress; adding per-element interactivity would require a significant rethink of the animation model.

**Accessibility**  
SVG element order does not correspond to visual reading order, there is no semantic structure, and screen reader support for inline SVG is inconsistent. Out of scope until the core tool is stable.

**Export to video / screen recording**  
Automated recording as MP4 requires driving the presenter JS from outside the browser. The complexity is disproportionate; system screen recorders already exist.
