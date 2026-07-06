# Getting started

This page takes you from zero to a running presentation in about five minutes.

## Prerequisites

- Python 3.10 or newer
- [uv](https://docs.astral.sh/uv/) (recommended), or pip in a virtualenv
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
uv run inkflow serve --deck demo/deck.py
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
    building, or exporting a deck executes it. Only run decks you trust, the
    same caution you would apply to any downloaded script.

## Create your first deck

**1. Create the project directory:**

```bash
mkdir my-talk && cd my-talk
mkdir slides
```

**2. Draw your first slide in your SVG editor.**
Save it as `slides/01-title.svg`.
Give the element you want to animate an ID.
For example, select the title text and set its ID to `headline`.
In Inkscape, open Object Properties via the Object menu (or <kbd>Ctrl+Shift+O</kbd>) and type the ID there.

**3. Create `deck.py`:**

```python
from inkflow import Deck, Slide, animations

def main() -> Deck:
    return Deck(slides=[
        Slide("slides/01-title.svg", animations=[
            animations.FadeIn("#headline", step=1),
        ]),
    ])
```

**4. Serve it:**

```bash
inkflow serve
```

Every time you save a change in your editor, the presenter updates automatically.
No refresh needed.

## Set up git integration (recommended)

If your project is in a git repository, run this once after cloning:

```bash
inkflow setup-git
```

This installs a pre-commit hook that automatically strips Inkscape editor metadata
(viewport position, zoom, window size) from SVGs before every commit,
and configures the diff driver so `git diff` shows only visual changes.

Commit `.githooks/pre-commit` and `.gitattributes` so teammates get the same setup.
They just need to run `inkflow setup-git` in their own clone to activate it.

## Next steps

- [Concepts](concepts.md): understand the mental model before writing more slides
- [SVG slides](guides/svg-slides.md): animations, element IDs, and what the pipeline does
- [Markdown slides](guides/markdown-slides.md): write text content in Markdown instead of SVG
- [Layout system](guides/layout-system.md): reusable slide templates
