# Multi-window sync

Open the deck in more than one window and they follow each other.
This is what makes a second screen work:
the projector shows the stage full-screen
while your laptop shows the same deck with the
[presenter panel](presenter-panel.md) open.

## Setting up a second screen

1. Click **Open a synced window** in the status bar.
   It opens a second window at the current position.
2. Drag that window to the projector and press <kbd>f</kbd> for fullscreen.
3. In the original window, press <kbd>p</kbd> to open the presenter panel.

Navigating in either window moves both,
so it does not matter which one you drive from.

## How windows find each other

The transport depends on how the deck is running,
though the behaviour is the same either way.

**Under `inkflow serve`,** position travels over the same WebSocket used for live
reload. Any number of windows can join, in any browser, including another device
on the network. Just open the URL.

**In an exported build,** including a deck opened straight from disk with no
server at all, there is no WebSocket. Two windows sync directly instead:
the one you clicked the button in, and the one it opened.
A window opened by hand in a new tab will not join,
because the direct link only exists between opener and opened.

## Which slide a new window lands on

- A window opened at the bare URL adopts the shared position,
  so a second screen lands where you already are.
- A window opened at a link naming a slide, such as `#slide=5`, keeps that slide.
  A refresh counts as such a link, so reloading never pulls a window off its slide.
- Under `serve`, position survives a rebuild, clamped if the deck got shorter.

The slide lives in the URL fragment, so a link behaves the same whether the deck
is served, hosted as a static build, or opened from disk.

## Sync modes

Each window decides for itself how it participates.
Cycle with <kbd>s</kbd>, or click the sync button in the status bar.
The button shows the current mode and tints when it is anything but two-way.

| Mode | Broadcasts its navigation | Follows other windows |
|---|:---:|:---:|
| **Two-way** (default) | yes | yes |
| **Present** | yes | no |
| **Follow** | no | yes |
| **Solo** | no | no |

Put the window you drive on **Present** and the projector on **Follow**,
and a stray keypress on the projector cannot move the deck.

Switching into Follow or Two-way catches that window up immediately.
The choice is remembered per browser tab across reloads.

!!! note
    [Zoom](index.md#drawing-attention) is never synced.
    Magnifying a detail on your own screen leaves the projector alone.
