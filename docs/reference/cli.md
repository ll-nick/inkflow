# CLI reference

All commands are available through the `inkflow` entry point. Run `inkflow --help`
for the top-level list, or `inkflow COMMAND --help` for any single command.

::: mkdocs-click
    :module: inkflow.cli
    :command: main
    :prog_name: inkflow
    :depth: 1

## Output and diagnostics

Status lines, warnings, and errors print to stderr; machine-readable output (the
`palette` and `completion` scripts, `parent get` values, and `clean --stdout`)
stays on stdout so it can be redirected cleanly.

Diagnostics flow through three independent sinks, each with its own level
(`off`, `debug`, `info`, `warning`, `error` — `off` disables the sink):

- **console** — stderr for every command, or the live `serve` TUI in its place.
  Default `warning`.
- **file** — an optional on-disk log, off by default. When enabled without an explicit
  path it writes to the per-user log directory (`~/.local/state/inkflow/log/` on Linux,
  `~/Library/Logs/inkflow/` on macOS, `%LOCALAPPDATA%\inkflow\Logs\` on Windows).
- **browser** — the presenter's message banner during `serve`. Default `warning`.

Warnings raised by the libraries inkflow builds on
are folded into the same sinks under the emitting library's name,
at the level that library chose.
They obey the flags below like any other record,
instead of printing past them unformatted.

Set a baseline for every sink with `--log-level`, or target one sink; a per-sink setting
overrides the baseline. Each flag has an environment-variable twin, and a per-sink
setting (flag or env) beats the `--log-level` baseline:

| Scope | Flag | Environment variable |
| --- | --- | --- |
| all sinks | `--log-level LEVEL` | `INKFLOW_LOG_LEVEL` |
| console / TUI | `--log-level-console LEVEL` | `INKFLOW_LOG_LEVEL_CONSOLE` |
| file | `--log-level-file LEVEL` | `INKFLOW_LOG_LEVEL_FILE` |
| browser | `--log-level-browser LEVEL` | `INKFLOW_LOG_LEVEL_BROWSER` |
| file destination | `--log-file PATH` | `INKFLOW_LOG_FILE` |

`--log-file` only sets *where* the file sink writes; it does not enable it — raise the
file level above `off` for that. These are global options, so they come **before** the
subcommand (the environment twins are position-independent):

```bash
inkflow --log-level-file debug build              # archive a full trace to the default path
inkflow --log-level-console off serve             # silence the TUI log list; banner unaffected
inkflow --log-level debug --log-file run.log build  # every sink at debug, file to ./run.log
INKFLOW_LOG_LEVEL_FILE=debug inkflow build        # same as the first, via the environment
```

A fatal build error is shown as a full-screen overlay (and the `serve` TUI error view),
separate from these sinks; enabling the file sink also captures its traceback.

## Editing from the presenter

The presenter's Edit button (see [Presenter panel](../guides/presenter-view.md))
copies the current slide's source path to the clipboard by default.
Set `INKFLOW_EDIT_CMD` to launch an editor instead, for every file kind,
with `{path}` substituted (appended as a final argument if the template has no
`{path}` placeholder).
`INKFLOW_EDIT_CMD_SVG` overrides it specifically for SVG files,
if you want a different command there
(Inkscape instead of a text editor, say) without losing the general one
for content, notes, and the deck script itself.

```bash
INKFLOW_EDIT_CMD="code -r --goto {path}" inkflow serve deck.py
```

### Suggested editor commands

These are starting points to copy and adjust, not built-in behavior.

**VS Code** reuses an already-open window natively:

```bash
export INKFLOW_EDIT_CMD="code -r --goto {path}"
```

**Neovim** needs a fixed socket to connect to,
since its own address is otherwise random per instance.
Launch nvim with that socket, for example via a shell alias:

```bash
alias vim='nvim --listen /tmp/nvim.sock'
```

```bash
export INKFLOW_EDIT_CMD="nvim --server /tmp/nvim.sock --remote {path}"
```

If no nvim with that listen address is running,
the command fails silently (logged as a warning server-side).

**Inkscape** has no comparable built-in remote-control flag,
so this uses its D-Bus interface directly.
Set it as `INKFLOW_EDIT_CMD_SVG`, not the general `INKFLOW_EDIT_CMD`.
Save this as an executable script on your `PATH`:

```bash
#!/bin/sh
# Reuses a running Inkscape's window (a new tab on 1.5+, a new window on
# older versions) instead of spawning a second process; falls back to a
# plain `inkscape` launch if no instance is running yet.
if gdbus call --session --dest org.inkscape.Inkscape \
    --object-path /org/inkscape/Inkscape \
    --method org.freedesktop.Application.ActivateAction \
    "file-open-window" "[<'$1'>]" "{}" >/dev/null 2>&1; then
    exit 0
fi
exec inkscape "$1"
```

```bash
export INKFLOW_EDIT_CMD_SVG="inkflow-edit-svg {path}"
```

This is Linux-specific (D-Bus) and depends on Inkscape's own D-Bus interface,
which isn't part of inkflow and could change between Inkscape releases.
It degrades safely on any version, though.

