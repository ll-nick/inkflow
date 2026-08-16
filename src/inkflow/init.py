from __future__ import annotations

import re
from importlib.metadata import PackageNotFoundError, version
from importlib.resources import files
from pathlib import Path

_DECK_PY = """\
from inkflow import Deck, Slide, animations


def main() -> Deck:
    return Deck(
        title="My Talk",
        slides=[
            # 1. A pure SVG you drew. Point a Slide at it and you are done.
            Slide("title", notes="notes/title.md"),
            # 2. A built-in layout, its zone filled with Markdown (slides/guide.md).
            Slide("content", md="guide", notes="notes/guide.md"),
            # 3. Your own SVG: it inherits a themed background via inkflow:parent,
            #    carries its own zone (slides/diagram.md), and animates an element
            #    by id -- here the "Browser" box appears once you click. Open
            #    slides/diagram.svg in Inkscape to see how.
            Slide(
                "diagram",
                md="diagram",
                animations=[animations.FadeIn("box-browser")],
                notes="notes/diagram.md",
            ),
        ],
    )
"""

# Copied verbatim from src/inkflow/templates/ into the new project.
_SLIDE_TEMPLATES = ("title.svg", "diagram.svg", "guide.md", "diagram.md")
_NOTES_TEMPLATES = ("title.md", "guide.md", "diagram.md")

_PYPROJECT = """\
[project]
name = "{name}"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "{requirement}",
]
"""


def _project_name(target: Path) -> str:
    """Derive a PEP 508-valid project name from the target directory."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", target.name.lower()).strip("-._")
    return slug or "my-deck"


def _inkflow_requirement() -> str:
    """Pin the scaffold to the running inkflow via a compatible-release bound.

    ``~=X.Y.Z`` lets patch fixes flow in but caps at the next minor, so a deck is
    not silently upgraded across a breaking release while the DSL is unstable. The
    exact version is still locked by ``uv.lock``. Falls back to a bare or ``>=``
    requirement if the version cannot be parsed to a release triple.
    """
    try:
        raw = version("inkflow")
    except PackageNotFoundError:
        return "inkflow"
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", raw)
    if match is None:
        return f"inkflow>={raw}"
    return f"inkflow~={match.group(1)}.{match.group(2)}.{match.group(3)}"


def scaffold(target: Path) -> None:
    """Create starter files for a new presentation in target.

    Copies the packaged starter templates (kept lean, theme-agnostic) into
    ``slides/`` and ``notes/`` and writes a ``deck.py`` that wires them together.
    Layout parents and preview colors are injected live afterwards (see
    ``init_cmd``).
    """
    templates = files("inkflow").joinpath("templates")
    target.mkdir(parents=True, exist_ok=True)
    slides_dir = target / "slides"
    slides_dir.mkdir(exist_ok=True)
    notes_dir = target / "notes"
    notes_dir.mkdir(exist_ok=True)

    for name in _SLIDE_TEMPLATES:
        content = templates.joinpath(name).read_text(encoding="utf-8")
        (slides_dir / name).write_text(content, encoding="utf-8")
    for name in _NOTES_TEMPLATES:
        content = templates.joinpath("notes", name).read_text(encoding="utf-8")
        (notes_dir / name).write_text(content, encoding="utf-8")

    (target / "deck.py").write_text(_DECK_PY, encoding="utf-8")

    (target / "pyproject.toml").write_text(
        _PYPROJECT.format(
            name=_project_name(target), requirement=_inkflow_requirement()
        ),
        encoding="utf-8",
    )
