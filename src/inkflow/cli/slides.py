"""``inkflow slide``: add, delete, duplicate, move, hide and rename slides,
and group them in sections (``inkflow slide section``).

A slide is more than its ``Slide(...)`` line: its drawing, Markdown, notes and
saved ink are files named after it (``ink/<slide id>.svg`` follows the id,
which a Markdown file's name gives). These commands make the change the visual
editor makes for the same click, through the same ``EditorSession`` action, so
every file moves together and deck.py keeps its comments and formatting.

When ``inkflow edit``/``serve`` has the deck open, the change goes through that
server (``editor.remote``): it lands in the editor's undo history as
"Agent: …", and the author can take it back there with Ctrl+Z.
"""

from __future__ import annotations

import sys
from pathlib import Path

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides as _Slides
from inkflow.cli._edits import apply_edit as _apply
from inkflow.cli._edits import rename_request
from inkflow.editor.remote import Applied
from inkflow.logging import report


def _new_place(applied: Applied, deck_path: Path) -> None:
    """Say where a new slide (``select``: its deck index) ended up."""
    index = applied.result.get("select")
    if not isinstance(index, int):
        return
    try:
        after = _Slides.load(deck_path)
    except click.ClickException:
        return
    if 0 <= index < len(after.ids):
        report("Slide", f"{after.name(index)} is the new one")


@main.group()
def slide() -> None:
    """Add, delete, duplicate, move, hide or rename slides; group them in sections.

    Each command changes deck.py and the slide's own files together (its
    drawing, Markdown, notes and saved ink), exactly as the visual editor does,
    and prints every file it wrote, created, renamed or deleted.

    When `inkflow edit` (or `serve`) has the deck open, the change is made by
    that server: the editor shows it at once as "Agent: …", and Ctrl+Z there
    undoes it. Otherwise the files are changed directly.

    SLIDE is a slide number as the presenter and `inkflow goto` count them
    (1-based, hidden slides left out) or a slide id; a hidden slide goes by id.
    """


@slide.command("add")
@deck_option
@click.option(
    "--layout",
    "-l",
    default=None,
    help="Layout to build it on (see `inkflow layouts`).",
)
@click.option("--like", default=None, metavar="SLIDE", help="The same layout as SLIDE.")
@click.option(
    "--after",
    default=None,
    metavar="SLIDE",
    help="Insert after SLIDE; 0 puts it first [default: last].",
)
@click.option(
    "--id", "name", default=None, help="Name for its files, which gives its id."
)
@click.option("--title", default=None, help="Its title (a leading `# ` heading).")
@click.option(
    "--md",
    default=None,
    help="Its Markdown text (`-` reads stdin), saved as slides/<id>.md.",
)
def add(
    deck_path: Path,
    layout: str | None,
    like: str | None,
    after: str | None,
    name: str | None,
    title: str | None,
    md: str | None,
) -> None:
    """Add a slide with its own drawing, built on a layout.

    The drawing is slides/<id>.svg, on LAYOUT (or the layout of --like),
    blank without either. --title and --md fill its zones through
    slides/<id>.md, as text typed into the editor would.
    """
    if layout and like:
        raise click.UsageError("give --layout or --like, not both")
    slides = _Slides.load(deck_path)
    request: dict[str, object] = {"action": "slide", "op": "new"}
    summary = "Add a slide"
    if like:
        model = slides.index(like)
        request["like"] = model
        summary += f" like {slides.name(model)}"
    elif layout:
        request["layout"] = layout
        summary += f" on {layout}"
    if after is None:
        request["after"] = len(slides.ids) - 1
    elif after.strip() == "0":
        request["after"] = -1
    else:
        request["after"] = slides.index(after)
    if name:
        request["name"] = name
    text = sys.stdin.read() if md == "-" else (md or "")
    if title:
        text = f"# {title.strip()}\n\n{text}".rstrip() + "\n"
    if text.strip():
        request["md"] = text
    applied = _apply(slides, request, summary)
    _new_place(applied, slides.path)


@slide.command("delete")
@click.argument("refs", metavar="SLIDE...", nargs=-1, required=True)
@deck_option
@click.option(
    "--keep-files",
    is_flag=True,
    help="Leave its drawing, Markdown and notes files in place.",
)
def delete(refs: tuple[str, ...], deck_path: Path, keep_files: bool) -> None:
    """Delete slides, with the files only they use.

    Its drawing, Markdown, notes and ink go too, unless another slide uses
    them (a shared layout always stays). All the slides go in one step.
    """
    slides = _Slides.load(deck_path)
    indices = sorted({slides.index(r) for r in refs})
    names = ", ".join(slides.name(i) for i in indices)
    _apply(
        slides,
        {
            "action": "slide",
            "op": "delete",
            "slides": indices,
            "files": not keep_files,
        },
        f"Delete {names}",
    )


