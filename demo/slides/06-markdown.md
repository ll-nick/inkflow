# Markdown Slide

A slide authored in pure Markdown, rendered into a layout SVG at build time.

::step::
`::step::` reveals this entire block in **one** click.

::step::
And this whole block on the **next** click.

::steps::
`::steps::` reveals each item below **individually**:

- First bullet — one click
- Second bullet — one click
- Third bullet — one click

This works for both bullet points as well as top-level paragraphs.
::steps end::

This line is visible from the start, and is not part of any step.

::notes::

This slide demonstrates both step markers:

- `::step::` — each marker advances the step counter; everything between two markers appears together on a single click.
- `::steps::` / `::steps end::` — wraps a block where every top-level paragraph and every list item becomes its own step automatically.
