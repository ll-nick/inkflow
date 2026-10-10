"""Git worktrees for a deck: a branch of the deck in a folder of its own.

A coding agent asked for a proposal or a variant works in a worktree on its
own branch, so the author's deck (and editor) stay as they are until the work
is reviewed and merged. ``add`` makes branch ``deck/<name>`` and checks it out
under ``.inkflow/worktrees/<name>`` in the main worktree's root: ``.inkflow/``
ignores itself in git (so the main worktree's status never shows it) and the
server's watcher skips it (so the agent's writes do not rebuild the author's
deck). The deck sits at the same relative path inside every worktree, which
is what ``list`` reports as each one's ``deck``.

``merge`` brings a branch into the deck's current branch in the worktree the
deck is open in (fast-forward when it can); a conflict is aborted, never left
half-merged in the author's files. ``remove`` refuses to lose work (uncommitted
changes, unmerged commits) unless forced, and deletes only branches it named
(``deck/…``), once merged or forced.

Every git call goes through ``gitops.run`` (no prompts, git's own messages).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from inkflow.editor.context import context_dir
from inkflow.editor.gitops import GitError, Repo, open_repo, run

PREFIX = "deck/"
LOCATION = Path(".inkflow", "worktrees")
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_SLOW = 300.0  # a checkout can fetch LFS objects


@dataclass(frozen=True)
class _Entry:
    path: Path
    head: str
    branch: str | None


def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


def _names(out: str | None) -> list[str]:
    """Paths from a ``-z`` listing."""
    return [name for name in (out or "").split("\0") if name]


def _try(cwd: Path, *args: str) -> str | None:
    try:
        return run(cwd, *args).strip()
    except GitError:
        return None


def _repo(deck_path: Path) -> Repo:
    repo = open_repo(deck_path.parent)
    if repo is None:
        raise GitError("this deck is not in a git repository")
    return repo


def _blocks(repo: Repo) -> list[dict[str, str]]:
    """``git worktree list --porcelain``, one dict per worktree, the main
    worktree first."""
    out = repo.git("worktree", "list", "--porcelain")
    blocks: list[dict[str, str]] = []
    for block in out.strip().split("\n\n"):
        fields: dict[str, str] = {}
        for line in block.splitlines():
            key, _, value = line.partition(" ")
            fields[key] = value
        if "worktree" in fields:
            blocks.append(fields)
    return blocks


def _entries(repo: Repo) -> list[_Entry]:
    """The worktrees with files to work on: bare and missing (prunable) ones
    are left out."""
    entries: list[_Entry] = []
    for fields in _blocks(repo):
        if "bare" in fields or "prunable" in fields:
            continue
        branch = fields.get("branch")
        entries.append(
            _Entry(
                path=Path(fields["worktree"]),
                head=fields.get("HEAD", ""),
                branch=branch.removeprefix("refs/heads/") if branch else None,
            )
        )
    return entries


def _main_root(repo: Repo) -> Path:
    """The main worktree's folder: new worktrees go under its ``.inkflow/``."""
    blocks = _blocks(repo)
    if not blocks or "bare" in blocks[0]:
        return repo.root  # a bare repository: under the deck's own worktree
    return Path(blocks[0]["worktree"])


def _same(a: Path, b: Path) -> bool:
    return a.resolve() == b.resolve()


def _current(repo: Repo) -> str | None:
    return _try(repo.root, "symbolic-ref", "--quiet", "--short", "HEAD")


def _counts(repo: Repo, base: str, head: str) -> tuple[int, int]:
    """(ahead, behind) of ``head`` relative to ``base``."""
    counts = _try(repo.root, "rev-list", "--left-right", "--count", f"{base}...{head}")
    if not counts:
        return 0, 0
    behind, ahead = (int(n) for n in counts.split())
    return ahead, behind


def _dirty(path: Path, scope: str = "") -> list[str]:
    """Uncommitted changes in the worktree at ``path`` (new files included)."""
    out = _try(path, "status", "--porcelain=v1", "--", scope or ".")
    return [line[3:] for line in (out or "").splitlines() if len(line) > 3]


def _describe(repo: Repo, entry: _Entry, deck_rel: Path) -> dict[str, object]:
    base = _current(repo) or "HEAD"
    ahead, behind = _counts(repo, base, entry.head) if entry.head else (0, 0)
    deck = entry.path / deck_rel
    return {
        "name": entry.path.name,
        "path": str(entry.path),
        "branch": entry.branch,
        "head": entry.head[:7],
        "deck": str(deck) if deck.is_file() else None,
        "dirty": bool(_dirty(entry.path)),
        "ahead": ahead,
        "behind": behind,
        "main": _same(entry.path, repo.root),
    }


