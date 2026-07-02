# CLI reference

All commands are available via the `inkflow` entry point.

```bash
inkflow --help
inkflow --version
```

---

## `inkflow serve`

Start the presentation server with live reload.

```bash
inkflow serve [--deck DECK] [--port PORT] [--ws-port WS_PORT] [--host HOST]
```

| Argument/Option | Default | Description |
|---|---|---|
| `-d`, `--deck` | `deck.py` | Path to `deck.py` |
| `--ws-port` | `7778` | WebSocket server port |
| `--host` | `localhost` | Bind address. Use `0.0.0.0` to expose on all interfaces |
| `--port` | `7777` | HTTP server port |

The server is accessible at `http://{host}:{port}`.
Press `o` to open it in the default browser.
File changes trigger a live reload over WebSocket.
The presenter updates in place without a full page reload.

Press `?` in the browser for keyboard shortcut help.

---

## `inkflow build`

Export a self-contained presentation directory for offline use.

```bash
inkflow build [--deck DECK] [--output DIR]
```

| Argument/Option | Default | Description |
|---|---|---|
| `-d`, `--deck` | `deck.py` | Path to `deck.py` |
| `--output`, `-o` | `build/` next to `deck.py` | Output directory |

Produces `index.html` with all slides inlined.
No server required.
Assets referenced by the deck are copied into the output directory.

---

## `inkflow export`

Export a PDF via headless Chromium. One page per slide, no animations.

```bash
inkflow export [--deck DECK] [--output FILE] [--chromium PATH] [--no-sandbox]
```

| Argument/Option | Default | Description |
|---|---|---|
| `-d`, `--deck` | `deck.py` | Path to `deck.py` |
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

## `inkflow completion`

Print a shell completion script and install it to enable tab completion.

```bash
inkflow completion {bash|zsh|fish|carapace}
```

