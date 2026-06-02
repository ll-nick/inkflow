# Presenter view

The presenter view is a secondary window for the speaker.
It shows the current slide, a preview of the next one, the speaker notes,
a wall clock, and an elapsed timer.
Navigation in any open window is mirrored in all the others, so you can
project the main view and keep the presenter view on your laptop screen.

## Opening it

While the deck is being served, open the view in any of these ways:

- Press <kbd>p</kbd> in the main view.
- Click the presenter-icon button in the status bar.
- Navigate directly to `http://localhost:7777/presenter`.

The view opens in a new window. You can move it to a second display and
leave the main view on the projector.

## Layout

```
┌──────────────────────────────┬─────────────────┐
│                              │  NEXT           │
│   CURRENT SLIDE              │  [preview]      │
│   (large, centered)          │                 │
│                              ├─────────────────┤
│                              │  14:32:07       │
│                              │  elapsed 04:22  │
│                              │  Slide 4 / 12   │
│                              │  Step 1 / 3     │
│                              │  ● live         │
│                              ├─────────────────┤
│                              │  [notes]        │
└──────────────────────────────┴─────────────────┘
```

- **Current slide:** the same slide the audience sees, with step-by-step
  reveals in sync.
- **Next:** a static thumbnail of the next slide in its final state.
  Empty after the last slide.
- **Clock and elapsed:** wall-clock time and time since the presenter
  view was opened.
- **Slide / Step:** current position counters.
- **● live:** green when connected to the server, red on disconnect.
  The view tries to reconnect automatically.
- **Notes:** the rendered speaker notes for the current slide.

## Speaker notes

Notes come from the same slide data as the main view.

For `MarkdownSlide`, use the `::notes::` zone marker.
Anything after the marker is routed to the notes pane and does not appear
on the slide itself:

```markdown
# My slide title

Content shown on the slide.

::notes::

These are the speaker notes.
They support **Markdown**, including lists and `code`.
```

For `Slide` (raw SVG), pass a string or a `Path`:

```python
Slide("slides/03-diagram.svg", notes="Walk through the diagram top to bottom.")
Slide("slides/04-results.svg", notes=Path("slides/04-notes.md"))
```

See [Markdown slides](markdown-slides.md) and
[Manifest reference](../reference/manifest.md) for details.

## Keyboard

The presenter view accepts the same core navigation keys as the main view:

| Key | Action |
|---|---|
| <kbd>→</kbd> <kbd>Space</kbd> <kbd>l</kbd> | Advance step / next slide |
| <kbd>←</kbd> <kbd>Backspace</kbd> <kbd>h</kbd> | Back one step / previous slide |
| <kbd>↓</kbd> <kbd>j</kbd> | Next slide (skip steps) |
| <kbd>↑</kbd> <kbd>k</kbd> | Previous slide (skip steps) |

Other shortcuts (overview, picker, blackout, theme toggle) live on the main
view only. Drive those from the projected window.

## Multi-window sync

Position sync runs over the same WebSocket the main view uses for live
reload. Any number of presenter-view windows can be open at once:

- Each window connects on load and is sent the current position immediately,
  so it lands on the correct slide and step with no flash.
- A navigation in any window is broadcast to every other open window.
- After a deck rebuild, the position is preserved (clamped if the slide
  count drops).
