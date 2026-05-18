# Roadmap

Things that would need to exist before this is a tool someone would actually give a talk with.

Items are roughly ordered by how much they matter. The first two sections are load-bearing — without them the tool is a toy. Everything after is about closing the gap to a real presenter experience. The final section is honest about what is out of scope or architecturally not possible.

---

## Decided: design questions

**Slide master: pipeline inlining with inject-preview**  
Chosen approach: pipeline inlines master templates at build time. Inkscape shows only slide content during authoring (no master frame). WYSIWYG gap is addressed not by duplicating master content into each file, but by a CLI command (`inkflow inject-master`) that injects ancestors as locked, non-selectable Inkscape layers for spatial reference. These layers are stripped by the pipeline and never reach the browser. See the "Template inheritance" section below for the full model.

**One file per slide vs multi-page SVG**  
Staying with one file per slide. Inkscape's multi-page SVG format uses `inkscape:page` elements that are not standard SVG; parsing them would tightly couple the tool to Inkscape's internal implementation. One-file-per-slide produces cleaner git diffs and maps to the standard SVG model. Worth revisiting only if Inkscape formalises the format.

**Markdown slide types: foreignObject**  
Chosen approach: `foreignObject` injection. An existing Markdown library (`mistune` or `markdown-it-py`) converts content to HTML in one call — no custom Markdown parsing. The HTML is injected into a `<foreignObject>` at the placeholder zone's geometry. Typography and color come from a theme CSS file, not per-slide. The SVG text generation approach is not pursued: it cannot support tables, images, or nested lists and hits a ceiling quickly.

---

## Open design questions

**Parent path resolution**  
`inkflow:parent` paths in SVG files need a consistent resolution base. Options: relative to the SVG file's own location; relative to the project root (where `deck.py` lives); or theme-relative (resolved via the active theme). The choice affects portability — a theme-relative reference stays valid if the project is moved, a file-relative one does not. Decision pending.

**Optional zones in MarkdownSlide templates**  
Template SVGs declare placeholder zones as `<rect>` elements with zone IDs. `MarkdownSlide` maps kwargs to zone IDs. If a kwarg is omitted (e.g. no `subtitle=` for a title slide), the corresponding rect needs to be handled. Candidates: leave it visible (shows an empty box in the browser — bad), remove it from the SVG (pipeline deletes unreferenced zone rects), or mark it invisible. Remove-if-unreferenced is the likely answer but needs confirmation.

**Layout-level master overrides**  
Some layouts visually override the master frame — a section divider or full-bleed title slide typically drops the footer and page number. The mechanism for opting out (per-layout or per-slide) is not yet decided. Candidates: a flag attribute on the layout SVG root (`inkflow:no-master="true"`), Inkscape layers inside `main.svg` that layouts can selectively suppress, or a `master_zones` exclusion list in `deck.py`. This affects both inject-master (which layers to inject) and the pipeline (which elements to include).

---

## Template inheritance

The master system uses a general parent/child model rather than a fixed two-level hierarchy. Each SVG file can declare its parent via an `inkflow:parent` attribute on the root `<svg>` element:

```xml
<svg xmlns:inkflow="https://inkflow.dev/ns"
     inkflow:parent="themes/catppuccin-mocha/templates/bullets.svg"
     ...>
```

This creates an arbitrary-depth chain. A typical deck has three levels:

```
slides/05-bullets.svg
  ↑ inkflow:parent
themes/catppuccin-mocha/templates/bullets.svg   ← layout: content zone positions
  ↑ inkflow:parent
themes/catppuccin-mocha/main.svg                ← global master: background, logo, footer, slide number tokens
  (no parent — chain terminates)
```

The attribute is set by tooling (`inkflow new`, `inkflow set-parent`), not by hand. Authors do not type it into Inkscape's XML editor.

**`Deck.main` as implicit root**  
`Deck(main="themes/catppuccin-mocha/main.svg")` is the fallback parent for slides whose chain does not already reach a root. If a slide's SVG has no `inkflow:parent`, the pipeline prepends `Deck.main` to the chain. `Deck(main=None)` disables this and slides get no master frame — the current behaviour for the example deck.

**`inject-master` command**  
`inkflow inject-master <files>` resolves the parent chain for each file and injects each ancestor as a separate locked Inkscape layer below the slide's own content:

