"""Review comments: threads pinned to a slide, or to a point or an element on
it, for the people editing a deck to discuss, reply to and resolve.

Kept in ``.inkflow/comments.json`` by slide id, like the stars (stars.py):
this working copy's, not committed, not watched, never part of a build, an
export or a presentation. Everyone editing through the same server sees
them at once (the server tells every editor page, ``{"type":"comments"}``),
``inkflow outline`` lists the open ones for an agent, and ``inkflow
comments`` prints them. A thread follows its slide through id changes
(`follow`, as the stars do).
"""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import cast

from inkflow.editor.context import CONTEXT_DIR, context_dir

COMMENTS_FILE = "comments.json"
MAX_TEXT = 5000


class CommentError(ValueError):
    pass


Thread = dict[str, object]
"""``{id, slide, x?, y?, target?, resolved, created, messages: [{author,
name, text, at}]}``: ``x``/``y`` a point in slide units, ``target`` an
element id on the slide."""


def comments_path(project_dir: Path) -> Path:
    return project_dir / CONTEXT_DIR / COMMENTS_FILE


def read_threads(project_dir: Path) -> list[Thread]:
    """Every thread, oldest first; none when there is no file or it cannot
    be read."""
    try:
        text = comments_path(project_dir).read_text(encoding="utf-8")
        data = cast("object", json.loads(text))
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    threads = cast("dict[str, object]", data).get("threads")
    if not isinstance(threads, list):
        return []
    return [
        cast("Thread", t)
        for t in cast("list[object]", threads)
        if isinstance(t, dict) and isinstance(cast("Thread", t).get("id"), str)
    ]


def write_threads(project_dir: Path, threads: Iterable[Thread]) -> list[Thread]:
    kept = list(threads)
    directory = context_dir(project_dir)
    tmp = directory / f"{COMMENTS_FILE}.tmp"
    _ = tmp.write_text(
        json.dumps({"threads": kept}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    _ = tmp.replace(comments_path(project_dir))
    return kept


def _text(raw: object) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise CommentError("write a comment")
    text = raw.strip()
    if len(text) > MAX_TEXT:
        raise CommentError(f"a comment is at most {MAX_TEXT} characters")
    return text


def _message(text: object, author: str, name: str) -> dict[str, object]:
    return {"author": author, "name": name, "text": _text(text), "at": time.time()}


def _find(threads: list[Thread], thread_id: object) -> Thread:
    for t in threads:
        if t.get("id") == thread_id:
            return t
    raise CommentError("that comment is gone")


def add(
    project_dir: Path,
    slide: str,
    text: object,
    author: str,
    name: str,
    *,
    x: object = None,
    y: object = None,
    target: object = None,
) -> Thread:
    """A new thread on slide ``slide`` (an id), at ``x``/``y`` (slide units)
    or on element ``target`` when given."""
    thread: Thread = {
        "id": secrets.token_hex(6),
        "slide": slide,
        "resolved": False,
        "created": time.time(),
        "messages": [_message(text, author, name)],
    }
    if isinstance(x, int | float) and isinstance(y, int | float):
        thread["x"], thread["y"] = round(float(x), 1), round(float(y), 1)
    if isinstance(target, str) and target:
        thread["target"] = target
    threads = read_threads(project_dir)
    write_threads(project_dir, [*threads, thread])
    return thread


def reply(
    project_dir: Path, thread_id: object, text: object, author: str, name: str
) -> Thread:
    threads = read_threads(project_dir)
    thread = _find(threads, thread_id)
    messages = cast("list[object]", thread.get("messages") or [])
    thread["messages"] = [*messages, _message(text, author, name)]
    thread["resolved"] = False
    write_threads(project_dir, threads)
    return thread


def resolve(project_dir: Path, thread_id: object, on: bool) -> Thread:
    threads = read_threads(project_dir)
    thread = _find(threads, thread_id)
    thread["resolved"] = on
    write_threads(project_dir, threads)
    return thread


def delete(project_dir: Path, thread_id: object, author: str, owner: bool) -> None:
    """Remove a thread: its author's, or anyone's for the owner."""
    threads = read_threads(project_dir)
    thread = _find(threads, thread_id)
    messages = cast("list[dict[str, object]]", thread.get("messages") or [])
    started = messages[0].get("author") if messages else None
    if not owner and started != author:
        raise CommentError("only who started a thread (or the owner) deletes it")
    write_threads(project_dir, [t for t in threads if t is not thread])


def follow(project_dir: Path, moves: Mapping[str, str]) -> None:
    """Carry the threads through a step that changed slide ids (``moves``:
    old -> new, all at once). Nothing is written when none is concerned."""
    threads = read_threads(project_dir)
    changed = False
    for t in threads:
        slide = t.get("slide")
        if isinstance(slide, str) and slide in moves:
            t["slide"] = moves[slide]
            changed = True
    if changed:
        write_threads(project_dir, threads)


def visible(threads: list[Thread], known: Iterable[str]) -> list[Thread]:
    """The threads whose slide the deck shows (a slide gone or hidden keeps
    its threads in the file, for when it comes back)."""
    ids = set(known)
    return [t for t in threads if t.get("slide") in ids]


def open_count(threads: list[Thread]) -> int:
    return sum(1 for t in threads if not t.get("resolved"))
