"""Each slide's changes since the last commit, and commits of chosen slides.

git knows files; a slide is several of them (its SVG, its Markdown, notes,
ink, chart data, pictures: `comparesrc.slide_paths`) plus its ``Slide(...)``
entry in deck.py, a file every slide shares. So a slide's state is read
from both: the git status of its own files, and its entry in deck.py
compared with the last commit's deck.py, entry by entry (`match_entries`).

- ``new``: its ``Slide(...)`` is not in the last commit (VS Code's U)
- ``modified``: its entry or one of its own files changed (M)
- ``shared``: only files it shares changed: its layout, an overlay, a
  picture or Markdown file other slides use too, or what every slide is
  drawn with (`deck_inputs`: styles.css, fonts, a theme in the deck's
  folder, Python files deck.py imports) (a dot)

A committed slide is complete: a fresh clone of the commit shows it exactly
as it looks now. So committing chosen slides commits every changed file they
are made of, the shared ones and the deck-wide ones included (a layout
change then reaches the other slides on it too), and a deck.py made for the
commit (`partial_deck`): the working deck.py with every other slide's entry
as it was in the last commit (a new one left out, a removed one put back
unless its removal goes in too), so the other slides' own changes stay
uncommitted. What deck.py says besides its slides (imports, the ``Deck(...)``
settings, sections, the order) goes in as it is now. Files a clone would
lack whatever is committed (ignored by git, outside the repository) are
named (`CommitPlan.missing`).
"""

from __future__ import annotations

import difflib
import os
import re
import sys
import textwrap
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

import libcst as cst

from inkflow.assets import is_local_ref
from inkflow.editor import gitops
from inkflow.editor.comparesrc import SideBuild, slide_paths
from inkflow.editor.deckedit import DeckEditError, DeckSource, SlideRef
from inkflow.fonts import font_sources
from inkflow.loaders import load_deck_styles
from inkflow.manifest import Inline
from inkflow.pipeline import slide_ids

NEW = "new"
MODIFIED = "modified"
SHARED = "shared"

_KINDS = ("id", "md", "src")
_SHARED_ROLES = frozenset({"layout", "overlay", "deck"})
_MAX_DIFF = 400_000
"""Characters of diff text sent to the page at most."""


# ── deck.py, entry by entry ──


@dataclass
class Entry:
    """One ``Slide(...)`` of deck.py: its code and what names it."""

    code: str
    names: dict[str, str] = field(default_factory=dict)
    """``id``, ``md``, ``src`` as written (`_names`)."""

    @property
    def key(self) -> str | None:
        """The name that says most: its id, else its Markdown, else its source."""
        for kind in _KINDS:
            if kind in self.names:
                return f"{kind}:{self.names[kind]}"
        return None

    @property
    def shown(self) -> str:
        """The code as a block of its own: its first line (which starts
        where the call does) indented like its closing line, then the
        whole dedented."""
        lines = self.code.splitlines()
        if len(lines) > 1:
            last = lines[-1]
            lines[0] = " " * (len(last) - len(last.lstrip())) + lines[0]
        return textwrap.dedent("\n".join(lines))

    @property
    def norm(self) -> str:
        """The code with its layout ignored (a slide moved into a section is
        indented again, and is the same slide)."""
        return " ".join(self.code.split())


def _string(node: cst.BaseExpression) -> str | None:
    if isinstance(node, cst.SimpleString):
        value = node.evaluated_value
        return value if isinstance(value, str) else None
    return None


def _names(call: cst.Call) -> dict[str, str]:
    """What names a slide in deck.py without running it: its ``id=``, its
    Markdown file and its source, as far as they are written as strings."""
    found: dict[str, str] = {}
    for arg in call.args:
        name = arg.keyword.value if arg.keyword is not None else None
        value = _string(arg.value)
        if value is None:
            continue
        if name in ("id", "md"):
            found.setdefault(name, value)
        elif name in (None, "src"):
            found.setdefault("src", value)
    return found


