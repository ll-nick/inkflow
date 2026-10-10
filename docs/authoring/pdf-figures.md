# PDF figures

A figure from a paper (a plot made with matplotlib or pgfplots, a TikZ drawing,
a LaTeX `standalone` page) can go on a slide as the PDF it already is.
Inkflow shows the page as vector graphics: sharp at any zoom, with the figure's
own fonts, since the text is drawn as outlines.

## Using one

A PDF goes anywhere a picture goes:

| Where | Written as |
|---|---|
| A slide SVG | `<image href="../figures/plot.pdf" width="800" height="500"/>` |
| A zone, from `deck.py` | `Image("figures/plot.pdf")` |
| Markdown | `![Response over time](../figures/plot.pdf)` |

The first page shows unless the reference names another one,
with the fragment PDF viewers understand:

```python
Image("figures/results.pdf#page=3")
Image("figures/results.pdf", page=3)  # the same: kept as #page=3
```

```markdown
![Ablation](../figures/results.pdf#page=3)
```

A path resolves against the file it is written in, as for
[any other picture](markdown.md#images).
The page shows at its own box (the crop box, what a PDF viewer shows),
so a LaTeX `standalone` figure or a cropped plot needs no trimming.
In the editor, [**Crop**](../editor/index.md#pictures) trims a figure further.

Most PDF figures have no background of their own: the slide shows through,
as it does with a transparent PNG. On a dark deck, black axes and labels
disappear. Give the picture a **background**: `"paper"` paints white behind
it, with a small margin and rounded corners, whatever the deck's mode:

```python
zones={"media": Image("figures/plot.pdf", background="paper")}
```

In a slide's SVG it is `inkflow:background="paper"` on the `<image>` (the
editor's **Background** setting writes it). `"surface"` uses the theme's
surface colour instead, and a theme colour name (`"blue"`) or `#rrggbb` any
other. It works for any picture: an SVG or a transparent PNG, too.

## Installing a converter

Browsers do not show a PDF inside a slide, so Inkflow converts each page to SVG.
It uses the first converter it finds:

1. **PyMuPDF**, installed with Inkflow's `pdf` extra. One install on Windows,
   macOS and Linux, no system packages:

    === "uv tool"

        ```bash
        uv tool install --reinstall "inkflow[pdf]"
        ```

    === "uv project"

        ```bash
        uv add "inkflow[pdf]"   # in the deck's folder
        ```

    === "pip"

        ```bash
        pip install "inkflow[pdf]"
        ```

    !!! note "Licence"
        PyMuPDF is licensed under the AGPL-3.0 (or commercially, by Artifex).
        Installing the extra brings an AGPL component into your environment;
        Inkflow itself remains MIT and never requires it.
        If that does not suit you, use one of the programs below instead.

2. **`pdftocairo`**, part of poppler: `poppler-utils` on Debian and Ubuntu,
   `poppler` in Homebrew, Fedora and Arch (on Windows, the poppler builds from
   conda-forge or MSYS2).
3. **`mutool`**, part of MuPDF: `mupdf-tools` on Debian and Ubuntu, `mupdf` in
   Homebrew.
4. **Inkscape**, which many decks have anyway (slower than the others).

Without any of them, a PDF picture shows as a dashed box naming the file,
the build warns once with what to install, and
[`inkflow verify`](../reference/cli.md) reports it.
`verify` also reports a page the PDF does not have.

## Where the converted pages go

Only the PDF belongs in git. Converted pages are a cache in the project's
`.inkflow/cache/pdf/`, which ignores itself in git, named by the PDF's
content, the page and the converter: an unchanged PDF is never converted
twice, and a changed one is converted again the moment it is saved
(`inkflow serve` and the editor update the slide).

[`inkflow build`](../presenting/export.md) embeds the converted pages
like any picture (with `--assets-folder` it copies them into the output under
`_pdf/`); the PDF itself is not copied. `inkflow export` draws them into the
deck's PDF as vectors.

!!! note "`.gitignore` from older projects"
    Projects created by earlier versions of `inkflow init` ignore `*.pdf`
    (meant for the exported deck), which would leave a PDF figure out of git.
    Change the line to `/*.pdf`, which only covers PDFs next to `deck.py`.
