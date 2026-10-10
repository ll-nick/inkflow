"""The two sides of a comparison: where each deck comes from, and its build.

A side is named by a source (JSON from the editor, or a spec on the command
line):

- ``{"kind": "live"}``: the deck being served (or, for the CLI, the deck on disk);
- ``{"kind": "commit", "rev": …}``: any revision git understands (a sha, a
  branch or tag name, ``HEAD~2``), read from the deck's repository;
- ``{"kind": "path", "deck": …}``: any deck.py (or a folder holding one), e.g.
  an agent's git worktree;
- ``{"kind": "branch", "name": …}``: that branch's worktree when one has it
  checked out (the live deck itself if it is this one), else its commit.

A commit is materialized read-only into ``.inkflow/cache/compare/<sha>/`` (git
ignores ``.inkflow/``, the watcher skips it) through a throwaway index:
``git read-tree`` + ``git checkout-index``, which runs the checkout filters, so
Git LFS media arrive as files, not pointers. A pointer that is still a pointer
(git-lfs missing, the object not fetched) is replaced by the working copy's
file when that has the pointer's content. Nothing is registered as a worktree,
so ``git worktree list`` stays the author's. Old materializations are pruned.

`build_side` builds a deck as the editor does (``process_deck(editor=True)``,
its model, its styles) under a module name of its own, and `deck_facts` reads
what `editor/compare.py` compares off it.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import shutil
import subprocess
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, cast

from inkflow.assets import THEME_PREFIX, AssetRoots, is_local_ref, rewrite_references
from inkflow.editor.compare import (
    DeckFacts,
    SlideFacts,
    normalize_svg,
    plain_text,
    strip_editor_attrs,
)
from inkflow.editor.context import CONTEXT_DIR, context_dir
from inkflow.enums import ColorMode
from inkflow.ink import ink_path
from inkflow.loaders import load_deck_scripts, load_deck_styles, resolve_content_src
from inkflow.manifest import Chart, Deck, Inline, Slide
from inkflow.pipeline import SlideData, process_deck, slide_ids

CACHE_DIR = Path(CONTEXT_DIR, "cache", "compare")
KEEP = 6
"""Materialized commits kept in the cache (the newest, plus any in use)."""
_TIMEOUT = 120

Kind = Literal["live", "commit", "path", "branch"]


class CompareError(Exception):
    """A side that cannot be compared; the message is for the user."""


# ── Sources ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Source:
    kind: Kind
    value: str = ""
    """The revision, deck path or branch name (nothing for ``live``)."""
    label: str | None = None
    """A name to show instead of the derived one (the worktree event's)."""

    @classmethod
    def parse(cls, obj: object) -> Source:
        if not isinstance(obj, dict):
            raise CompareError("a compare side must be an object")
        data = cast("dict[str, object]", obj)
        kind = data.get("kind")
        label = data.get("label")
        label = label if isinstance(label, str) and label.strip() else None
        key = {"commit": "rev", "path": "deck", "branch": "name", "spec": "spec"}
        if kind == "live":
            return cls("live", label=label)
        if kind in key:
            value = data.get(key[str(kind)])
            if not isinstance(value, str) or not value.strip():
                raise CompareError(f"a {kind} side needs {key[str(kind)]!r}")
            if kind == "spec":
                raise CompareError("resolve a spec with Source.spec")
            return cls(cast("Kind", kind), value.strip(), label)
        raise CompareError(f"unknown compare side {kind!r}")

    def as_json(self) -> dict[str, object]:
        if self.kind == "live":
            return {"kind": "live"}
        key = {"commit": "rev", "path": "deck", "branch": "name"}[self.kind]
        return {"kind": self.kind, key: self.value}


def spec_source(spec: str, base: Path, repo_dir: Path | None) -> Source:
    """A command-line side: a deck.py or a folder with one (relative to
    ``base``), a local branch, else any git revision. ``.``-style paths that
    name the working copy's own deck come back as ``path`` and resolve to
    ``live`` later."""
    candidate = Path(spec).expanduser()
    if not candidate.is_absolute():
        candidate = base / candidate
    if candidate.is_file() and candidate.suffix == ".py":
        return Source("path", str(candidate.resolve()))
    if candidate.is_dir():
        if (candidate / "deck.py").is_file():
            return Source("path", str((candidate / "deck.py").resolve()))
        raise CompareError(f"no deck.py in {spec}")
    if repo_dir is not None and _branch_exists(repo_dir, spec):
        return Source("branch", spec)
    return Source("commit", spec)


# ── git ───────────────────────────────────────────────────────────────────────


def _git(
    cwd: Path,
    *args: str,
    env: dict[str, str] | None = None,
    stdin: str | None = None,
) -> str:
    full_env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "",
        "LC_ALL": "C",
        **(env or {}),
    }
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            env=full_env,
            timeout=_TIMEOUT,
            input=stdin,
            stdin=None if stdin is not None else subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise CompareError("git is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise CompareError(f"git {args[0]} took too long") from exc
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip()
        raise CompareError(message or f"git {args[0]} failed")
    return result.stdout


def repo_root(directory: Path) -> Path | None:
    try:
        return Path(_git(directory, "rev-parse", "--show-toplevel").strip())
    except CompareError:
        return None


def _branch_exists(repo_dir: Path, name: str) -> bool:
    if name.startswith("-"):
        return False
    try:
        _git(repo_dir, "show-ref", "--verify", "--quiet", f"refs/heads/{name}")
    except CompareError:
        return False
    return True


def resolve_commit(repo_dir: Path, rev: str) -> str:
    """The full sha ``rev`` names (refusing anything that looks like an option)."""
    if not rev or rev.startswith("-") or "\0" in rev:
        raise CompareError(f"{rev!r} is not a revision")
    try:
        out = _git(repo_dir, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    except CompareError as exc:
        raise CompareError(f"no commit {rev!r} in this repository") from exc
    return out.strip()


def commit_label(repo_dir: Path, sha: str) -> str:
    try:
        subject = _git(repo_dir, "log", "-1", "--format=%s", sha).strip()
    except CompareError:
        subject = ""
    return f"{sha[:7]} {subject}".strip()


def worktrees(repo_dir: Path) -> list[dict[str, object]]:
    """``git worktree list --porcelain``: path, head, branch (or None)."""
    try:
        out = _git(repo_dir, "worktree", "list", "--porcelain")
    except CompareError:
        return []
    items: list[dict[str, object]] = []
    current: dict[str, object] = {}
    for line in [*out.splitlines(), ""]:
        if not line:
            if current.get("path"):
                items.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = {"path": value, "head": None, "branch": None, "bare": False}
        elif key == "HEAD":
            current["head"] = value
        elif key == "branch":
            current["branch"] = value.removeprefix("refs/heads/")
        elif key == "bare":
            current["bare"] = True
    return [w for w in items if not w["bare"]]


def branches(repo_dir: Path) -> list[str]:
    try:
        out = _git(
            repo_dir,
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads",
        )
    except CompareError:
        return []
    return [line for line in out.splitlines() if line]


# ── Materializing a commit ────────────────────────────────────────────────────

_LFS_POINTER = re.compile(
    rb"^version https://[^\n]*/spec/v1\n(?:.*\n)*?oid sha256:([0-9a-f]{64})\n",
)


def _lfs_oid(path: Path) -> str | None:
    try:
        if path.stat().st_size > 1024:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    m = _LFS_POINTER.match(data)
    return m.group(1).decode() if m else None


def _sha256(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _fill_lfs_pointers(tree: Path, repo: Path) -> list[str]:
    """Replace LFS pointers left in ``tree`` by the working copy's file with
    the same content; returns the ones that stay pointers."""
    missing: list[str] = []
    for path in tree.rglob("*"):
        oid = _lfs_oid(path) if path.is_file() else None
        if oid is None:
            continue
        rel = path.relative_to(tree)
        live = repo / rel
        if live.is_file() and _sha256(live) == oid:
            shutil.copyfile(live, path)
        else:
            missing.append(rel.as_posix())
    return missing


def materialize(
    project_dir: Path, sha: str, *, in_use: Iterable[str] = ()
) -> tuple[Path, list[str]]:
    """The deck.py of commit ``sha`` as files, and the LFS files it lacks.

    ``project_dir`` is the live deck's folder: its repository is read, and the
    cache is its ``.inkflow/cache/compare/``. The deck keeps its place in the
    repository, so a deck in a subfolder lands in that subfolder.
    """
    repo = repo_root(project_dir)
    if repo is None:
        raise CompareError("this deck is not in a git repository")
    scope = project_dir.resolve().relative_to(repo.resolve()).as_posix()
    scope = "" if scope == "." else scope
    context_dir(project_dir)
    cache = project_dir / CACHE_DIR
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / sha
    deck_name = "deck.py"
    missing: list[str] = []
    if not dest.is_dir():
        token = secrets.token_hex(4)
        tmp = cache / f".tmp-{sha[:12]}-{token}"
        index = cache / f".index-{token}"
        env = {"GIT_INDEX_FILE": str(index.resolve())}
        try:
            _git(repo, "read-tree", sha, env=env)
            names = _git(repo, "ls-files", "-z", "--", scope or ".", env=env).split(
                "\0"
            )
            listing = "\0".join(n for n in names if n) + "\0"
            if listing.strip("\0"):
                _git(
                    repo,
                    "-c",
                    "filter.lfs.required=false",
                    "checkout-index",
                    "-f",
                    "-z",
                    "--stdin",
                    f"--prefix={tmp.resolve()}/",
                    env=env,
                    stdin=listing,
                )
            tmp.mkdir(parents=True, exist_ok=True)
            missing = _fill_lfs_pointers(tmp, repo)
            tmp.replace(dest)
        finally:
            index.unlink(missing_ok=True)
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
    os.utime(dest)
    prune(cache, keep=KEEP, in_use={sha, *in_use})
    deck = dest / scope / deck_name if scope else dest / deck_name
    if not deck.is_file():
        raise CompareError(
            f"there is no {scope + '/' if scope else ''}deck.py in {sha[:7]}"
        )
    return deck, missing


def prune(cache: Path, *, keep: int, in_use: set[str]) -> None:
    """Delete all but the ``keep`` most recently used materializations."""
    try:
        entries = [p for p in cache.iterdir() if p.is_dir()]
    except OSError:
        return
    stale = [p for p in entries if p.name.startswith(".tmp-")]
    for p in stale:
        try:
            if time.time() - p.stat().st_mtime > 3600:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass
    done = sorted(
        (p for p in entries if not p.name.startswith(".")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for p in done[keep:]:
        if p.name not in in_use:
            shutil.rmtree(p, ignore_errors=True)


# ── Resolving a source ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Resolved:
    key: str
    """What two equal sides share: ``live``, ``commit:<sha>``, ``path:<deck>``."""
    kind: Literal["live", "commit", "path"]
    deck_path: Path | None
    """The deck.py to build (None: the live deck, built by the server)."""
    label: str
    branch: str | None = None
    """The branch this side shows, when it is one (offered for merging)."""
    sha: str | None = None
    missing: tuple[str, ...] = ()
    """LFS files a materialized commit could not get."""

    @property
    def watched(self) -> bool:
        return self.kind == "path"


LIVE_LABEL = "Working copy"


def _short_path(path: Path, project_dir: Path) -> str:
    home = Path.home()
    folder = path.parent
    try:
        return folder.relative_to(project_dir.parent).as_posix()
    except ValueError:
        pass
    try:
        return "~/" + folder.relative_to(home).as_posix()
    except ValueError:
        return str(folder)


def resolve(
    source: Source,
    live_deck: Path,
    *,
    local: bool = True,
    in_use: Iterable[str] = (),
) -> Resolved:
    """Where ``source`` is, relative to the deck being served (``live_deck``).

    A deck outside the live deck's folder is only read for a local request
    (``local``); a branch's worktree outside it then falls back to its commit.
    """
    live_deck = live_deck.resolve()
    project_dir = live_deck.parent
    if source.kind == "live":
        return Resolved("live", "live", None, source.label or LIVE_LABEL)
    if source.kind == "path":
        deck = Path(source.value).expanduser()
        if not deck.is_absolute():
            deck = project_dir / deck
        if deck.is_dir():
            deck = deck / "deck.py"
        deck = deck.resolve()
        if deck == live_deck:
            return Resolved("live", "live", None, source.label or LIVE_LABEL)
        if not deck.is_file() or deck.suffix != ".py":
            raise CompareError(f"no deck at {source.value}")
        if not local and not deck.is_relative_to(project_dir):
            raise CompareError(
                "only this computer can compare a deck in another folder"
            )
        branch = worktree_branch(deck)
        label = source.label or branch or _short_path(deck, project_dir)
        return Resolved(f"path:{deck}", "path", deck, label, branch=branch)
    repo = repo_root(project_dir)
    if repo is None:
        raise CompareError("this deck is not in a git repository")
    if source.kind == "branch":
        name = source.value
        if not _branch_exists(repo, name):
            raise CompareError(f"no branch {name!r}")
        scope = (
            project_dir.relative_to(repo.resolve())
            if project_dir.is_relative_to(repo.resolve())
            else Path()
        )
        for tree in worktrees(repo):
            if tree.get("branch") != name:
                continue
            path = Path(str(tree["path"])).resolve()
            if path == repo.resolve():
                return Resolved(
                    "live", "live", None, source.label or LIVE_LABEL, branch=name
                )
            deck = path / scope / live_deck.name
            if deck.is_file() and (local or deck.is_relative_to(project_dir)):
                return Resolved(
                    f"path:{deck}", "path", deck, source.label or name, branch=name
                )
        sha = resolve_commit(repo, name)
        deck, missing = materialize(project_dir, sha, in_use=in_use)
        return Resolved(
            f"commit:{sha}",
            "commit",
            deck,
            source.label or f"{name} ({sha[:7]})",
            branch=name,
            sha=sha,
            missing=tuple(missing),
        )
    sha = resolve_commit(repo, source.value)
    deck, missing = materialize(project_dir, sha, in_use=in_use)
    branch = source.value if _branch_exists(repo, source.value) else None
    return Resolved(
        f"commit:{sha}",
        "commit",
        deck,
        source.label or commit_label(repo, sha),
        branch=branch,
        sha=sha,
        missing=tuple(missing),
    )


def worktree_branch(deck: Path) -> str | None:
    """The branch checked out where ``deck`` is, if it is in a repository."""
    try:
        name = _git(deck.parent, "symbolic-ref", "--quiet", "--short", "HEAD").strip()
    except CompareError:
        return None
    return name or None


# ── Building a side ───────────────────────────────────────────────────────────


@dataclass
class SideBuild:
    """One deck, built the way the editor builds it."""

    deck: Deck
    deck_path: Path
    slides: list[SlideData]
    """The editor build (``process_deck(editor=True)``)."""
    model: dict[str, object]
    styles: str
    scripts: str
    module: str = "_inkflow_deck"
    built_at: float = field(default_factory=time.time)

    @property
    def project_dir(self) -> Path:
        return self.deck_path.parent

    @property
    def mode(self) -> ColorMode:
        return self.deck.effective_mode

    @property
    def roots(self) -> AssetRoots:
        return AssetRoots(self.project_dir, self.deck.theme.asset_dir())


DeckLoader = Callable[[Path, str], Deck]
"""``server.load_deck``: handed in, since the server imports this module."""


def build_side(deck_path: Path, module: str, load: DeckLoader) -> SideBuild:
    """Load (``load``) and build the deck at ``deck_path`` as module ``module``."""
    from inkflow.editor.model import build_model

    deck = load(deck_path, module)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir, deck_path, editor=True)
    model = build_model(deck, deck_path, slides, deck_module=module)
    return SideBuild(
        deck=deck,
        deck_path=deck_path,
        slides=slides,
        model=model,
        styles=load_deck_styles(deck, project_dir),
        scripts=load_deck_scripts(deck, project_dir),
        module=module,
    )


# ── Facts for compare.py ──────────────────────────────────────────────────────

_FENCE = re.compile(r"^```chart[^\n]*\n(.*?)^```", re.M | re.S)
_FENCE_DATA = re.compile(r"^\s*data\s*:\s*(\S+)\s*$", re.M)


def _content_hash(path: Path, cache: dict[Path, str]) -> str:
    if path not in cache:
        try:
            cache[path] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
        except OSError:
            cache[path] = ""
    return cache[path]


def _rel(path: Path, project_dir: Path) -> str:
    absolute = Path(os.path.abspath(path))
    root = Path(os.path.abspath(project_dir))
    if absolute.is_relative_to(root):
        return absolute.relative_to(root).as_posix()
    return str(absolute)


_UNSETTINGS = frozenset({"custom", "path", "columns", "numeric", "error"})
"""Model keys that are not deck.py settings: how deck.py was loaded, where
the deck is, what a chart's data file holds (compared as a file)."""


def _json_settings(value: object) -> object:
    """Model JSON as the deck.py settings it stands for (`_UNSETTINGS` out)."""
    if isinstance(value, dict):
        return {
            str(k): _json_settings(v)
            for k, v in cast("dict[object, object]", value).items()
            if k not in _UNSETTINGS
        }
    if isinstance(value, list):
        return [_json_settings(v) for v in cast("list[object]", value)]
    return value


def _content_ref(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, Inline):
        return f"inline:{hashlib.sha256(str(value).encode()).hexdigest()[:12]}"
    return str(value)


def _slide_settings(slide: Slide, entry: dict[str, object]) -> dict[str, object]:
    overlays = None if slide.overlays is None else [o.src for o in slide.overlays]
    return {
        "hidden": not slide.visible,
        "layout": slide.src,
        "id": slide.id,
        "title": slide.title,
        "md": _content_ref(slide.md),
        "notes_file": _content_ref(slide.notes),
        "transition": _json_settings(entry.get("transition")),
        "animations": _json_settings(entry.get("animations")),
        "zones": _json_settings(entry.get("zones")),
        "overlays": overlays,
        "style": _content_ref(slide.extra_style),
        "font_size": slide.font_size,
    }


def _slide_files(
    build: SideBuild,
    slide: Slide,
    entry: dict[str, object],
    data: SlideData | None,
    slide_id: str,
    hashes: dict[Path, str],
) -> dict[str, tuple[str, str]]:
    project_dir = build.project_dir
    files: dict[str, tuple[str, str]] = {}

    def add(path: Path, role: str) -> None:
        if path.is_file():
            files.setdefault(
                _rel(path, project_dir), (role, _content_hash(path, hashes))
            )

    for src in cast("list[dict[str, object]]", entry.get("sources") or []):
        add(Path(str(src["path"])), str(src["role"]))
    if not entry.get("sources"):
        src_path = entry.get("srcPath")
        if isinstance(src_path, str):
            add(Path(src_path), "slide")
    md_path: Path | None = None
    if slide.md is not None and not isinstance(slide.md, Inline):
        md_path = resolve_content_src(str(slide.md), project_dir)
        add(md_path, "md")
    if slide.notes is not None and not isinstance(slide.notes, Inline):
        notes = Path(str(slide.notes))
        add(notes if notes.is_absolute() else project_dir / notes, "notes")
    add(ink_path(slide, slide_id, project_dir), "ink")
    for value in slide.zones.values():
        if isinstance(value, Chart) and value.src and is_local_ref(value.src):
            add(project_dir / value.src, "data")
    if md_path is not None and md_path.is_file():
        text = md_path.read_text(encoding="utf-8", errors="replace")
        for body in cast("list[str]", _FENCE.findall(text)):
            for ref in cast("list[str]", _FENCE_DATA.findall(body)):
                if is_local_ref(ref):
                    add(md_path.parent / ref, "data")
    if data is not None:
        roots = build.roots
        refs: list[str] = []

        def collect(ref: str) -> None:
            refs.append(ref)

        rewrite_references(data["svg"], collect)
        for ref in refs:
            if not is_local_ref(ref) or ref.startswith("_pdf/"):
                continue
            located = roots.locate(ref.split("?", 1)[0].split("#", 1)[0])
            if located is not None and not ref.startswith(THEME_PREFIX):
                add(located, "asset")
    return files


def deck_facts(build: SideBuild) -> DeckFacts:
    """What `compare.compare_decks` needs to know about one built deck."""
    deck = build.deck
    model_slides = cast("list[dict[str, object]]", build.model["slides"])
    raw_ids = [slide_ids([s])[0] for s in deck.slides]
    all_ids = slide_ids(deck.slides)
    hashes: dict[Path, str] = {}
    out: list[SlideFacts] = []
    for index, (slide, entry) in enumerate(zip(deck.slides, model_slides, strict=True)):
        visible_index = entry.get("visibleIndex")
        data = build.slides[visible_index] if isinstance(visible_index, int) else None
        slide_id = data["id"] if data is not None else all_ids[index]
        notes_info = cast("dict[str, object]", entry.get("notes") or {})
        md_info = cast("dict[str, object] | None", entry.get("md"))
        key_file: str | None = None
        if md_info and md_info.get("kind") == "file" and md_info.get("path"):
            key_file = "md:" + _rel(Path(str(md_info["path"])), build.project_dir)
        elif entry.get("srcPath") and not entry.get("srcShared"):
            key_file = "svg:" + _rel(Path(str(entry["srcPath"])), build.project_dir)
        out.append(
            SlideFacts(
                index=index,
                number=visible_index + 1 if isinstance(visible_index, int) else None,
                id=slide_id,
                raw_id=raw_ids[index],
                explicit=slide.id is not None,
                title=str(entry.get("title") or slide_id),
                visible=slide.visible,
                svg=normalize_svg(data["svg"]) if data is not None else None,
                notes=plain_text(data["notes"])
                if data is not None
                else str(notes_info.get("text") or ""),
                settings=_slide_settings(slide, entry),
                files=_slide_files(build, slide, entry, data, slide_id, hashes),
                key_file=key_file,
            )
        )
    settings: dict[str, object] = {
        "theme": type(deck.theme).__qualname__,
        "tokens": _digest(deck.theme.render_tokens_css()),
        "styles": _digest(build.styles),
        "scripts": _digest(build.scripts),
        "mode": deck.effective_mode.value,
        "transition": _json_settings(build.model.get("defaultTransition")),
        "overlays": [o.src for o in deck.effective_overlays],
        "font_size": deck.effective_font_size,
        "title": deck.title,
        # Which slides each section holds, by id (so a renamed section, a
        # moved one or a slide moved between them each read as a change).
        "sections": [
            [section.name, [all_ids[i] for i in span]]
            for section, span in zip(deck.sections, deck.section_ranges(), strict=True)
        ],
    }
    return DeckFacts(out, settings)


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ── For the browser ───────────────────────────────────────────────────────────

_FONT_FACE = re.compile(r"@font-face\s*\{[^{}]*\}", re.S)
_ROOT = re.compile(r":root\b")


def shadow_css(css: str) -> tuple[str, str]:
    """A deck's stylesheet for a shadow root, and its ``@font-face`` rules.

    In a shadow root nothing is ``:root``: the view puts a ``.cmp-root``
    element (carrying ``data-theme``) around the slide and the theme's token
    blocks are aimed at it. ``@font-face`` does not work inside a shadow root,
    so those rules come back separately, for the document.
    """
    fonts = "\n".join(cast("list[str]", _FONT_FACE.findall(css)))
    rest = _FONT_FACE.sub("", css)
    return _ROOT.sub(".cmp-root", rest), fonts


def display_svg(svg: str, token: str, roots: AssetRoots) -> str:
    """A built slide as the compare view shows it: no editor attributes, and
    its pictures served from this side's own folder (``/_cmp/<token>/…``),
    stamped with their modification time so a changed file reloads."""

    def route(ref: str) -> str | None:
        if not is_local_ref(ref) or ref.startswith(("/", "#")):
            return None
        bare, _, fragment = ref.split("?", 1)[0].partition("#")
        located = roots.locate(bare)
        try:
            stamp = f"?v={located.stat().st_mtime_ns:x}" if located is not None else ""
        except OSError:
            stamp = ""
        return f"/_cmp/{token}/{bare}{stamp}" + (f"#{fragment}" if fragment else "")

    return rewrite_references(strip_editor_attrs(svg), route)
