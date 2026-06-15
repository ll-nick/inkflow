# Roadmap

Unimplemented features, roughly ordered by impact.
Items covered in the docs are implemented and not listed here.

---

## Developer experience

**`inkflow.logging` — unified log/warn/error sink**

Replace ad-hoc `print()` calls and warning return values across library code with a
single `inkflow.logging` module backed by Python's built-in `logging`.

**Motivation:** library code currently mixes `print()` (pipeline, content, fonts) with
`-> tuple[str, list[str]]` return values to surface warnings to callers. Both patterns
are inconsistent and require threading messages up the call stack manually.

**Design:** a thin `inkflow.logging` wrapper around `logging` that:
- Provides `warn(msg)` / `info(msg)` for use anywhere in library code
- Installs a collecting handler at the top of each CLI command and the server rebuild
  loop so warnings can be formatted with color (`click.style`, Rich `Text`) at the
  presentation layer
- Keeps the default handler as a plain `print`-equivalent so library code works
  correctly in isolation (tests, scripts) without any configuration

**Migration path:** every `log.warn(msg)` or `print(f"[inkflow] warning: ...")` becomes
`logger.warning(msg)`; every `with log.collecting() as warnings:` becomes a standard
`logging.Handler` install/remove. Straightforward, low risk.

---

## Presenter experience

**Drawing and annotation mode**
A toggle that overlays a canvas element and lets you draw with the mouse or stylus during Q&A.
Drawings are ephemeral — they don't persist between slides.

---

## Content features

**Configurable step animations (Option B)**
`::step::` and `::steps::` markers currently hardcode `anim-fade-in` as the reveal animation.
Add a `step_animation` parameter to `Slide` (and a deck-level default on `Deck`) that accepts a small
`StepAnimation(kind, duration, delay)` dataclass — analogous to the existing `Animation` subclasses.
The kind maps to `anim-<kind>`, and duration/delay emit `--anim-*` custom properties on the wrapper div,
so no new CSS is required for custom durations.
Per-zone overrides via the `::zone step-anim=slide-in::` marker parameter are a natural follow-on.

**Section dividers and table of contents**
A `SectionSlide("title")` type that marks a section boundary.
The pipeline can auto-generate a TOC slide from all section boundaries.

---

## Authoring experience

**Watch-only mode**
`inkflow watch deck.py` rebuilds on change without opening a browser or server.
Useful for catching `deck.py` errors immediately during authoring.

---

## Theme

**Named theme support**
`_resolve_theme_dir` currently raises an error for bare names like `Deck(theme="catppuccin-mocha")`.
Named resolution requires a pip package naming convention (`inkflow-theme-{name}`).

**Pip-installable themes**
Auto-discovery so `Deck(theme="catppuccin-mocha")` works after `pip install inkflow-theme-catppuccin-mocha`.

**Theme eject**
`inkflow eject-theme` copies a theme into the project and updates `deck.py` to point at the local copy.

---

## Nice to have

- **More animation types** — `Scale`, `Rotate`, `Draw` (stroke-dashoffset), `Highlight` (colour pulse)
- **Morph for paths and groups** — `<path>`, `<polygon>`, `<g>`, `<text>` currently fall back to an instant cut
- **Auto-advance** — timed slides for kiosk or lightning-talk use
- **Hyperlinks** — SVG `<a>` elements open in a new tab during presentation
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
