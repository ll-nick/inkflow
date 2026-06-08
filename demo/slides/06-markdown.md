# Markdown Slide

A slide authored in pure Markdown, rendered into a layout SVG at build time.

- First bullet point
- Second bullet point
- Third bullet point

::step::
This paragraph appears on the first click.

::step::
And this one on the second.

::notes::

These notes come from a `::notes::` zone in the Markdown file —
content after the marker is routed to the presenter view's
notes pane instead of the slide body.

- Remind the audience: same source file produces both the slide and the notes.
- Reveal the two staged paragraphs one click at a time, then transition out.
