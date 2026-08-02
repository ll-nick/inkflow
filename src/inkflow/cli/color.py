from __future__ import annotations

import sys
from pathlib import Path

import click

from inkflow import colors, loaders
from inkflow.cli._common import (
    deck_option,
    load_project_or_none,
    main,
    mode_option,
    no_deck_option,
    resolve_dark_mode,
    targets_or_deck_slides,
)
from inkflow.logging import logger, report


@main.command("colorize")
@click.argument("files", nargs=-1, type=click.Path(path_type=Path))
@deck_option
@no_deck_option
@mode_option
def colorize_cmd(
    files: tuple[Path, ...],
    deck_path: Path,
    no_deck: bool,
    color_mode: str | None,
) -> None:
    """Replace hardcoded theme hex colors in SVG files with semantic CSS classes.

    Reads the active theme's color tokens and replaces matching fill/stroke
    attributes and inline style declarations with inkflow-fill-* / inkflow-stroke-*
    classes. The hardcoded attributes are removed after replacement.

    If FILES is omitted, colorizes every project-local SVG the deck uses
    (each slide and its local layout ancestors).
    """
    project = load_project_or_none(deck_path, no_deck)
    deck_obj = project.deck if project else None
    project_dir = project.dir if project else None
    dark_mode = resolve_dark_mode(color_mode, deck_obj, no_deck)
    deck_styles = loaders.load_deck_styles(deck_obj, project_dir)
    hex_map = colors.hex_to_class_map(colors.extract_tokens(deck_styles, dark_mode))

    targets = targets_or_deck_slides(files, project)
    errors = False
    for target in targets:
        try:
            new_svg, changed = colors.colorize_svg(
                target.path.read_text(encoding="utf-8"), hex_map
            )
            if changed:
                target.path.write_text(new_svg, encoding="utf-8")
                report("Colorized", target.label)
            else:
                report("Unchanged", target.label, style="dim")
        except Exception as exc:
            logger.error(f"colorize: {target.label}: {exc}")
            errors = True

    if errors:
        sys.exit(1)


@main.command("palette")
@deck_option
@no_deck_option
@mode_option
def palette_cmd(
    deck_path: Path,
    no_deck: bool,
    color_mode: str | None,
) -> None:
    """Generate an Inkscape GPL color palette for the active theme.

    Writes a .gpl palette to stdout whose colors correspond to the inkflow-fill-* /
    inkflow-stroke-* CSS class tokens so you can pick theme colors by name in
    Inkscape's swatches panel and then run 'inkflow colorize' to convert the
    hardcoded hex values to semantic classes. Redirect it to save:

        inkflow palette > inkflow.gpl
    """
    project = load_project_or_none(deck_path, no_deck)
    deck_obj = project.deck if project else None
    project_dir = project.dir if project else None
    dark_mode = resolve_dark_mode(color_mode, deck_obj, no_deck)
    tokens = colors.extract_tokens(
        loaders.load_deck_styles(deck_obj, project_dir), dark_mode
    )

    theme_label = project.theme.name if project else None
    mode_label = "light" if not dark_mode else "dark"
    palette_name = f"{theme_label or 'inkflow'} ({mode_label})"
    gpl = colors.build_gpl(tokens, palette_name)
    click.echo(gpl, nl=False)
