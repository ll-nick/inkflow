# Markdown content

Pointing `md=` at a Markdown file fills a slide's [zones](slides.md#zones) with its content:

```python
from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(
        slides=[
            Slide("content", md="intro"),
        ]
    )
```

`md` takes the same kind of reference as `Slide.src`.
A bare name like `"intro"` resolves to `slides/intro.md`,
or you can write out a full path.
`Inline("# Title\n\nBody")` passes Markdown directly instead of reading a file.

Here `"content"` happens to be a [built-in layout](../design/layouts.md#built-in-layouts),
but nothing about `md=` requires one.
It fills whatever zones the referenced SVG defines.

## Where the content goes

inkflow routes a Markdown file into zones in two ways.

### Automatic

With no markers at all:

- a leading `# H1` goes to `zone-title`
- an `## H2` immediately after it goes to `zone-subtitle`
- everything else goes to the [default zone](../design/layouts.md#the-default-zone)

```markdown
# My slide title
## Optional subtitle

The body content goes here.
```

### Explicit markers

`::zone-name::` routes everything after it to that zone,
until the next marker:

```markdown
::left::

## Left column

Content for the left side.

::right::

## Right column

Content for the right side.
```

Explicit markers always win over the automatic routing.

## Alignment inside a zone

Zone markers take optional `key=value` parameters:

```markdown
::content align=center valign=center padding=60::

Horizontally and vertically centered, with 60 units of padding.
```

| Parameter | Values | Controls |
|---|---|---|
| `align` | `left`, `center`, `right`, `justify` | Horizontal text alignment |
| `valign` | `top`, `center`, `bottom` | Vertical position of the content block |
| `padding` | number, in SVG user units | Inner spacing on all sides |

All three are optional and combine freely.

These are the most specific of three layers.
A marker parameter beats a CSS variable set in the layout SVG,
which beats the built-in default (`left`, `top`, `0`):

```css
/* in the layout SVG's <defs><style> — applies to every slide using it */
#zone-title   { --inkflow-valign: center; }
#zone-content { --inkflow-padding: 40px; }
```

From `deck.py`, pass `align`, `valign` and `padding` to
[`TextBox`](../reference/manifest.md#inkflow.manifest.TextBox) instead.

## Text size and shrinking to fit

Two more parameters set how large a zone's text is and what happens when it
does not fit:

```markdown
::content size=80%::

Everything in this zone is 80 % of its usual size: headings, code, tables
and formulas with it.

::notes-box fit=none::

This zone keeps its size even when the text runs past the box.
```

| Parameter | Values | Controls |
|---|---|---|
| `size` | a percentage (`80%`) or a factor (`0.8`), 25 % to 300 % | The zone's text size, relative to its usual size |
| `fit` | `shrink` (the default), `none` | Shrink the text when it overflows the box, or never |

**Every text zone shrinks its text to fit, by default.** When a zone's text
runs past its box, the slide shows it smaller, just enough to fit: in the
presenter, the editor, the static build, the PDF export and `inkflow render`
alike. Nothing is written to your files; only `size` and `fit` are.

Shrinking stops at a floor: a third of the zone's own size, or the smallest
text `inkflow render --check` calls readable (1/80 of the slide's height on a
screen; on a printed deck, 0.6 of the sheet's body size), whichever is larger.
Text that still does not fit at the floor stays there and overflows; the
editor marks the box *Doesn't fit*, and `inkflow render --check` reports it.

The same two settings are CSS custom properties, so they have the three layers
alignment has. The slide's own text wins (a marker parameter, or
`TextBox(size=0.8, fit=False)` in `deck.py`), then the zone shape's own style
(`style="--inkflow-font-scale:0.8"` on the rect: a text box the editor drew,
or a layout's zone for every slide built on it), then the layout's CSS:

```css
#zone-content { --inkflow-font-scale: 0.9; }
#zone-caption { --inkflow-fit: none; }
```

To turn shrinking off for a whole deck, set the token in the project's
`styles.css`:

```css
:root { --inkflow-fit: none; }
```

`--inkflow-fit: shrink` on a zone, or `fit=shrink` on its marker, turns it back
on there.

## Revealing content in steps

`::step::` and `::steps::` split a zone into chunks that appear on successive keypresses.
They share one timeline with the slide's animations,
so they are covered together on [Steps](steps.md#markdown-reveals).

## Code blocks

Fenced code blocks are syntax-highlighted automatically with Pygments.
Write a standard fence with a language tag, and nothing else is needed:

````markdown
```python
def greet(name: str) -> str:
    return f"Hello, {name}!"
```
````

A `{…}` spec after the language name walks the block line by line as you advance,
which is a step feature: see [code walkthroughs](steps.md#code-walkthroughs).

## Images

Standard Markdown syntax works:

```markdown
![A diagram](assets/diagram.png)
```

**A path resolves relative to the file it is written in.**
This is what every editor already assumes, so there is no separate convention:

| Reference in | Points at |
|---|---|
| `![](assets/diagram.png)` in `slides/intro.md` | `slides/assets/diagram.png` |
| `<image href="../assets/diagram.png">` in `slides/intro.svg` | `assets/diagram.png` |
| `Image("assets/diagram.png")` in `deck.py` | `assets/diagram.png` |

A slide SVG keeps rendering in Inkscape
and a Markdown file keeps previewing in your editor.

The file itself must live inside the project directory,
or inside the active theme's asset directory.
Anything outside both cannot be served or exported,
and is reported as a warning naming the file and the reference.
To use a directory elsewhere, symlink it in:

```bash
ln -s ../shared/assets assets
```

Local files are copied into the output of
[`inkflow build` and `inkflow export`](../presenting/export.md).
Remote `https://` and `data:` URIs are left alone.

A PDF works too, `![Results](../figures/results.pdf#page=2)`:
see [PDF figures](pdf-figures.md).

## Linking to another slide

A link with the `slide:` scheme jumps to the slide with that `id`:

```markdown
See the [architecture overview](slide:overview) for the full picture.
```

Clicking it cuts straight to that slide at its first step,
and the browser's Back button returns you.

A slide's `id` is inferred from its `.md` filename,
or from the `src` filename when there is no Markdown,
and you can set it explicitly:

```python
Slide("diagram", md="architecture", id="overview")
```

IDs must be unique across the deck.
Collisions get `-2`, `-3` appended.
A link to an id that does not exist is left inert.

The same scheme works on drawn objects: wrap one in an SVG link,
`<a href="slide:overview">…</a>` (the visual editor's **Link** field does this),
and clicking it in the presentation jumps there. A web link on an object opens in
a new tab, so the presentation stays where it is.

## Coloured words

To colour a few words with the theme's palette, wrap them in a span with an
`inkflow-color-<name>` class (any token: `accent`, `text-muted`, `red`, `orange`,
`yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `grey`, …):

```markdown
Revenue is <span class="inkflow-color-green">up 12%</span> this quarter.
```

The colour follows dark and light mode. The visual editor's text colour button
writes exactly this.

## Speaker notes

`::notes::` routes everything after it to the speaker notes
rather than onto the slide:

```markdown
# My slide title

The visible slide body goes here.

::notes::

These are my private notes. They support **Markdown** and appear
only in the presenter panel.
```

You can also set notes from `deck.py`:

```python
from inkflow import Inline, Slide

Slide("title", notes=Inline("Remember to greet the audience."))
Slide("content", md="bullets", notes="notes/bullets.md")
```

A bare `str` is a path, `Inline(...)` is the text itself.
Either way the content is rendered as Markdown.
When a slide has both `notes=` and a `::notes::` marker, the two are concatenated,
`notes=` first.

Notes show in the [presenter panel](../presenting/presenter-panel.md).
