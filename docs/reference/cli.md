# CLI reference

All commands are available via the `inkflow` entry point.

```bash
inkflow --help
```

---

## `inkflow serve`

Start the presentation server with live reload.

```bash
inkflow serve [DECK] [--port PORT] [--ws-port WS_PORT]
```

| Argument/Option | Default | Description |
|---|---|---|
| `DECK` | `deck.py` | Path to `deck.py` |
| `--port` | `7777` | HTTP server port |
| `--ws-port` | `7778` | WebSocket server port |

Opens `http://localhost:{port}` in the default browser.
File changes trigger a live reload over WebSocket.
The presenter updates in place without a full page reload.

Press `?` in the browser for keyboard shortcut help.

---

## `inkflow build`

Export a self-contained presentation directory for offline use.

```bash
inkflow build [DECK] [--output DIR]
```

| Argument/Option | Default | Description |
|---|---|---|
| `DECK` | `deck.py` | Path to `deck.py` |
| `--output`, `-o` | `build/` next to `deck.py` | Output directory |

Produces `index.html` with all slides inlined.
No server required.
Assets referenced by the deck are copied into the output directory.

---

## `inkflow export`

Export a PDF via headless Chromium. One page per slide, no animations.

```bash
inkflow export [DECK] [--output FILE] [--chromium PATH] [--no-sandbox]
```

| Argument/Option | Default | Description |
|---|---|---|
| `DECK` | `deck.py` | Path to `deck.py` |
| `--output`, `-o` | `<deck-stem>.pdf` | Output PDF path |
| `--chromium` | auto-detected | Path to `chromium` or `google-chrome` binary |
| `--no-sandbox` | off | Pass `--no-sandbox` to Chromium (needed when running as root or in Docker) |

Requires a Chromium-based browser on the system.

---

## `inkflow clean`

Strip editor metadata from SVG files in place.

```bash
inkflow clean FILE [FILE ...] [--stdout] [--check]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILE` | required | One or more SVG file paths |
| `--stdout` | off | Write cleaned SVG to stdout instead of modifying files |
| `--check` | off | Exit non-zero if any file would be modified, without writing changes |

Removes elements and attributes in the Inkscape and Sodipodi namespaces that represent editor state
(viewport position, zoom level, window geometry, etc.).
Structural attributes that carry meaning inside Inkscape
— layer identity (`inkscape:groupmode`, `inkscape:label`) and lock state (`sodipodi:insensitive`) —
are preserved.

`--check` is useful in CI to verify that no dirty SVGs were committed:

```bash
inkflow clean --check slides/*.svg
```

`--check` and `--stdout` are mutually exclusive.

---

## `inkflow setup-git`

Configure git hooks and the SVG diff driver for any git repository.

```bash
inkflow setup-git
```

Run this once after cloning a repository that contains SVG slides.
It configures two things:

**Pre-commit hook:** writes `.githooks/pre-commit` (if not already present)
and sets `core.hooksPath = .githooks` in the local git config.
Before every commit the hook strips Inkscape editor metadata from any staged SVGs
so viewport pan, zoom, and window state never land in history.
The hook is portable: it detects the inkflow executable at commit time,
trying `.venv/bin/inkflow` first, then falling back to `inkflow` on `PATH`.

**SVG diff driver:** sets `diff.inkscape-svg.textconv` in the local git config.
`git diff`, `git log -p`, and GitHub's diff view then show only visual changes,
even for SVGs that have not been cleaned in place.

Both git config entries go into `.git/config` (per-clone, never committed).
The hook script and `.gitattributes` are committed to the repository
so teammates get them on clone.
They just need to run `inkflow setup-git` themselves to activate the config entries in their own clone.

---

## `inkflow parent`

Manage slide layout parents.

```bash
inkflow parent COMMAND [ARGS]...
```

---

### `inkflow parent get`

Print the `inkflow:parent` value of a slide SVG.

```bash
inkflow parent get FILE
```

| Argument | Description |
|---|---|
| `FILE` | Path to the slide SVG |

Prints `(no parent)` if the attribute is absent.

---

### `inkflow parent set`

Set the `inkflow:parent` of a slide SVG and refresh its layout layers.

```bash
inkflow parent set FILE PARENT [--deck DECK]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILE` | required | Path to the slide SVG |
| `PARENT` | required | Layout name or `inkflow:parent` string (see [path resolution](../guides/layout-system.md#path-resolution)) |
| `--deck` | `deck.py` | Path to `deck.py` |

Validates that `PARENT` resolves, updates the attribute in place,
then automatically runs `parent inject` on the file.

---

### `inkflow parent strip`

Remove `inkflow:parent` and all injected layout layers from one or all slides.

```bash
inkflow parent strip [FILE] [--deck DECK] [-y]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILE` | all slides in deck | Path to the slide SVG |
| `--deck` | `deck.py` | Path to `deck.py` |
| `-y`, `--yes` | off | Skip the confirmation prompt |

Always prompts for confirmation unless `-y` is passed.
Use this to detach a slide from its layout.
The SVG's own content is untouched.

---

### `inkflow parent inject`

Refresh ancestor layout layers in slide SVG(s) for editor preview.

```bash
inkflow parent inject [FILE] [--deck DECK] [--check]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILE` | all slides in deck | Path to the slide SVG |
| `--deck` | `deck.py` | Path to `deck.py` |
| `--check` | off | Report stale files without rewriting. Exits 1 if any are stale |

Writes each ancestor layout as a locked layer into each slide SVG.
These layers are visible in Inkscape as a spatial reference
and are stripped by the pipeline before serving.

Idempotent: compares a hash of each ancestor against an existing layer's stored hash
and only rewrites stale entries.

---

### `inkflow parent list`

List all slides and their `inkflow:parent` values.

```bash
inkflow parent list [--deck DECK]
```

| Option | Default | Description |
|---|---|---|
| `--deck` | `deck.py` | Path to `deck.py` |

---

## `inkflow add`

Create a new slide SVG wired to a layout parent.

```bash
inkflow add PARENT OUTPUT [--deck DECK]
```

| Argument/Option | Default | Description |
|---|---|---|
| `PARENT` | required | Layout name or `inkflow:parent` string (see [path resolution](../guides/layout-system.md#path-resolution)) |
| `OUTPUT` | required | Path for the new SVG file |
| `--deck` | `deck.py` | Path to `deck.py` |

Creates the SVG with `inkflow:parent` set,
then automatically runs `parent inject` to add preview layers.
Prints the `Slide(...)` line to add to `deck.py`.

Example:

```bash
inkflow add content slides/07-new.svg
# [inkflow] created slides/07-new.svg
# [inkflow] add to deck.py:
#     Slide("slides/07-new.svg"),
```
