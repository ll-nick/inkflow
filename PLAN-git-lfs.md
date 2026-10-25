# Plan: git-lfs support in `setup-git` and `init`

## Goal

`inkflow setup-git` and `inkflow init` also configure git-lfs
for the binary assets a deck tends to accumulate,
when `git-lfs` is installed and the user has not opted out.

## Decisions already made

- SVG stays out of LFS.
  It is XML text, so plain git diffs, compresses, and merges it,
  and the `inkscape-svg` textconv driver and pre-commit cleaning depend on that.
- Tracked by default: video, fonts, and images.
  - Video: `*.mp4`, `*.webm`, `*.mov`
  - Fonts: `*.woff2`, `*.ttf`, `*.otf`
  - Images: `*.png`, `*.jpg`, `*.jpeg`, `*.gif`, `*.webp`
- Opt-out flag `--no-lfs` on both `setup-git` and `init`.
- If `git-lfs` is not on PATH, skip with a hint on how to install it.
  Never fail, since LFS is optional.
- `init` keeps its existing rule of only owning a repo it created itself;
  inside an existing repo it still just points at `setup-git`.

## Changes

### `src/inkflow/git_setup.py`

- `LFS_TRACKED_PATTERNS`: tuple of the patterns above.
- `ensure_lfs(root) -> LfsResult`, idempotent, an enum or dataclass rather than a string:
  - `git-lfs` missing: return a "skipped, not installed" result.
  - Run `git lfs install --local` in `root`.
  - Append `<pattern> filter=lfs diff=lfs merge=lfs -text` per missing pattern to `.gitattributes`.
    Refactor `ensure_gitattributes` so the SVG line and the LFS lines share one
    "append missing lines" helper.
  - Report each outcome with the existing `report()` styles.
- `run_git_setup(root, *, verbose, lfs: bool)`: call `ensure_lfs` **after** `core.hooksPath` is set.
- `init_project_git(target, *, verbose, lfs: bool)`: pass the flag through.

### `src/inkflow/cli/project.py`

- `--no-lfs` option on `init_cmd` (line ~50) and `setup_git` (line ~108).
- Pass `lfs=not no_lfs` to `init_project_git` / `run_git_setup`.

### Hooks path (must verify first)

`setup-git` sets `core.hooksPath = .githooks`, which makes git ignore `.git/hooks`.
Do **not** also install into `.git/hooks`: those would be dead copies.
Expectation: recent git-lfs installs its hooks
(`pre-push`, `post-checkout`, `post-commit`, `post-merge`) into the configured hooks path,
so they land in the committed `.githooks/` beside `pre-commit`.

Verify with a scratch repo, with `git-lfs` installed:

1. `git init`, `git config core.hooksPath .githooks`, `git lfs install --local`.
2. Check whether the four hooks appear in `.githooks/` or `.git/hooks/`.
3. Check that `.githooks/pre-commit` (ours) survives untouched.
   `git lfs install` refuses to overwrite a differing existing hook of the same name;
   we do not have a `pre-push` etc., so no conflict expected.

If the hooks do not land in `.githooks/`, fall back to writing the LFS hook stubs
ourselves (they are one-line `git lfs <hook> "$@"` scripts).

Known consequence: committed LFS hooks make teammates without `git-lfs`
get an error on push/checkout telling them to install it.
Acceptable, since their clone would be broken anyway.

## Tests

- `ensure_lfs` with `git-lfs` absent (monkeypatch `shutil.which`): skipped, nothing written.
- With `git-lfs` present (skip the test if the binary is missing):
  patterns appended once, a re-run reports unchanged, existing `.gitattributes` content kept.
- CLI: `--no-lfs` writes no LFS lines and does not call `git lfs`.
- `init` in an existing repo still skips all git setup.

## Docs

- `CLAUDE.md`: "Git setup" section and the `git_setup.py` layout entry mention LFS.
- `docs/`: wherever `setup-git` / `init` flags are documented;
  mention the pattern list and `--no-lfs`.

## Open items

- Confirm git-lfs hooks-path behaviour (above).
- `mise run check` must pass.
