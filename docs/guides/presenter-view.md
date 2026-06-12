# Presenter panel

The presenter panel is a collapsible sidebar built into the main view.
It shows a preview of the next click, the speaker notes, a wall clock, and an elapsed timer.
Press <kbd>p</kbd> to toggle it.

## Opening it

While the deck is being served, open the panel in either of these ways:

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
  current slide number, and a circular step indicator matching the one in the status bar.
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
Slide("slides/03-diagram.svg", notes="Walk through the diagram top to bottom.")
Slide("slides/04-results.svg", notes=Path("slides/04-notes.md"))
```

See [Markdown slides](markdown-slides.md) and
[Manifest reference](../reference/manifest.md) for details.

## Using a second screen

To present on a projector while keeping the panel on your laptop screen, open two
browser windows at the same URL (`http://localhost:7777`).
In the window on your laptop screen, press <kbd>p</kbd> to open the panel.
Leave the other window full-screen on the projector.

Navigation in either window is broadcast to the other over WebSocket, so both
stay in sync regardless of which one you use to advance.

## Multi-window sync

Position sync runs over the same WebSocket the main view uses for live reload.
Any number of windows can be open at once:

- Each window connects on load and receives the current position immediately,
  so it lands on the correct slide and step.
- A navigation in any window is broadcast to every other open window.
- After a deck rebuild, the position is preserved (clamped if the slide count drops).
