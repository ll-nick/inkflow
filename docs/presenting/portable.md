# A deck that looks the same everywhere

A deck is a folder: `deck.py`, its drawings, Markdown and pictures. A
colleague who clones it, a CI runner publishing it, or you on another
laptop should get exactly the slides you see. Three things quietly tie a deck
to the computer it was made on:

- **fonts** that only this computer has (a font installed for you, or one
  your OS ships, such as Arial or Segoe UI), and font stacks that start with a
  generic family (`sans-serif`, `monospace`), which every OS draws with its own
  font;
- **files outside the deck**: a picture named as `../shared/logo.png`, or
  reached through a symlinked folder (git keeps the link, not the file, and a
  Windows checkout turns links into small text files);
- **the setup**: no `pyproject.toml` pinning the inkflow version, no
  `uv.lock`, no line-ending rules (a Windows checkout can rewrite every SVG
  with CRLF line endings), no Git LFS rules for fonts and media.

`inkflow fonts` shows where each font comes from, and `inkflow pack` fixes
everything that copying can fix, in one step.

## Where the fonts come from

```bash
inkflow fonts            # one line per family, with the weights the deck uses
inkflow fonts --json     # the same, for scripts and agents
```

Every family the deck names is listed: the theme's font tokens as your
`styles.css` leaves them, other `font-family` declarations in the deck's
styles, and every font in the built slides (SVG text, Markdown, charts,
drawn-in diagrams). Each says where it comes from:

| Where | Meaning | On another machine |
|--|--|--|
| `project` | the deck's `fonts/` folder | the same: it is committed |
| `theme` | shipped with inkflow or the deck's theme | the same: the version is pinned |
| `machine` | this computer's font folders (the path is shown) | another font |
| `missing` | nowhere | a fallback, here too |
| `generic` | a stack starting with `sans-serif`, `serif`, `monospace`… | each OS's own font |

Weights and styles are the ones actually used: body text adds bold and italic
only where the Markdown has `**bold**` or `*italic*`, headings use the theme's
heading weight.

## Bringing fonts into the deck

```bash
inkflow fonts bundle                 # every `machine` font into fonts/
inkflow fonts bundle "Source Sans 3" # only that family
inkflow fonts bundle --all-weights   # every file of each family
inkflow fonts set body Inter         # use Inter for body text, and bundle it
inkflow fonts set mono "JetBrains Mono"
```

`bundle` copies each family to `fonts/<family>/`: only the files for the
weights and styles the deck uses (a variable font is one file), with the
licence files found beside them (`OFL.txt`, `LICENSE*`, the family's README),
and lists it in `fonts/README.md` with where it came from and its licence.
When the folder has no licence file, the licence the font itself states is
written to `LICENSE-from-font.txt`.

Licences are read, not guessed at, and nothing is refused: a font whose
licence does not allow sharing is copied with a warning, because you may only
want the deck on your own machines.

- The well-known system fonts (Arial, Helvetica, Segoe UI, SF Pro, Calibri,
  Cambria, Consolas, Times New Roman, Menlo…) come with Windows or macOS and
  cannot be shared. The warning names an open alternative, often one with the
  same metrics, so text keeps its layout: Arimo for Arial and Helvetica,
  Carlito for Calibri, Tinos for Times New Roman, Inter for Segoe UI and
  SF Pro, JetBrains Mono for Consolas and Menlo.
- A licence file or font that says it may not be redistributed, or a font that
  forbids embedding, gets the same warning.
- A font with no licence anywhere is copied with a reminder to check.

`set` writes the theme token (`--inkflow-body-font`, `-heading-font`,
`-mono-font`) in your `styles.css`, as the editor's Theme dialog does: a bare
family gets a generic fallback after it (`Inter, sans-serif`), a whole stack is
kept as written, and a generic family first is refused with a hint. With an
editor open, `bundle` and `set` are one undoable *Agent: …* step there.

## Packing the deck

```bash
inkflow pack --dry-run          # what it would do
inkflow pack                    # do it
inkflow pack --with-pdf-pages   # also commit PDF figures' pages as SVG
inkflow pack --zip talk.zip     # then zip the deck for someone without git
```

`inkflow pack` makes the deck self-contained, printing each change:

1. **Fonts**: the `machine` fonts bundled into `fonts/`, as above.
2. **Outside files**: every file the deck names outside its folder, or
   through a symlink, is copied in (pictures and data to `assets/`, layouts
   to `layouts/`, overlays to `overlays/`, slides to `slides/`, names kept
   unique), and every reference to it is rewritten where it is written, the
   way [renaming a file](../editor/index.md#renaming-files) rewrites them,
   always as a relative path. A copied SVG or Markdown file's own references
   come along too. Links (`<a href>`, Markdown links) are left alone; theme
   and inkflow files are not copied (they come with the pinned version).
3. **Versions**: `pyproject.toml` pins inkflow (`inkflow~=X.Y.Z`) and a
   pip-installed theme the deck uses, in the nearest `pyproject.toml` or a new
   one in the deck's folder, and `uv lock` runs when there is no `uv.lock`
   (with uv installed; offline it says so and you run it later).
4. **Git rules** in the deck's `.gitattributes`: LF line endings for its text
   sources (`*.svg`, `*.md`, `*.py`, `*.css`, `*.csv`, `*.json`, `*.txt`, one
   rule each), the SVG diff driver line, and Git LFS rules for media and fonts.
   Rules already there (including a repository-wide `* text=auto eol=lf`) are
   not added again, and a deck that chose *git only* (`# inkflow: lfs off`)
   keeps that choice.
5. **PDF figures** (`--with-pdf-pages`): each page a slide shows is converted
   now and committed beside its PDF (`figure.pdf` page 1 is
   `figure.pdf.p1.svg`). References still name the PDF; the build uses the
   committed page while the PDF is the one it was drawn from (its hash is
   stamped in the page), so a clone needs no converter and every machine
   draws the figure the same. A changed PDF converts again as usual.

With an editor open, packing is one undoable step there (the lock file
included). Afterwards it lists what still depends on the machine:

- generic or missing fonts (pick a font with `inkflow fonts set`);
- pictures read from the web (`https://…`): they need internet access;
- emoji and formulas, when no font in the deck or the theme draws them;
- PDF figures without committed pages, which need a PDF converter to build;
- the tools a build needs: `inkflow build` needs nothing else, `inkflow
  export` (PDF) needs Chromium or Chrome, and ffmpeg is never needed to build.

`--zip FILE` zips the packed deck's source tree: what git would hand over
(tracked and untracked files that `.gitignore` does not ignore), Git LFS files
with their real content, without `.inkflow/` and build output.

## Checks

`inkflow verify` ends with the deck-wide checks, one warning each: a font from
this machine (`font "Arial" comes from this machine (C:\Windows\Fonts\arial.ttf):
inkflow fonts bundle, or pick an open font`), a missing font, a generic family
first, files outside the deck or behind a symlink, pictures from the web, no
pinned inkflow, no `uv.lock`, no line-ending rules. `--no-portable` skips them.
`inkflow render --check` does not repeat them.

In the editor, the Theme dialog lists where each font comes from, and a commit
asks to pack first when packing would change something (see
[Version control](../editor/index.md#version-control)).

## New decks start self-contained

`inkflow init` and the editor's new decks write the line-ending rules, run
`uv lock` when uv is installed (a note when offline), and copy into `fonts/`
any font the chosen look names that only this computer has.
