from __future__ import annotations

import sys
from pathlib import Path

import click

from inkflow.cli._common import Project, deck_option, main, resolve_deck_path
from inkflow.enums import ColorMode
from inkflow.logging import console
from inkflow.manifest import Deck
from inkflow.pipeline import resolve_slide_src, slide_ids
from inkflow.verify import verify_portable, verify_slide


@main.command("verify")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@deck_option
@click.option("--all", "include_hidden", is_flag=True, help="Include hidden slides.")
@click.option(
    "--strict", is_flag=True, help="Treat warnings as errors (exit 1 if any warn)."
)
@click.option(
    "--no-portable",
    "no_portable",
    is_flag=True,
    help="Skip the deck-wide checks of what ties it to this machine.",
)
def verify_cmd(
    files: tuple[Path, ...],
    deck_path: Path,
    include_hidden: bool,
    strict: bool,
    no_portable: bool,
) -> None:
    """Check slides for authoring errors before presenting or building.

    Runs per-slide checks and prints an `ok` / `error` / `warn` line for each,
    starting with the slide's number and id (and the layout or file it is
    drawn from), then one line saying how many slides were checked and how
    many errors and warnings were found.
    Errors: the SVG source, `.md`, notes file, or `Media.src` is missing; a zone id
    (from `zones` keys or `::zone::` markers) or an animation element id is absent
    from the composed SVG; an overlay paints an opaque full-canvas rect, which would
    hide the slide. Warnings: animation steps are not contiguous from 1, a zone id is
    declared twice after composition, or layout layers are stale (run `inkflow sync`).

    Then, for the whole deck (not with FILES or `--no-portable`), what ties it
    to this machine, one warning each: a font found only among this computer's
    fonts, missing, or a stack starting with a generic family; files outside
    the deck or behind a symlink; pictures from the web; no pinned inkflow, no
    uv.lock, no LF line-ending rules (`inkflow pack` fixes what it can).

    Exits 1 on any error, or on any warning when `--strict` is set. Hidden slides
    (`visible=False`) are skipped unless `--all` is passed.
    """

    project = Project.load(deck_path)
    deck_obj = project.deck
    project_dir = project.dir
    theme = project.theme
    slides = (
        deck_obj.slides if include_hidden else [s for s in deck_obj.slides if s.visible]
    )
    if files:
        resolved_files = {Path(f).resolve() for f in files}
        slides = [
            s
            for s in slides
            if resolve_slide_src(s.src, project_dir, theme) in resolved_files
        ]

    # effective_mode, not mode: a deck that defers to its theme has mode=None, which
    # would silently build the light preview here and disagree with the dark one
    # `inkflow sync` wrote, reporting every slide as stale.
    preview = project.preview_context(deck_obj.effective_mode == ColorMode.DARK)

    names = _slide_names(deck_obj)
    errors = warnings = 0
    for slide in slides:
        issues = verify_slide(slide, project_dir, theme, preview)
        errors += sum(1 for level, _ in issues if level == "error")
        warnings += sum(1 for level, _ in issues if level != "error")
        _print_slide_issues(names[id(slide)], issues)

    if not files and not no_portable:
        deck_file = resolve_deck_path(deck_path)
        deck_issues = verify_portable(deck_obj, project_dir, deck_file)
        if deck_issues:
            warnings += len(deck_issues)
            _print_slide_issues("deck", deck_issues)

    console.print(verify_summary(len(slides), errors, warnings))
    if errors or (strict and warnings):
        sys.exit(1)


def _slide_names(deck: Deck) -> dict[int, str]:
    """What each slide's lines start with: its number in the presentation
    and its id (what `outline`, `render -s` and `slide` take), then the
    layout or file it is drawn from when the id does not say. A hidden slide
    has no number."""
    visible = [s for s in deck.slides if s.visible]
    shown = dict(zip(map(id, visible), slide_ids(visible), strict=True))
    width = len(str(len(visible)))
    names: dict[int, str] = {}
    number = 0
    for slide in deck.slides:
        slide_id = shown.get(id(slide)) or slide_ids([slide])[0]
        if slide.visible:
            number += 1
        place = str(number) if slide.visible else "-"
        name = f"{place:>{width}} {slide_id}"
        if Path(slide.src).stem != slide_id:
            name += f" ({slide.src})"
        names[id(slide)] = name
    return names


def verify_summary(slides: int, errors: int, warnings: int) -> str:
    """The last line: what was checked and what was found (as `render --check`
    ends with its count)."""

    def count(n: int, word: str) -> str:
        return f"{n} {word}" + ("" if n == 1 else "s")

    checked = count(slides, "slide")
    if not errors and not warnings:
        return f"no problems in {checked}"
    found = [count(errors, "error")] if errors else []
    if warnings:
        found.append(count(warnings, "warning"))
    return f"{' and '.join(found)} in {checked}"


def _print_slide_issues(label: str, issues: list[tuple[str, str]]) -> None:
    if not issues:
        console.print(f"[bold green]ok   [/bold green]  [dim]{label}[/dim]")
        return
    first = True
    for level, msg in issues:
        if level == "error":
            badge = "[bold red]error[/bold red]"
            msg_markup = f"[red]{msg}[/red]"
        else:
            badge = "[bold yellow]warn [/bold yellow]"
            msg_markup = f"[yellow]{msg}[/yellow]"
        prefix = label if first else " " * len(label)
        console.print(f"{badge}  {prefix}  {msg_markup}")
        first = False
