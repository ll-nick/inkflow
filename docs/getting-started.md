# Getting started

This page takes you from zero to a running presentation in about five minutes.

## Prerequisites

- Python 3.11 or newer
- [uv](https://docs.astral.sh/uv/) (recommended), or pip
- An SVG editor.
  [Inkscape](https://inkscape.org/) is the primary authoring tool,
  but any editor that exports standard SVG works

## Installation

=== "uv (recommended)"

    ```bash
    uv add inkflow
    ```

=== "pip"

    ```bash
    pip install inkflow
    ```

!!! note "Early release"
    Inkflow is early-stage.
    The package is on PyPI as a pre-release,
    so you may need to opt in to pre-release versions explicitly:

    ```bash
    uv add inkflow --prerelease allow
    ```

    or

    ```bash
    pip install inkflow --pre
    ```

## Run the demo

The repository ships with a working demo deck:

```bash
inkflow serve --deck demo/deck.py
```

Open [http://localhost:7777](http://localhost:7777) in your browser.
Use the keyboard to navigate.
Here are a few shortcuts to get you started:

| Key | Action |
|---|---|
| `←` / `→` | Navigate slides step-wise |
| `↓` / `↑` | Jump to next / previous slide (skip steps) |
| `g` + number + `Enter` | Go to slide number |
| `f` | Toggle fullscreen |
| `?` | Show all shortcuts |

!!! warning "Decks are executable code"
    A `deck.py` is a Python program that Inkflow imports and runs. Serving,
    building, or exporting a deck executes it. Only run decks you trust.

## Create your first deck

`inkflow init` scaffolds a starter project instead of you writing everything by hand:

!!! note
    Inside a git repository, `inkflow init` also configures git hooks automatically —
    see [Git integration](#git-integration).

```bash
inkflow init my-talk
cd my-talk
inkflow serve
```

This creates `slides/01-title.svg` (a title slide from the built-in theme),
`slides/02-content.md` (Markdown content — example bullets with two reveal steps),
and a `deck.py` that lists both.

**Make it yours:**

- `slides/01-title.svg` only defines empty zones from the built-in cover layout —
  fill them in from `deck.py`:

  ```python
  from inkflow import Deck, Slide, TextBox

  def main() -> Deck:
      return Deck(slides=[
          Slide("slides/01-title.svg", zones={
              "title": TextBox("My Talk"),
              "subtitle": TextBox("A subtitle"),
          }),
          Slide("builtin:default", md="slides/02-content.md"),
      ])
  ```

- Edit `slides/02-content.md` to change the bullets.
- Draw your own shapes directly in `slides/01-title.svg` and give one an ID (in
  Inkscape, select it and open Object Properties via the Object menu or
  <kbd>Ctrl+Shift+O</kbd>) to animate it:

  ```python
  Slide("slides/01-title.svg", animations=[animations.FadeIn("#my-shape", step=1)])
  ```

Save, and the presenter updates automatically. No refresh needed.

## Git integration

`inkflow init` configures git hooks automatically whenever it detects a git
repository — if `my-talk` was inside one, this already happened. It sets up two
things:

- A pre-commit hook that strips Inkscape editor metadata (viewport position, zoom,
  window size) from staged SVGs, so that noise never lands in git history.
- A diff driver so `git diff` and GitHub show only visual changes for SVGs.

Skip it during scaffolding with `inkflow init --no-git`, or run it manually at any
time:

```bash
inkflow setup-git
```

Git won't run hooks automatically on clone — that's an intentional security
boundary — so commit `.githooks/pre-commit` and `.gitattributes`, and have
teammates run `inkflow setup-git` once in their own clone to activate it.

## Next steps

- [Concepts](concepts.md): understand the mental model before writing more slides
- [Authoring slides](guides/slides.md): animations, element IDs, zones, and Markdown content
- [Layout system](guides/layout-system.md): reusable slide templates