def entries(code: str | None) -> list[Entry] | None:
    """deck.py's slides as written, or None when its slide list is not a
    plain list of ``Slide(...)`` calls (or there is no such file)."""
    if code is None:
        return None
    try:
        source = DeckSource(code)
    except cst.ParserSyntaxError:
        return None
    calls = source.slide_calls()
    if calls is None:
        return None
    return [Entry(source.module.code_for_node(c), _names(c)) for c in calls]


def _agree(a: dict[str, str], b: dict[str, str]) -> bool:
    """Two slides' names say nothing against them being the same slide."""
    return all(a[k] == b[k] for k in a.keys() & b.keys())


def match_entries(head: list[Entry], work: list[Entry]) -> list[int | None]:
    """For each slide of ``work``, the slide of ``head`` it is (None: new).
    Identical code pairs first, in order; then the same id, the same
    Markdown file, the same source, each in order, as long as no other name
    the two both have differs (two slides on one layout with Markdown files
    of their own are two slides)."""
    found: list[int | None] = [None] * len(work)
    by_code: dict[str, deque[int]] = defaultdict(deque)
    for j, e in enumerate(head):
        by_code[e.norm].append(j)
    used: set[int] = set()
    for i, e in enumerate(work):
        if by_code[e.norm]:
            j = by_code[e.norm].popleft()
            found[i] = j
            used.add(j)
    for kind in _KINDS:
        for i, e in enumerate(work):
            name = e.names.get(kind)
            if found[i] is not None or name is None:
                continue
            j = next(
                (
                    j
                    for j, h in enumerate(head)
                    if j not in used
                    and h.names.get(kind) == name
                    and _agree(h.names, e.names)
                ),
                None,
            )
            if j is not None:
                found[i] = j
                used.add(j)
    return found


@dataclass
class DeckDiff:
    """deck.py now against the last commit, slide by slide."""

    head_code: str | None
    work_code: str
    head: list[Entry] | None
    work: list[Entry] | None
    match: list[int | None]

    @property
    def readable(self) -> bool:
        """Both versions' slides could be read (an untracked deck.py has no
        head version: every slide is new)."""
        return self.work is not None and (
            self.head_code is None or self.head is not None
        )

    def entry_state(self, index: int) -> str | None:
        """``new``, ``modified`` or None (as committed) for slide ``index``."""
        if self.head_code is None:
            return NEW
        if not self.readable or self.work is None or index >= len(self.work):
            return MODIFIED if self.head_code != self.work_code else None
        j = self.match[index]
        if j is None:
            return NEW
        assert self.head is not None
        return None if self.head[j].norm == self.work[index].norm else MODIFIED

    def removed(self) -> list[int]:
        """The last commit's slides that deck.py no longer has."""
        if self.head is None or not self.readable:
            return []
        kept = {j for j in self.match if j is not None}
        return [j for j in range(len(self.head)) if j not in kept]

    def entry_diff(self, index: int, rel: str) -> str:
        """Slide ``index``'s ``Slide(...)`` as a unified diff."""
        if self.work is None or index >= len(self.work):
            return ""
        j = self.match[index] if self.head is not None else None
        before = self.head[j].shown if self.head is not None and j is not None else ""
        after = self.work[index].shown
        if before == after:
            return ""
        lines = difflib.unified_diff(
            [f"{line}\n" for line in before.splitlines()],
            [f"{line}\n" for line in after.splitlines()],
            fromfile=f"a/{rel} (Slide)" if before else "/dev/null",
            tofile=f"b/{rel} (Slide)",
        )
        return "".join(lines)


def deck_diff(head_code: str | None, work_code: str) -> DeckDiff:
    head = entries(head_code)
    work = entries(work_code)
    match: list[int | None] = (
        match_entries(head, work)
        if head is not None and work is not None
        else [None for _ in work or []]
    )
    return DeckDiff(head_code, work_code, head, work, match)


class PartialError(Exception):
    pass


