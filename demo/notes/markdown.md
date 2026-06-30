Markdown injection lives at the core of Inkflow since SVG editors are not designed for text editing.
Most Markdown features are supported and Inkflow adds a few extras for slide decks:

Math is rendered as MathML via `latex2mathml` — converted server-side at build time,
no JavaScript math library needed in the browser.

`::step::` markers split Markdown into steps that appear on successive clicks.
`::steps::` (plural) does the same but wraps each list-item, paragraph and definition-list term in its own
step automatically.

Cross-slide links use the `slide:id` protocol: `[label](slide:deck-py)` navigates
directly to the slide whose `id=` matches. Footnotes are standard Markdown and
render at the bottom of the page.
