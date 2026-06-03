# Roadmap

Unimplemented features, roughly ordered by impact.
Items covered in the docs are implemented and not listed here.

---

## Open design questions

**Layout overrides**
Some layouts visually override the base layout frame — a section divider or full-bleed title slide typically drops the footer and page number.
The mechanism for opting out (per-layout or per-slide) is not yet decided.
Candidates: a flag attribute on the layout SVG root (`inkflow:no-layout="true"`), or a `layout_zones` exclusion list in `deck.py`.
This affects both `inject-layout` (which layers to inject) and the pipeline (which elements to include).

---

## Pipeline

**Font embedding**
SVGs reference fonts by name.
On the authoring machine this works; on any other machine it may not.
Use fonttools to resolve fonts via fontconfig, base64-encode them, and inline `@font-face` declarations inside a `<defs>` block.
Makes each output SVG self-contained without converting text to paths.

---

## Presenter experience

**Hidden / draft slides**
`Slide("...", visible=False)` keeps a slide in `deck.py` but excludes it from the presentation.
Essential for working decks where you trim slides depending on audience or time.

**Remote control**
A `/remote` URL serving a minimal forward/back interface for a phone browser.
The WebSocket architecture makes this nearly free to implement.

**Drawing and annotation mode**
A toggle that overlays a canvas element and lets you draw with the mouse or stylus during Q&A.
Drawings are ephemeral — they don't persist between slides.

**Laser pointer**
A coloured dot that follows the mouse while a modifier key is held.

---

## Content features

**Per-step code line highlighting**
A `CodeSlide` template (or a `Highlight` animation targeting line ranges) that dims non-highlighted lines per step.
One of the most-used Slidev features for technical presentations.

**Math / LaTeX**
Enable the `dollarmath` plugin in `markdown-it-py` and load KaTeX in the presenter.
Since `<foreignObject>` content is real HTML in the browser, KaTeX's auto-render works there without modification.

**Section dividers and table of contents**
A `SectionSlide("title")` type that marks a section boundary.
The pipeline can auto-generate a TOC slide from all section boundaries.

---

## Authoring experience

**Element ID validation**
When `deck.py` references `#headline` but the SVG has no matching element,
this should be a hard build error naming the slide file and the missing ID.
Currently a silent skip.

**Watch-only mode**
`inkflow watch deck.py` rebuilds on change without opening a browser or server.
Useful for catching `deck.py` errors immediately during authoring.

**Custom slide dimensions**
Currently hardcoded 1920×1080.
Should be a per-deck setting on `Deck(width=..., height=...)`.

---

## Theme

**Complete the default theme**
The current built-in theme is a visual placeholder — bare zone rects on a flat background with no typography or decoration.
Needs a coherent color palette using the `--inkflow-*` CSS variables,
styled layout SVGs using the semantic CSS classes,
readable typography for headings, body text, and code blocks,
and light/dark variants that both look intentional.
The showcase deck should demonstrate a well-designed presentation, not just exercise every layout type.

**Named theme support**
`_resolve_theme_dir` currently raises an error for bare names like `Deck(theme="catppuccin-mocha")`.
Named resolution requires a pip package naming convention (`inkflow-theme-{name}`).

**Pip-installable themes**
Auto-discovery so `Deck(theme="catppuccin-mocha")` works after `pip install inkflow-theme-catppuccin-mocha`.

**Theme eject**
`inkflow eject-theme` copies a theme into the project and updates `deck.py` to point at the local copy.

---

## Reliability and polish

**CLI polish**
`--no-browser` flag, `--host` for SSH forwarding, `--version`.

---

## Nice to have

- **More animation types** — `Scale`, `Rotate`, `Draw` (stroke-dashoffset), `Highlight` (colour pulse)
- **Morph for paths and groups** — `<path>`, `<polygon>`, `<g>`, `<text>` currently fall back to an instant cut
- **Auto-advance** — timed slides for kiosk or lightning-talk use
- **Hyperlinks** — SVG `<a>` elements open in a new tab during presentation
- **Within-slide Morph** — element changes shape as part of a step sequence on a single slide
- **Configurable keybindings** — a `keybindings` dict on `Deck`

---

## Out of scope

**Auto-reflow and bullet lists for SVG-authored text**
Inkscape has no native bullet list feature; SVG 2.0 `shape-inside` text wrapping has no browser support.
Use a `TextBox` placeholder in the SVG and write the content as Markdown instead.

**PPTX export**
SVG is arbitrary vector geometry; PPTX has its own shape/text model.
Conversion fidelity for anything non-trivial would be poor.

**WYSIWYG layout preview in Inkscape**
A structural consequence of the pipeline-inlining approach.
The injected layers from `inject-layout` are a spatial reference, not a live preview.

**Real-time collaboration**
SVG files on disk and a local Python server are the wrong substrate.
Git handles version history already.

**Interaction-triggered animations**
The step model advances globally on keypress.
Adding per-element interactivity would require a significant rethink of the animation model.

**Accessibility**
SVG element order does not correspond to visual reading order and screen reader support for inline SVG is inconsistent.
Out of scope until the core tool is stable.

**Export to video**
Automated recording as MP4 requires driving the presenter JS from outside the browser.
The complexity is disproportionate; system screen recorders already exist.
