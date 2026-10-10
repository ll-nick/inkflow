---
name: inkflow
description: Edit this inkflow presentation (slides drawn as SVG, content in Markdown, order/animations/transitions in deck.py). Use for any request about the slides, the deck, a slide's layout, text, images, animations, transitions or speaker notes, and whenever the author refers to "this", "these" or "the selected" thing in the inkflow editor.
---

# Editing an inkflow deck

The deck is plain files, edited by the author in the visual editor
(`inkflow edit`, served at `http://localhost:7777/edit`) and by you, at the
same time. The server watches every file: whatever you write shows up in the
author's editor within a moment, and whatever they change there is already on
disk when you read it. Re-read a file before editing it, since the author may
have just changed it.

## Start with `inkflow outline`

`inkflow outline` prints the whole deck in a few lines per slide: number, id,
position in deck.py (`slides[i]`), its SVG/layout chain, `.md` and notes
files, then each zone with where its text lives (`md` = the slide's `.md`,
`deck.py` = `zones={...}`, `empty`) and the animations and clicks.
`inkflow outline -s N` adds full zone texts, zone boxes and the canvas size
(to place shapes), the element ids animations can target, and each animation
as deck.py writes it. Read it instead of opening every file; open only the
files you change. `inkflow layouts` lists every layout with its zones.

To place or size something against text, use the boxes the browser actually
drew, not guesses: `inkflow render --boxes -s N` prints each element's box in
slide units (`id  x,y wxh  kind  "text"`), each zone with its content's extent
and free height, and each block of a zone's text (`zone-content/2  …  p`) with
the extent of its text.

## Posters and page sizes

A deck may be a poster or any other size: `Deck(size="a0")` (also `"a1"`,
`"a0-landscape"`, `"9:16"`, `PageSize.mm(600, 900)`; the header of
`inkflow outline` shows it). New slides take its canvas (A sizes: 3179x4494
units). Posters use the `poster-*` layouts (zones `title`, `authors`,
`affiliations`, `logos`, `col-1`… , `references`, `contact`); on a print deck
`inkflow render --check` reports text too small to read on paper (in pt) and
pictures under 150 dpi at their printed size; `inkflow export` writes the PDF
at the printed size.

## What the author is looking at

`inkflow context` prints the editor's current slide, build step and
selection: each selected object's id, tag, source file and position. A prompt
hook adds the same text to each message while the editor is open, so "align
these", "make this blue" or "animate the selected boxes" refer to that
selection. Run it again whenever you need the current state.

Point the author at something with `inkflow goto N` (1-based slide number)
and `inkflow select ID [ID…]` (selects elements on the current slide).

Add, delete, duplicate, move, hide/show or re-id slides with `inkflow slide …`
(`inkflow slide --help`), not by editing `slides=[...]` by hand: they move the
slide's Markdown, notes, drawing and ink files along, and with the editor open
each is a step the author can undo there.

Rename or move a deck's files with `inkflow mv OLD NEW` (`-n` to preview) and a
slide's own files with `inkflow slide rename-files N NAME`, never by hand: every
reference to the file is rewritten with it, which a plain `mv` would break.

A deck must look the same on every machine: `inkflow fonts` says where each font
comes from (`machine`/`generic`/`missing` are not portable); set fonts with
`inkflow fonts set body|heading|mono FAMILY` (never a generic family first) and
run `inkflow pack` (fonts, outside files, lock file, git rules) before handing over.

Sections (`Section("Method", slides=[...])` entries in `slides=[...]`) group
slides by name: `inkflow slide section add NAME --at N`, `section rename`,
`section move`, `section remove`, and `inkflow slide move N --section NAME`.
`inkflow outline` shows them as `## <section>` lines.

To find or change wording across the deck, `inkflow find TEXT` lists every
match (slide, file, `#id` or Markdown line and zone) in SVG text, Markdown,
notes and deck.py's titles/zone text, and `inkflow replace TEXT NEW` changes
them all as one undoable step (`--regex`, `--case`, `--word`, `-s SLIDE`,
`--dry-run` first when unsure).

## Files

