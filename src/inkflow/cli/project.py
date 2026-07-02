from __future__ import annotations

import os
import subprocess
import sys
from importlib.resources import files
from pathlib import Path

import click

from inkflow import git_setup, init
from inkflow.cli._common import main


@main.command("init")
@click.argument("directory", default=".", type=click.Path(path_type=Path))
@click.option(
    "--theme", "theme_path", default=None, help="Path to a custom theme directory."
)
@click.option(
    "--no-git",
    "no_git",
    is_flag=True,
    help="Skip git hook setup even when inside a git repository.",
)
def init_cmd(directory: Path, theme_path: str | None, no_git: bool) -> None:
    """Scaffold a new presentation project."""
    target = directory.resolve()
    if (target / "deck.py").exists():
        raise click.ClickException(f"deck.py already exists: {target / 'deck.py'}")
    try:
        init.scaffold(target, theme_path)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo("[inkflow] created slides/01-title.svg")
    click.echo("[inkflow] created slides/02-content.md")
    click.echo("[inkflow] created deck.py")
    if not no_git:
        git_root_path = git_setup.detect_git_root(target)
        if git_root_path:
            git_setup.run_git_setup(git_root_path, verbose=False, log=click.echo)
    rel = str(directory) if str(directory) not in (".", "./") else None
    suffix = f"cd {rel} && inkflow serve" if rel else "inkflow serve"
    click.echo(f"\n[inkflow] run:  {suffix}")


@main.command("completion")
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish", "carapace"]))
def completion_cmd(shell: str) -> None:
    """Print shell completion script for SHELL.

    \b
    Add to your shell config:
      bash:     eval "$(inkflow completion bash)"
      zsh:      eval "$(inkflow completion zsh)"
      fish:     inkflow completion fish | source
      carapace: inkflow completion carapace > ~/.config/carapace/specs/inkflow.yaml
    """
    if shell == "carapace":
        spec = files("inkflow").joinpath("completions/inkflow.yaml")
        click.echo(spec.read_text(encoding="utf-8"), nl=False)
        return

    env = {**os.environ, "_INKFLOW_COMPLETE": f"{shell}_source"}
    result = subprocess.run([sys.argv[0]], env=env, capture_output=True, text=True)
    click.echo(result.stdout, nl=False)


@main.command("setup-git")
def setup_git() -> None:
    """Configure git hooks and SVG diff driver for any git repository."""
    try:
        root = git_setup.git_root()
        git_setup.run_git_setup(root, verbose=True, log=click.echo)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
