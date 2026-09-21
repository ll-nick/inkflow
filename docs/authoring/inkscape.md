# Working in Inkscape

inkflow never opens your editor and never rewrites your SVGs while serving.
That keeps the pipeline simple, but it leaves a few gaps
between what Inkscape shows you and what the browser will show.

Four commands close them.
All of them are optional, and all of them are safe to re-run.

| Command | Closes the gap between |
|---|---|
| [`inkflow sync`](#previewing-the-full-slide-sync) | a bare slide file and the composed slide |
| [`inkflow label2id`](#naming-elements-label2id) | Inkscape's labels and SVG ids |
| [`inkflow colorize`](#theme-colors-in-the-editor-colorize-and-palette) | hardcoded hex fills and theme tokens |
| [`inkflow verify`](#checking-a-deck-verify) | a deck that looks fine and one that is |

## Previewing the full slide (`sync`)

A slide that inherits a [layout](../design/layouts.md) is mostly empty on its own.
The background, the frame and the zone positions all live in its ancestors,
and the [chrome](../design/overlays.md) lives in the overlays.
Open the file in Inkscape and you see none of it.

`inkflow sync` writes them in as locked layers:

```bash
inkflow sync
```

Bottom to top, a synced slide holds its ancestor chain, its own content, then the overlays.
You can see how much room the footer needs and where the content zone actually sits.

These layers are authoring reference only.
The pipeline strips them before serving, so they never reach the browser.

To find stale files without rewriting anything:

```bash
inkflow sync --check
```

It exits 1 if any file needs updating, which makes it usable in CI.

### Which overlays a file previews

`sync` works on files, but overlays are declared on slides,
and one layout can back many slides that disagree about their chrome.
The answer is resolved in three steps:

1. An explicit `inkflow:preview-overlays` attribute on the file wins.
   Space-separated names, or `""` for none.
2. Otherwise, what every slide backed by this file agrees on.
3. Otherwise the deck default.

`sync` prints which rule fired for each file, so the third is never silent:

```
    Injected  slides/intro.svg (1 overlay layer, slides agree)
    Injected  layouts/content.svg (1 overlay layer, deck default overlays)
    Injected  overlays/footer.svg (overlay file)
```

The third rule is a guess, and it leans toward *showing* chrome.
The question you are answering in Inkscape is how much room to leave,
so a preview with chrome a slide will not have costs you some empty space,
while the reverse causes overlap.

When the guess is wrong for a file, pin it:

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:parent="content"
     inkflow:preview-overlays="footer logo"
     viewBox="0 0 1920 1080">
```

### Drawing an overlay

An overlay file gets no chrome of its own,
otherwise `sync` would stamp the deck's footer onto the footer you are drawing.

It can name a **backdrop** instead: something drawn behind it purely as reference,
so you are positioning against a real slide rather than a checkerboard.

```xml
<!-- overlays/footer.svg -->
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkflow="urn:inkflow"
     inkflow:preview="content"
     viewBox="0 0 1920 1080">
```

`inkflow:preview` takes a layout name, any of the
[prefixes](../design/layouts.md#finding-a-layout-by-name), or a relative path.
A path is the useful form for a deck of hand-drawn SVGs with no layouts at all,
where the honest backdrop is an actual slide:

```xml
     inkflow:preview="../slides/01-title.svg"
```

That slide's own layout chain comes along with it.

A backdrop is a preview choice, not a structural claim.
Picking `content` while the overlay lands on `two-cols` at runtime is fine.

Without the attribute an overlay previews against nothing, and `sync` says so:

```
    Injected  overlays/footer.svg (overlay file, no backdrop)
    Injected  overlays/logo.svg (overlay file, backdrop: content)
```

A file counts as an overlay when it lives in an `overlays/` directory,
or when the deck references it as one.

### Working on a theme

Theme files have no `deck.py` to consult.
Use `--no-deck`:

```bash
inkflow sync --no-deck layouts/*.svg
```

With no deck there is no slide-to-overlay mapping to derive,
so overlay previews come from `inkflow:preview-overlays` alone
and everything else is synced without chrome.
A theme overlay still gets whatever backdrop it names.

`local:` and `theme:` references need a project context,
so using them with `--no-deck` is an immediate error.

## Naming elements (`label2id`)

Animations and [morph](morph.md) match elements by `id`.
Inkscape's Layers & Objects panel edits an element's *label* (`inkscape:label`),
which is not the same field.
Setting an `id` means opening the XML editor for every element.

`label2id` promotes every label to the `id`:

```bash
inkflow label2id slides/*.svg          # rewrite in place
inkflow label2id -n slides/three.svg   # preview, write nothing
```

Name things in the panel as you draw, run it once, then wire up `deck.py`.

A label that is already a valid id is used verbatim.
Anything else is slugified: spaces become hyphens, accents and symbols are dropped.
Labels are allowed to repeat but ids are not,
so a clash is reported and skipped rather than overwriting an existing id.
Elements inside the locked preview layers are left alone.

## Theme colors in the editor (`colorize` and `palette`)

Inkscape cannot read CSS custom properties,
so an element painted with a [semantic class](../design/themes.md#svg-element-utility-classes)
appears unstyled in the editor without help.

```bash
# 1. Install the theme's palette as Inkscape swatches, once per machine
inkflow palette --deck deck.py > ~/.config/inkscape/palettes/inkflow.gpl

# 2. Convert hardcoded hex fills and strokes into semantic classes
inkflow colorize slides/*.svg

# 3. Refresh the editor preview
inkflow sync
```

Step 3 injects hex fallbacks that Inkscape can render.
They are stripped at serve time and never reach the browser,
so the slide still follows the live theme and its light/dark switch.

`inkflow palette` derives the swatches from the active theme,
so a custom theme exports its own colors.

## Checking a deck (`verify`)

`inkflow verify` checks a deck before you present it,
printing one line per slide:

```bash
inkflow verify
inkflow verify --strict   # exit 1 on warnings too
```

**Errors** are things that will not render:
a missing SVG, `.md`, notes file or media file,
a zone id or animation element id that is not in the composed slide,
or an overlay that paints an opaque full-canvas rect and would hide the deck.

**Warnings** are things that are probably wrong:
animation steps that are not contiguous from 1,
a zone id declared twice after composition,
or layout layers that are stale and need `inkflow sync`.

Hidden slides (`visible=False`) are skipped unless you pass `--all`.

## Keeping SVGs clean in git

Inkscape stores viewport position, zoom level and window size inside the file,
so every save produces a diff even when nothing visual changed.

`inkflow setup-git` installs a pre-commit hook that strips that metadata
from staged SVGs, plus a diff driver so `git diff` and GitHub show only visual changes.
[`inkflow init`](../getting-started.md#git-integration) does this for new projects.

To clean files committed before the hook was in place:

```bash
inkflow clean slides/*.svg
```
