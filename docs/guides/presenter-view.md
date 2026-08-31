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
Slide("diagram", notes="Walk through the diagram top to bottom.")
Slide("results", notes=Path("slides/results-notes.md"))
```

See [Authoring slides](slides.md#speaker-notes) and
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

- A navigation in any window is broadcast to every other open window.
- A window opened at the bare URL adopts the shared position on connect, so it
  lands where the presenter already is (second-screen follow).
- A window opened at a deliberate deep link (a URL naming a slide, such as
  `#slide=5`) keeps that slide instead of being pulled to the shared position. A
  browser refresh counts as a deep link, so reloading never yanks a window off its
  slide. The slide lives in the URL fragment so the link works the same whether
  the deck is served, hosted as a static build, or opened straight from disk.
- After a deck rebuild, the position is preserved (clamped if the slide count drops).

### Sync modes

Each window chooses how it participates, independent of the others. Cycle the mode
with <kbd>s</kbd>, or click the sync button in the status bar and pick from the menu.
The button shows the active mode and tints when it is anything but two-way.

| mode | broadcasts its navigation | follows other windows |
|------|:---:|:---:|
| **Two-way** (default) | yes | yes |
| **Present** | yes | no |
| **Follow** | no | yes |
| **Solo** | no | no |

Use **Present** on the window you drive from and **Follow** on a screen that should
only ever track it, so an accidental key press on the follower cannot move the deck.
Switching a window into Follow (or Two-way) immediately catches it up to the current
position. The choice is remembered per browser tab across reloads.