@slide.command("duplicate")
@click.argument("ref", metavar="SLIDE")
@deck_option
def duplicate(ref: str, deck_path: Path) -> None:
    """Copy a slide, with its own files, right after it."""
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    applied = _apply(
        slides,
        {"action": "slide", "op": "duplicate", "slide": index},
        f"Duplicate {slides.name(index)}",
    )
    _new_place(applied, slides.path)


@slide.command("move")
@click.argument("ref", metavar="SLIDE")
@click.option(
    "--to",
    "to",
    type=click.IntRange(min=1),
    default=None,
    help="The number it gets (as the presenter counts); past the end = last.",
)
@click.option(
    "--section",
    "section_ref",
    default=None,
    metavar="SECTION",
    help="The section it joins (at its end, or at --to within it).",
)
@deck_option
def move(ref: str, to: int | None, section_ref: str | None, deck_path: Path) -> None:
    """Move a slide so it becomes slide number --to, or into --section.

    With --to alone it joins the section of the slide it lands before.
    """
    if to is None and section_ref is None:
        raise click.UsageError("give --to, --section or both")
    slides = _Slides.load(deck_path)
    src = slides.index(ref)
    rest = [i for i in range(len(slides.ids)) if i != src]
    shown = [i for i in rest if slides.numbers[i] is not None]
    request: dict[str, object] = {"action": "slide", "op": "move", "from": src}
    where: list[str] = []
    if to is not None:
        # Before the slide that number belongs to once this one is out of the way.
        request["to"] = rest.index(shown[to - 1]) if to <= len(shown) else len(rest)
        where.append(f"to {min(to, len(shown) + 1)}")
    else:
        request["to"] = len(rest)  # the session keeps it inside the section
    if section_ref is not None:
        k = slides.section(section_ref)
        request["section"] = k
        where.append(f"into section {slides.section_name(k)}")
    _apply(slides, request, f"Move {slides.name(src)} {' '.join(where)}")


# ── Sections ──────────────────────────────────────────────────────────────────


@slide.group("section")
def section_group() -> None:
    """Add, rename, move or remove sections (named groups of slides).

    SECTION is a section's name (any case) or its 1-based position among the
    sections. Slides before the first section belong to none. Each command is
    one step, undoable in an open editor like the other slide commands.
    """


@section_group.command("add")
@click.argument("name")
@click.option(
    "--at",
    default=None,
    metavar="SLIDE",
    help="The slide it starts at; it takes the rest of that slide's section "
    + "[default: a new empty section at the end].",
)
@deck_option
def section_add(name: str, at: str | None, deck_path: Path) -> None:
    """Start a section called NAME at slide --at."""
    slides = _Slides.load(deck_path)
    request: dict[str, object] = {"action": "slide", "op": "section-add", "name": name}
    summary = f"Add section {name}"
    if at is not None:
        index = slides.index(at)
        request["slide"] = index
        summary += f" at {slides.name(index)}"
    _apply(slides, request, summary)


@section_group.command("rename")
@click.argument("ref", metavar="SECTION")
@click.argument("name", metavar="NEW_NAME")
@deck_option
def section_rename(ref: str, name: str, deck_path: Path) -> None:
    """Rename a section."""
    slides = _Slides.load(deck_path)
    k = slides.section(ref)
    _apply(
        slides,
        {"action": "slide", "op": "section-rename", "section": k, "name": name},
        f"Rename section {slides.section_name(k)} to {name}",
    )


@section_group.command("move")
@click.argument("ref", metavar="SECTION")
@click.option(
    "--to",
    type=click.IntRange(min=1),
    default=None,
    help="The position it gets among the sections (1 = first).",
)
@click.option(
    "--before", default=None, metavar="SECTION", help="Put it before SECTION."
)
@deck_option
def section_move(ref: str, to: int | None, before: str | None, deck_path: Path) -> None:
    """Move a section, with all its slides, among the sections.

    Slides before the first section stay first.
    """
    if (to is None) == (before is None):
        raise click.UsageError("give --to or --before")
    slides = _Slides.load(deck_path)
    k = slides.section(ref)
    count = len(slides.deck.sections)
    if before is not None:
        other = slides.section(before)
        dst = other - 1 if other > k else other
        where = f"before {slides.section_name(other)}"
    else:
        assert to is not None
        dst = min(to, count) - 1
        where = f"to {dst + 1}"
    _apply(
        slides,
        {"action": "slide", "op": "section-move", "section": k, "to": dst},
        f"Move section {slides.section_name(k)} {where}",
    )