def partial_deck(diff: DeckDiff, selected: set[int], with_removed: bool) -> str:
    """deck.py as it would be committed with only the ``selected`` slides'
    changes (deck indices): every other slide as in the last commit, a new
    one left out; the slides deck.py no longer has gone too when
    ``with_removed``, else put back after the slide they followed."""
    if diff.head_code is None and not selected:
        raise PartialError("nothing of deck.py to commit")
    if not diff.readable or diff.work is None:
        raise PartialError(
            "deck.py's slides are not a plain list of Slide(...) calls:"
            + " commit deck.py as a whole"
        )
    source = DeckSource(diff.work_code)
    groups = source.groups()
    if groups is None:
        raise PartialError("deck.py's slide list cannot be read")
    # The committed slides with their comments, to put back as they were.
    committed = (
        DeckSource(diff.head_code).slide_items() if diff.head_code is not None else []
    ) or []
    changed = False
    # Each group's slides with the committed slide each one stands for.
    placed: list[list[tuple[SlideRef, int | None]]] = []
    for g in groups:
        out: list[tuple[SlideRef, int | None]] = []
        for s in g.slides:
            assert isinstance(s, int)
            j = diff.match[s]
            state = diff.entry_state(s)
            if s in selected or state is None:
                out.append((s, j))
            elif j is None:
                changed = True  # new, not chosen: not in this commit
            else:
                changed = True
                out.append((committed[j], j))
        placed.append(out)
    if not with_removed:
        for j in diff.removed():
            changed = True
            spot: tuple[int, int] = (0, 0)
            best = -1
            for gi, out in enumerate(placed):
                for pos, (_, k) in enumerate(out):
                    if k is not None and best < k < j:
                        best, spot = k, (gi, pos + 1)
            placed[spot[0]].insert(spot[1], (committed[j], j))
    if not changed:
        return diff.work_code
    if not any(placed):
        raise PartialError("a deck needs at least one slide")
    try:
        source.restructure(
            [
                g.with_slides([ref for ref, _ in out])
                for g, out in zip(groups, placed, strict=True)
            ]
        )
    except (DeckEditError, cst.ParserSyntaxError) as exc:
        raise PartialError(str(exc)) from exc
    return source.code


# ── Slides and their files ──


@dataclass
class SlideFile:
    path: str
    """Relative to the repository root, as git names it."""
    status: str
    role: str
    shared: bool

    def json(self) -> dict[str, object]:
        return {
            "path": self.path,
            "status": self.status,
            "role": self.role,
            "shared": self.shared,
        }


@dataclass
class SlideState:
    state: str | None
    entry: str | None
    files: list[SlideFile] = field(default_factory=list)

    def json(self) -> dict[str, object]:
        return {
            "state": self.state,
            "entry": self.entry,
            "files": [f.json() for f in self.files],
        }


@dataclass
class Changes:
    """The deck's changes since the last commit, slide by slide."""

    repo: gitops.Repo
    deck_rel: str
    diff: DeckDiff
    slides: list[SlideState]
    changed: dict[str, str]
    """Every changed file of the repository: path -> status."""
    claimed: set[str]
    """The changed files some slide is made of."""
    titles: list[str]
    outside: list[set[str]]
    """Per slide, the files it is made of that are outside the repository
    (a clone lacks them)."""
    made_of: list[list[str]]
    """Per slide, every file it is made of (relative to the repository)."""
    own: list[list[str]]
    """Per slide, the files only it is made of (no layout, overlay or deck
    input, no file another slide uses too)."""

    def removed_json(self) -> list[dict[str, object]]:
        head = self.diff.head or []
        return [
            {"index": j, "key": head[j].key, "code": head[j].code}
            for j in self.diff.removed()
        ]

    def json(self) -> dict[str, object]:
        deck_changed = self.deck_rel in self.changed
        return {
            "slides": [s.json() for s in self.slides],
            "removed": self.removed_json(),
            "deck": {
                "path": self.deck_rel,
                "status": self.changed.get(self.deck_rel),
                "readable": self.diff.readable,
                "other": deck_changed and self.other_changes(),
            },
        }

    def other_changes(self) -> bool:
        """deck.py changed besides its slides' entries: imports, settings,
        sections, the order (what goes in with any slide's commit)."""
        if self.diff.head_code is None:
            return True
        try:
            rest = partial_deck(self.diff, set(), with_removed=False)
        except PartialError:
            return True
        return rest != self.diff.head_code