- `deck.py`: `main()` returns `Deck(slides=[Slide(...), ...])`. Slide order,
  each slide's source, its `md=` content, `zones={...}`, `animations=[...]`,
  `transition=`, `notes=`, `title=`, `visible=`.
- `slides/*.svg`: one-off slide drawings. `inkflow:parent="<layout>"` on the root
  builds the slide on a layout. Elements need an `id` to be animated or morphed.
- `layouts/*.svg`, `overlays/*.svg`: shared backgrounds and chrome. A change
  here changes every slide that uses it; say so before doing it.
- `slides/*.md`: Markdown routed into a layout's zones (`::zone::` markers;
  a leading `# Title` fills the title zone; `::step::` reveals on click).
- `notes/*.md`: speaker notes.
- `ink/<slide id>.svg`: what the author drew on that slide with a pen (the
  editor's pen tool, or the presenter's ink mode with "Keep"), painted on top
  of the slide. One filled `<path id="ink-…">` per stroke, directly under the
  root; `Slide(ink="…")` names another file. Leave the strokes' outlines alone
  (they are hand-drawn shapes, not something to tidy); deleting a stroke, or
  the whole file to clear the slide, is fine. To change a slide's id, use
  `inkflow slide rename`, which moves its ink file and `slide:` links along.

Colours: prefer the theme's classes over hex values so slides follow dark and
light mode: `class="inkflow-fill-accent"`, `inkflow-stroke-text`, and so on
for `bg surface border text text-muted accent accent-fg code-bg code-text red
orange yellow green teal blue purple pink grey`.

## Common tasks

- **Add a slide with text on a layout**: `inkflow slide add --layout two-cols
  --after 3 --id compare --md -` with the Markdown on stdin (it becomes
  `slides/compare.md`; the id names the files). A leading `# Title` fills the
  title zone, the text after it the default zone (`content`), and a
  `::<zone>::` line starts another zone:

  ```markdown
  # Before and after

  ::left::

  - Slides in a binary file

  ::right::

  - Plain text in git
  ```

  Layouts: `content`, `two-cols` (left, right), `three-cols`, `comparison`,
  `media-left`/`media-right` (content, media), `quote`, `section`, `center`,
  `cover`, `end`… (`inkflow layouts` for all of them and their zones).
- **Reorder, hide, remove**: `inkflow slide move compare --to 2`,
  `inkflow slide hide 9` (kept, not shown), `inkflow slide delete 9`. Slides
  are named by number or id; numbers (`outline`, `render -s`, `goto`) count
  visible slides only, so prefer ids across several commands.
- **Reveal on click**: in Markdown, a `::step::` line shows what follows on the
  next click; inside `::steps::` … `::steps end::` each list item comes on its
  own click. Drawn elements: `animations=[...]` (below).
- **Picture**: on a layout with a `media` zone,
  `zones={"media": Image("assets/photo.jpg")}`; in Markdown,
  `![alt](../assets/photo.jpg)` (relative to the `.md`).
- **Theme**: `Deck(theme=Paper())` (quiet white document look) or
  `Deck(theme=Stage())` (big bold keynote type), both `from inkflow import`;
  no `theme=` is the default Catppuccin theme.
- **Light/dark and colours**: `Deck(mode=ColorMode.LIGHT)` (or `DARK`). Token
  overrides go in `styles.css` between `/* inkflow:theme */` and
  `/* /inkflow:theme */` (add both lines if missing):
  `:root { --inkflow-accent: #e8590c; }` for dark mode,
  `:root[data-theme="light"] { --inkflow-accent: #c2410c; }` for light.
  After changing `mode`, run `inkflow sync` (refreshes Inkscape previews).
- **Put it online**: `inkflow setup-pages github` (or `gitlab`; `--release`
  for HTML+PDF releases at tags `v*`) writes the CI file publishing the deck at
  every push; commit and push it, and on GitHub set Settings → Pages → Source
  "GitHub Actions" once.

## Animations and transitions (deck.py)

