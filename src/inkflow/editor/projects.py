"""Decks as projects: creating a new deck from the editor, browsing for a
folder to put it in, and remembering the decks recently opened.

A new deck is what ``inkflow init`` makes, in one of seven looks:

- ``starter``: the built-in theme and the three starter slides;
- ``paper``, ``stage``: the starter slides on one of the other themes inkflow
  ships (``inkflow init --theme``);
- ``showcase``: the built-in theme, one slide per built-in layout;
- ``example``: the starter slides in the inkflow example look (the footer logo
  overlay and its styles, as in inkflow's own demo deck);
- ``poster``: a conference poster (``inkflow init --poster``): one page on a
  built-in poster layout, at a paper size (``POSTER_SIZES``);
- ``current``: the open deck's look. Its ``deck.py`` is kept whole (theme,
  overlays, mode, transitions, its own classes) with the slide list replaced by
  the starter slides, and its styles, scripts, layouts, overlays and fonts are
  copied, with the files those reference.

Inside a git repository the deck is simply a new folder of it; elsewhere it can
get a repository of its own (``git init``, ``.gitignore``, SVG hooks).
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
from collections.abc import Callable
from importlib.resources import files
from pathlib import Path
from typing import cast

import platformdirs

from inkflow import init, pack, sync
from inkflow import lfs as lfs_rules
from inkflow.assets import REFERENCE_PATTERNS, is_local_ref
from inkflow.builtin_themes import Paper, Stage
from inkflow.editor import gitops, places
from inkflow.editor.codegen import Code
from inkflow.editor.deckedit import DeckEditError, DeckSource
from inkflow.enums import ColorMode
from inkflow.logging import logger
from inkflow.manifest import Deck
from inkflow.sizes import PageSize
from inkflow.themes import Builtin, Theme

THEMES: list[dict[str, str]] = [
    {
        "id": "current",
        "label": "This deck's look",
        "description": "The theme, styles, layouts and overlays of the deck open now",
    },
    {
        "id": "starter",
        "label": "Inkflow default",
        "description": "The built-in theme with three starter slides",
    },
    {
        "id": "paper",
        "label": "Paper",
        "description": "A quiet white theme: near-black text, hairline rules, "
        + "one ink-blue accent",
    },
    {
        "id": "stage",
        "label": "Stage",
        "description": "Big bold type on black (or white), soft cards, "
        + "one vivid blue",
    },
    {
        "id": "example",
        "label": "Inkflow example",
        "description": "Inkflow's demo look: the built-in theme, logo footer",
    },
    {
        "id": "showcase",
        "label": "Layout showcase",
        "description": "The built-in theme, one slide for each built-in layout",
    },
    {
        "id": "poster",
        "label": "Poster",
        "description": "A conference poster: title band, three columns, a chart "
        + "and a figure; exports as a PDF at its printed size",
    },
]

# The theme each look is on, for its preview in the dialog.
_LOOK_THEMES: dict[str, type[Theme]] = {
    "starter": Builtin,
    "paper": Paper,
    "stage": Stage,
    "example": Builtin,
    "showcase": Builtin,
    "poster": Builtin,
}
# Looks that are the starter slides on another theme (init.scaffold's names).
_THEMED_STARTERS = ("paper", "stage")

# The sizes the new-deck dialog offers a poster in (any PageSize works).
POSTER_SIZES = ("a0", "a1", "a2", "a0-landscape", "a1-landscape", "a2-landscape")

# What a deck's look is made of, besides deck.py.
_LOOK_FILES = ("styles.css", "scripts.js")
_LOOK_DIRS = ("layouts", "overlays", "fonts")
_RECENT_MAX = 10


class ProjectError(ValueError):
    pass


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:48] or "my-deck"


# ── Folders ──


_NO_FILES: frozenset[str] = frozenset()


def browse(
    path: str | None, fallback: Path, suffixes: frozenset[str] = _NO_FILES
) -> dict[str, object]:
    """A folder's subfolders, and its files with one of ``suffixes``, for the
    editor's folder and file pickers."""
    folder = Path(path).expanduser() if path else fallback
    if not folder.is_absolute():
        folder = fallback / folder
    folder = folder.resolve()
    while not folder.is_dir() and folder != folder.parent:
        folder = folder.parent
    try:
        dirs = sorted(
            (
                p.name
                for p in folder.iterdir()
                if p.is_dir() and not p.name.startswith(".")
            ),
            key=str.lower,
        )
    except OSError as exc:
        raise ProjectError(f"cannot read {folder}: {exc.strerror}") from exc
    root = gitops.repo_root(folder)
    found: list[dict[str, object]] = []
    if suffixes:
        for p in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
            if (
                p.suffix.lower() in suffixes
                and p.is_file()
                and not p.name.startswith(".")
            ):
                found.append({"name": p.name, "size": p.stat().st_size})
    return {
        "path": str(folder),
        "files": found[:1000],
        "parent": str(folder.parent) if folder.parent != folder else None,
        "dirs": dirs[:500],
        "isDeck": (folder / "deck.py").is_file(),
        "repo": str(root) if root else None,
        "home": str(Path.home()),
    }


