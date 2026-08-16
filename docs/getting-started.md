# Getting started

This page takes you from zero to a running presentation in about five minutes.

## Prerequisites

- Python 3.11 or newer
- [uv](https://docs.astral.sh/uv/) (recommended), or pip
- An SVG editor.
  [Inkscape](https://inkscape.org/) is the primary authoring tool,
  but any editor that exports standard SVG works

## Run the demo

The demo deck lives in the repository, so clone it and serve:

=== "uv (recommended)"

    ```bash
    git clone https://github.com/ll-nick/inkflow
    cd inkflow/demo
    uv run inkflow serve
    ```

=== "pip"

    ```bash
    git clone https://github.com/ll-nick/inkflow
    cd inkflow
    pip install -e .
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
    For a fresh project, `inkflow init` also runs `git init` and configures git
    hooks automatically — see [Git integration](#git-integration).

=== "uv (recommended)"

    ```bash
    uvx inkflow init my-talk
    cd my-talk
    uv run inkflow serve
    ```

    `uvx` runs inkflow just long enough to scaffold. `uv run` then installs inkflow
    into the project's own environment from the generated `pyproject.toml`.

=== "pip"

    ```bash
    pip install inkflow
    inkflow init my-talk
    cd my-talk
    inkflow serve
    ```

    Install inkflow into the environment you work in (a virtualenv is recommended);
    that is the same environment `deck.py` imports it from. The generated
    `pyproject.toml` records the dependency for reproducibility and for teammates on uv.

`inkflow init` writes `slides/`, `notes/`, a `deck.py`,
and a `pyproject.toml` pinning inkflow.
It refuses to scaffold into a non-empty directory unless you pass `--force`.

The starter deck has three slides, each showing a different way to author one:

1. **`slides/title.svg`** — a plain SVG you drew. No layout, no zones: draw an SVG,
   point a `Slide` at it, done.
2. **A built-in layout filled with Markdown** — `Slide("content", md="guide")` pulls
   `slides/guide.md` into the layout's content zone. `slides/guide.md` itself explains
   how the template works.
3. **`slides/diagram.svg`** — your own SVG that inherits a themed background via
   `inkflow:parent`, carries its own Markdown zone (`slides/diagram.md`), and animates
   an element by its `id`. The slide is a labelled "anatomy" diagram of itself.

Speaker notes for each slide live in `notes/` and show only in the presenter panel
(press `p`).

**Make it yours:**

- Edit the text in `slides/title.svg` (open it in Inkscape) and the Markdown in
  `slides/guide.md` / `slides/diagram.md`.
- Fill a layout zone from `deck.py` with a `TextBox` instead of Markdown:

  ```python
  from inkflow import Slide, TextBox

  Slide("content", zones={"title": TextBox("My Talk")})
  ```

- Draw your own shape in any slide SVG and give it an ID (in Inkscape, select it and
  open Object Properties via the Object menu or <kbd>Ctrl+Shift+O</kbd>) to animate it:

  ```python
  Slide("diagram", animations=[animations.FadeIn("my-shape")])
  ```

Save, and the presenter updates automatically. No refresh needed.

## Git integration

For a fresh project, `inkflow init` also runs `git init`, writes a `.gitignore`,
and configures git hooks — so `inkflow init my-talk` gives you a version-controlled
project out of the box. The hooks set up two things:

- A pre-commit hook that strips Inkscape editor metadata (viewport position, zoom,
  window size) from staged SVGs, so that noise never lands in git history.
- A diff driver so `git diff` and GitHub show only visual changes for SVGs.

If you run `inkflow init` inside an *existing* repository, it leaves that repo's
git configuration untouched and instead points you at `inkflow setup-git`. Skip all
git steps during scaffolding with `inkflow init --no-git`, or run the hook setup
manually at any time:

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