```xml
<g inkscape:groupmode="layer"
   inkscape:label="__inkflow: main__"
   sodipodi:insensitive="true"
   data-inkflow-src="themes/catppuccin-mocha/main.svg"
   data-inkflow-hash="a3f9c2">
  ...main.svg content...
</g>
<g inkscape:groupmode="layer"
   inkscape:label="__inkflow: bullets layout__"
   sodipodi:insensitive="true"
   data-inkflow-src="themes/catppuccin-mocha/templates/bullets.svg"
   data-inkflow-hash="b71e04">
  ...zone rects and guide elements...
</g>
<!-- slide's own editable content above -->
```

The command is idempotent: it compares each layer's `data-inkflow-hash` against the current file content and only rewrites stale layers. The pipeline strips all `__inkflow:*__` layers before processing; they never appear in the browser.

`inkflow new <template> <path>` calls `inject-master` automatically after creating the file.

**Theme directory structure**

```
themes/catppuccin-mocha/
  main.svg              ← global master (background, logo, footer, {{slide_number}}, {{slide_total}})
  content.css           ← typography for foreignObject zones (headings, bullets, code blocks)
  templates/
    title.svg           ← zones: #zone-title, #zone-subtitle
    bullets.svg         ← zones: #zone-title, #zone-content
    two-column.svg      ← zones: #zone-title, #zone-left, #zone-right
    code.svg            ← zones: #zone-title, #zone-code
    section.svg         ← zones: #zone-section-title
```

`Deck(theme="catppuccin-mocha")` resolves a built-in theme by name. `Deck(theme="./my-theme/")` accepts a path to a directory with the same structure. The initial built-in theme is Catppuccin Mocha.

---

## Pipeline completeness

**Template chain inlining**  
The pipeline resolves each slide's `inkflow:parent` chain (see "Template inheritance" above), strips any `__inkflow:*__` preview layers, then composes the ancestor SVGs below the slide content before annotation runs. The composition order is root-first (main.svg at the bottom, slide content at the top). `{{slide_number}}` and `{{slide_total}}` tokens in any `<text>` element across the chain are substituted at this stage. Hidden slides (`visible=False`) are excluded from both numbering and totals.

**Content substitutions (`TextBox`, `Image`, `Video`, `Math`)**  
The `content` list on `Slide` declares what replaces named placeholder elements in the SVG. The pipeline finds each element by ID, reads its bounding box, and substitutes the appropriate content at the same position and size:

- `TextBox("#id", src="file.md")` or `TextBox("#id", text="...")` — Markdown is converted to HTML by an existing library (no custom parsing), then injected into a `<foreignObject>`. The theme's `content.css` is inlined inside the `<foreignObject>` as a scoped `<style>` block so typography applies without bleeding into the surrounding SVG. `overflow: hidden` is set on the container so overflow is immediately visible in the live preview.
- `Image("#id", src="assets/photo.png")` — replaces the placeholder with an SVG `<image>` element at the rect's geometry.
- `Video("#id", src="assets/demo.mp4")` — replaces the placeholder with an HTML `<video>` element; dimensions come from the rect's geometry.
- `Math("#id", latex="...")` — renders LaTeX to SVG via KaTeX at build time and inlines the result.

An element can have both a substitution and an animation: the substitution determines what the element becomes, the animation determines how it appears.

Bounding box extraction requires that placeholders be `<rect>` elements (explicit `x`, `y`, `width`, `height` attributes). `<g>` groups and transformed elements are harder to measure without a render tree; document this constraint clearly.

**`MarkdownSlide`**  
A `MarkdownSlide` class for content-heavy slides authored without Inkscape. It is syntactic sugar: it expands in `manifest.py` to a `Slide` pointing at the resolved theme template, with auto-generated `TextBox` substitutions derived from its kwargs. The pipeline then processes it identically to any other slide.

```python
deck = Deck(theme="catppuccin-mocha")
deck.slides = [
    MarkdownSlide("title", title="My Talk", subtitle="A subtitle"),
    MarkdownSlide("bullets", title="Agenda", src="slides/02-agenda.md"),
    MarkdownSlide("code", title="Example", src="slides/03-example.py"),
    Slide("slides/04-diagram.svg", animations=[FadeIn("#arrow", step=1)]),
]
```

