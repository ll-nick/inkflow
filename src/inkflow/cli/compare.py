"""``inkflow compare``: which slides differ between two versions of a deck.

Each side is the working copy (the default left), a git revision (a sha, a
branch, a tag, ``HEAD~2``) or a deck folder / deck.py, e.g. an agent's git
worktree. The same comparison as the editor's compare view
(editor/compare.py), printed one line per slide that differs, as JSON, or as
side-by-side images of the slides that differ (``--sheet``).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.editor import comparesrc
from inkflow.editor.compare import compare_decks, comparison_json, format_comparison
from inkflow.editor.comparesrc import CompareError, Resolved, Source
from inkflow.editor.context import context_dir
from inkflow.server import load_deck


def _side(resolved: Resolved, live_deck: Path, module: str) -> comparesrc.SideBuild:
    deck_path = resolved.deck_path or live_deck
    try:
        return comparesrc.build_side(deck_path, module, load_deck)
    except Exception as exc:
        raise click.ClickException(f"{resolved.label} does not build: {exc}") from exc


@main.command("compare")
@deck_option
@click.argument("sides", nargs=-1, metavar="[LEFT] RIGHT")
@click.option("--json", "as_json", is_flag=True, help="Print the comparison as JSON.")
@click.option(
    "--sheet",
    is_flag=True,
    help="Write side-by-side images of the slides that differ, changes outlined.",
)
@click.option(
    "--output",
    "-o",
    default=None,
    help="PNG file or directory for --sheet (default: .inkflow/render/compare.png).",
)
@click.option("--chromium", default=None, help="Path to a Chromium/Chrome binary.")
@click.option(
    "--no-sandbox", "no_sandbox", is_flag=True, help="Pass --no-sandbox to Chromium."
)
def compare(
    deck_path: Path,
    sides: tuple[str, ...],
    as_json: bool,
    sheet: bool,
    output: str | None,
    chromium: str | None,
    no_sandbox: bool,
) -> None:
    """Show which slides differ between two versions of the deck.

    LEFT and RIGHT are each a git revision (`main`, `HEAD~2`, a sha, a tag) or a
    deck: a deck.py or a folder with one, such as a git worktree. LEFT defaults
    to the working copy. Slides are paired by id, then by the file they are
    written in, and one line is printed per slide that differs:

    \b
      ~ 3 features: slides/features.md, notes   changed (what differs)
      + 4 compare                               only on the right
      - 7 morph                                 only on the left
      ↕ 5 → 6 media                             moved (left → right number)
      = 8 unchanged: 1, 2, 9-14

    To review what your branch or worktree changes compared with main, run
    `inkflow compare main .` (main on the left, this folder on the right).
    `--sheet` writes images of the differing slides side by side with the
    changed elements outlined, for looking at instead of reading.
    """
    if not 1 <= len(sides) <= 2:
        raise click.UsageError("give one or two sides: [LEFT] RIGHT")
    live_deck = resolve_deck_path(deck_path)
    project_dir = live_deck.parent
    cwd = Path.cwd()
    try:
        sources = (
            [Source("live"), comparesrc.spec_source(sides[0], cwd, project_dir)]
            if len(sides) == 1
            else [comparesrc.spec_source(s, cwd, project_dir) for s in sides]
        )
        resolved: list[Resolved] = []
        for source in sources:
            in_use = [r.sha for r in resolved if r.sha]
            resolved.append(comparesrc.resolve(source, live_deck, in_use=in_use))
    except CompareError as exc:
        raise click.ClickException(str(exc)) from exc
    for r in resolved:
        for missing in r.missing:
            click.echo(
                f"warning: {r.label}: {missing} is a Git LFS file not here", err=True
            )
    left = _side(resolved[0], live_deck, "_inkflow_deck")
    right = _side(
        resolved[1],
        live_deck,
        "_inkflow_deck" if resolved[1].kind == "live" else "_inkflow_cmp_right",
    )
    left_facts, right_facts = comparesrc.deck_facts(left), comparesrc.deck_facts(right)
    result = compare_decks(left_facts, right_facts)
    labels = (resolved[0].label, resolved[1].label)
    if as_json:
        found = comparison_json(result, left_facts, right_facts)
        data = {
            "left": {
                "label": labels[0],
                "deck": str(left.deck_path),
                "slides": found["left"],
            },
            "right": {
                "label": labels[1],
                "deck": str(right.deck_path),
                "slides": found["right"],
            },
            "deck": found["deck"],
            "pairs": found["pairs"],
        }
        click.echo(
            json.dumps(
                data, indent=1 if sys.stdout.isatty() else None, ensure_ascii=False
            )
        )
    else:
        click.echo(format_comparison(result, left_facts, right_facts, *labels))
    if not sheet:
        return
    from inkflow.render import render_comparison

    out = (
        Path(output) if output else context_dir(project_dir) / "render" / "compare.png"
    )
    if output is None:
        out.parent.mkdir(parents=True, exist_ok=True)
    try:
        images = render_comparison(
            left,
            right,
            left_facts,
            right_facts,
            result,
            labels,
            out,
            chromium=chromium,
            no_sandbox=no_sandbox or (hasattr(os, "geteuid") and os.geteuid() == 0),
        )
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
    if not images:
        click.echo("no slides differ: no sheet written", err=True)
    for path in images:
        click.echo(str(path), err=as_json)
