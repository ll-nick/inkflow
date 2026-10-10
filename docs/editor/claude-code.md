# Editing with Claude Code

Because a deck is plain files, an agent can edit it as easily as you can. Inkflow
connects the two: run [Claude Code](https://claude.com/claude-code) in a terminal
next to the visual editor, select something on a slide, and ask for what you want.
Claude knows what "this" is, edits the same files, and the editor shows the result
live.

## Setup

Once per project:

```bash
inkflow setup-claude
```

This adds two things under `.claude/`:

- a **prompt hook** in `settings.json` that runs `inkflow context --hook` before
  each prompt, so Claude sees the editor's current slide and selection;
- an **`inkflow` skill** describing the deck's files, the Python DSL, the theme's
  colour classes and how to check results.

Existing settings are kept, and running it again changes nothing.

## Working together

```bash
inkflow edit        # the editor, in your browser
claude              # Claude Code, in a terminal in the same project
```

Select the objects you mean, then ask:

> make these the same width and align their tops

> reveal these one per click, sliding in from the left

> turn the bullet list on this slide into a three-step diagram

> write speaker notes for this slide, about a minute's worth

> split this slide in two at the second heading

Claude reads the selection (file, element ids, positions and text), edits the SVG,
Markdown or `deck.py`, and the editor re-renders. Anything it changes is an ordinary
file change: review it with `git diff`, undo it with `git`, or keep editing by hand
right away.

## The commands behind it

| Command | What it does |
|---|---|
| `inkflow outline` | Prints what is on every slide in a few lines each: its files and layout chain, each zone with where its text is written and how it starts, the animations and clicks. `--slide N` shows one slide in full (zone texts and boxes, canvas size, element ids to animate, animations as `deck.py` writes them); `--json` for the whole structure. Claude starts here instead of reading every file. |
| `inkflow context` | Prints what the editor has selected right now (`--json` for the raw data). |
| `inkflow render` | Writes PNGs of slides at any build step to `.inkflow/render/`, the editor's current slide by default (`--slide N`, `--all`, `--step S`), and reports layout problems. Claude looks at them to check its own work. `--sheet` puts the slides on one contact sheet; `--check` only measures (see below). `--boxes` prints where the browser drew every element instead ([below](#placing-against-real-text)). |
| `inkflow verify` | Checks the deck for authoring mistakes. |
| `inkflow goto N` | Shows slide `N` in the editor open on this deck. |
| `inkflow select ID…` | Selects elements by id in the editor open on this deck, so Claude can point at what it means. |
| `inkflow slide …` | Adds, deletes, duplicates, moves, hides, shows, renames or retitles slides, with their files (below). |
| `inkflow shape …` | Draws on a slide as the editor does: shapes, text boxes, pictures, charts, and arrows attached to shapes, routed exactly where the editor routes them ([below](#shapes-and-arrows)). |
| `inkflow anim …` | A slide's whole click timeline (Markdown reveals and `animations=[...]`, numbered as the build numbers them), and adding, changing, reordering or removing its animations as undoable steps ([below](#animations-from-the-command-line)). |
| `inkflow find TEXT` / `inkflow replace TEXT NEW` | The editor's Find and Replace: every match on the slides with where it is, and a replace that is one undoable step ([below](#finding-and-replacing-text)). |
| `inkflow worktree …` | A copy of the deck on a branch of its own for Claude to work in, merged when you like it ([below](#working-on-a-branch)). |
| `inkflow compare [LEFT] RIGHT` | Which slides differ between two versions: the working copy, a revision (`main`, `HEAD~2`) or a deck folder. One line per slide that differs (`~ 3 features: slides/features.md, notes`, `+ 4 compare`, `- 7 morph`, `↕ 5 → 6 media`); `--json` adds the changed elements; `--sheet` writes side-by-side images of only those slides (see [Comparing two versions](compare.md)). |

With several editors running, `goto` and `select` find the right one from the
deck's `.inkflow/context.json`.

## Finding and replacing text

`inkflow find` and `inkflow replace` search exactly what the editor's Find
dialog searches: the text in each slide's drawings (and in the project's
layouts and overlays it is built on), its Markdown and speaker notes, and in
`deck.py` only author text (titles, `zones={...}` text, `Inline(...)`), never
code. Each match is one line: the slide it shows on, the file and where in it
(an SVG text's `#id`, a Markdown line and its zone), and the match in brackets
with some context:

```text
$ inkflow find widget
slide 1 (drawn): slides/drawn.svg #label: "Blue [widget]s"
slide 2 (intro): slides/intro.md:3 [content]: "All about [widget]s."
slide 1 (drawn): deck.py: "[Widget]s"
3 matches on 2 slides
```

| Option | |
|---|---|
| `--regex` / `--case` / `--word` | A regular expression (`NEW` may use `\1`, `\g<name>`), match case, whole words. |
| `-s SLIDE` | Only that slide's files, and only its own text in `deck.py`. A layout's text changes on every slide built on it. |
| `--dry-run` | (`replace`) Each match with what it would become; nothing is written. |
| `--json` | (`find`) The matches as JSON. |

`replace` replaces every match in one step: with the editor open, that step
is *Agent: Replace "widget" with "gadget"* in its undo history, like the
editor's own Replace All; otherwise the files are changed directly. It prints
every file it wrote.

## Animations from the command line

A slide's clicks come from two places: reveals in its Markdown (`::step::`,
`::steps::`, code highlight stages), which come first, and `animations=[...]`
in `deck.py`, numbered on from them. `inkflow anim list -s N` prints them as
one timeline, exactly as the build resolves the triggers:

```text
$ inkflow anim list -s 3
slide 3 (drawn): 3 clicks
  click    #  animation                target                       trigger timing
      1    -  FadeIn                   zone-content "Second point"  click   0.4s
      2    -  FadeIn                   zone-content "Third point"   click   0.4s
      3    1  FadeIn                   #box                         click   0.4s
      3    2  SlideIn direction=up     #label                       with    0.4s +0.2s
  (- = a Markdown reveal: change it in the .md; # = an animations=[...] entry)
```

The `#` column numbers `animations=[...]`; the other commands take it:

| Command | What it does |
|---|---|
| `inkflow anim add -s N TYPE TARGET [--trigger click\|with\|after\|at:N] [--duration MS] [--delay MS] [--easing E] [--direction D] [--set NAME=VALUE] [--at INDEX]` | Animates `TARGET` (an element id, a chart series `chart-series-sales`, a drawn-in diagram's cell; for `PlayVideo`, the video's zone). `TYPE` is an animation class (`FadeIn`, `SlideIn`, `ScaleOut`, `Highlight`, `PlayVideo`, or one the deck defines) or its kebab-case name (`fade-in`). Durations are milliseconds (`400`) or seconds (`0.4s`). |
| `inkflow anim set -s N INDEX [--type T] [--target ID] [--trigger …] [--duration …] …` | Changes one animation; fields not given keep their values. |
| `inkflow anim move -s N INDEX --to INDEX` | Moves it to another place in the list. |
| `inkflow anim remove -s N INDEX…` | Removes animations, all in one step. |

Types, fields and targets are checked against the deck itself: a misspelt type
or id is refused with the nearest names. Each change is made through the same
session action as the editor's Animation panel, so with the editor open it is
one undoable *Agent: …* step there, and the new timeline is printed after it.

## Changing the slide list

A slide is more than its `Slide(...)` line in `deck.py`: it has its own drawing,
Markdown, notes and saved ink, and some of those files are named after the
slide's id. `inkflow slide` makes each change the way the editor's slide list
does, so nothing is left behind or orphaned:

| Command | What it does |
|---|---|
| `inkflow slide add --layout content [--after N] [--id NAME] [--title T] [--md TEXT]` | A new slide with its own drawing on that layout (`--like N`: the layout of slide `N`), after slide `N` (`0`: first; default: last). `--title` and `--md` (`-` reads stdin) become its `slides/<id>.md`. |
| `inkflow slide delete N [N…]` | Removes the slides, with the drawing, Markdown, notes and ink only they use (`--keep-files` leaves those). |
| `inkflow slide duplicate N` | A copy right after it, with copies of its own files. |
| `inkflow slide move N --to M` | Moves slide `N` so it becomes slide `M` (in the section of the slide it lands before). |
| `inkflow slide move N --section S [--to M]` | Moves it into section `S`: at its end, or as slide `M` within it. |
| `inkflow slide section add NAME --at N` | A [section](../authoring/slides.md#sections) starting at slide `N`; it takes the rest of that slide's section (no `--at`: an empty one at the end). |
| `inkflow slide section rename S NEW` | Renames a section. |
| `inkflow slide section move S --to K` / `--before S2` | Moves a section, with its slides, among the sections. |
| `inkflow slide section remove S [--with-slides]` | Removes it; its slides join the section before it, or with `--with-slides` are deleted like `slide delete`. |
| `inkflow slide hide N` / `show ID` | Sets or clears `visible=False`. |
| `inkflow slide rename N NEW_ID` | Sets `id=`; its ink file and every `slide:<old id>` link follow. |
| `inkflow slide rename-files N NAME [--keep-id] [-n]` | Renames the slide's own drawing, Markdown, notes and ink file to `NAME` (each in its folder); its id becomes `NAME` (unless it has an `id=`, or `--keep-id` writes the old one), and every reference and `slide:` link follows. |
| `inkflow slide title N TEXT` | Sets `title=` (`""` removes it). |

A slide is named by its number, counted as the presenter and `inkflow goto` count
(1-based, hidden slides left out), or by its id; a hidden slide goes by its id.
A section is named by its name (any case) or its 1-based position among the
sections. `inkflow outline` lists slides under a `## <section>` line per section.
Each command prints the files it wrote, created, renamed or deleted, and
`deck.py` keeps its comments and formatting.

When the editor (or `inkflow serve`) has the deck open, the change is made by
that server, as one step in the editor's undo history: the editor shows
*Agent: Delete slide 3 (interface)* with an **Undo** button, and
<kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it back like any of your own edits. Without a
server the files are changed directly, and `git` is the undo. The editor keeps its state in `.inkflow/` in the project, which ignores itself in
git and is not watched for changes. `render` needs Chromium or Chrome, like
`inkflow export`; one installed by Playwright is found too.

## Renaming and moving files

Never rename or move a deck's file with `mv` or `git mv`: slides name it by
path (an `<image href>`, a Markdown image, `Image("…")` in `deck.py`, a
layout's `inkflow:parent`), and those references would break. `inkflow mv`
moves the file and rewrites every reference in one step, each resolved
relative to the file it is written in:

```bash
inkflow mv assets/IMG_0042.jpg assets/team-photo.jpg   # the extension may be left out
inkflow mv data/chart-3.csv data/revenue -n            # --dry-run: print the edits only
inkflow mv diagrams/diagram-2.drawio.svg figures/      # into a folder, keeping its name
inkflow mv layouts/two-col.svg layouts/compare.svg     # parent="two-col" becomes "compare"
inkflow slide rename-files 4 architecture              # slide 4's drawing, md, notes, ink
```

`OLD` and `NEW` are relative to the current folder (or the project); `NEW` may
be a folder, a new one is created, and one left empty is removed. The
extension never changes. A slide whose id came from the renamed file's name
(`slides/intro.md` gives `intro`) takes the new one, and its ink file and
`slide:` links follow. `--dry-run` lists every reference it would rewrite.
With the editor open, the rename is one *Agent: …* step there, undone with
<kbd>Ctrl</kbd>+<kbd>Z</kbd>. A path built in code in `deck.py` cannot be
followed: the command warns when `deck.py` still names the old file.

## Fonts and a self-contained deck

A deck should look the same on every machine that clones it. These commands
show and fix what ties it to this one (see
[A deck that looks the same everywhere](../presenting/portable.md)):

```bash
inkflow fonts                    # where each font comes from: project, theme,
                                 # machine (path), missing, generic
inkflow fonts --json             # the same, machine-readable
inkflow fonts bundle             # copy this machine's fonts into fonts/ (+ licences)
inkflow fonts set body Inter     # the body/heading/mono token, bundled if needed
inkflow pack --dry-run           # everything pack would change
inkflow pack                     # fonts, outside files, pyproject + uv.lock,
                                 # .gitattributes rules; then what remains
inkflow pack --zip talk.zip      # and a zip of the deck's source tree
```

`fonts bundle`, `fonts set` and `pack` go through the editor when it is open:
each is one *Agent: …* step there, undone with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
`inkflow verify` warns about each font from this machine, generic-first
stacks, files outside the deck, a missing `uv.lock` or line-ending rules.

## Shapes and arrows

`inkflow shape` makes the change the editor makes for the same click, through
the same editor actions. Claude uses it instead of writing SVG by hand, so an
arrow's path is exactly the one the editor would draw (and follows its shapes
when they move), a text box is its zone and its Markdown written together,
ids stay unique, and renaming an object keeps its arrows and animations
attached. With the editor open, each command is one step in its undo history
(*Agent: Connect plan to build on slide 3 (flow)*), like `inkflow slide`.

| Command | What it does |
|---|---|
| `inkflow shape list [-s N] [--json]` | The slide's own objects: id, kind, box in slide units, text, and each arrow's ends (`plan:right -> build:left`), flagged `STALE` when they no longer meet their shapes; then the ids of its layout and overlays. |
| `inkflow shape add rect\|ellipse [--at X,Y] [--size W,H] [--id ID] [--text T]` | The editor's shape; with `--text`, text in it: it becomes the text zone `zone-ID`, its text a section of the slide's Markdown. `--fill`/`--stroke` take a theme colour (`accent`, `surface`, …) or `#hex`. |
| `inkflow shape add textbox --text T` | A wrapping Markdown text box: a `zone-text` rect and its `::text::` section, in one step. |
| `inkflow shape add text\|line\|arrow\|image\|chart …` | An SVG `<text>` line; a line or arrow with free ends (`--from X,Y --to X,Y`); a picture (`--src FILE`; `--drawio inline` draws a draw.io diagram into the slide); a chart (`--data data/x.csv --chart line`). |
| `inkflow shape connect A B [--style elbow] [--from SITE] [--to SITE]` | An arrow attached to two shapes, zones or shapes of a drawn-in draw.io diagram (`<diagram id>-<cell id>`). A site is a side (`top`) or a point along one (`top@0.25`); without them, the nearest pair the shapes offer. `--arrow end\|start\|both\|none`, `--bend x:640` for an elbow's middle segment. |
| `inkflow shape sites ID N` | Offers `N` connection points per side. |
| `inkflow shape move\|resize\|align\|distribute …` | Moves (`--by DX,DY`, `--to X,Y`), resizes (`--size W,H --anchor center`), aligns (`left`, `middle`, …; one object: on the slide) or spaces objects; their arrows follow, as when you drag them. |
| `inkflow shape style\|text\|rename\|delete\|duplicate\|group\|ungroup\|order\|lock\|unlock\|hide\|show\|link …` | The rest of the editor's object panel: colours, opacity, text, a new id (arrows and animations follow), deleting (a zone's text goes too), copies, groups, stacking order, locking, hiding, links (`slide:<id>`, a number, a URL). |
| `inkflow shape reroute [IDs] [--all]` | Puts arrows back on their shapes after the shapes moved elsewhere (Inkscape, draw.io, a hand edit): the editor's **Re-route all**, for one slide or every slide. |
| `inkflow shape batch [FILE]` | A JSON list of commands (from stdin) as one step: one undo, one rebuild, nothing changed if one is refused. |

```bash
inkflow shape batch -s 3 <<'EOF'
[{"add": "rect", "id": "plan", "at": [160, 420], "size": [320, 140], "text": "Plan"},
 {"add": "rect", "id": "build", "at": [800, 640], "size": [320, 140], "text": "Build"},
 {"add": "rect", "id": "ship", "at": [1440, 420], "size": [320, 140], "text": "Ship"},
 {"connect": ["plan", "build"], "style": "elbow"},
 {"connect": ["build", "ship"], "style": "elbow"}]
EOF
```

Every command takes `-s/--slide` (a number or an id; without it, the slide
open in the editor) and `--json`. A slide drawn straight from a shared layout
first gets a drawing of its own, as when you draw on it in the editor; objects
of layouts and overlays are refused (arrows may still attach to them).

The routing runs without a browser: `inkflow shape` has a Python copy of the
editor's connector maths, held to the editor's by a shared set of cases both
test suites check, and computes each shape's box from the SVG the way the
browser does (transforms, cropped pictures, zones, draw.io shapes, curves).
Only a plain SVG `<text>` has no exact box without a browser, so arrows attach
to shapes and text boxes, not to `<text>`. `inkflow verify` warns about arrows
whose shapes moved since they were routed, naming `inkflow shape reroute`.

## Working on a branch

For a bigger change, a proposal you may not want, or two variants to choose
from, let Claude work on a branch in a separate folder, a
[git worktree](https://git-scm.com/docs/git-worktree), while your deck and
editor stay exactly as they are:

> make a version of this deck with a bolder colour scheme on a branch, so I can compare

1. Claude runs `inkflow worktree add bolder`: a new branch `deck/bolder` from
   the deck's last commit, checked out in `.inkflow/worktrees/bolder` at the
   top of the repository (ignored by git, and not watched by your editor's
   server, so nothing Claude writes there reaches your slides).
2. It works only there, passing `--deck .inkflow/worktrees/bolder/…/deck.py`
   to every `inkflow` command, and commits on that branch.
3. You review it: **Compare** in the editor's Git menu shows its slides next to
   yours (or `inkflow compare`), or open it in a second editor with
   `inkflow edit --deck <its deck.py>` (it takes the next free port).
4. **Merge** it into your branch, or **Remove** it.

You can also start it yourself: Git menu → **New worktree for an agent…** asks
for a name and shows what to tell Claude (with a Copy button), or the command to
start a new Claude Code session inside the worktree. Uncommitted changes to
your deck are not in a new worktree, which starts from the last commit, so
commit first if Claude should build on them.

| Command | What it does |
|---|---|
| `inkflow worktree add NAME [--base REV]` | Branch `deck/NAME` from `REV` (default: the deck's last commit) in `.inkflow/worktrees/NAME`; prints its `path:` and the `deck:` to pass as `--deck`. An existing `deck/NAME` branch is checked out as it is. |
| `inkflow worktree list` | Every worktree of the repository: branch, commits ahead of and behind your branch, uncommitted changes. |
| `inkflow worktree merge NAME` | Merges its branch into your deck's branch: a fast-forward when your branch has not moved, else a merge commit. Refused while your deck has uncommitted changes; a conflict is aborted (nothing merged) and the files named. |
| `inkflow worktree remove NAME [--force]` | Removes the folder, and the `deck/NAME` branch once merged. Uncommitted changes or unmerged commits there are refused unless `--force`. |

Claude does not merge or remove a worktree unless you ask it to.

## Reviewing a branch

An agent working on a branch (or in its own git worktree) can review what it
changed before handing over:

```bash
inkflow compare main .            # main on the left, this folder on the right
inkflow compare main . --sheet    # .inkflow/render/compare.png: before | after
```

The author sees the same in the editor's compare view
(**Git → Compare…**, or `inkflow edit --compare <branch or folder>`), takes
slides over one by one, or merges the branch.

## Checking the layout

`inkflow render` measures each slide in the browser while it renders it, and
prints a line for each layout problem it finds:

```text
slide 2 (features): #zone-content: text overflows its zone by 232px (bottom)
slide 3 (interface): #zone-content: code block is cut off by 528px (right)
slide 8 (morph): #logo: lies 40px outside the slide (right)
slide 8 (morph): #lost: lies entirely outside the slide (right), so it is not shown
slide 3 (interface): #zone-content: text 10px tall is likely too small to read (below 13.5px): "tiny footnote"
slide 1 (title): #subtitle: contrast 2.4:1 against its background (needs 3:1): #8839ef on #203341 "Your editor, your style."
```

Lengths are in slide units, the numbers in the SVG. A zone's text is compared
with the zone's box; a drawn object with the slide's edges, except a background
or a band spanning the whole slide, and anything clipped on purpose (a crop, a
media zone). Small text (below 1/80 of the slide's height) is a hint, the rest
are problems.

**Contrast** is measured against what is really behind each piece of text, in
the rendered slide: the slide is shot once as shown and once with its text made
transparent, and the background is read where the letters are. So text over a
photo, a gradient or a coloured box is judged by the pixels behind it, in the
deck's colour mode and with its theme's colours. The worst tenth of those pixels
decides, so a light patch behind white letters is found but a few anti-aliased
edges are not; a thick outline of another colour (a halo) is what the text is
read against, and a text shadow counts where it helps. Below 3:1 is a problem
for any text; between 3:1 and 4.5:1 is a hint for text smaller than 24px on a
1080px-tall slide (18.66px bold), the WCAG size for large text. The check takes
two more screenshots per slide (about 0.2 s); `--no-contrast` skips it.

```bash
inkflow render --check            # every slide, no images; exit 1 on a problem
inkflow render --sheet            # .inkflow/render/sheet.png: all slides in a grid
inkflow render --sheet -s 4 -s 5  # just these slides
```

A contact sheet labels each slide with its number and id, and flags the ones
with problems. It is at most 1600 px wide, with up to 16 slides per image
(`sheet-1.png`, `sheet-2.png`… for a longer deck), so one image shows the flow of
the deck. Every render runs in a single browser, so `--all`, `--sheet` and
`--check` take a few seconds for a whole deck.

## Placing against real text

The boxes in an SVG say where a zone *is*, not where its text ends. To size or
line things up against what is really drawn, `inkflow render --boxes` prints
every element's box as the browser renders it, in slide units after
transforms, one line each (`--json` for everything):

```text
slide 2 (features): 1920x1080
zone-title  80,60 1760x120  zone  "Features"  content 300.1x80, free 40
  zone-title/1  80,63 300.1x80  h1  "Features"
zone-content  80,220 1760x740  zone  "Draw in any SVG editor…"  content 1288.7x566.5, free 173.5
  zone-content/1  80,224 1180x91.4  p  "Draw in any SVG editor…"
  zone-content/2  80,342.8 1288.7x91.4  p  "Slides from Markdown…"
box-svg  89,322.5 357.9x157.9  g
  rect-svg  89,322.5 357.9x157.9  rect
```

Each element with an id is listed, nested under the listed element it is in. A
zone shows the extent of its content and the height left free in it (negative
when the text overflows); under it, each block of its text (paragraph, heading,
list, code, table, picture) as `zone/N` with the extent of its *text*, not the
full width its box takes. Only boxes are measured, no image is written unless
`--output` is given, and it costs nothing noticeable on top of a render (about
0.13 s per slide for the demo deck, browser start included). `inkflow outline
--slide N --boxes` appends the same lines to a slide's outline.