def _empty(folder: Path) -> bool:
    return not folder.exists() or not any(
        not p.name.startswith(".") for p in folder.iterdir()
    )


def new_deck_info(deck_path: Path | None, deck: Deck | None) -> dict[str, object]:
    """Where a new deck goes by default, and which looks are on offer.

    Without a deck (the start page), a new deck goes in the home folder."""
    project_dir = deck_path.parent if deck_path else Path.home()
    root = gitops.repo_root(project_dir) if deck_path else None
    default = places.load()["default"]
    if root is not None and project_dir.resolve() != root.resolve():
        base = project_dir.parent  # next to this deck, in the same repository
    elif default is not None:
        base = Path(default)  # the default location the person saved
    elif deck_path is None:
        base = project_dir
    else:
        base = root or project_dir.parent
    name = "new-deck"
    n = 2
    while not _empty(base / name):
        name = f"new-deck-{n}"
        n += 1
    can_reuse = deck is not None and deck_path is not None and _reusable(deck_path)
    return {
        "repo": str(root) if root else None,
        "parent": str(base),
        "name": name,
        "home": str(Path.home()),
        "current": str(project_dir),
        "themes": [
            {**t, "preview": _preview(t["id"], deck)}
            for t in THEMES
            if t["id"] != "current" or can_reuse
        ],
        "posterSizes": [{"id": s, "label": PageSize(s).label} for s in POSTER_SIZES],
        "git": gitops.available(),
        "lfs": lfs_rules.available(),
    }


def _preview(look: str, deck: Deck | None) -> dict[str, str] | None:
    """The colours a look's thumbnail is drawn in: its theme in the mode a
    deck of that look opens in (a poster is printed: light)."""
    if look == "current":
        if deck is None:
            return None
        theme = deck.theme
        light = deck.effective_mode == ColorMode.LIGHT
    else:
        theme = _LOOK_THEMES[look]()
        light = look == "poster" or theme.mode == ColorMode.LIGHT
    p = theme.light if light else theme.dark
    return {
        "bg": p.bg,
        "surface": p.surface,
        "heading": p.heading,
        "muted": p.text_muted,
        "accent": p.accent,
    }


def _reusable(deck_path: Path) -> bool:
    try:
        return DeckSource.read(deck_path).slides_list() is not None
    except Exception:
        return False


# ── Creating a deck ──