_CSS_URL = re.compile(r"""url\(\s*['"]?([^'")]+)['"]?\s*\)""")


def _inside(path: Path, folder: Path) -> bool:
    return Path(os.path.abspath(path)).is_relative_to(os.path.abspath(folder))


def deck_inputs(build: SideBuild) -> tuple[dict[Path, str], list[Path]]:
    """What every slide is drawn with, besides deck.py: the project's
    styles.css and scripts.js and the files its ``url()``s name, the fonts
    the build embeds from the deck's folder, and the Python files deck.py
    imports from it; and the folder of a theme that lives in the deck's
    folder (any file in it counts). Files outside the folder are not the
    deck's to commit and are left out."""
    project = build.project_dir
    files: dict[Path, str] = {}

    def add(path: Path) -> None:
        if path.is_file() and _inside(path, project):
            files.setdefault(Path(os.path.abspath(path)), "deck")

    styles = project / "styles.css"
    add(styles)
    add(project / "scripts.js")
    if styles.is_file():
        text = styles.read_text(encoding="utf-8", errors="replace")
        for ref in cast("list[str]", _CSS_URL.findall(text)):
            if is_local_ref(ref):
                add(project / ref.split("?", 1)[0].split("#", 1)[0])
    deck = build.deck
    try:
        css = load_deck_styles(deck, project)
        fonts_dir = deck.theme.fonts_dir
        for _, font in font_sources(build.slides, project, fonts_dir, styles_css=css):
            if font is not None:
                add(font)
    except (OSError, ValueError):
        pass  # (a font that cannot be read is not the commit's concern)
    deck_file = Path(os.path.abspath(build.deck_path))
    for module in list(sys.modules.values()):
        file = getattr(module, "__file__", None)
        if isinstance(file, str) and file.endswith(".py"):
            path = Path(os.path.abspath(file))
            if path != deck_file and _inside(path, project):
                add(path)
    dirs: list[Path] = []
    try:
        theme_dir = deck.theme.asset_dir()
    except ValueError:
        theme_dir = None
    if theme_dir is not None and _inside(theme_dir, project):
        dirs.append(Path(os.path.abspath(theme_dir)))
    return files, dirs


def _deck_rel(repo: gitops.Repo, deck_path: Path) -> str:
    rel = repo.rel(deck_path)
    if rel is None:
        raise gitops.GitError("deck.py is outside its repository")
    return rel


