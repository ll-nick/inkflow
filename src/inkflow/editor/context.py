"""The editor's current focus, shared with agents through ``.inkflow/context.json``.

The browser editor reports which slide, step and elements are selected; the
server writes that here. ``inkflow context`` reads it back as text an agent can
act on, so "align these" in a Claude Code prompt resolves to the elements the
author has selected in the editor. The directory ignores itself in git and is
excluded from the file watcher.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import cast

CONTEXT_DIR = ".inkflow"
CONTEXT_FILE = "context.json"
_MAX_SELECTION = 50


def context_path(project_dir: Path) -> Path:
    return project_dir / CONTEXT_DIR / CONTEXT_FILE


def context_dir(project_dir: Path) -> Path:
    """The project's ``.inkflow/``, created ignoring itself in git."""
    directory = project_dir / CONTEXT_DIR
    directory.mkdir(exist_ok=True)
    ignore = directory / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    return directory


def write_context(project_dir: Path, context: object) -> None:
    """Persist the editor's focus. Malformed input is dropped, not trusted."""
    if not isinstance(context, dict):
        return
    data = cast("dict[str, object]", context)
    selection = data.get("selection")
    if isinstance(selection, list):
        data["selection"] = cast("list[object]", selection)[:_MAX_SELECTION]
    data["updatedAt"] = time.time()
    directory = context_dir(project_dir)
    tmp = directory / f"{CONTEXT_FILE}.tmp"
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(context_path(project_dir))


def read_context(project_dir: Path) -> dict[str, object] | None:
    path = context_path(project_dir)
    try:
        data = cast("object", json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None
    return cast("dict[str, object]", data) if isinstance(data, dict) else None


def _fmt_box(box: object) -> str:
    if not isinstance(box, dict):
        return ""
    b = cast("dict[str, object]", box)
    try:
        x, y = float(cast("float", b["x"])), float(cast("float", b["y"]))
        w, h = float(cast("float", b["width"])), float(cast("float", b["height"]))
    except (KeyError, TypeError, ValueError):
        return ""
    return f" at ({x:.0f}, {y:.0f}) size {w:.0f}x{h:.0f}"


def format_context(context: dict[str, object], *, max_age: float | None = None) -> str:
    """Plain text an agent can act on. Empty when the context is older than
    ``max_age`` seconds (the editor was closed long ago).

    The prompt hook adds this to every message, so it stays a few lines.
    """
    updated = context.get("updatedAt")
    age = time.time() - float(cast("float", updated)) if updated else None
    if max_age is not None and (age is None or age > max_age):
        return ""
    slide = cast("dict[str, object]", context.get("slide") or {})
    head = "inkflow editor, what the author sees now:"
    lines: list[str] = []
    if slide:
        title = slide.get("title") or slide.get("id") or ""
        head += (
            f' slide {slide.get("number")}/{slide.get("total")} "{title}"'
            + f" (id {slide.get('id')}, deck.py slides[{slide.get('deckIndex')}])"
        )
        files = [
            f"{label} {slide[label]}"
            for label in ("svg", "md", "notes")
            if slide.get(label)
        ]
        if files:
            lines.append("  " + ", ".join(files))
    step = context.get("step")
    if step:
        head += f", previewing step {step}"
    if context.get("layoutMode"):
        head += ", in layout mode (edits change every slide on the layout)"
    selection = context.get("selection")
    if isinstance(selection, list) and selection:
        lines.append("selected:")
        for item in cast("list[object]", selection):
            if not isinstance(item, dict):
                continue
            sel = cast("dict[str, object]", item)
            zone = sel.get("zone")
            kind = f"zone '{zone}'" if zone else f"<{sel.get('tag')}>"
            ident = f" #{sel['id']}" if sel.get("id") else " (no id)"
            where = f" in {sel.get('file')}" if sel.get("file") else ""
            text = sel.get("text")
            snippet = f' "{str(text)[:80]}"' if text else ""
            lines.append(f"  - {kind}{ident}{where}{_fmt_box(sel.get('box'))}{snippet}")
    else:
        head += "; nothing selected"
    return "\n".join([head, *lines])
