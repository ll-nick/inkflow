# Roadmap

Things that would need to exist before this is a tool someone would actually give a talk with.

Items are roughly ordered by how much they matter. The first two sections are load-bearing — without them the tool is a toy. Everything after is about closing the gap to a real presenter experience. The final section is honest about what is out of scope or architecturally not possible.

---

## Open design questions

These need a decision before the relevant features can be built.

**Slide master: authoring vs presentation mismatch**  
The planned approach is to define shared layout elements (`main.svg`) as SVG `<symbol>` blocks and resolve them in the Python pipeline via `<use>`. This means Inkscape shows slides *without* the master frame while authoring — you're editing a content canvas, not the final slide. The pipeline inlines the template at build time. This is an intentional tradeoff (same as any template system), but it needs to be documented clearly and the authoring workflow needs to account for it. An alternative — putting master elements in a locked Inkscape layer inside each slide file — preserves WYSIWYG at the cost of duplication and harder template updates.

**One file per slide vs multi-page SVG**  
The current design uses one SVG file per slide. Inkscape 1.2+ supports multi-page SVGs via `inkscape:page` elements, which would let the whole deck live in one file and be edited without switching documents. The downside is that parsing multi-page SVGs requires understanding Inkscape's internal namespace rather than standard SVG, which tightly couples the tool to Inkscape's implementation. One-file-per-slide is simpler, produces cleaner git diffs, and maps naturally to the standard SVG model. Worth revisiting if Inkscape formalises the multi-page format.

**Markdown slide types: how to inject text content**  
For content-heavy slides (title + bullets, quote, code), requiring a full Inkscape SVG is overkill. The idea: a `MarkdownSlide` type in `deck.py` that references a template by name and fills named placeholder zones with text content from a `.md` file or inline string. The relationship is inverted from Slidev — Inkscape (or a built-in template) defines *where* text lives and how it looks, Markdown defines *what* it says.

Two implementation approaches with different tradeoffs:
- **SVG `<foreignObject>`** — inject rendered Markdown as HTML inside placeholder zones. Works well in browsers; Inkscape shows an empty box, so the Inkscape view is meaningless for these slides. Appropriate for pure content slides where you're not doing layout work in Inkscape anyway.
- **SVG text generation** — the pipeline converts Markdown to `<text>`/`<tspan>` trees placed into named zones. Keeps the SVG-native model and renders in Inkscape, but cannot support all Markdown features (tables, images, nested lists).

The `foreignObject` approach is simpler and more capable; the text-generation approach is more principled but hits a ceiling quickly. Note that SVG is fixed-geometry — there is no text reflow. Either approach requires authors to think about how much content fits in a zone, which is a real ceiling compared to PowerPoint or Slidev's "just keep typing" text boxes.

---

## Pipeline completeness

**Content substitutions (`Video`, `TextBox`, `Math`)**  
The `content` list on `Slide` lets `deck.py` declare what goes into named placeholder elements in the SVG. The pipeline finds each element by ID, reads its bounding box, and replaces it with the appropriate content at the same position and size. Initial set of substitution types:

- `TextBox("#id", src="file.md")` or `TextBox("#id", text="...")` — renders Markdown to HTML inside a `<foreignObject>`, giving full text reflow within the placeholder bounds
- `Video("#id", src="assets/demo.mp4")` — replaces the placeholder with an HTML `<video>` element; dimensions come from the rect's geometry in the SVG
- `Math("#id", latex="...")` — renders LaTeX to SVG via KaTeX at build time and inlines the result

An element can have both a substitution and an animation: the substitution determines what the element becomes, the animation determines how it appears.

Bounding box extraction requires that placeholders be `<rect>` elements (explicit `x`, `y`, `width`, `height` attributes). `<g>` groups and transformed elements are harder to measure without a render tree; document this constraint clearly.

**Markdown slide types**  
A `MarkdownSlide` class that lets content-heavy slides be authored in Markdown rather than Inkscape, without leaving `deck.py` or changing the mental model. Mixed decks — some slides designed in Inkscape, some written as text — should work naturally:

```python
deck = Deck(theme="catppuccin-mocha")
deck.slides = [
    MarkdownSlide("title", title="My Talk", subtitle="A subtitle"),
    MarkdownSlide("bullets", src="slides/02-agenda.md"),
    MarkdownSlide("code", language="python", src="slides/03-example.py"),
    Slide("slides/04-diagram.svg", animations=[Fade("#arrow", step=1)]),
]
```

The named first argument (`"title"`, `"bullets"`, `"code"`) selects a built-in template SVG. Inkflow ships a set of Catppuccin Mocha-styled templates covering the common cases. User-defined templates (custom SVGs with named placeholder zones) should also be possible.

**Markdown parsing** is handled by an existing library (`markdown`, `mistune`, or `markdown-it-py`) — no custom parsing. A Markdown file becomes HTML in three lines of Python. That HTML is injected into a `<foreignObject>` in the SVG and the browser renders it normally, including bullet lists, code blocks, bold/italic, tables.

