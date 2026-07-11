from __future__ import annotations

import sys
from pathlib import Path

import click

from inkflow import colors, loaders
from inkflow.cli._common import Project, deck_option, main
from inkflow.enums import ColorMode
from inkflow.logging import console
from inkflow.pipeline import resolve_slide_src
from inkflow.verify import verify_slide


@main.command("verify")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@deck_option
@click.option("--all", "include_hidden", is_flag=True, help="Include hidden slides.")
@click.option(
    "--strict", is_flag=True, help="Treat warnings as errors (exit 1 if any warn)."
)
def verify_cmd(
    files: tuple[Path, ...],
    deck_path: Path,
    include_hidden: bool,
    strict: bool,
) -> None:
    """Check slides for authoring errors before presenting or building.

    Runs per-slide checks and prints an `ok` / `error` / `warn` line for each.
    Errors: the SVG source, `.md`, notes file, or `Media.src` is missing; a zone id
    (from `zones` keys or `::zone::` markers) or an animation element id is absent
    from the composed SVG. Warnings: animation steps are not contiguous from 1, or
    layout layers are stale (run `inkflow sync`).

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

    css = loaders.load_deck_styles(deck_obj, project_dir)
    preview_css = colors.build_preview_style(
        colors.extract_tokens(css, deck_obj.mode == ColorMode.DARK)
    )

    has_error = has_warn = False
    for slide in slides:
        issues = verify_slide(slide, project_dir, theme, preview_css)
        for level, _ in issues:
            if level == "error":
                has_error = True
            else:
                has_warn = True
        _print_slide_issues(str(slide.src), issues)

    if has_error or (strict and has_warn):
        sys.exit(1)


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
