# Drawing with a pen

Ink is writing and drawing on a slide with a pen (a stylus) or, if you want, a
mouse or a finger: circling a number while you talk, sketching an arrow the deck
does not have, or annotating a slide for good.

Strokes are pressure-sensitive when the pen reports pressure, smoothed as you
draw, and stored as vector shapes, so they stay sharp at any size and print in a
PDF like the rest of the slide.

## In the presenter

Press <kbd>i</kbd>, or the pen button in the status bar, to turn ink mode on.
A palette appears over the top of the slide:

| Palette | What it does |
|---|---|
| Pen | A pressure-sensitive line that thins and swells with the pen |
| Highlighter | A wide, flat, see-through marker of constant width |
| Eraser | Wipe over strokes to remove them, whole (a pen's eraser end erases too) |
| Colours | The theme's colours, black and white, and any colour from the last well |
| Widths | Thin, medium, thick |
| Undo | Take back the last stroke, erase or clear (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) |
| Clear | Remove this slide's ink |
| Hand | Draw with a mouse or a finger too, not only a pen |
| Keep | Save new strokes with the deck (see below) |

<kbd>i</kbd> or <kbd>Esc</kbd> leaves ink mode; the ink stays on the slide.

**Only a pen draws, by default.** A click still advances the slide, a swipe
still changes it, and a hand resting on a tablet while you write is ignored.
Turn on the hand button to draw with a mouse or a finger as well; then a click
on the slide is a dot rather than a step forward, and the keyboard is how you
move on. Two fingers still [zoom](index.md#drawing-attention): a stroke the
first finger began is dropped as soon as the second one lands.

**Ink belongs to its slide.** Leave a slide and its ink goes with it; come back
and it is there again. A stroke is drawn in the slide's own coordinates, so it
stays on what it marked through window resizes, fullscreen and the
[zoom camera](index.md#drawing-attention), and it leaves with the slide in the
transition.

**Every window shows it.** Ink drawn in one window appears in the others of the
same presentation as it is drawn, under the same [sync modes](sync.md#sync-modes)
as the slide position: draw in the window with the
[presenter panel](presenter-panel.md), and the projector shows the strokes.
A window opened later picks up the ink drawn before it.

### Ink for the talk, or for keeps

Ink lasts for the talk unless you say otherwise. It lives in the browser windows
and is gone when they close; nothing is written to the deck.

With **Keep** on, each stroke is also saved to the slide's
[ink file](#how-ink-is-saved) as soon as the pen lifts, so it is part of the
deck from then on: in every window, after a reload, in an
[exported](export.md) build or PDF, and in the editor. With Keep on, the eraser
and Clear also remove saved strokes (Clear asks first); with it off, they only
touch the ink of the talk and leave the deck's saved ink alone.

Keep needs `inkflow serve` (or `inkflow edit`) and a presenter window opened on
the same machine as the server. A window on another computer, such as an
audience screen reached over the network, can draw ink for the talk but never
writes the deck's files; the server refuses it.

A [static build](export.md) has no server, so its ink is for the talk only. Two
windows of a build (the second opened with <kbd>n</kbd>) still show each
other's ink.

## In the editor

The [editor's](../editor/index.md#ink) pen tool (<kbd>P</kbd>) draws saved ink
directly, with the same palette. See its section there.

## How ink is saved

Each slide's saved ink is one SVG file, `ink/<slide id>.svg`, next to
`deck.py`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow" viewBox="0 0 1920 1080" width="1920" height="1080">
  <path id="ink-3kq9xz1b0c7d" d="M412.3 380.1Q…Z" fill="#e64553" class="inkflow-fill-red" inkflow:tool="pen" inkflow:size="6"/>
  <path id="ink-8hy2m4p0aa1t" d="M300 520Q…Z" fill="#df8e1d" fill-opacity="0.35" class="inkflow-fill-yellow inkflow-highlighter" inkflow:tool="highlighter" inkflow:size="36"/>
</svg>
```

Every stroke is one filled `<path>`: the outline around the pen's track, so it
renders the same in Inkscape, on GitHub or in a PDF with nothing of inkflow's to
interpret it. A theme colour is both a literal `fill` (what other programs show)
and an `inkflow-fill-<token>` class, which inkflow paints with the theme's colour
so the ink follows a dark/light switch. `inkflow:tool` and `inkflow:size` record
how the stroke was drawn.

inkflow paints the file over the slide, above its [overlays](../design/overlays.md),
as one `<g class="inkflow-ink">`. The slide's own SVG is never touched, so:

- **Clearing a slide's ink is deleting its file.**
- Ink on a slide built straight from a shared layout stays on that one slide.
- A stroke has an id, so an [animation](../authoring/animations.md) can reveal
  it on a step like any element: `animations.FadeIn("ink-3kq9xz1b0c7d")`.

To keep a slide's ink somewhere else, name the file with
`Slide(..., ink="annotations/intro.svg")` (relative to the project).

**Ink follows its slide.** A slide's id comes from its `.md` or SVG file name
when it has no `id=`, so it can change when the editor gives a slide its own
drawing, changes its layout, or moves it among slides with the same name. The
editor renames the ink file in the same undo step; deleting a slide deletes its
ink, and duplicating it copies the ink. Renaming a slide's files outside the
editor does not move the ink: rename `ink/<old id>.svg` to match, or give the
slide an explicit `id=` (or `ink=`) so its ink never depends on file names.

The [pre-commit hook](../getting-started.md#git-integration) leaves ink files as they are: they
are written in the same layout `inkflow clean` produces.
