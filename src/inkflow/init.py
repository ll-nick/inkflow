from __future__ import annotations

import re
from importlib.metadata import PackageNotFoundError, version
from importlib.resources import files
from pathlib import Path

from inkflow.builtin_themes import THEMES
from inkflow.sizes import PageSize

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
{requirements}]
"""


def _project_name(target: Path) -> str:
    """Derive a PEP 508-valid project name from the target directory."""
    slug = re.sub(r"[^a-z0-9._-]+", "-", target.name.lower()).strip("-._")
    return slug or "my-deck"


def inkflow_requirement() -> str:
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


def with_theme(deck_py: str, theme: str) -> str:
    """A scaffolded ``deck.py`` on one of the shipped themes (`THEMES`):
    ``theme=Paper()`` after its title, the class imported from ``inkflow``.
    ``default`` leaves it as it is (no ``theme=``: the built-in theme).

    Raises ValueError for a name that is not a shipped theme."""
    if theme not in THEMES:
        raise ValueError(f"unknown theme {theme!r}: choose one of {', '.join(THEMES)}")
    if theme == "default":
        return deck_py
    name = THEMES[theme].__name__
    imports = re.compile(r"^from inkflow import (?P<names>.+)$", re.M)
    match = imports.search(deck_py)
    assert match is not None, "a scaffolded deck.py imports from inkflow"
    # classes first, then modules, as isort orders them
    names = sorted(
        {*match.group("names").split(", "), name}, key=lambda n: (n[:1].islower(), n)
    )
    deck_py = imports.sub(f"from inkflow import {', '.join(names)}", deck_py, 1)
    return re.sub(
        r"^(?P<indent>[ \t]*)title=.*\n",
        lambda m: m.group(0) + f"{m.group('indent')}theme={name}(),\n",
        deck_py,
        count=1,
        flags=re.M,
    )


def scaffold(target: Path, theme: str = "default") -> None:
    """Create starter files for a new presentation in target.

    Copies the packaged starter templates (kept lean, theme-agnostic) into
    ``slides/`` and ``notes/`` and writes a ``deck.py`` that wires them together,
    on ``theme`` (a name in `THEMES`). Layout parents and preview colors are
    injected live afterwards (see ``init_cmd``).
    """
    deck_py = with_theme(_DECK_PY, theme)
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

    (target / "deck.py").write_text(deck_py, encoding="utf-8")
    write_pyproject(target)


_POSTER_DECK_PY = """\
from inkflow import Deck, Image, Slide


def main() -> Deck:
    return Deck(
        title="My Poster",
        # The printed page: a0 (841 x 1189 mm), a1, a0-landscape, letter, or
        # PageSize.mm(...). The A sizes share one canvas, so this poster prints
        # at any of them, its text in proportion.
        size="{size}",
        slides=[
            # One page: the poster layout's zones filled from slides/poster.md
            # (::authors::, ::col-1::, ::references::, ...).
            Slide(
                "{layout}",
                md="poster",
                zones={{"logos": Image("figures/logo.svg")}},
            ),
        ],
    )
"""

# Copied from src/inkflow/templates/poster/ into a new poster project.
_POSTER_FILES = {
    "poster.md": "slides/poster.md",
    "figures/method.svg": "figures/method.svg",
    "figures/logo.svg": "figures/logo.svg",
    "data/results.csv": "data/results.csv",
}


def poster_layout(size: PageSize) -> str:
    """The built-in poster layout for a sheet of ``size``: three columns
    portrait or landscape (the template's three sections)."""
    w, h = size.canvas
    return "poster-landscape-3col" if w > h else "poster-3col"


def scaffold_poster(target: Path, size: str = "a0", theme: str = "default") -> PageSize:
    """Create a conference poster project in ``target``: one page on a
    built-in poster layout, its sections in ``slides/poster.md``, a chart
    from ``data/results.csv`` and a figure and a logo in ``figures/``, on
    ``theme`` (a name in `THEMES`).

    Raises ValueError for a size that is not a paper size, or an unknown
    theme."""
    sheet = PageSize(size)
    if not sheet.is_print:
        raise ValueError(
            "a poster is printed: give a paper size such as a0 or a1-landscape, "
            + f"not {size!r}"
        )
    deck_py = with_theme(
        _POSTER_DECK_PY.format(size=str(sheet), layout=poster_layout(sheet)), theme
    )
    templates = files("inkflow").joinpath("templates", "poster")
    target.mkdir(parents=True, exist_ok=True)
    for name, dest in _POSTER_FILES.items():
        path = target / dest
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(templates.joinpath(name).read_text(encoding="utf-8"))
    (target / "deck.py").write_text(deck_py, encoding="utf-8")
    write_pyproject(target)
    return sheet


def write_pyproject_text(target: Path, requirements: list[str]) -> str:
    """A bare ``pyproject.toml`` for a deck in ``target`` needing ``requirements``."""
    return _PYPROJECT.format(
        name=_project_name(target),
        requirements="".join(f'    "{r}",\n' for r in requirements),
    )


def write_pyproject(target: Path) -> None:
    """A bare ``pyproject.toml`` declaring the deck's inkflow dependency."""
    (target / "pyproject.toml").write_text(
        write_pyproject_text(target, [inkflow_requirement()]), encoding="utf-8"
    )