def create_deck(
    target: Path,
    *,
    title: str,
    theme: str,
    git: bool,
    lfs: bool = True,
    current: Path | None = None,
    size: str | None = None,
) -> Path:
    """Make a new deck in ``target``; returns its deck.py. Its
    ``.gitattributes`` sends media through Git LFS, or (``lfs=False``) records
    that the deck uses git alone. ``size`` is a poster's paper size (``a0``
    when not given)."""
    target = target.expanduser()
    if not target.is_absolute():
        raise ProjectError("give the new deck's folder as a full path")
    target = target.resolve()
    if (target / "deck.py").exists():
        raise ProjectError(f"{target} already has a deck")
    if not _empty(target):
        raise ProjectError(f"{target} is not empty; choose a new folder")
    if theme not in {t["id"] for t in THEMES}:
        raise ProjectError(f"unknown look {theme!r}")
    if theme == "current" and (current is None or not _reusable(current)):
        raise ProjectError("this deck's slide list is built in code; pick another look")

    in_repo = gitops.repo_root(target) is not None
    target.mkdir(parents=True, exist_ok=True)
    try:
        if theme == "showcase":
            _showcase(target)
        elif theme == "poster":
            try:
                init.scaffold_poster(target, size or "a0")
            except ValueError as exc:
                raise ProjectError(str(exc)) from exc
        elif theme in _THEMED_STARTERS:
            init.scaffold(target, theme)
        else:
            init.scaffold(target)
        if theme == "example":
            _example(target)
        elif theme == "current" and current is not None:
            _reuse(current, target)
        _set_title(target / "deck.py", title)
        lfs_rules.ensure_attributes(target / ".gitattributes", lfs)
        pack.ensure_text_rules(target)
    except Exception:
        shutil.rmtree(target, ignore_errors=True)
        raise
    _sync_previews(target / "deck.py")
    _self_contained(target / "deck.py")
    if git and not in_repo and gitops.available():
        try:
            gitops.init(target, lfs=lfs)
        except gitops.GitError as exc:
            logger.warning(f"could not create a git repository: {exc}")
    remember(target / "deck.py")
    return target / "deck.py"


def _self_contained(deck_py: Path) -> None:
    """The fonts the look names that only this machine has, copied into the
    new deck's fonts/; uv.lock when uv is installed (best effort, both)."""
    try:
        bundled = pack.bundle_fonts_now(_load(deck_py), deck_py.parent)
        for warning in bundled.warnings:
            logger.warning(warning)
    except Exception as exc:
        logger.warning(f"could not check the new deck's fonts: {exc}")
    ok, note = pack.lock_new_deck(deck_py.parent)
    if not ok:
        logger.info(note)


def _set_title(deck_py: Path, title: str) -> None:
    title = title.strip()
    if not title:
        return
    source = DeckSource.read(deck_py)
    source.set_deck_arg("title", Code().literal(title))
    deck_py.write_text(source.code, encoding="utf-8")


def _showcase(target: Path) -> None:
    showcase = files("inkflow").joinpath("theme", "showcase")
    (target / "slides").mkdir()
    for item in showcase.joinpath("slides").iterdir():
        if item.name.endswith(".md"):
            (target / "slides" / item.name).write_text(
                item.read_text(encoding="utf-8"), encoding="utf-8"
            )
    (target / "deck.py").write_text(
        showcase.joinpath("deck.py").read_text(encoding="utf-8"), encoding="utf-8"
    )
    init.write_pyproject(target)


def _example(target: Path) -> None:
    example = files("inkflow").joinpath("templates", "example")
    (target / "overlays").mkdir(exist_ok=True)
    (target / "overlays" / "footer.svg").write_text(
        example.joinpath("overlays", "footer.svg").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (target / "styles.css").write_text(
        example.joinpath("styles.css").read_text(encoding="utf-8"), encoding="utf-8"
    )
    source = DeckSource.read(target / "deck.py")
    source.set_deck_arg("overlays", '[Overlay("footer")]')
    source.ensure_imports({"Overlay"})
    (target / "deck.py").write_text(source.code, encoding="utf-8")


def _reuse(current: Path, target: Path) -> None:
    """The open deck's deck.py with the starter slides, and its look's files."""
    starter = DeckSource.read(target / "deck.py")
    calls = starter.slide_calls() or []
    slides = [starter.module.code_for_node(c) for c in calls]
    source = DeckSource.read(current)
    try:
        existing = source.slide_calls()
        if existing is None:
            raise ProjectError("this deck's slide list is built in code")
        # The starter slides first: a deck may not be left without slides.
        for i, code in enumerate(slides):
            source.insert_slide(i, code)
        for _ in existing:
            source.remove_slide(len(slides))
        source.ensure_imports({"Slide", "animations"})
    except DeckEditError as exc:
        raise ProjectError(str(exc)) from exc
    (target / "deck.py").write_text(source.code, encoding="utf-8")

    src_dir = current.parent
    copied: list[Path] = []
    for name in _LOOK_FILES:
        if (src_dir / name).is_file():
            shutil.copy2(src_dir / name, target / name)
            copied.append(target / name)
    for name in _LOOK_DIRS:
        if (src_dir / name).is_dir():
            shutil.copytree(src_dir / name, target / name, dirs_exist_ok=True)
            copied.extend(p for p in (target / name).rglob("*") if p.is_file())
    _copy_references(copied, src_dir, target)


_CSS_URL = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)")