```python
from inkflow import Direction, Slide, Trigger, animations, transitions

Slide(
    "diagram.svg",
    animations=[
        animations.FadeIn("box-a"),  # next click
        animations.SlideIn("box-b", Trigger.WITH_PREVIOUS, direction=Direction.UP),
        animations.ScaleIn("arrow", Trigger.AFTER_PREVIOUS, scale=0.6),
        animations.Highlight("box-a"),  # emphasis
        animations.FadeOut("box-b"),
    ],
    transition=transitions.Morph(),  # Cut, Crossfade, Fade, Push, Cover, Wipe, Zoom
)
```

Steps are inferred from triggers; never number them by hand unless pinning
with `Trigger.at(n)`. Morph pairs elements by `id` across consecutive slides.

`inkflow anim list -s N` prints the slide's whole click timeline (Markdown
reveals first, then `animations=[...]` with its `#` index). Prefer these to
editing the list by hand; they check types and target ids and are undoable
steps in the open editor: `inkflow anim add -s N FadeIn box-a --trigger with
--duration 300` (`--direction`, `--delay`, `--easing`, `--set scale=0.6`,
`--at INDEX`), `anim set -s N INDEX --trigger after`, `anim move -s N INDEX
--to 1`, `anim remove -s N INDEX…`.

## Images and video (deck.py)

A zone is a `<rect id="zone-NAME">` in an SVG; `zones={"NAME": ...}` fills it.
To place a video anywhere, add such a rect to the slide's own SVG and fill it:

```python
from inkflow import Image, MediaFit, Muted, Slide, Video, animations

Slide(
    "demo.svg",  # contains <rect id="zone-video" x="200" y="200" width="960" height="540"/>
    zones={
        "video": Video("assets/clip.mp4", autoplay=True, loop=True, muted=Muted.ON),
        "media": Image("assets/photo.jpg", fit=MediaFit.COVER),
    },
    animations=[animations.PlayVideo("video")],  # or: start it on a click
)
```

Paths are relative to `deck.py`; keep media files in `assets/`.

