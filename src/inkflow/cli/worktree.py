"""``inkflow worktree``: the deck on a branch of its own, in a folder of its own.

An agent asked for a proposal works in a git worktree (``add``), commits
there, and the author reviews it (the editor's Compare, ``inkflow compare``)
and merges it (``merge``) or drops it (``remove``). The logic is
``editor/worktrees.py``, shared with the editor's Git menu.
"""

from __future__ import annotations

from pathlib import Path

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.editor import gitops, worktrees
from inkflow.logging import report


def _fail(exc: gitops.GitError) -> click.ClickException:
    return click.ClickException(str(exc))


@main.group()
def worktree() -> None:
    """Work on the deck in a separate git worktree, on its own branch.

    `add NAME` makes branch `deck/NAME` and checks it out in
    `.inkflow/worktrees/NAME` (ignored by git, not watched by the deck's
    server). Work there with `--deck <its deck.py>` on every inkflow command
    and commit there; the deck here is untouched until `merge`.
    """


@worktree.command("add")
@click.argument("name")
@click.option(
    "--base", default=None, metavar="REV", help="Start from REV [default: HEAD]."
)
@deck_option
def add_cmd(name: str, base: str | None, deck_path: Path) -> None:
    """A new worktree on branch deck/NAME, from the deck's last commit.

    Prints its folder (`path:`) and the deck.py to pass as `--deck` (`deck:`).
    Uncommitted changes here are not in it.
    """
    resolved = resolve_deck_path(deck_path)
    try:
        info, note = worktrees.add(resolved, name, base)
    except gitops.GitError as exc:
        raise _fail(exc) from exc
    report("Created", f"worktree {name} on branch {info['branch']}")
    # The paths on stdout, whole (an agent copies them; stderr may wrap).
    click.echo(f"path: {info['path']}")
    deck = info["deck"]
    if isinstance(deck, str):
        click.echo(f"deck: {deck}")
        report(
            "Next",
            "pass that deck.py as --deck to every inkflow command; " + "commit there",
            style="dim",
        )
    if note:
        report("Note", note, style="yellow")


@worktree.command("list")
@deck_option
def list_cmd(deck_path: Path) -> None:
    """Every worktree of the deck's repository: branch, commits ahead of and
    behind the deck's branch, uncommitted changes."""
    resolved = resolve_deck_path(deck_path)
    try:
        items = worktrees.list_worktrees(resolved)
    except gitops.GitError as exc:
        raise _fail(exc) from exc
    for item in items:
        state = [
            "this deck" if item["main"] else "",
            f"{item['ahead']} ahead" if item["ahead"] else "",
            f"{item['behind']} behind" if item["behind"] else "",
            "uncommitted changes" if item["dirty"] else "",
            "" if item["deck"] or item["main"] else "no deck",
        ]
        branch = item["branch"] or f"@{item['head']}"
        detail = ", ".join(s for s in state if s)
        click.echo(
            f"{item['name']}\t{branch}\t{item['path']}"
            + (f"\t{detail}" if detail else "")
        )


@worktree.command("merge")
@click.argument("ref", metavar="NAME|BRANCH")
@deck_option
def merge_cmd(ref: str, deck_path: Path) -> None:
    """Merge a worktree's branch into the deck's current branch.

    Fast-forwards when it can, else makes a merge commit. Refused while the
    deck has uncommitted changes; a conflict is aborted, nothing merged.
    """
    resolved = resolve_deck_path(deck_path)
    try:
        merged = worktrees.merge(resolved, ref)
    except gitops.GitError as exc:
        raise _fail(exc) from exc
    report(
        "Merged" if merged.files else "Unchanged",
        merged.message,
        style="green" if merged.files else "dim",
    )
    for path in merged.files:
        report("Changed", path, style="dim")
    if merged.note:
        report("Note", merged.note, style="yellow")


@worktree.command("remove")
@click.argument("name")
@click.option(
    "--force",
    is_flag=True,
    help="Even with uncommitted changes or unmerged commits (they are lost).",
)
@deck_option
def remove_cmd(name: str, force: bool, deck_path: Path) -> None:
    """Remove a worktree; its deck/ branch goes too once merged (or --force)."""
    resolved = resolve_deck_path(deck_path)
    try:
        message = worktrees.remove(resolved, name, force=force)
    except gitops.GitError as exc:
        raise _fail(exc) from exc
    report("Removed", message.removeprefix("Removed "))