def _copy_references(copied: list[Path], src_dir: Path, target: Path) -> None:
    """Bring along the local files the copied look refers to (a logo, a font)."""
    for path in copied:
        if path.suffix.lower() not in (".svg", ".css"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        patterns = [*REFERENCE_PATTERNS, _CSS_URL]
        refs = {m.group(1) for p in patterns for m in p.finditer(text)}
        for ref in refs:
            if not is_local_ref(ref):
                continue
            source = (src_dir / path.relative_to(target).parent / ref).resolve()
            if not source.is_file() or not source.is_relative_to(src_dir.resolve()):
                continue
            dest = target / source.relative_to(src_dir.resolve())
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, dest)


def _load(deck_py: Path) -> Deck:
    """Load another deck without displacing the open deck's module."""
    spec = importlib.util.spec_from_file_location("_inkflow_new_deck", deck_py)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {deck_py}")
    module = importlib.util.module_from_spec(spec)
    # Registered while it runs (dataclasses look their module up), under a
    # name of its own, then dropped again.
    sys.modules[spec.name] = module
    try:
        exec(compile(deck_py.read_bytes(), str(deck_py), "exec"), module.__dict__)
        return cast(Callable[[], Deck], module.main)()
    finally:
        sys.modules.pop(spec.name, None)


def _sync_previews(deck_py: Path) -> None:
    """Layout layers and theme colours in the new deck's SVGs, for Inkscape."""
    try:
        deck = _load(deck_py)
        project = deck_py.parent
        backing = sync.slides_by_file(deck, project, deck.theme)
        overlays = sync.overlay_files(deck, project, deck.theme)
        paths = [
            p
            for p in dict.fromkeys([*backing, *sorted(overlays)])
            if p.is_relative_to(project)
        ]
        ctx = sync.build_context(
            deck, project, deck.theme, deck.effective_mode == ColorMode.DARK
        )
        sync.sync_slides(paths, ctx)
    except Exception as exc:
        logger.warning(f"could not add Inkscape previews to the new deck: {exc}")


# ── Recent decks ──


def _recent_file() -> Path:
    return Path(platformdirs.user_state_dir("inkflow")) / "recent-decks.json"


def recent() -> list[str]:
    try:
        raw = cast(object, json.loads(_recent_file().read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return []
    items = cast("list[object]", raw) if isinstance(raw, list) else []
    return [str(p) for p in items if isinstance(p, str) and Path(p).is_file()]


def remember(deck_py: Path) -> None:
    entry = str(deck_py.resolve())
    items = [entry, *(p for p in recent() if p != entry)][:_RECENT_MAX]
    try:
        _recent_file().parent.mkdir(parents=True, exist_ok=True)
        _recent_file().write_text(json.dumps(items, indent=2), encoding="utf-8")
    except OSError:
        pass


def deck_file(path: str) -> Path:
    """The deck.py a path names (the file, or the folder holding it)."""
    candidate = Path(path).expanduser()
    if candidate.is_dir():
        candidate = candidate / "deck.py"
    if candidate.name != "deck.py" or not candidate.is_file():
        raise ProjectError(f"no deck.py at {path}")
    return candidate.resolve()