def _deck_rel(repo: Repo, deck_path: Path) -> Path:
    return deck_path.resolve().relative_to(repo.root.resolve())


def list_worktrees(deck_path: Path) -> list[dict[str, object]]:
    """Every worktree of the deck's repository (see the module docstring)."""
    repo = _repo(deck_path)
    rel = _deck_rel(repo, deck_path)
    return [_describe(repo, e, rel) for e in _entries(repo)]


def _find(repo: Repo, ref: str) -> _Entry | None:
    """A worktree by name (its folder), path or branch."""
    ref = ref.strip()
    for entry in _entries(repo):
        if ref in (entry.path.name, str(entry.path), entry.branch) or (
            entry.branch is not None and entry.branch == PREFIX + ref
        ):
            return entry
    return None


def _check_name(repo: Repo, name: str) -> str:
    name = name.strip()
    if (
        not _NAME.match(name)
        or name.endswith((".lock", "."))
        or ".." in name
        or _try(repo.root, "check-ref-format", "--branch", PREFIX + name) is None
    ):
        raise GitError(
            f"{name!r} is not a usable worktree name: use letters, digits, - _ and ."
        )
    return name


def _ensure_ignored(repo: Repo, root: Path, target: Path) -> None:
    """``.inkflow/`` ignores itself; a project that overrode that gets the
    worktrees folder in the repository's local exclude file instead."""
    context_dir(root)
    if _try(root, "check-ignore", "--quiet", str(target)) is not None:
        return
    exclude = Path(
        repo.git(
            "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"
        ).strip()
    )
    exclude.parent.mkdir(parents=True, exist_ok=True)
    text = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    line = f"/{LOCATION.as_posix()}/"
    if line not in text.splitlines():
        gap = "" if not text or text.endswith("\n") else "\n"
        exclude.write_text(f"{text}{gap}{line}\n", encoding="utf-8")


def add(
    deck_path: Path, name: str, base: str | None = None
) -> tuple[dict[str, object], str | None]:
    """A new worktree on branch ``deck/<name>`` from ``base`` (default: the
    deck's HEAD); an existing ``deck/<name>`` branch is checked out as it is.
    Returns the worktree (as ``list`` describes it) and a note for the author,
    if there is one."""
    repo = _repo(deck_path)
    name = _check_name(repo, name)
    branch = PREFIX + name
    root = _main_root(repo)
    target = root / LOCATION / name
    if target.exists() or _find(repo, name) is not None:
        raise GitError(f"a worktree named {name!r} exists already")
    start = base.strip() if base else "HEAD"
    if (
        _try(repo.root, "rev-parse", "--verify", "--quiet", f"{start}^{{commit}}")
        is None
    ):
        if base:
            raise GitError(f"{base!r} is not a commit or branch")
        raise GitError("commit the deck first: a worktree starts from a commit")
    exists = _try(repo.root, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}")
    if exists and base:
        raise GitError(f"branch {branch} exists already; leave out the base to use it")
    _ = _try(repo.root, "worktree", "prune")
    target.parent.mkdir(parents=True, exist_ok=True)
    _ensure_ignored(repo, root, target)
    if exists:
        repo.git("worktree", "add", str(target), branch, timeout=_SLOW)
    else:
        repo.git("worktree", "add", "-b", branch, str(target), start, timeout=_SLOW)
    rel = _deck_rel(repo, deck_path)
    entry = _find(repo, str(target)) or _Entry(target, "", branch)
    info = _describe(repo, entry, rel)
    notes: list[str] = []
    if info["deck"] is None:
        notes.append(
            f"{rel.as_posix()} is not committed at {start}, "
            + "so the worktree has no deck yet"
        )
    pending = len(_dirty(repo.root, repo.scope))
    if pending:
        notes.append(
            f"{_plural(pending, 'uncommitted change')} to the deck here "
            + f"{'is' if pending == 1 else 'are'} not in the worktree, which starts "
            + "from the last commit (commit first to include them)"
        )
    return info, "; ".join(notes) or None


