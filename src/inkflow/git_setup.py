from __future__ import annotations

import subprocess
from pathlib import Path
from typing import cast

from inkflow.logging import logger, report

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


def run_git_config(key: str, value: str, *, cwd: Path | None = None) -> bool:
    """Set a local git config key, returning True only if it changed.

    Reading the current value first keeps a re-run quiet: an already-correct key is
    left untouched and reported as unchanged rather than re-set every time.
    """
    existing = subprocess.run(
        ["git", "config", "--get", key],
        capture_output=True,
        text=True,
        cwd=cwd,
    )
    if existing.returncode == 0 and existing.stdout.strip() == value:
        return False
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
    return True


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


def _report_config(changed: bool, detail: str) -> None:
    if changed:
        report("Set", detail)
    else:
        report("Unchanged", detail, style="dim")


def run_git_setup(root: Path, *, verbose: bool) -> None:
    """Configure git hooks and SVG diff driver.

    verbose=True (the ``setup-git`` command) narrates every step and raises on failure;
    verbose=False (init's best-effort setup) narrates only key steps and swallows it.
    Idempotent: a re-run leaves already-correct settings untouched and says so.
    """
    try:
        textconv_cmd = resolve_textconv(root)
    except RuntimeError:
        if verbose:
            raise
        return

    hook_created = ensure_hook(root / ".githooks")
    if hook_created:
        report("Created", ".githooks/pre-commit")
    elif verbose:
        report("Unchanged", ".githooks/pre-commit", style="dim")

    try:
        hooks_set = run_git_config("core.hooksPath", ".githooks", cwd=root)
        textconv_set = run_git_config(
            "diff.inkscape-svg.textconv", textconv_cmd, cwd=root
        )
    except RuntimeError as exc:
        if verbose:
            raise
        logger.warning(f"git config failed: {exc}")
        return
    if verbose:
        _report_config(hooks_set, "git config core.hooksPath = .githooks")
        _report_config(
            textconv_set, f"git config diff.inkscape-svg.textconv = {textconv_cmd}"
        )

    attr_result = ensure_gitattributes(root)
    if verbose:
        if attr_result == "ok":
            report("Unchanged", ".gitattributes", style="dim")
        else:
            report(attr_result.capitalize(), ".gitattributes")

    if hook_created or hooks_set or textconv_set or attr_result != "ok":
        report("Configured", "git hooks and SVG diff driver")
    else:
        report("Up to date", "git hooks and SVG diff driver", style="dim")