def changes(build: SideBuild, repo: gitops.Repo) -> Changes:
    """Every slide's state since the last commit (see the module's words)."""
    changed = {str(c["path"]): str(c["status"]) for c in gitops.changes(repo)}
    deck_rel = _deck_rel(repo, build.deck_path)
    head_code = repo.head_text(deck_rel)
    work_code = build.deck_path.read_text(encoding="utf-8")
    if deck_rel not in changed and head_code is not None:
        work_code = head_code  # (the same file, maybe with other line ends)
    diff = deck_diff(head_code, work_code)
    deck = build.deck
    model_slides = cast("list[dict[str, object]]", build.model["slides"])
    ids = slide_ids(deck.slides)
    common, theme_dirs = deck_inputs(build)
    common_rel = {
        rel: role
        for path, role in common.items()
        if (rel := repo.rel(path)) is not None and rel != deck_rel
    }
    root = repo.root.resolve()
    for rel in changed:
        if any(_inside(root / rel, d) for d in theme_dirs):
            common_rel.setdefault(rel, "deck")
    outside: list[set[str]] = []
    per_slide: list[dict[str, str]] = []
    uses: dict[str, int] = defaultdict(int)
    titles: list[str] = []
    for index, (slide, entry) in enumerate(zip(deck.slides, model_slides, strict=True)):
        visible = entry.get("visibleIndex")
        data = build.slides[visible] if isinstance(visible, int) else None
        slide_id = data["id"] if data is not None else ids[index]
        titles.append(str(entry.get("title") or slide_id))
        files: dict[str, str] = {}
        away: set[str] = set()
        found = slide_paths(build, slide, entry, data, slide_id)
        style = slide.extra_style
        if style and not isinstance(style, Inline):
            path = Path(str(style))
            path = path if path.is_absolute() else build.project_dir / path
            if path.is_file():
                found.setdefault(Path(os.path.abspath(path)), "style")
        for path, role in found.items():
            rel = repo.rel(path)
            if rel is None:
                # (inkflow's own theme files come with inkflow.)
                if _inside(path, build.project_dir):
                    away.add(str(path))
            elif rel != deck_rel:
                files.setdefault(rel, role)
        for rel, role in common_rel.items():
            files.setdefault(rel, role)
        per_slide.append(files)
        outside.append(away)
        for rel in files:
            uses[rel] += 1
    states: list[SlideState] = []
    claimed: set[str] = set()
    for index, files in enumerate(per_slide):
        mine: list[SlideFile] = []
        for rel, role in files.items():
            status = changed.get(rel)
            if status is None:
                continue
            claimed.add(rel)
            shared = role in _SHARED_ROLES or uses[rel] > 1
            mine.append(SlideFile(rel, status, role, shared))
        mine.sort(key=lambda f: (f.shared, f.path))
        entry_state = diff.entry_state(index)
        if entry_state == NEW:
            state: str | None = NEW
        elif entry_state is not None or any(not f.shared for f in mine):
            state = MODIFIED
        elif mine:
            state = SHARED
        else:
            state = None
        states.append(SlideState(state, entry_state, mine))
    return Changes(
        repo,
        deck_rel,
        diff,
        states,
        changed,
        claimed,
        titles,
        outside,
        [list(files) for files in per_slide],
        [
            [
                rel
                for rel, role in files.items()
                if role not in _SHARED_ROLES and uses[rel] == 1
            ]
            for files in per_slide
        ],
    )


# ── One slide's diff ──


def slide_diff(found: Changes, index: int, shared: bool = True) -> str:
    """Slide ``index``'s changes as diff text: its ``Slide(...)`` entry, then
    its files (the shared ones last, when ``shared``)."""
    if not 0 <= index < len(found.slides):
        raise gitops.GitError(f"there is no slide {index + 1}")
    state = found.slides[index]
    parts = [found.diff.entry_diff(index, found.deck_rel)]
    files = [f for f in state.files if shared or not f.shared]
    tracked = [f.path for f in files if f.status != "new"]
    untracked = [f.path for f in files if f.status == "new"]
    parts.append(gitops.diff_text(found.repo, tracked, untracked))
    text = "".join(parts)
    if len(text) > _MAX_DIFF:
        text = text[:_MAX_DIFF] + "\n… (cut off: the diff is too long to show)\n"
    return text


# ── Committing chosen slides ──


@dataclass
class CommitPlan:
    paths: list[dict[str, object]]
    """Every changed file the chosen slides are made of, committed as it is
    (``why``: ``own``, ``shared`` with other slides, or ``deck`` = what every
    slide is drawn with)."""
    offered: list[dict[str, object]]
    """Changed files that may go along: deleted files no slide uses (ticked
    with the removal of slides)."""
    deck: str
    """How deck.py goes in: ``none``, ``whole`` or ``partial``."""
    deck_text: str | None
    other: bool
    """deck.py's changes besides slides (imports, settings, order) go in."""
    removed: list[dict[str, object]]
    left: int
    """Other slides with changes of their own that stay uncommitted."""
    missing: list[dict[str, object]] = field(default_factory=list)
    """Files the slides are made of that a clone would lack whatever is
    committed: ``ignored`` by git, or ``outside`` the repository."""
    touched: int = 0
    """Other slides that look different in the commit too (a shared file)."""

    def json(self, found: Changes) -> dict[str, object]:
        return {
            "paths": self.paths,
            "offered": self.offered,
            "deck": self.deck,
            "deckPath": found.deck_rel,
            "other": self.other,
            "removed": self.removed,
            "left": self.left,
            "missing": self.missing,
            "touched": self.touched,
        }


_WHY = ("own", "shared", "deck")