A **PDF figure** (a plot or drawing from a paper) is used as it is, wherever a
picture goes: `<image href="../figures/plot.pdf#page=2" .../>` in an SVG,
`Image("figures/plot.pdf", page=2)` in `zones=`, `![](plot.pdf)` in Markdown.
No fragment means page 1. Always write the PDF's own path: the build converts
the page to SVG in `.inkflow/cache/pdf/` and the served slide shows it under
`_pdf/…` (with `data-inkflow-pdf` naming the PDF), but that cache is never a
source to reference or edit. A figure drawn for paper (black on transparent)
vanishes on a dark deck: give it `background="paper"` (`Image(...)`) or
`inkflow:background="paper"` (an SVG `<image>`) for a white card behind it.
A dashed placeholder box means no converter is installed
(`pip install "inkflow[pdf]"`, or poppler's `pdftocairo`).

A **chart** fills a zone the same way, plotted from a data file at build time
(keep data in `data/`; the first CSV row names the columns):

```python
from inkflow import Chart, ChartKind, Slide, animations

Slide(
    "demo.svg",  # contains <rect id="zone-sales" x="200" y="200" width="960" height="540"/>
    zones={
        "sales": Chart(
            "data/sales.csv",
            kind=ChartKind.LINE,
            x="quarter",
            y=["revenue", "cost"],
            title="Sales",
            labels=True,
        )
    },
    animations=[animations.FadeIn("sales-series-revenue")],  # one series at a time
)
```

Kinds: `BAR` (`stacked=`, `horizontal=`), `LINE`, `AREA` (`stacked=`),
`SCATTER`, `PIE` (`donut=`). `y_min=`/`y_max=` fix the value axis's ends;
`y2=["col"]` measures those columns on a second axis on the right (`y2_min=`,
`y2_max=`; not for stacked or horizontal bars). `Chart(data={"col": [...], ...})` writes the data
inline; `.tsv` and `.json` (records or columns) work too. Each series is the
group `<zone>-series-<column>` (pie slices `<zone>-slice-<category>`). In
Markdown, a ```` ```chart ```` block takes `key: value` lines (`kind`, `x`,
`y: a, b`, `title`, `stacked`, `horizontal`, `labels`, `legend`, `donut`,
`y_min`, `y_max`, `y2: c`, `y2_min`, `y2_max`, `id`, `aspect: 4:3`) and either `data: ../data/x.csv` (relative to the `.md`)
or a Markdown table. To change a chart, edit its data file; never edit the
drawn SVG.

A **draw.io diagram** is `diagrams/<name>.drawio.svg` (draw.io's editable SVG:
a picture with the diagram's `<mxfile>` source in the root's `content`
attribute, stored uncompressed), shown on a slide as an `<image href>`. To
change one, edit the `<mxGraphModel>` inside `content` *and* the drawing, or
better ask the author to open it in draw.io (double-click it in the editor).
`inkflow clean --stdout FILE` prints its source readably. With
`inkflow:drawio="inline"` (or `"themed"`: the deck's colours and fonts) on that
`<image>`, the build draws the diagram into the slide instead of its picture;
each draw.io cell is then an element named `<image id>-<cell id>` that
`animations=[...]` can target (`FadeIn("flow-client")`) and an arrow can
attach to (`inkflow shape connect box flow-client`). Change a diagram's
shapes in its `<mxGraphModel>` (geometry, `value`, `style`), never in the
picture alone: draw.io redraws the picture from the source.

## Shapes, arrows and text boxes: `inkflow shape`

Draw with `inkflow shape …` (`inkflow shape --help`) rather than by editing
SVG: each command makes the change the editor makes for the same click, so
ids stay unique, an arrow's path is routed exactly where the editor routes it
(and follows its shapes when they move), a text box gets its zone and its
Markdown together, a renamed object keeps its arrows and animations, and
with the editor open every command is one step the author can undo there.
`-s SLIDE` (number or id) picks the slide, default the one open in the
editor; coordinates are slide units (`--at X,Y` is the top-left corner,
`--size W,H`). Objects go by id; a zone's `zone-` may be left off.

- `inkflow shape list -s 3` shows the slide's objects: id, kind, box, text,
  and each arrow's ends (`a:right -> b:left`), `STALE` when they no longer
  meet their shapes.
- `add rect|ellipse --text "Draft"`: a shape with text in it (it becomes the
  text zone `zone-<id>`, its text a `::<id>::` section of the slide's `.md`);
  `add textbox --text "…"`: wrapping Markdown text; `add text`: an SVG
  `<text>` line (no wrapping); `add line|arrow --from X,Y --to X,Y`;
  `add image --src FILE` (`--drawio inline` draws a draw.io diagram in, its
  shapes then named `<id>-<cell id>`); `add chart --data data/x.csv --chart line`.
  `--fill`/`--stroke` take theme colours (`accent`, `surface`, …) or `#hex`.
- `connect A B --style elbow` (straight, elbow, curved) attaches an arrow to
  two shapes, zones or draw.io shapes; `--from right --to top@0.25` picks the
  sites (a side, or `side@fraction` clockwise along it; default: the nearest
  pair), `--arrow end|start|both|none`, `--bend x:640` moves an elbow's middle.
  `sites ID 3` offers three connection points per side.
- `move ID… --by DX,DY` (or `--to X,Y`), `resize ID --size W,H`,
  `align ID… left|center|…|bottom`, `distribute ID… horizontal`: attached
  arrows follow. `style ID… --fill accent --stroke-width 2 --opacity 0.5`,
  `text ID "…"`, `rename ID NEW`, `delete ID…` (a zone's text goes too),
  `duplicate`, `group`/`ungroup`, `order ID front`, `lock`, `hide`/`show`,
  `link ID slide:<id>|URL`.
- `batch` reads a JSON list of commands from stdin and applies them as ONE
  step (one undo, one rebuild); later commands see what earlier ones made.
  Each object's first key names the command, its other keys are the options:

  ```bash
  inkflow shape batch -s 3 <<'EOF'
  [{"add": "rect", "id": "plan", "at": [160, 420], "size": [320, 140], "text": "Plan"},
   {"add": "rect", "id": "build", "at": [800, 640], "size": [320, 140], "text": "Build"},
   {"add": "rect", "id": "ship", "at": [1440, 420], "size": [320, 140], "text": "Ship"},
   {"connect": ["plan", "build"], "style": "elbow"},
   {"connect": ["build", "ship"], "style": "elbow"}]
  EOF
  ```

Reading existing files: an attached arrow is a `<path inkflow:connector="elbow"
inkflow:connect-start="a:right" inkflow:connect-end="b:left" d="…">`, a text box a
`<rect id="zone-text">` filled by a `::text::` section of the slide's `.md`.
Raw SVG edits remain fine for anything the commands don't cover (gradients,
paths, an element's own attributes); when you move shapes that way, run
`inkflow shape reroute -s N` afterwards so their arrows meet them again
(`inkflow verify` warns about arrows left behind).

## Colours and links

- Slide text belongs in the slide's `.md` file, not in `deck.py` (the shape
  commands and the editor put it there).
- Colour a few words with the theme palette:
  `<span class="inkflow-color-accent">words</span>` (any colour token).
- Link to another slide with `[label](slide:<id>)` in Markdown, or
  `inkflow shape link ID slide:<id>` for a drawn object; web links open in a
  new tab.
- Deck-wide colours and fonts: override `--inkflow-*` tokens in the project's
  `styles.css` (the editor's Theme dialog keeps them in one marked
  `/* inkflow:theme */` block; leave that block's markers intact).
- Fonts: Inter (text), JetBrains Mono (code), STIX Two Math (formulas) and
  Twemoji (emoji) ship with inkflow and look the same everywhere; text in
  `sans-serif`/`monospace` (Inkscape's default) shows in them. Another font
  must be a file in the project's `fonts/` to be portable (named in the
  `--inkflow-*-font` tokens or a `font-family`).
- `inkflow build` writes one self-contained `index.html` (pictures, videos and
  fonts inside); `--assets-folder` keeps the media as files beside it.

## Working on a branch

When the author asks for a proposal, a variant, an alternative, or to "work on
a branch", don't touch their deck:

1. `inkflow worktree add <name>` (short, kebab-case). It makes branch
   `deck/<name>` in `.inkflow/worktrees/<name>` and prints `path:` and `deck:`.
2. Work only there: `--deck <that deck.py>` on every inkflow command
   (`outline`, `slide`, `verify`, `render`…), edit only files under `path:`,
   and commit there (`git -C <path> add -A`, `git -C <path> commit -m …`).
   `inkflow context` still describes the author's editor on their own deck.
3. Commit when done and tell the author to review it with **Compare** in the
   editor's Git menu (or `inkflow compare`). They merge it themselves (Git
   menu, or `inkflow worktree merge <name>`); don't merge or remove a
   worktree unless asked.

## Check your work

1. `inkflow verify` for authoring mistakes (missing ids, zones, layouts,
   slides of another shape than the deck's size).
2. `inkflow render --check` measures every slide in a browser, without images,
   and prints one line per layout problem (`slide 3 (intro): #zone-content:
   text overflows its zone by 120px (bottom)`; also code blocks cut off,
   objects outside the slide, text too small to read, and text whose
   contrast with the pixels behind it is too low: `contrast 2.3:1 against
   its background (needs 4.5:1): #9ca0b0 on #eff1f5`), exit 1 on a problem.
   Fix what it reports: shorten text, enlarge the zone, move the object, or
   use a theme colour that stands out from what is behind the text (check
   both `mode`s if the deck may be shown in either).
3. `inkflow render --sheet` writes one contact-sheet PNG of all slides
   (labelled with number and id) to `.inkflow/render/sheet.png`: read it to
   check flow and consistency. `inkflow render` writes one PNG per slide (the
   editor's current slide by default; `--slide N`, `--all`, `--step S`) and
   prints the same findings. Overlapping objects are only visible in the
   images: look before you report back.
4. On a branch or in a worktree, `inkflow compare main .` lists the slides
   your work changed compared with main (`~` changed, with the files; `+`
   added; `-` removed; `↕` moved); `--sheet` writes them side by side
   (`.inkflow/render/compare.png`). Check it lists only what you meant to change.

Keep edits small and in the author's style: the files are diffed and committed
like code. SVGs are XML; keep existing ids and structure, and change only what
was asked.
