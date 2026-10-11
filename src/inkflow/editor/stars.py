"""Starred slides: the author's own marks on the slides worth coming back to.

Kept in ``.inkflow/stars.json`` beside the editor's context, by slide id, so a
star stays on its slide wherever the slide moves. Like everything in
``.inkflow/`` the file is this working copy's (the folder ignores itself in
git) and is not watched: a star changes no slide, no export and no
presentation, and starting or stopping one builds nothing. The editor shows
them (slide list, grid view, its "starred only" filter), ``inkflow outline``
marks them, ``inkflow slide star`` sets them.

An id can change (a slide renamed, or the ``-2`` of two same-named slides
after one moves): the session passes each step's id changes on (`follow`),
and back again when the step is undone.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import cast

from inkflow.editor.context import CONTEXT_DIR, context_dir

STARS_FILE = "stars.json"


def stars_path(project_dir: Path) -> Path:
    return project_dir / CONTEXT_DIR / STARS_FILE


def read_stars(project_dir: Path) -> list[str]:
    """The starred slides' ids, in the order they were starred; none when
    there is no file or it cannot be read."""
    try:
        text = stars_path(project_dir).read_text(encoding="utf-8")
        data = cast("object", json.loads(text))
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    ids = cast("dict[str, object]", data).get("starred")
    if not isinstance(ids, list):
        return []
    seen: dict[str, None] = {}
    for item in cast("list[object]", ids):
        if isinstance(item, str) and item:
            seen[item] = None
    return list(seen)


def write_stars(project_dir: Path, ids: Iterable[str]) -> list[str]:
    """Keep ``ids`` (each once, in order) as the starred slides."""
    kept = list(dict.fromkeys(ids))
    directory = context_dir(project_dir)
    tmp = directory / f"{STARS_FILE}.tmp"
    _ = tmp.write_text(
        json.dumps({"starred": kept}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    _ = tmp.replace(stars_path(project_dir))
    return kept


def set_starred(
    project_dir: Path, ids: Iterable[str], on: bool, known: Iterable[str]
) -> list[str]:
    """Star (or unstar) the slides ``ids``. ``known`` are the deck's ids:
    a star left behind by a slide that is gone is dropped on the way, so a
    later slide of the same id does not come starred."""
    known = set(known)
    wanted = list(ids)
    current = [i for i in read_stars(project_dir) if i in known]
    if on:
        current += [i for i in wanted if i not in current]
    else:
        current = [i for i in current if i not in wanted]
    return write_stars(project_dir, current)


def follow(
    project_dir: Path, moves: Mapping[str, str], created: Iterable[str] = ()
) -> None:
    """Carry the stars through a step that changed ids (``moves``: old ->
    new, all at once: two slides may swap theirs) and made new slides
    (``created``: their ids start without a star, whoever had the id before).
    Nothing is written when no star is concerned."""
    stars = read_stars(project_dir)
    fresh = set(created)
    after = [moves.get(i, i) for i in stars if i in moves or i not in fresh]
    after = list(dict.fromkeys(after))
    if after != stars:
        _ = write_stars(project_dir, after)