def commit_plan(found: Changes, selected: list[int], with_removed: bool) -> CommitPlan:
    chosen = {i for i in selected if 0 <= i < len(found.slides)}
    if not chosen:
        raise gitops.GitError("choose the slides to commit")
    paths: dict[str, dict[str, object]] = {}
    for i in sorted(chosen):
        for f in found.slides[i].files:
            why = "deck" if f.role == "deck" else "shared" if f.shared else "own"
            paths.setdefault(f.path, {"path": f.path, "status": f.status, "why": why})
    ordered = sorted(
        paths.values(), key=lambda p: (_WHY.index(str(p["why"])), str(p["path"]))
    )
    offered: list[dict[str, object]] = [
        {"path": rel, "status": status, "why": "deleted"}
        for rel, status in sorted(found.changed.items())
        if status == "deleted" and rel not in found.claimed and found.repo.in_deck(rel)
    ]
    touched = sum(
        1
        for i, s in enumerate(found.slides)
        if i not in chosen and any(f.path in paths for f in s.files)
    )
    deck = "none"
    deck_text: str | None = None
    other = False
    if found.deck_rel in found.changed:
        other = found.other_changes()
        text = partial_deck(found.diff, chosen, with_removed)
        if text == found.diff.work_code:
            deck = "whole"
        elif text != found.diff.head_code:
            deck, deck_text = "partial", text
    left = sum(
        1
        for i, s in enumerate(found.slides)
        if s.state in (NEW, MODIFIED) and i not in chosen
    )
    removed = [] if not with_removed else found.removed_json()
    if not paths and deck == "none" and not with_removed:
        raise gitops.GitError("these slides have no changes to commit")
    return CommitPlan(
        ordered,
        offered,
        deck,
        deck_text,
        other,
        removed,
        left,
        _missing(found, chosen),
        touched,
    )


def _missing(found: Changes, chosen: set[int]) -> list[dict[str, object]]:
    """The chosen slides' files a clone would lack: ignored by git, or
    outside the repository."""
    out: list[dict[str, object]] = [
        {"path": path, "why": "outside"}
        for path in sorted({p for i in chosen for p in found.outside[i]})
    ]
    rels = sorted({rel for i in chosen for rel in found.made_of[i]})
    root = found.repo.root
    states = gitops.file_states(found.repo.deck_dir, [root / rel for rel in rels])
    out.extend(
        {"path": rel, "why": "ignored"}
        for rel in rels
        if states.get(root / rel) == gitops.IGNORED
    )
    return out


def commit_slides(
    found: Changes,
    selected: list[int],
    message: str,
    with_removed: bool,
    extra: list[str],
) -> str:
    """Commit the chosen slides (see `commit_plan`) and the changed files
    ``extra`` names (the offered ones ticked); the
    short sha of the commit."""
    plan = commit_plan(found, selected, with_removed)
    paths = [str(p["path"]) for p in plan.paths]
    # Also: the offered files ticked (any changed file is accepted).
    paths += [p for p in extra if p in found.changed and p not in paths]
    blobs: dict[str, str] = {}
    if plan.deck == "whole":
        paths.append(found.deck_rel)
    elif plan.deck == "partial" and plan.deck_text is not None:
        blobs[found.deck_rel] = plan.deck_text
    if not paths and not blobs:
        raise gitops.GitError("these slides have no changes to commit")
    return gitops.commit_with(found.repo, message, paths, blobs)


# ── Discarding chosen slides' changes ──


@dataclass
class DiscardPlan:
    paths: list[dict[str, object]]
    """The chosen slides' own changed files, put back as committed (a new
    one deleted)."""
    shared: list[dict[str, object]]
    """Changed files they share with other slides: put back only when
    ticked (the other slides change too)."""
    deck: str
    """``none`` or ``partial``: deck.py with the chosen slides' entries as
    committed (a new one left out), everything else as it is now."""
    deck_text: str | None

    def json(self, found: Changes) -> dict[str, object]:
        return {
            "paths": self.paths,
            "shared": self.shared,
            "deck": self.deck,
            "deckPath": found.deck_rel,
        }