**Styling** (font sizes, colors, heading hierarchy, bullet appearance) is defined by a CSS theme file, not per-slide. The theme is set once on `Deck(theme=...)`. The default Catppuccin Mocha theme ships with Inkflow. Users can point to a custom CSS file. The `TextBox` placeholder in the SVG provides position and size; the theme provides typography and color; the Markdown file provides content — three separate concerns that don't interfere with each other. See the design question above for the `foreignObject` vs SVG text generation decision.

**Main SVG template inlining**  
`main.svg` defines shared layout (background, logo, footer) as SVG `<symbol>` blocks. Each slide SVG references them via `<use>`. The pipeline resolves and inlines them at build time. Authors accept that the Inkscape view is a content canvas, not the final slide — the template is only visible in the browser presenter.

**Font embedding**  
SVGs reference fonts by name. On the authoring machine this works; on any other machine it may not. Use fonttools to resolve fonts via fontconfig, base64-encode them, and inline `@font-face` declarations inside a `<defs>` block. Makes each output SVG self-contained without converting text to paths.

**Cross-slide Morph (PowerPoint-style)**  
The signature animation feature. When the same element ID appears on two consecutive slides, Inkflow interpolates its path, position, and size during the slide transition — the element appears to physically move or reshape as you advance. This is more powerful than within-slide morphing: a diagram can grow more complex across multiple slides without duplicating authoring work. Implementation: detect shared IDs between adjacent slides at build time, generate CSS keyframe or JS-stepper animations for the transition. The `Morph` class is already a stub in the manifest but currently describes the wrong thing; the API needs rethinking around slide transitions rather than within-slide steps.

**PDF export**  
Distinct from static HTML export. PDF is how you share slides with conference organizers, submit to proceedings, and post a permanent copy online. The cleanest path: build the static HTML, then print it to PDF via headless Chromium (`--print-to-pdf`). Each slide needs to map to exactly one PDF page, which requires a print stylesheet that shows one slide at a time.

**Static HTML export**  
`inkflow build deck.py` produces a single self-contained HTML file — all slides inlined, fonts embedded, no server required. How you present from an unfamiliar machine and the intermediate step before PDF export.

---

## Presenter experience

**URL-based slide and step tracking**  
The current implementation keeps slide index and step in JavaScript memory only. A browser refresh resets to slide 1, step 0. Slidev encodes position in the URL hash (e.g. `#/3/2` for slide 3, step 2). This should just be done: write `location.hash` on every navigation, parse it on page load. The only cost is a trivial amount of implementation; the gain is that refresh keeps your position, browser history works, and you can share a link to a specific slide.

**Full-screen mode**  
Press F to enter full-screen. Status bar hides and reappears on mouse movement. Table stakes for actually presenting.

**Keyboard navigation refinement**  
Current keys (Space/→ for next step, ← for previous slide) conflate step-wise and slide-wise movement. A cleaner split: Space/→/← advance and retreat through steps, while ↑/↓ jump directly to the previous or next slide regardless of the current step. Useful when you need to skip back several slides quickly during Q&A without stepping through all the animations. Vim bindings (h/j/k/l, gg/G for first/last slide) as an opt-in alternative for the terminally inclined.

**Go-to-slide by number**  
Essential for recovering mid-talk ("can you go back to slide 8?"). Two implementation tiers:

- **Number + Enter** (PowerPoint style): digit keypresses accumulate in a buffer shown in the status bar (`→ 8`), Enter jumps, Escape or a short timeout clears. About 20 lines of JS, no backend changes. Implement this first — it covers the use case immediately.
- **`g` popup with slide titles** (Slidev style): pressing `g` opens a small modal overlay, typing a number shows a filtered list of slides by number and title, Enter or click to jump. Substantially better UX, but requires slide titles. This means either adding an optional `title` field to `Slide` in `deck.py` (`Slide("slides/01.svg", title="Introduction")`) or auto-extracting a title from the SVG. The manifest field is cleaner; auto-extraction from SVG is fragile. Worth doing once `Slide` grows a title field for other reasons (presenter view, slide overview, TOC) — at that point the popup comes nearly for free.

**Slide numbers**  
Display current slide number and total in the presenter status bar (already partially there). Optionally expose a `{{slide_number}}` / `{{total_slides}}` token that can be placed as a text element in `main.svg` and substituted by the pipeline, so slide numbers appear on the slides themselves. Hidden slides (see below) should not count toward the total.

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

**Slide transitions**  
Currently a hard cut between slides. A simple crossfade makes the experience feel less jarring. Cross-slide Morph (see above) is the more interesting case, but a basic opacity transition should come first.

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
- **Auto-advance** — timed slides for kiosk or lightning-talk use
- **Slide overview** — press Escape for a thumbnail grid, click to jump
- **Hyperlinks** — SVG `<a>` elements open in a new tab during presentation
- **Within-slide Morph** — an element changes shape as part of a step sequence on a single slide; distinct from and less powerful than cross-slide Morph but still useful for things like a circle expanding into a diagram

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