def remove(deck_path: Path, name: str, force: bool = False) -> str:
    """Remove a worktree; its ``deck/…`` branch goes too once merged (or
    forced). Refuses to drop uncommitted changes or unmerged commits unless
    ``force``."""
    repo = _repo(deck_path)
    entry = _find(repo, name)
    if entry is None:
        raise GitError(f"no worktree named {name!r}")
    if _same(entry.path, repo.root) or _same(entry.path, _main_root(repo)):
        raise GitError("that is the worktree this deck is open in; it stays")
    current = _current(repo) or "HEAD"
    tip = entry.branch or entry.head
    unmerged = int(_try(repo.root, "rev-list", "--count", f"{current}..{tip}") or 0)
    if not force:
        if _dirty(entry.path):
            raise GitError(
                f"{entry.path.name} has uncommitted changes: commit or discard them "
                + "there first, or remove it anyway (they are lost)"
            )
        if unmerged:
            raise GitError(
                f"{entry.path.name} has {_plural(unmerged, 'commit')} not merged "
                + f"into {current}: merge first, or remove it anyway"
            )
    repo.git("worktree", "remove", *(["--force"] if force else []), str(entry.path))
    message = f"Removed worktree {entry.path.name}"
    branch = entry.branch
    if branch and branch.startswith(PREFIX) and branch != _current(repo):
        if not unmerged or force:
            repo.git("branch", "-D", branch)
            message += f" and branch {branch}"
        else:
            message += f"; kept branch {branch}"
    return message


@dataclass(frozen=True)
class Merged:
    message: str
    files: list[str]
    fast_forward: bool
    note: str | None = None


def _resolve_branch(repo: Repo, ref: str) -> str:
    ref = ref.strip()
    entry = _find(repo, ref)
    if entry is not None and entry.branch:
        return entry.branch
    for candidate in (PREFIX + ref, ref):
        if _try(
            repo.root, "rev-parse", "--verify", "--quiet", f"refs/heads/{candidate}"
        ):
            return candidate
    raise GitError(f"no worktree or branch named {ref!r}")


def merge(deck_path: Path, ref: str) -> Merged:
    """Merge branch ``ref`` (a worktree name, ``deck/<name>`` or any branch)
    into the deck's current branch, in the worktree the deck is open in."""
    repo = _repo(deck_path)
    branch = _resolve_branch(repo, ref)
    current = _current(repo)
    if current is None:
        raise GitError("switch the deck to a branch before merging into it")
    if branch == current:
        raise GitError(f"{branch} is the deck's own branch")
    pending = _dirty(repo.root, repo.scope)
    if pending:
        shown = ", ".join(pending[:5]) + (" …" if len(pending) > 5 else "")
        raise GitError(
            f"commit or discard your changes to the deck first ({shown}): "
            + "a merge would mix them in"
        )
    note = None
    entry = _find(repo, branch)
    if entry is not None and _dirty(entry.path):
        note = (
            f"uncommitted changes in {entry.path.name} were not merged "
            + "(commit them there)"
        )
    before = repo.git("rev-parse", "HEAD").strip()
    if _try(repo.root, "merge-base", "--is-ancestor", branch, "HEAD") is not None:
        return Merged(f"Already up to date: {branch} has nothing new", [], False, note)
    fast = _try(repo.root, "merge-base", "--is-ancestor", "HEAD", branch) is not None
    if fast:
        repo.git("merge", "--ff-only", "--quiet", branch)
    else:
        subjects = repo.git("log", "--format=- %s", f"HEAD..{branch}").splitlines()
        body = "\n".join(subjects[:20] + (["- …"] if len(subjects) > 20 else []))
        try:
            repo.git(
                "merge",
                "--no-ff",
                "--no-edit",
                "--quiet",
                "-m",
                f"Merge {branch} into {current}",
                "-m",
                body,
                branch,
            )
        except GitError as exc:
            conflicts = _names(
                _try(repo.root, "diff", "-z", "--name-only", "--diff-filter=U")
            )
            _ = _try(repo.root, "merge", "--abort")
            if conflicts:
                raise GitError(
                    f"{branch} conflicts with {current} in {', '.join(conflicts)}; "
                    + "nothing was merged. Merge "
                    + f"{current} into {branch} in its worktree, resolve the "
                    + "conflicts there and commit, then merge again"
                ) from exc
            raise
    files = _names(repo.git("diff", "-z", "--name-only", before, "HEAD"))
    commits = _plural(
        len(repo.git("rev-list", f"{before}..{branch}").split()), "commit"
    )
    message = (
        f"Fast-forwarded {current} to {branch} ({commits})"
        if fast
        else f"Merged {branch} into {current} ({commits})"
    )
    return Merged(message, files, fast, note)
