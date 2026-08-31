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

