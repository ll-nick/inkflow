"""``inkflow mv``: rename or move a project file, every reference following.

A picture, a chart's data file, a diagram or a slide's drawing is named in
other files (an SVG's ``href``, Markdown, deck.py, a layout's
``inkflow:parent``), each relative to the file it is written in. Renaming the
file by hand breaks them; this command rewrites every one in the same step,
through the visual editor's own ``rename`` action (``editor/filerename.py``),
so with an editor open it is one undoable "Agent: …" step there.
"""

from __future__ import annotations

from pathlib import Path

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides, rename_request
from inkflow.editor.filerename import full_suffix


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