The first argument selects a template from the active theme. Kwargs map to zone IDs by name convention (`title=` → `#zone-title`, `src=` → the template's primary zone). `MarkdownSlide` does not add a new pipeline path — it is resolved before the pipeline runs.

**`inkflow new` command**  
`inkflow new <template> <path>` creates a new slide file from a theme template and wires it up for authoring:
1. Copies the template SVG to the target path.
2. Writes `inkflow:parent` pointing at the template.
3. Runs `inject-master` to inject ancestor layers for Inkscape preview.
4. Prints the `deck.py` snippet to add to the deck.

CLI-only for now. A companion `.md` file is created alongside for templates whose primary zone expects a `src=` argument.

**Font embedding**  
SVGs reference fonts by name. On the authoring machine this works; on any other machine it may not. Use fonttools to resolve fonts via fontconfig, base64-encode them, and inline `@font-face` declarations inside a `<defs>` block. Makes each output SVG self-contained without converting text to paths.

**PDF export**  
Distinct from static HTML export. PDF is how you share slides with conference organizers, submit to proceedings, and post a permanent copy online. The cleanest path: build the static HTML, then print it to PDF via headless Chromium (`--print-to-pdf`). Each slide needs to map to exactly one PDF page, which requires a print stylesheet that shows one slide at a time.

**Static HTML export**  
`inkflow build deck.py` produces a single self-contained HTML file — all slides inlined, fonts embedded, no server required. How you present from an unfamiliar machine and the intermediate step before PDF export.

---

## Presenter experience

**Slide picker**  
`g` currently enters a numeric goto buffer (`g: 12_`, Enter jumps, Escape cancels). The next step is replacing `enterGoto()` with a full picker overlay that opens immediately on `g`: a small modal where typing digits narrows by slide number and Enter or click jumps. Requires an optional `title` field on `Slide` in `deck.py` (`Slide("slides/01.svg", title="Introduction")`); the manifest field is cleaner than auto-extracting from SVG. Worth doing once `Slide` grows a title field for other reasons (presenter view, TOC) — at that point the popup comes nearly for free.

**Slide number tokens**  
Expose `{{slide_number}}` / `{{total_slides}}` tokens that can be placed as text elements in `main.svg` and substituted by the pipeline, so slide numbers appear on the slides themselves. Hidden slides (see below) should not count toward the total.

**Hidden / draft slides**  
`Slide("...", visible=False)` keeps a slide in `deck.py` and its SVG on disk but excludes it from the presentation. Essential for working decks where you trim slides depending on audience or time without deleting anything.

**Presenter view**  
A second window (or `/presenter` URL) showing the current slide, the next slide preview, step counter, and a running clock. The two windows stay in sync via the same WebSocket connection. Essential for any talk longer than ten minutes.

**Remote control**  
A `/remote` URL serving a minimal forward/back interface designed for a phone browser. Sends the same advance/retreat messages the keyboard sends. The WebSocket architecture makes this nearly free to implement and it solves the "I'm not at my laptop" problem in any conference room.

**Speaker notes**  
A `notes` field on `Slide` that appears in the presenter view but not the main display. Plain string in `deck.py`; rendered as markdown in the presenter window.

**Drawing and annotation mode**  
During Q&A, freehand drawing on the current slide is more useful than a laser pointer. A toggle (e.g. D key) that overlays a canvas element and lets you draw with the mouse or stylus. Drawings are ephemeral — they don't persist between slides. Slidev has this; PowerPoint with a pen does too.

**Laser pointer**  
A coloured dot that follows the mouse while a modifier key is held. Lower effort than drawing mode and useful for directing attention without marking the slide.

---

## Content features

**Per-step code line highlighting**  
In technical presentations, stepping through a code block with specific lines highlighted per keypress is one of the most-used Slidev features. A `CodeSlide` template (or a `Highlight` animation that targets line ranges) that dims non-highlighted lines and brightens the relevant ones on each step. This needs to work both for `MarkdownSlide("code", ...)` and for code blocks embedded inside custom SVGs via `<foreignObject>`.

**Math / LaTeX**  
KaTeX rendered at build time and inlined as SVG. Any scientific or engineering presentation needs this. For `MarkdownSlide`, math delimiters (`$...$`, `$$...$$`) should be supported automatically. For Inkscape slides, use `Math("#id", latex="...")` in `deck.py` — place a `<rect>` placeholder in Inkscape and the pipeline replaces it with the rendered SVG at the same position.

**Section dividers and table of contents**  
A `SectionSlide("title")` type that marks a section boundary. The pipeline can auto-generate a TOC slide from all section boundaries, and section titles can appear in the presenter status bar so you know where you are in the talk structure.

---

## Authoring experience

**`inkflow inject-master` command**  
Resolves the `inkflow:parent` chain for each target file and injects ancestor SVGs as locked Inkscape layers (see "Template inheritance"). Idempotent: compares `data-inkflow-hash` on existing layers against current file content and only rewrites stale entries. Run after editing `main.svg` or any template to refresh Inkscape preview layers across the deck. `inkflow inject-master --check` reports which files have stale layers without rewriting.

**`inkflow set-parent <file> <parent-path>` command**  
Updates `inkflow:parent` on an existing slide SVG and re-runs `inject-master` on that file. Use when changing a slide's layout after initial creation.

**Element ID validation**  
When `deck.py` references `#headline` but the SVG has no matching element, the pipeline prints a warning and silently skips it. This should be a hard build error: name the slide file and the missing ID, stop the build.

**Error display in the browser**  
If `deck.py` has a syntax error or references a missing SVG, the current slide in the browser should be replaced with the error message rather than silently keeping the stale version. The watcher already catches exceptions; they need to be forwarded to the presenter.

**Watch-only mode**  
`inkflow watch deck.py` rebuilds on change but doesn't open a browser or run a server. Useful for catching `deck.py` errors immediately during authoring without needing a browser open.

**Custom slide dimensions**  
Currently hardcoded 1920×1080. Should be a per-deck setting on `Deck(width=..., height=...)`, used by the pipeline to set the SVG viewport and by the presenter to size the stage correctly. 4:3, ultrawide, and A0 poster dimensions are all real use cases.

**Inkscape layer conventions for Morph**  
For within-slide morphing, the two element states need to live somewhere in the SVG that the pipeline can find. A layer naming convention needs to be documented with a worked example. Currently there is nothing telling an author how to structure their file for any Inkflow-specific feature.

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
- **Morph for paths and groups** — the current morph interpolates geometry attributes for `<rect>`, `<circle>`, and `<ellipse>`; `<path>`, `<polygon>`, `<g>`, and `<text>` fall back to an instant cut. Path morphing requires interpolating the `d` attribute (same command count and structure between slides).
- **Auto-advance** — timed slides for kiosk or lightning-talk use
- **Slide overview** — press Escape for a thumbnail grid, click to jump
- **Hyperlinks** — SVG `<a>` elements open in a new tab during presentation
- **Within-slide Morph** — an element changes shape as part of a step sequence on a single slide, distinct from the cross-slide morph that already exists
- **Configurable keybindings** — a `keybindings` dict on `Deck` that overrides the defaults, injected into the presenter as JSON. The keydown handler becomes a lookup table; the current defaults become the fallback. Low effort once the presenter JS is refactored for it; not needed until someone has a concrete conflict with the defaults.

---

## The content substitution pattern

Before the limits section, it is worth naming a general pattern that resolves several apparent constraints, and describing how it should be designed.

The animation system already establishes the right model: `Fade("#headline", step=1)` says "find this element in the SVG by ID and do something to it." The SVG contains only geometry and IDs; `deck.py` contains all semantics. Content substitutions should follow exactly the same pattern rather than encoding semantics in Inkscape element IDs or `data-*` attributes (which would require authors to type structured strings into Inkscape's XML editor — the wrong tool for that job).

```python
Slide("slides/03-demo.svg",
    animations=[
        Fade("#title", step=1),
    ],
    content=[
        Video("#demo-area",  src="assets/demo.mp4"),
        TextBox("#bullets",  src="slides/03-content.md"),
        Math("#formula",     latex=r"\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}"),
    ],
)
```

In Inkscape the author places a plain `<rect>` where the content should go and gives it a meaningful ID. The pipeline reads the rect's `x`, `y`, `width`, `height` and replaces it with the real content at the same geometry — a `<foreignObject>` with flowing HTML for text, a `<video>` element for video, rendered KaTeX SVG for math. The Inkscape view shows spatial placeholders. The browser view shows content. For the authoring decisions that matter in Inkscape — where does this go, how large is it, how does it relate to the rest of the slide — the placeholder is sufficient.

`content` substitutions are **build-time** (the pipeline replaces elements before the slide is served). `animations` are **display-time** (the presenter JS toggles CSS classes). The distinction is clean and composable: an element can have both a substitution (what it becomes) and an animation (how it appears).

---

## Extensibility

The current architecture is closed: animation types, CSS effects, and the pipeline itself are all hardcoded in `inkflow`. Three shallow additions would open it up without changing the overall shape of the code:

**Custom animation classes**  
Add a generic `Animate("#id", css_class="my-effect", step=1)` type that bypasses the `_ANIM_CLASS` lookup and uses whatever CSS class the author names. Authors define the CSS themselves (injected via `Deck(style=...)` — see below) and reference it by name. This makes `Fade`, `FadeOut`, and `Bounce` special cases of the same mechanism rather than a closed enum.

**CSS injection**  
A `style: str = ""` field on `Deck` (or optionally per-`Slide`) that the pipeline injects into a `<style>` block inside the SVG's `<defs>`. Combined with `Animate`, this lets authors define and use entirely custom transitions without touching inkflow's source. The field is a raw CSS string — no parsing, no abstraction.

**Pre-annotation pipeline hook**  
A `transform: Callable[[str], str] | None = None` field on `Slide` that, if set, is called with the cleaned SVG string before annotation runs. Lets authors inject content, manipulate the DOM, apply text substitutions, or call external tools — anything expressible as a string-to-string function in Python. Heavier than `content` substitutions but maximally flexible as an escape hatch.

None of these require changes to the HTTP server, WebSocket layer, or presenter JS. They are pure additions to `manifest.py` and `pipeline.py`.

---

## Out of scope and hard limits

**Auto-reflow and bullet lists for Inkscape-authored text**  
Inkscape is a drawing tool that supports text, not a text layout tool. It has no native bullet list feature — you place bullet characters manually and indent by hand. Inkscape 1.2 added SVG 2.0 `shape-inside` text wrapping, but browser support is absent in Firefox and experimental in Chrome, so the pipeline cannot rely on it. The pipeline could attempt build-time word wrapping with fonttools glyph metrics for simple cases, but it breaks immediately with mixed styling.

In practice this is not a problem: if you need bullet lists or reflowing text, use a `TextBox` placeholder in Inkscape and write the content as Markdown in `deck.py`. Inkscape is for designing the spatial layout; the `TextBox` approach handles the text content properly. Trying to make Inkscape into a word processor is the wrong direction.

**PPTX export**  
SVG is arbitrary vector geometry; PPTX has its own shape/text model. Conversion fidelity for anything non-trivial would be poor, and maintaining that mapping as both sides evolve is not worth it. If you need a PPTX, use PowerPoint.

**WYSIWYG template preview in Inkscape**  
A structural consequence of the pipeline-inlining approach: if the master template is resolved at build time, Inkscape cannot show it during authoring. The tool commits to this and authors need to accept the split. The alternative — putting master elements in a locked layer in every slide file — trades the split view for a duplication problem.

**Real-time collaboration**  
SVG files on disk and a local Python server are the wrong substrate. Git handles version history already; simultaneous multi-user editing is a different product.

**Interaction-triggered animations**  
Hover effects or click-a-specific-element-to-reveal. The step model advances globally on keypress; adding per-element interactivity would require a significant rethink of the animation model and would make `deck.py` much more complex to write.

**Accessibility**  
SVG element order does not correspond to visual reading order, there is no semantic structure, and screen reader support for inline SVG is inconsistent. A genuinely accessible presentation would require a parallel semantic layer mirroring the visual content. Not impossible, but out of scope until the core tool is stable.

**Export to video / screen recording**  
Automated recording as MP4 requires driving the presenter JS from outside the browser, syncing with narration, and handling transitions frame-accurately. The complexity is disproportionate to the use case; system screen recorders already exist.
