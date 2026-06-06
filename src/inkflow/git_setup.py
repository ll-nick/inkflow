from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import cast

HOOK_SCRIPT = """\
#!/usr/bin/env bash
# Strip Inkscape editor metadata from staged SVG files before committing.
# Installed by: inkflow setup-git

set -e

mapfile -t staged < <(git diff --cached --name-only --diff-filter=ACM \\
  | grep -E '\\.svg$' || true)
[ ${#staged[@]} -eq 0 ] && exit 0

if [ -x ".venv/bin/inkflow" ]; then
    INKFLOW=".venv/bin/inkflow"
elif command -v inkflow &>/dev/null; then
    INKFLOW="inkflow"
else
    echo "[inkflow] inkflow not found, skipping SVG clean" >&2
    exit 0
fi

echo "[inkflow] cleaning staged SVGs..."
"$INKFLOW" clean "${staged[@]}"

git add "${staged[@]}"
"""


def git_root() -> Path:
    """Return the root of the current git repository."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip())
    except subprocess.CalledProcessError as exc:
        raise RuntimeError("not inside a git repository") from exc


def detect_git_root(directory: Path) -> Path | None:
    """Return the git root for the given directory, or None if not in a repo."""
    try:
        result = subprocess.run(
            ["git", "-C", str(directory), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip())
    except subprocess.CalledProcessError:
        return None


def resolve_textconv(root: Path) -> str:
    """Return the textconv command for the local git config.

    Returns a command that will run inkflow clean --stdout.
    Prefers a local .venv/bin/inkflow if it exists,
    otherwise falls back to global inkflow.
    """
    venv_bin = root / ".venv" / "bin" / "inkflow"
    if venv_bin.exists():
        return ".venv/bin/inkflow clean --stdout"
    if subprocess.run(["which", "inkflow"], capture_output=True).returncode == 0:
        return "inkflow clean --stdout"
    raise RuntimeError(
        "inkflow not found — no .venv/bin/inkflow in repo root "
        + "and inkflow is not on PATH. "
        + "Install inkflow globally to continue."
    )


def ensure_hook(hooks_dir: Path) -> bool:
    """Write pre-commit hook if absent. Returns True if created."""
    hooks_dir.mkdir(exist_ok=True)
    hook = hooks_dir / "pre-commit"
    created = not hook.exists()
    if created:
        hook.write_text(HOOK_SCRIPT)
    hook.chmod(hook.stat().st_mode | 0o111)  # chmod +x
    return created


def run_git_config(key: str, value: str, *, cwd: Path | None = None) -> None:
    try:
        subprocess.run(
            ["git", "config", key, value],
            check=True,
            capture_output=True,
            cwd=cwd,
        )
    except subprocess.CalledProcessError as exc:
        raw = cast(bytes | None, exc.stderr)
        msg = raw.decode().strip() if isinstance(raw, bytes) else str(exc)
        raise RuntimeError(f"git config {key} failed: {msg}") from exc


def ensure_gitattributes(root: Path) -> str:
    """Add SVG diff attribute if missing. Returns 'created', 'updated', or 'ok'."""
    attr_line = "*.svg diff=inkscape-svg\n"
    gitattributes = root / ".gitattributes"
    if not gitattributes.exists():
        gitattributes.write_text(attr_line, encoding="utf-8")
        return "created"
    content = gitattributes.read_text(encoding="utf-8")
    if "diff=inkscape-svg" in content:
        return "ok"
    sep = "" if content.endswith("\n") else "\n"
    gitattributes.write_text(content + sep + attr_line, encoding="utf-8")
    return "updated"


def run_git_setup(
    root: Path,
    *,
    verbose: bool,
    log: Callable[[str], None] = lambda _: None,
) -> None:
    """Configure git hooks and SVG diff driver.

    When verbose=True, raises RuntimeError on failure and logs every step.
    When verbose=False, silently returns on failure and logs minimally.
    """
    try:
        textconv_cmd = resolve_textconv(root)
    except RuntimeError:
        if verbose:
            raise
        return

    hook_created = ensure_hook(root / ".githooks")
    if hook_created:
        log("[inkflow] created .githooks/pre-commit")
    elif verbose:
        log("[inkflow] .githooks/pre-commit already exists, left unchanged")

    try:
        run_git_config("core.hooksPath", ".githooks", cwd=root)
        if verbose:
            log("[inkflow] set git config: core.hooksPath = .githooks")
        run_git_config("diff.inkscape-svg.textconv", textconv_cmd, cwd=root)
        if verbose:
            log(
                f"[inkflow] set git config: diff.inkscape-svg.textconv = {textconv_cmd}"
            )
    except RuntimeError as exc:
        if verbose:
            raise
        log(f"[inkflow] warning: git config failed: {exc}")
        return

    attr_result = ensure_gitattributes(root)
    if verbose:
        if attr_result == "ok":
            log("[inkflow] .gitattributes already up to date")
        else:
            log(f"[inkflow] {attr_result} .gitattributes")

    log("[inkflow] git setup complete")