@section_group.command("remove")
@click.argument("ref", metavar="SECTION")
@click.option(
    "--with-slides",
    is_flag=True,
    help="Delete its slides too (with the files only they use).",
)
@click.option(
    "--keep-files",
    is_flag=True,
    help="With --with-slides: leave the slides' files in place.",
)
@deck_option
def section_remove(
    ref: str, with_slides: bool, keep_files: bool, deck_path: Path
) -> None:
    """Remove a section; its slides join the section before it (or none).

    With --with-slides its slides are deleted as `inkflow slide delete` does.
    """
    slides = _Slides.load(deck_path)
    k = slides.section(ref)
    summary = f"Remove section {slides.section_name(k)}"
    if with_slides:
        summary += " and its slides"
    _apply(
        slides,
        {
            "action": "slide",
            "op": "section-remove",
            "section": k,
            "slides": with_slides,
            "files": with_slides and not keep_files,
        },
        summary,
    )


def _set_hidden(ref: str, deck_path: Path, hidden: bool) -> None:
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    if (slides.numbers[index] is None) == hidden:
        state = "hidden" if hidden else "shown"
        report("Unchanged", f"{slides.name(index)} is already {state}", style="dim")
        return
    verb = "Hide" if hidden else "Show"
    _apply(
        slides,
        {"action": "slide", "op": "hide", "slide": index, "hidden": hidden},
        f"{verb} {slides.name(index)}",
    )


@slide.command("hide")
@click.argument("ref", metavar="SLIDE")
@deck_option
def hide(ref: str, deck_path: Path) -> None:
    """Leave a slide out of the presentation (`visible=False`); it keeps its
    files and is addressed by its id while hidden."""
    _set_hidden(ref, deck_path, hidden=True)


@slide.command("show")
@click.argument("ref", metavar="SLIDE")
@deck_option
def show(ref: str, deck_path: Path) -> None:
    """Put a hidden slide back in the presentation."""
    _set_hidden(ref, deck_path, hidden=False)


@slide.command("rename")
@click.argument("ref", metavar="SLIDE")
@click.argument("new_id", metavar="NEW_ID")
@deck_option
def rename(ref: str, new_id: str, deck_path: Path) -> None:
    """Give a slide a new id (`id=` in deck.py).

    Its saved ink follows (ink/<id>.svg), and `slide:<old id>` links in
    deck.py and the slides' files are rewritten to the new id.
    """
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    _apply(
        slides,
        {"action": "slide", "op": "id", "slide": index, "id": new_id},
        f"Rename {slides.name(index)} to {new_id}",
    )


@slide.command("rename-files")
@click.argument("ref", metavar="SLIDE")
@click.argument("stem", metavar="NEW_NAME")
@click.option(
    "--keep-id",
    is_flag=True,
    help="Keep the slide's current id (written as id=) instead of the new name.",
)
@click.option(
    "--dry-run",
    "-n",
    is_flag=True,
    help="Print the moves and reference edits; change nothing.",
)
@deck_option
def rename_files(
    ref: str, stem: str, keep_id: bool, dry_run: bool, deck_path: Path
) -> None:
    """Rename a slide's own files to NEW_NAME: its drawing, Markdown, notes
    and named ink file, each in its folder with its extension.

    Every reference follows (as with `inkflow mv`). The slide's id is
    inferred from those names, so it becomes NEW_NAME too, and its saved ink
    and `slide:` links follow, unless the slide has an explicit id= (kept;
    dropped when it equals NEW_NAME) or --keep-id. Files other slides use
    as well (a layout, a shared drawing or Markdown file) stay as they are.
    """
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    request: dict[str, object] = {
        "action": "rename",
        "slide": index,
        "stem": stem,
        "keepId": keep_id,
    }
    rename_request(
        slides, request, f"Rename the files of {slides.name(index)} to {stem}", dry_run
    )


@slide.command("title")
@click.argument("ref", metavar="SLIDE")
@click.argument("text", metavar="TITLE")
@deck_option
def title_cmd(ref: str, text: str, deck_path: Path) -> None:
    """Set a slide's title (`title=`: the overview, the outline and the tab
    title); an empty TITLE removes it. The text on the slide is not changed."""
    slides = _Slides.load(deck_path)
    index = slides.index(ref)
    _apply(
        slides,
        {"action": "slide", "op": "title", "slide": index, "title": text},
        f"Retitle {slides.name(index)}",
    )
