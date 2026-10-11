"""``inkflow comments``: the review comments people left on the slides in
the editor (editor/comments.py), for an agent or a terminal."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import Project, deck_option, main
from inkflow.editor import comments
from inkflow.logging import console
from inkflow.pipeline import slide_ids


@main.command("comments")
@deck_option
@click.option("--all", "include_resolved", is_flag=True, help="Resolved ones too.")
@click.option("--json", "as_json", is_flag=True, help="As JSON.")
def comments_cmd(deck_path: Path, include_resolved: bool, as_json: bool) -> None:
    """List the review comments on the slides, open ones first by slide.

    Each thread prints its slide's number and id, where it is pinned (an
    element id or a point in slide units) and every message with who wrote
    it. People add, answer and resolve them in the editor (right-click a
    slide, or the C key); they live in `.inkflow/comments.json`, not in git.
    """
    project = Project.load(deck_path)
    visible = [s for s in project.deck.slides if s.visible]
    numbers = {sid: n for n, sid in enumerate(slide_ids(visible), start=1)}
    threads = [
        t
        for t in comments.read_threads(project.dir)
        if include_resolved or not t.get("resolved")
    ]
    threads.sort(
        key=lambda t: (numbers.get(str(t.get("slide")), 10**9), t.get("created", 0))
    )
    if as_json:
        click.echo(
            json.dumps(
                [{**t, "number": numbers.get(str(t.get("slide")))} for t in threads],
                indent=2,
                ensure_ascii=False,
            )
        )
        return
    if not threads:
        console.print("no open comments" if not include_resolved else "no comments")
        return
    for t in threads:
        slide = str(t.get("slide"))
        number = numbers.get(slide)
        where = f"{number}. {slide}" if number else f"-  {slide} (not shown)"
        if isinstance(t.get("target"), str):
            where += f" @{t['target']}"
        elif isinstance(t.get("x"), int | float):
            where += f" @{t['x']:g},{t.get('y', 0):g}"
        if t.get("resolved"):
            where += " RESOLVED"
        console.print(where, highlight=False, markup=False)
        for m in cast("list[dict[str, object]]", t.get("messages") or []):
            at = m.get("at")
            when = (
                datetime.fromtimestamp(at).strftime("%Y-%m-%d %H:%M")
                if isinstance(at, int | float)
                else ""
            )
            console.print(
                f"  {m.get('name') or 'someone'} ({when}): {m.get('text', '')}",
                highlight=False,
                markup=False,
            )
