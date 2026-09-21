# Presenter panel

The presenter panel is a collapsible sidebar built into the main view.
It shows a preview of the next click, the speaker notes, a wall clock, and an elapsed timer.
Press <kbd>p</kbd> to toggle it.

## Opening it

Open the panel in either of these ways:

- Press <kbd>p</kbd> in the main view.
- Click the presenter-icon button in the status bar.

The stage shrinks to make room for the panel on the right.
Press <kbd>p</kbd> again (or click the button again) to close it and return to the full-width view.

## Layout

```
┌──────────────────────────────────────┬─────────────────┐
│                                      │  14:32:07  04:22│
│                                      │  Slide 4 / 12 ○ │
│   CURRENT SLIDE                      ├─────────────────┤
│   (stage — same view the audience    │  NEXT           │
│    sees, with live transitions)      │  [preview]      │
│                                      │                 │
│                                      ├─────────────────┤
│                                      │                 │
│                                      │  [notes]        │
│                                      │                 │
└──────────────────────────────────────┴─────────────────┘
```

- **Info strip:** clock (current time), elapsed time since the page was opened,
  with buttons to pause and reset it,
  current slide number, and a circular step indicator matching the one in the status bar.
  The elapsed time turns yellow while paused.
- **Next:** a preview of the next click — either the same slide with one more step
  revealed, or the first state of the following slide. Shows `END` after the last slide.
- **Notes:** the rendered speaker notes for the current slide.

## Speaker notes

Notes come from the same slide data as the main view.

For slides with a Markdown file (`md=`), use the `::notes::` zone marker.
Anything after the marker is routed to the notes pane and does not appear
on the slide itself:

```markdown
# My slide title

Content shown on the slide.

::notes::

These are the speaker notes.
They support **Markdown**, including lists and `code`.
```

You can also pass notes directly via the `notes=` parameter on any `Slide`:

```python
from inkflow import Inline, Slide

Slide("diagram", notes=Inline("Walk through the diagram top to bottom."))
Slide("results", notes="notes/results.md")
```

A bare `str` is a path to a file, `Inline(...)` is the text itself.

See [Speaker notes](../authoring/markdown.md#speaker-notes) and
[Manifest reference](../reference/manifest.md) for details.

## Editing a slide

Click the pencil-icon button in the status bar to edit the current slide's source.
It opens a small dropdown listing, top to bottom: any parent layouts
(a layout built on a project-local `inkflow:parent`), the layout itself,
a file-backed `md=` and/or `notes=` as Content and Notes,
and finally the deck script.
Each entry shows its kind and filename.
A parent layout that lives in the active theme or an installed package
is never listed, since it isn't yours to edit.

By default this copies the file's absolute path to the clipboard.
With `INKFLOW_EDIT_CMD` set, it launches that command instead
(`INKFLOW_EDIT_CMD_SVG` overrides it just for SVG files).
See [CLI reference](../reference/cli.md#editing-from-the-presenter) for details,
including suggested commands for VS Code, Neovim, and Inkscape.

This button only appears under `inkflow serve`, not in a static build.

## Presenting on a second screen

Open the deck in two windows: the panel on your laptop, the stage on the projector.
Both stay in sync as you navigate.
See [Multi-window sync](sync.md).
