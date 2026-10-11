"""``inkflow mv``: rename or move a project file, every reference following;
``inkflow files``: which files the deck uses, and deleting the others.

A picture, a chart's data file, a diagram or a slide's drawing is named in
other files (an SVG's ``href``, Markdown, deck.py, a layout's
``inkflow:parent``), each relative to the file it is written in. Renaming the
file by hand breaks them; this command rewrites every one in the same step,
through the visual editor's own ``rename`` action (``editor/filerename.py``),
so with an editor open it is one undoable "Agent: …" step there.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides, apply_edit, rename_request, report_deleted
from inkflow.editor.filerename import ORPHAN, TEMPLATE, UNUSED, USED, full_suffix
from inkflow.editor.remote import RemoteEditError, apply_request
from inkflow.editor.session import EditError, EditorSession
from inkflow.logging import report


def _in_project(raw: str, root: Path, must_exist: bool) -> str:
    """``raw`` (relative to the current folder, else to the project, or
    absolute) as a path relative to the project."""
    path = Path(raw).expanduser()
    if path.is_absolute():
        candidates = [path]
    else:
        here = Path.cwd() / path
        candidates = [here] if here.resolve().is_relative_to(root) else []
        candidates.append(root / path)
    chosen = next((c for c in candidates if c.exists()), None)
    if chosen is None:
        if must_exist:
            raise click.BadParameter(f"{raw} does not exist", param_hint="OLD")
        chosen = candidates[0]
    resolved = chosen.resolve()
    if not resolved.is_relative_to(root):
        raise click.BadParameter(f"{raw} is outside the project ({root})")
    return resolved.relative_to(root).as_posix()


@main.command("mv")
@click.argument("old", metavar="OLD")
@click.argument("new", metavar="NEW")
@deck_option
@click.option(
    "--dry-run",
    "-n",
    is_flag=True,
    help="Print the moves and reference edits; change nothing.",
)
def mv(old: str, new: str, deck_path: Path, dry_run: bool) -> None:
    """Rename or move a project file; every reference to it follows.

    OLD is any file of the deck (a picture, video, PDF, chart data, draw.io
    diagram, slide drawing, Markdown, notes, layout, overlay); NEW its new
    path. NEW may be a folder (the file keeps its name) and may leave out the
    extension, which never changes. A new folder is created, an emptied one
    removed.

    References are rewritten where they are written, each resolved against
    its own file: SVG hrefs and CSS url()s, Markdown images and links, chart
    data: lines, inkflow:parent (renaming layouts/a.svg to layouts/b.svg
    turns parent="a" into "b"), and the paths in deck.py. A slide whose id
    came from the renamed file's name takes the new id; its ink and slide:
    links follow.

    With `inkflow edit` open on the deck this is one undoable step there.
    """
    slides = DeckSlides.load(deck_path)
    root = slides.project_dir
    old_rel = _in_project(old, root, must_exist=True)
    if not (root / old_rel).is_file():
        raise click.BadParameter(f"{old} is not a file", param_hint="OLD")
    new_rel = _in_project(new, root, must_exist=False)
    name = Path(old_rel).name
    if new.endswith(("/", "\\")) or (root / new_rel).is_dir():
        new_rel = name if new_rel == "." else f"{new_rel}/{name}"
    elif not full_suffix(Path(new_rel).name):
        new_rel += full_suffix(name)
    rename_request(
        slides,
        {"action": "rename", "from": old_rel, "to": new_rel},
        f"Rename {old_rel} to {new_rel}",
        dry_run,
    )


# ── inkflow files ─────────────────────────────────────────────────────────────

_STATE_STYLE = {
    USED: "green",
    UNUSED: "yellow",
    ORPHAN: "yellow",
    TEMPLATE: "dim",
}


def _size(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB"
    if n >= 1000:
        return f"{round(n / 1000)} KB"
    return f"{n} B"


def _listing(slides: DeckSlides) -> dict[str, object]:
    """The session's ``files`` answer (read only: no server needed)."""
    session = EditorSession(slides.path)
    try:
        return session.apply({"action": "files"}, slides.deck)
    except EditError as exc:
        raise click.ClickException(str(exc)) from exc


