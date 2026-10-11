# Comparing two versions

The compare view shows two versions of a deck side by side and marks the
slides that differ: your working copy against an older commit, two commits,
your deck against an agent's branch while it works, or any two deck folders.
One editor builds both versions, so nothing else needs to run.

## Opening it

- **Git menu → Compare…** picks what to compare the working copy with: a
  branch or worktree, a commit from the deck's history (or any revision you
  type: `HEAD~2`, a tag, a sha), or another deck folder.
- **Git menu → History…** has a **Compare** button on every commit.
- From a terminal: `inkflow edit --compare main` (or a revision, or a folder
  with a `deck.py`) opens the editor straight in the compare view. If the
  editor is already open on that deck, it opens there.

Click either side's name in the header to show something else on that side
(the working copy, a commit, a branch, a folder): two commits are compared by
picking one for each side. **⇄** swaps the sides. <kbd>Esc</kbd> or **Close**
returns to editing.

## Reading it

The slide list pairs the two versions row by row, left | right:

| Mark | Means |
|---|---|
| amber **~** | changed: the slide looks different, or its files, notes or settings in `deck.py` differ |
| green **+** | only on the right |
| red **−** | only on the left |
| blue **↕** | the same slide at another place in the deck (with **~**: moved and changed) |

Slides are paired by their id, then by the file they are written in (a slide
whose id changed but whose Markdown file did not is the same slide), then by
identical content, and what is left by order, as long as the two are built on
the same layout. A slide that only moved because one was added before it does
not count as moved; neither does its page number changing.

**Only changes** hides the rows that are the same; <kbd>N</kbd> and
<kbd>P</kbd> jump to the next and previous change, <kbd>↑</kbd>/<kbd>↓</kbd>
step through the rows.

For the selected pair:

- **Side by side** (<kbd>1</kbd>), **Slider** (<kbd>2</kbd>: drag across the
  slide to wipe from one version to the other) and **Difference**
  (<kbd>3</kbd>: whatever is the same turns black, what changed lights up).
- **Outline changes** (<kbd>O</kbd>) draws a box around each element that
  changed (amber), was added (green) or removed (red, dashed): a shape that
  moved, a paragraph whose words changed, a new arrow. In the overlay modes the
  dashed box shows where it was.
- Below: the files that differ (`slides/features.md`, `data/sales.csv`, …),
  which of the slide's settings in `deck.py` differ (transition, animations,
  hidden, layout…), and the speaker notes with removed words struck through and
  new ones highlighted. The header also names deck-wide differences: theme,
  styles, colour mode, default transition, overlays.

Each version is drawn with its own deck's styles, so a commit from before a
theme change looks the way it did then. Both are shown in the colour mode the
editor's light/dark button is set to.

## Taking changes over

When one side is the working copy, **Take this slide** makes the other
version's slide yours:

- for a slide on both sides, its files (drawing, Markdown, notes, the layouts
  it is built on, its pictures and data) are written over the working copy's
  at their own paths, and its `Slide(...)` line in `deck.py` replaces yours;
- for a slide only on the other side, it is inserted at the same place, with
  its files.

It is one step in the editor's undo history: <kbd>Ctrl</kbd>+<kbd>Z</kbd> (or
**Undo** on the notice) takes it back. Editing is otherwise off while comparing.

When the other side is a branch (or a worktree on one), **Merge branch**
merges it into the working copy's branch. Commit or discard your own changes
first: git refuses a merge that would overwrite them.

## Reviewing an agent's branch

An agent working in its own git worktree (a second folder of the same
repository, on its own branch) changes files you are not editing. To see what it
did so far, open **Compare…** and pick its worktree, or run
`inkflow edit --compare ../talk-idea`. The view follows the worktree while the
agent works: each change it saves shows up within a moment. Take the slides
you want one by one, or merge the whole branch.

## Comparing with an older commit

**History… → Compare** on a commit shows what changed since, slide by slide.
The commit's files are read from git into `.inkflow/cache/compare/<sha>/`
(ignored by git, a few of the most recent kept); Git LFS pictures and videos
come out as files, from LFS or from your working copy when it has the same
file. Nothing is checked out or switched, so you can keep editing afterwards.

## Comparing two folders

Any two decks can be compared, say a copy of the talk you gave last year:
pick its folder under **Another deck folder**, or run
`inkflow edit --compare ~/talks/2025/deck.py`. A folder is watched while it is
compared. Folders outside the deck's own can only be compared from the computer
running `inkflow edit`.

## On the command line

`inkflow compare` prints the same comparison, one line per slide that differs:

```text
$ inkflow compare HEAD~1 .
680a4fc Initial demo ⟷ Working copy
~ 1 title: notes
~ 2 features: slides/features.md
~ 4 how-it-works: slides/how-it-works.svg
- 8 morph
↕ 7 → 8 animations
+ 9 compare
~ 10 charts: data/sales.csv
= 6 unchanged: 3, 5-7, 11-12
```

Each side is a revision (`main`, `HEAD~2`, a sha, a tag) or a deck (a
`deck.py`, or a folder with one, `.` for this one); with one side given, the
working copy is the left. A number is the slide's place in the presentation:
on the right for `~` and `+`, on the left for `-`, both for `↕`. To see what
your branch changes compared with main, put main on the left:
`inkflow compare main .` `--json` prints everything, including the changed elements and their
boxes. `--sheet` writes side-by-side images of only the slides that differ,
changed elements outlined, to `.inkflow/render/compare.png` (`-o` for another
file; long comparisons become `compare-1.png`, `compare-2.png`…). It needs
Chromium or Chrome, like `inkflow render`.
