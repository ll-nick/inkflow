# Presenting a deck

The presenter is the browser page `inkflow serve` opens,
and it is the same page an [exported build](export.md) produces.
Everything on this page works in both.

Press <kbd>?</kbd> at any time for the full keybinding list.

## Keybindings

### Navigate

| Key | Action |
|---|---|
| <kbd>→</kbd> <kbd>Space</kbd> <kbd>l</kbd> | Advance one step, or to the next slide |
| <kbd>←</kbd> <kbd>Backspace</kbd> <kbd>h</kbd> | Back one step, or to the previous slide |
| <kbd>↓</kbd> <kbd>j</kbd> | Next slide, skipping its remaining steps |
| <kbd>↑</kbd> <kbd>k</kbd> | Previous slide |
| <kbd>^</kbd> <kbd>Home</kbd> | First slide |
| <kbd>$</kbd> <kbd>End</kbd> | Last slide |
| <kbd>g</kbd> | Slide picker |
| <kbd>o</kbd> | Slide overview |

### Present

| Key | Action |
|---|---|
| <kbd>.</kbd> | Laser pointer |
| <kbd>i</kbd> | [Ink](ink.md): draw on the slide with a pen |
| <kbd>Ctrl</kbd>+<kbd>z</kbd> | Undo the last stroke (in ink mode) |
| <kbd>Ctrl</kbd> + scroll, trackpad pinch | Zoom toward the pointer |
| <kbd>Ctrl</kbd> + drag, scroll while zoomed | Pan |
| <kbd>+</kbd> <kbd>-</kbd> <kbd>0</kbd> | Zoom in, out, reset |
| <kbd>b</kbd> | Blackout |
| <kbd>w</kbd> | Whiteout |
| <kbd>f</kbd> | Fullscreen |

### View

| Key | Action |
|---|---|
| <kbd>t</kbd> | Dark / light mode |
| <kbd>p</kbd> | [Presenter panel](presenter-panel.md) |
| <kbd>s</kbd> | [Cycle sync mode](sync.md#sync-modes) |
| <kbd>d</kbd> | Diagnostics |
| <kbd>n</kbd> | Notifications |
| <kbd>E</kbd> (<kbd>Shift</kbd>+<kbd>e</kbd>) | Back to the [visual editor](../editor/index.md), at this slide (served decks only) |
| <kbd>?</kbd> | This help |

<kbd>Esc</kbd> closes whatever is open.
In ink mode it leaves ink mode; with nothing open it resets the zoom.

## Moving around

**Steps versus slides.**
<kbd>→</kbd> advances the build on the current slide and moves on once it is finished.
<kbd>↓</kbd> skips straight to the next slide.
Use <kbd>↓</kbd> when you are running short on a slide you have already made your point on.

**The picker** (<kbd>g</kbd>) is a search box over slide titles.
Type a few letters, or a slide number, and press <kbd>Enter</kbd>.
Matching is fuzzy, so `arc` finds "Architecture overview".
It jumps to that slide with its build already complete,
which is what you want when someone asks about an earlier diagram.
In a deck with [sections](../authoring/slides.md#sections), each slide shows its
section, and a section whose name matches is listed first: picking it jumps to
its first slide.

**The overview** (<kbd>o</kbd>) shows the whole deck as a thumbnail grid,
under a heading per section (click one to go to the section's first slide).
Arrow keys move the selection, <kbd>Enter</kbd> opens the highlighted slide,
and <kbd>o</kbd> or <kbd>Esc</kbd> returns without moving.

## Drawing attention

**The laser** (<kbd>.</kbd>) replaces the cursor with a dot.
Drag and it leaves a trail that fades on its own,
so you can circle a term or underline a line of code without leaving anything behind.
Press <kbd>.</kbd> again to go back to the normal cursor.

**Ink** (<kbd>i</kbd>) is for marks that should stay: write or draw on the
slide with a pen, with a highlighter, colours and widths, and an eraser.
Ink lasts for the talk and shows in every window of the presentation, or, with
*Keep*, is saved with the deck. By default only a pen draws, so the mouse and
swipes keep navigating. It has [its own page](ink.md).

**Zoom** magnifies part of a slide.
Pinch on a trackpad, or hold <kbd>Ctrl</kbd> and scroll, to zoom toward the
pointer; the zoom follows your fingers smoothly, and a mouse wheel's notch is
one even step. While zoomed in, scrolling (two fingers on a trackpad) or
<kbd>Ctrl</kbd>+drag pans. On a touchscreen, pinch with two fingers: the slide
zooms around them and pans with them at once.
<kbd>+</kbd>, <kbd>-</kbd> and <kbd>0</kbd> do the same from the keyboard,
and a double-click or double tap goes back to the full slide.
Scrolling while not zoomed does nothing, so a trackpad's coasting never
changes the slide.

Zoom is local to the window.
A second screen or a following window keeps its own view,
so magnifying a detail on your laptop does not disturb the projector.
Navigating while zoomed eases back to the full slide first.

!!! note
    This is the presenter's camera, unrelated to the
    [`Zoom` transition](../authoring/transitions.md#zoom).

**Blackout and whiteout** (<kbd>b</kbd> / <kbd>w</kbd>) cover the slide
with a solid colour.
Use them when the audience should be looking at you, or at a demo,
rather than at the screen.
Any key brings the slide back.

## Adjusting the view

**Dark and light** (<kbd>t</kbd>) switches the palette when the theme provides both.
Every element painted with a
[token class](../design/themes.md#svg-element-utility-classes) follows.
Useful when the projector washes out a dark deck.

**The presenter panel** (<kbd>p</kbd>) opens speaker notes, a next-slide preview
and timers in a sidebar. It has [its own page](presenter-panel.md).

**Diagnostics** (<kbd>d</kbd>) shows the warnings from the last rebuild,
which is where a missing font or an unresolvable image reference appears.
A banner surfaces automatically when new ones arrive under `inkflow serve`.

**Notifications** (<kbd>n</kbd>) lists recent transient messages
after their toast has gone.

## Touch and mobile

On a touchscreen, swipe left and right to move between slides,
or tap the left and right edges of the stage.
Two fingers [zoom](#drawing-attention) instead: when a second finger lands
right after the first (or before the first has moved), whatever the first one
began is taken back. A laser trail or an ink stroke it started disappears
(other windows drop the stroke too), and the gesture ends with no swipe and no
tap. The finger still down after a pinch does nothing until it lifts.
Outside the stage (the status bar, the presenter panel) the browser's own
pinch zoom still works.

A floating control appears with buttons for dark/light, the step indicator
and fullscreen.

## Where you are in the deck

The status bar carries the slide number (hover it for the section and the
slide's place in it), a ring showing progress through
the current slide's steps, and buttons for the overview, the presenter panel,
[sync mode](sync.md#sync-modes) and fullscreen.

Under `inkflow serve` it also has an
[Edit button](presenter-panel.md#editing-a-slide) for jumping to a slide's source.

The position also lives in the URL as `#slide=7&steps=2`.
Copy the link to send someone a specific slide,
and a refresh keeps you where you were rather than jumping to the start.