def _detail(f: dict[str, object]) -> str:
    state, uses = f["state"], cast("int", f["uses"])
    by = cast("list[str]", f["by"])
    if state == USED:
        how = f"{uses} use{'' if uses == 1 else 's'}"
    elif state == ORPHAN:
        how = "only " + ", ".join(by)
    elif state == TEMPLATE:
        how = "unused template" if not by else "only " + ", ".join(by)
    else:
        how = "nothing uses it"
    git = "" if f["git"] == "no-repo" else f" · {f['git']}"
    return f"{f['path']}  {how}{git} · {_size(cast('int', f['size']))}"


@main.group("files", invoke_without_command=True)
@deck_option
@click.option(
    "--unused",
    is_flag=True,
    help="Only the files the deck does not use (unused, orphan, template).",
)
@click.option("--json", "as_json", is_flag=True, help="Print the list as JSON.")
@click.pass_context
def files(ctx: click.Context, deck_path: Path, unused: bool, as_json: bool) -> None:
    """The deck's files and whether the deck uses them.

    Every picture, video, PDF, data file, diagram, drawing and Markdown file
    of the project, with its state: `used` (reached from deck.py, directly or
    through files the deck uses; N uses), `unused` (nothing names it),
    `orphan` (only files the deck does not use name it, such as the pictures
    of a slide drawing left behind when its slide was deleted), or `template`
    (a layout or overlay no slide uses, or a file only those use). In a git
    repository, also each file's state there: committed, modified, untracked
    or ignored.

    `inkflow files clean` deletes the unused and orphan files.
    """
    if ctx.invoked_subcommand is not None:
        ctx.obj = {"deck": deck_path}
        return
    slides = DeckSlides.load(deck_path)
    listing = _listing(slides)
    entries = cast("list[dict[str, object]]", listing["files"])
    if unused:
        entries = [f for f in entries if f["state"] != USED]
    if as_json:
        click.echo(json.dumps({"repo": listing["repo"], "files": entries}, indent=2))
        return
    if not entries:
        report("Files", "the deck uses every file" if unused else "none", style="dim")
        return
    for f in entries:
        state = str(f["state"])
        report(state, _detail(f), style=_STATE_STYLE.get(state, "green"))


@files.command("clean")
@deck_option
@click.option(
    "--dry-run",
    "-n",
    is_flag=True,
    help="Print what would be deleted and what version control keeps; delete nothing.",
)
@click.option(
    "--templates",
    is_flag=True,
    help="Also delete layouts and overlays no slide uses (and files only they use).",
)
@click.pass_context
def clean(ctx: click.Context, deck_path: Path, dry_run: bool, templates: bool) -> None:
    """Delete the files the deck does not use.

    The `unused` and `orphan` files of `inkflow files` (with --templates the
    `template` ones too), in one step: with `inkflow edit` open on the deck it
    is one undoable "Agent: …" step there. Says which files version control
    cannot bring back: never committed (untracked, ignored), or with
    uncommitted changes (only the last committed version is kept).
    """
    parent = cast("dict[str, object] | None", ctx.obj)
    if deck_path == Path("deck.py") and isinstance(parent, dict):
        deck_path = cast("Path", parent.get("deck", deck_path))
    slides = DeckSlides.load(deck_path)
    wanted = {UNUSED, ORPHAN, TEMPLATE} if templates else {UNUSED, ORPHAN}
    entries = cast("list[dict[str, object]]", _listing(slides)["files"])
    paths = [str(f["path"]) for f in entries if f["state"] in wanted]
    if not paths:
        report("Nothing to delete", "the deck uses every file", style="dim")
        return
    request: dict[str, object] = {"action": "delete-files", "paths": paths}
    if dry_run:
        try:
            applied = apply_request(
                slides.path, slides.deck, slides.hash, {**request, "dryRun": True}
            )
        except RemoteEditError as exc:
            raise click.ClickException(str(exc)) from exc
        report_deleted(applied.result, dry_run=True, undo=applied.server is not None)
        return
    applied = apply_edit(slides, request, "Delete unused files")
    report_deleted(applied.result, dry_run=False, undo=applied.server is not None)