| Argument | Description |
|---|---|
| `bash` | Completion script for Bash |
| `zsh` | Completion script for Zsh |
| `fish` | Completion script for Fish |
| `carapace` | [Carapace](https://carapace-sh.github.io/carapace-bin/) spec (YAML) for any supported shell |

**Bash** — add to `~/.bashrc`:
```bash
eval "$(inkflow completion bash)"
```

**Zsh** — add to `~/.zshrc`:
```bash
eval "$(inkflow completion zsh)"
```

**Fish** — add to `~/.config/fish/config.fish`:
```fish
inkflow completion fish | source
```

**Carapace** — install the spec once, then carapace handles completions for all shells it supports (Nushell, PowerShell, Elvish, and others):
```bash
inkflow completion carapace > ~/.config/carapace/specs/inkflow.yaml
```

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
inkflow parent get FILE [FILE ...]
```

| Argument | Description |
|---|---|
| `FILE` | One or more slide SVGs |

With a single file, prints just the value (useful for scripting).
With multiple files, prefixes each line with the filename.
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
| `--no-deck` | off | Skip deck lookup (for theme authoring; restricts parents to `builtin:` and relative paths) |

Validates that `PARENT` resolves, updates the attribute in place,
then automatically runs `inkflow sync` on the file.

---

### `inkflow parent strip`

Remove `inkflow:parent` and all injected layout layers from one or all slides.

```bash
inkflow parent strip [FILES...] [--deck DECK] [-y]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILES` | all slides in deck | One or more slide SVGs (glob-friendly) |
| `--deck` | `deck.py` | Path to `deck.py` |
| `-y`, `--yes` | off | Skip the confirmation prompt |

Always prompts for confirmation unless `-y` is passed.
Use this to detach a slide from its layout.
The SVG's own content is untouched.

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

## `inkflow sync`

Refresh ancestor layout layers in slide SVG(s) for editor preview.

```bash
inkflow sync [FILES...] [--deck DECK] [--check] [--no-deck] [--mode dark|light]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILES` | all slides in deck | One or more slide SVGs (glob-friendly) |
| `--deck` | `deck.py` | Path to `deck.py` |
| `--check` | off | Report stale files without rewriting. Exits 1 if any are stale |
| `--no-deck` | off | Skip deck lookup (for theme authoring, see below) |
| `--mode` | deck's `dark_mode` | Force `dark` or `light` color mode for the preview style |

Writes each ancestor layout as a locked layer into each slide SVG.
These layers are visible in Inkscape as a spatial reference
and are stripped by the pipeline before serving.

Also injects a `<style id="inkflow-preview">` block with hardcoded hex values for
each `inkflow-fill-*` / `inkflow-stroke-*` class so Inkscape renders semantic classes
with the correct theme colors. This block is stripped by the pipeline before serving.

Idempotent: compares content hashes for both layout layers and the preview style,
and only rewrites stale entries.

`--no-deck` is intended for theme authors who work without a `deck.py`.
It requires explicit `FILES` and restricts parent references to `builtin:` and
relative paths (`./`, `../`). Using `local:` or `theme:` with `--no-deck` is an error.

---

## `inkflow verify`

Run pre-flight checks on a deck and report any issues.

```bash
inkflow verify [FILES...] [--deck DECK] [--all] [--strict]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILES` | all visible slides | One or more slide SVGs to verify (matched by `src` path) |
| `--deck` | `deck.py` | Path to `deck.py` |
| `--all` | off | Include hidden slides (`visible=False`) |
| `--strict` | off | Promote warnings to errors. Exits 1 if any warnings remain |

Checks per slide:

| # | Check | Level |
|---|---|---|
| 1 | SVG source resolves and exists | error |
| 2 | `.md` file exists (when `slide.md` is set) | error |
| 3 | `notes=Path(…)` file exists | error |
| 4 | `Media.src` paths exist relative to `deck.py` | error |
| 5 | Zone IDs from `slide.zones` keys exist in the composed SVG | error |
| 6 | Zone IDs from `.md` `::zone::` markers exist in the composed SVG | error |
| 7 | Animation element IDs (`#id`) exist in the SVG | error |
| 8 | Animation steps are contiguous from 1 (no gaps) | warning |
| 9 | Layout layers are up to date (`inkflow sync`) | warning |

Exit codes: `0` if no errors (warnings are allowed unless `--strict`); `1` on any error.

Example output:

```
slides/01-title.svg          [ok]
slides/02-diagram.svg        [ok]
slides/03-media.svg          [error] zone #zone-media not found in layout
                             [error] media not found: assets/missing.jpg
slides/04-bullets.svg        [warn]  layout layers stale — run inkflow sync
```

---

## `inkflow layouts`

Print a table of all available layouts with their zones and parent chain.

```bash
inkflow layouts [--deck DECK] [--no-deck]
```

| Option | Default | Description |
|---|---|---|
| `--deck` | `deck.py` | Path to `deck.py` |
| `--no-deck` | off | Show only built-in layouts (no theme or project layouts) |

Discovers layouts from three sources in order — built-in, theme, project — and renders a
Rich table with one row per layout:

```
 NAME          SOURCE    PARENT          ZONES                          #
 base          builtin   —               —                              ✓
 cover         builtin   base            title, subtitle, attribution
 default       builtin   base            title, content                 ✓
 two-cols      builtin   base            title, left, right             ✓
 media-right   builtin   base            title, content, media          ✓
 my-layout     local     builtin:base    logo, body                     ✓
```

The `#` column shows ✓ when the layout contains `zone-slide-number` or `zone-slide-total`.

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
then automatically runs `inkflow sync` to add preview layers.
Prints the `Slide(...)` line to add to `deck.py`.

Example:

```bash
inkflow add content slides/07-new.svg
# [inkflow] created slides/07-new.svg
# [inkflow] add to deck.py:
#     Slide("slides/07-new.svg"),
```

---

## `inkflow colorize`

Replace hardcoded theme hex colors in SVG files with semantic CSS classes.

```bash
inkflow colorize FILE [FILE ...] [--deck DECK] [--no-deck] [--mode dark|light]
```

| Argument/Option | Default | Description |
|---|---|---|
| `FILE` | required | One or more SVG file paths |
| `--deck` | `deck.py` | Path to `deck.py` |
| `--no-deck` | off | Use only the built-in theme (no project `deck.py`) |
| `--mode` | deck's `dark_mode` | Match `dark` or `light` mode palette hex values |

Reads the active theme's color tokens for the selected mode and scans each SVG for
`fill` and `stroke` attributes (and `style=` declarations) whose hex values match.
Matching values are replaced with `inkflow-fill-*` / `inkflow-stroke-*` classes
and the hardcoded attribute is removed.

Intended as the second step after picking colors from the inkflow Inkscape palette:

```bash
inkflow colorize slides/*.svg
# [colorized]   slides/02-diagram.svg
# [no changes]  slides/03-crossfade.svg
```

After colorizing, run `inkflow sync` to refresh Inkscape's preview style.

---

## `inkflow palette`

Generate an Inkscape GPL color palette for the active theme.

```bash
inkflow palette [--deck DECK] [--no-deck] [--mode dark|light] [--output FILE] [--install]
```

| Argument/Option | Default | Description |
|---|---|---|
| `--deck` | `deck.py` | Path to `deck.py` |
| `--no-deck` | off | Use only the built-in theme (no project `deck.py`) |
| `--mode` | deck's `dark_mode` | Generate `dark` or `light` mode palette |
| `--output`, `-o` | stdout | Write palette to FILE instead of stdout |
| `--install` | off | Install to `~/.config/inkscape/palettes/inkflow.gpl` |

`--output` and `--install` are mutually exclusive.

Outputs a GIMP Palette (`.gpl`) file whose named colors correspond to the
`inkflow-fill-*` / `inkflow-stroke-*` CSS token set.
Load this palette in Inkscape's swatches panel to pick theme colors by name.

```bash
# Install for the current user:
inkflow palette --install

# Preview the palette for a custom theme in light mode:
inkflow palette --deck deck.py --mode light

# Save for theme distribution:
inkflow palette --deck deck.py --output my-theme/inkflow.gpl
```