def discard_plan(found: Changes, selected: list[int]) -> DiscardPlan:
    """What discarding the chosen slides' changes writes: the opposite of
    `commit_plan`, the other slides' changes kept."""
    chosen = {i for i in selected if 0 <= i < len(found.slides)}
    if not chosen:
        raise gitops.GitError("choose the slides to put back")
    paths: dict[str, dict[str, object]] = {}
    shared: dict[str, dict[str, object]] = {}
    for i in sorted(chosen):
        own = set(found.own[i])
        for f in found.slides[i].files:
            target = paths if f.path in own else shared
            target.setdefault(f.path, {"path": f.path, "status": f.status})
    deck = "none"
    deck_text: str | None = None
    if found.deck_rel in found.changed and any(
        found.diff.entry_state(i) is not None for i in chosen
    ):
        others = set(range(len(found.slides))) - chosen
        if not others and found.diff.head_code is None:
            raise gitops.GitError("deck.py has no committed version to go back to")
        text = partial_deck(found.diff, others, with_removed=True)
        if text != found.diff.work_code:
            deck, deck_text = "partial", text
    if not paths and deck == "none" and not shared:
        raise gitops.GitError("these slides have no changes to put back")
    return DiscardPlan(list(paths.values()), list(shared.values()), deck, deck_text)


def discard_writes(
    found: Changes, plan: DiscardPlan, shared: list[str]
) -> dict[Path, bytes | None]:
    """The bytes each file gets (None: deleted), by absolute path: the own
    files and the ticked shared ones as committed, deck.py as planned."""
    allowed = {str(p["path"]) for p in plan.shared}
    rels = [str(p["path"]) for p in plan.paths] + [r for r in shared if r in allowed]
    root = found.repo.root
    out: dict[Path, bytes | None] = {
        root / rel: gitops.head_bytes(found.repo, rel) for rel in rels
    }
    if plan.deck_text is not None:
        out[root / found.deck_rel] = plan.deck_text.encode("utf-8")
    return out


# ── One slide's history ──


_LOG_MAX = 50


def slide_log(
    found: Changes, index: int, limit: int = _LOG_MAX
) -> list[dict[str, object]]:
    """The commits that changed slide ``index``: one of its own files, or its
    ``Slide(...)`` entry (found in each version of deck.py by what names it,
    `match_entries`), newest first."""
    if not 0 <= index < len(found.slides):
        raise gitops.GitError(f"there is no slide {index + 1}")
    repo = found.repo
    if not repo.has_head():
        return []
    own = set(found.own[index])
    paths = [*sorted(own), found.deck_rel]
    out = repo.git(
        "-c",
        "core.quotepath=off",
        "log",
        f"-n{limit * 4}",
        "--format=%x01%H%x00%h%x00%an%x00%ar%x00%s",
        "--name-only",
        "--",
        *paths,
    )
    work = found.diff.work[index] if found.diff.work is not None else None
    parsed: dict[str, list[Entry] | None] = {}

    def entry_at(rev: str) -> str | None:
        blob = gitops.try_git(repo, "rev-parse", f"{rev}:{found.deck_rel}")
        if blob is None or work is None:
            return None
        if blob not in parsed:
            parsed[blob] = entries(gitops.try_git(repo, "cat-file", "blob", blob))
        found_entries = parsed[blob]
        if not found_entries:
            return None
        j = match_entries(found_entries, [work])[0]
        return found_entries[j].norm if j is not None else None

    items: list[dict[str, object]] = []
    for chunk in out.split("\x01"):
        if not chunk.strip():
            continue
        head, *names = chunk.strip("\n").split("\n")
        sha, short, author, when, subject = head.split("\0")
        touched = sorted(n for n in names if n in own)
        entry: str | None = None
        if found.deck_rel in names:
            now, before = entry_at(sha), entry_at(f"{sha}^")
            if now != before:
                entry = (
                    "added"
                    if before is None
                    else "removed"
                    if now is None
                    else "changed"
                )
        if not touched and entry is None:
            continue
        items.append(
            {
                "sha": sha,
                "short": short,
                "author": author,
                "when": when,
                "subject": subject,
                "files": touched,
                "entry": entry,
            }
        )
        if len(items) >= limit:
            break
    return items
