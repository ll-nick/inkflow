"""Git worktrees for a deck (editor/worktrees.py, the session's ``worktree``
action and ``inkflow worktree``), against throwaway repositories."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow import instances
from inkflow.cli import main
from inkflow.editor import gitops, media, worktrees
from inkflow.editor.session import EditError, EditorSession

pytestmark = pytest.mark.skipif(not gitops.available(), reason="needs git")


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Nobody's own git config (so no git-lfs filter either), a fixed identity.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for who in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{who}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{who}_EMAIL", "test@example.com")
    monkeypatch.setattr(instances, "_dir", lambda: tmp_path / "servers")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    ).stdout


def _commit(cwd: Path, message: str) -> None:
    _git(cwd, "add", "-A")
    _git(cwd, "commit", "-q", "-m", message)


@pytest.fixture
def deck(tmp_path: Path) -> Path:
    """deck.py of a deck in ``talk/`` of a repository, committed on main."""
    root = tmp_path / "repo"
    talk = root / "talk"
    (talk / "slides").mkdir(parents=True)
    (talk / "deck.py").write_text("# deck\n", encoding="utf-8")
    (talk / "slides" / "intro.md").write_text("# Hi\n", encoding="utf-8")
    (root / "README.md").write_text("readme\n", encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _commit(root, "First")
    return talk / "deck.py"


def _by_name(deck_py: Path, name: str) -> dict[str, object]:
    found = [w for w in worktrees.list_worktrees(deck_py) if w["name"] == name]
    assert len(found) == 1
    return found[0]


def test_list_shows_the_decks_own_worktree(deck: Path) -> None:
    [main_wt] = worktrees.list_worktrees(deck)
    root = deck.parent.parent
    assert main_wt == {
        "name": "repo",
        "path": str(root),
        "branch": "main",
        "head": _git(root, "rev-parse", "--short=7", "HEAD").strip(),
        "deck": str(deck),
        "dirty": False,
        "ahead": 0,
        "behind": 0,
        "main": True,
    }


def test_add_checks_out_a_branch_under_inkflow_ignored_by_git(deck: Path) -> None:
    root = deck.parent.parent
    info, note = worktrees.add(deck, "bolder")
    path = root / ".inkflow" / "worktrees" / "bolder"
    assert note is None
    assert info["path"] == str(path) and info["branch"] == "deck/bolder"
    # The deck at the same place inside it (a deck in a subdirectory).
    assert info["deck"] == str(path / "talk" / "deck.py")
    assert (path / "talk" / "slides" / "intro.md").read_text() == "# Hi\n"
    assert info["main"] is False and info["ahead"] == 0 and info["dirty"] is False
    # The main worktree does not see it, and git accepts it nested there.
    assert _git(root, "status", "--porcelain") == ""
    assert gitops.is_ignored(root, path)
    assert [w["name"] for w in worktrees.list_worktrees(deck)] == ["repo", "bolder"]
    # Its own deck sees the same list, from its side.
    inner = Path(cast("str", info["deck"]))
    assert [w["main"] for w in worktrees.list_worktrees(inner)] == [False, True]
    with pytest.raises(gitops.GitError, match="exists already"):
        worktrees.add(deck, "bolder")


def test_add_notes_uncommitted_changes_and_checks_names(deck: Path) -> None:
    (deck.parent / "slides" / "intro.md").write_text("# Changed\n", encoding="utf-8")
    info, note = worktrees.add(deck, "draft")
    assert note is not None and "1 uncommitted change" in note
    inner = Path(cast("str", info["deck"])).parent
    assert (inner / "slides" / "intro.md").read_text() == "# Hi\n"
    for bad in ("../up", "a b", "-x", "", "x.lock"):
        with pytest.raises(gitops.GitError, match="not a usable worktree name"):
            worktrees.add(deck, bad)
    with pytest.raises(gitops.GitError, match="not a commit"):
        worktrees.add(deck, "other", base="no-such-branch")


def test_add_reuses_an_existing_deck_branch(deck: Path) -> None:
    root = deck.parent.parent
    _git(root, "branch", "deck/old")
    info, _ = worktrees.add(deck, "old")
    assert info["branch"] == "deck/old"
    _git(root, "worktree", "remove", str(info["path"]))
    with pytest.raises(gitops.GitError, match="exists already"):
        worktrees.add(deck, "old", base="HEAD")


def test_add_needs_a_commit(tmp_path: Path) -> None:
    (tmp_path / "solo").mkdir()
    deck_py = tmp_path / "solo" / "deck.py"
    deck_py.write_text("# deck\n", encoding="utf-8")
    _git(tmp_path / "solo", "init", "-q", "-b", "main")
    with pytest.raises(gitops.GitError, match="commit the deck first"):
        worktrees.add(deck_py, "x")


def test_a_deck_at_the_repository_root(tmp_path: Path) -> None:
    root = tmp_path / "talk"
    root.mkdir()
    (root / "deck.py").write_text("# deck\n", encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _commit(root, "First")
    info, _ = worktrees.add(root / "deck.py", "alt")
    assert info["deck"] == str(root / ".inkflow" / "worktrees" / "alt" / "deck.py")
    assert _git(root, "status", "--porcelain") == ""


def test_commits_in_a_worktree_merge_fast_forward(deck: Path) -> None:
    info, _ = worktrees.add(deck, "alt")
    inner = Path(cast("str", info["deck"])).parent
    (inner / "slides" / "intro.md").write_text("# Better\n", encoding="utf-8")
    assert _by_name(deck, "alt")["dirty"] is True
    _commit(inner, "Better intro")
    alt = _by_name(deck, "alt")
    assert (alt["ahead"], alt["behind"], alt["dirty"]) == (1, 0, False)
    merged = worktrees.merge(deck, "alt")
    assert merged.fast_forward and merged.files == ["talk/slides/intro.md"]
    assert merged.message == "Fast-forwarded main to deck/alt (1 commit)"
    assert (deck.parent / "slides" / "intro.md").read_text() == "# Better\n"
    assert _by_name(deck, "alt")["ahead"] == 0
    again = worktrees.merge(deck, "deck/alt")
    assert again.files == [] and "Already up to date" in again.message
    # Merged: the worktree and its branch go.
    assert worktrees.remove(deck, "alt") == "Removed worktree alt and branch deck/alt"
    assert not Path(cast("str", info["path"])).exists()
    assert "deck/alt" not in _git(deck.parent, "branch")


def test_diverged_branches_get_a_merge_commit(deck: Path) -> None:
    root = deck.parent.parent
    info, _ = worktrees.add(deck, "alt")
    inner = Path(cast("str", info["deck"])).parent
    (inner / "slides" / "new.md").write_text("new\n", encoding="utf-8")
    _commit(inner, "Add a slide")
    (root / "README.md").write_text("changed\n", encoding="utf-8")
    _commit(root, "Readme")
    assert (_by_name(deck, "alt")["ahead"], _by_name(deck, "alt")["behind"]) == (1, 1)
    merged = worktrees.merge(deck, "alt")
    assert not merged.fast_forward
    assert merged.message == "Merged deck/alt into main (1 commit)"
    assert merged.files == ["talk/slides/new.md"]
    log = _git(root, "log", "-1", "--format=%s%n%b").strip()
    assert log.startswith("Merge deck/alt into main") and "- Add a slide" in log
    assert (deck.parent / "slides" / "new.md").exists()


def test_a_conflict_is_aborted_and_named(deck: Path) -> None:
    root = deck.parent.parent
    info, _ = worktrees.add(deck, "alt")
    inner = Path(cast("str", info["deck"])).parent
    (inner / "slides" / "intro.md").write_text("# Theirs\n", encoding="utf-8")
    _commit(inner, "Theirs")
    (deck.parent / "slides" / "intro.md").write_text("# Ours\n", encoding="utf-8")
    _commit(root, "Ours")
    head = _git(root, "rev-parse", "HEAD")
    with pytest.raises(gitops.GitError, match=r"conflicts .* in talk/slides/intro.md"):
        worktrees.merge(deck, "alt")
    assert _git(root, "rev-parse", "HEAD") == head
    assert _git(root, "status", "--porcelain") == ""
    assert (deck.parent / "slides" / "intro.md").read_text() == "# Ours\n"


def test_merge_waits_for_the_decks_own_changes(deck: Path) -> None:
    info, _ = worktrees.add(deck, "alt")
    inner = Path(cast("str", info["deck"])).parent
    (inner / "slides" / "new.md").write_text("new\n", encoding="utf-8")
    _commit(inner, "Add")
    (deck.parent / "slides" / "intro.md").write_text("# Mine\n", encoding="utf-8")
    with pytest.raises(gitops.GitError, match="commit or discard your changes"):
        worktrees.merge(deck, "alt")
    # A change outside the deck is git's business (it refuses only a clash).
    (deck.parent / "slides" / "intro.md").write_text("# Hi\n", encoding="utf-8")
    (deck.parent.parent / "README.md").write_text("mine\n", encoding="utf-8")
    assert worktrees.merge(deck, "alt").files == ["talk/slides/new.md"]
    with pytest.raises(gitops.GitError, match="no worktree or branch"):
        worktrees.merge(deck, "nothing")
    with pytest.raises(gitops.GitError, match="deck's own branch"):
        worktrees.merge(deck, "main")


def test_remove_keeps_work_unless_forced(deck: Path) -> None:
    info, _ = worktrees.add(deck, "alt")
    inner = Path(cast("str", info["deck"])).parent
    (inner / "slides" / "intro.md").write_text("# Wip\n", encoding="utf-8")
    with pytest.raises(gitops.GitError, match="uncommitted changes"):
        worktrees.remove(deck, "alt")
    _commit(inner, "Wip")
    with pytest.raises(gitops.GitError, match="1 commit not merged into main"):
        worktrees.remove(deck, "alt")
    with pytest.raises(gitops.GitError, match="open in"):
        worktrees.remove(deck, "repo")
    message = worktrees.remove(deck, "alt", force=True)
    assert message == "Removed worktree alt and branch deck/alt"
    assert [w["name"] for w in worktrees.list_worktrees(deck)] == ["repo"]


def test_a_branch_not_named_by_inkflow_is_kept(deck: Path, tmp_path: Path) -> None:
    root = deck.parent.parent
    _git(root, "worktree", "add", "-q", "-b", "feature", str(tmp_path / "feature"))
    assert _by_name(deck, "feature")["deck"] == str(tmp_path / "feature/talk/deck.py")
    assert worktrees.remove(deck, "feature") == "Removed worktree feature"
    assert "feature" in _git(root, "branch")


def test_media_without_lfs_check_out_as_committed(deck: Path) -> None:
    # A deck with LFS rules, on a machine whose git has no LFS filter set up.
    talk = deck.parent
    (talk / ".gitattributes").write_text(
        "*.png filter=lfs diff=lfs merge=lfs -text\n", encoding="utf-8"
    )
    (talk / "assets").mkdir()
    (talk / "assets" / "pic.png").write_bytes(b"\x89PNG")
    _commit(talk, "Picture")
    info, _ = worktrees.add(deck, "alt")
    inner = Path(cast("str", info["deck"])).parent
    assert (inner / "assets" / "pic.png").read_bytes() == b"\x89PNG"


def test_a_file_in_a_worktree_deck_is_used_in_place(deck: Path) -> None:
    info, _ = worktrees.add(deck, "alt")
    inner = Path(cast("str", info["deck"])).parent
    (inner / "assets").mkdir()
    (inner / "assets" / "pic.png").write_bytes(b"\x89PNG")
    arrival = media.import_path(inner, inner / "assets" / "pic.png")
    assert arrival.path == (inner / "assets" / "pic.png").resolve()


def test_the_watcher_skips_inkflow_only_below_its_deck(tmp_path: Path) -> None:
    from watchfiles import Change

    from inkflow.server import _WatchFilter  # pyright: ignore[reportPrivateUsage]

    root = tmp_path / "talk"
    outer = _WatchFilter(root)
    assert not outer(Change.modified, str(root / ".inkflow/worktrees/x/deck.py"))
    assert not outer(Change.modified, str(root / "build/index.html"))
    assert outer(Change.modified, str(root / "slides/a.svg"))
    inner_root = root / ".inkflow/worktrees/x"
    inner = _WatchFilter(inner_root)
    assert inner(Change.modified, str(inner_root / "slides/a.svg"))
    assert not inner(Change.modified, str(inner_root / ".inkflow/context.json"))


# ── Through the editor session ──


def test_session_worktree_actions(deck: Path) -> None:
    session = EditorSession(deck)
    out = session.apply({"action": "worktree", "op": "list"}, None)
    assert [w["name"] for w in cast("list[dict[str, object]]", out["worktrees"])] == [
        "repo"
    ]
    for op in ("add", "remove", "merge"):
        with pytest.raises(EditError, match="this machine"):
            session.apply({"action": "worktree", "op": op, "name": "x"}, None)
    out = session.apply(
        {"action": "worktree", "op": "add", "name": "alt", "_local": True}, None
    )
    added = cast("dict[str, object]", out["worktree"])
    assert added["branch"] == "deck/alt" and "note" not in out
    assert len(cast("list[object]", out["worktrees"])) == 2
    inner = Path(cast("str", added["deck"])).parent
    (inner / "slides" / "intro.md").write_text("# Agent\n", encoding="utf-8")
    _commit(inner, "Agent")
    with pytest.raises(EditError, match="not merged"):
        session.apply(
            {"action": "worktree", "op": "remove", "name": "alt", "_local": True},
            None,
        )
    out = session.apply(
        {"action": "worktree", "op": "merge", "branch": "deck/alt", "_local": True},
        None,
    )
    assert out["historyCleared"] is True and out["files"] == ["talk/slides/intro.md"]
    assert cast("dict[str, object]", out["git"])["branch"] == "main"
    out = session.apply(
        {"action": "worktree", "op": "remove", "name": "alt", "_local": True}, None
    )
    assert out["message"] == "Removed worktree alt and branch deck/alt"
    with pytest.raises(EditError, match="unknown worktree operation"):
        session.apply({"action": "worktree", "op": "rebase"}, None)


# ── inkflow worktree ──


def test_cli_add_list_merge_remove(deck: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(deck.parent)
    runner = CliRunner()
    result = runner.invoke(main, ["worktree", "add", "alt"])
    assert result.exit_code == 0, result.output
    inner = deck.parent.parent / ".inkflow" / "worktrees" / "alt" / "talk"
    assert f"path: {inner.parent}\n" in result.output
    assert f"deck: {inner / 'deck.py'}\n" in result.output
    assert "on branch deck/alt" in result.output
    (inner / "slides" / "intro.md").write_text("# Agent\n", encoding="utf-8")
    _commit(inner, "Agent")
    listed = runner.invoke(main, ["worktree", "list"])
    assert listed.exit_code == 0
    lines = listed.output.splitlines()
    assert lines[0].startswith("repo\tmain\t") and "this deck" in lines[0]
    assert lines[1].startswith("alt\tdeck/alt\t") and lines[1].endswith("1 ahead")
    merged = runner.invoke(main, ["worktree", "merge", "alt"])
    assert merged.exit_code == 0 and "Fast-forwarded" in merged.output
    removed = runner.invoke(main, ["worktree", "remove", "alt"])
    assert removed.exit_code == 0 and "branch deck/alt" in removed.output
    refused = runner.invoke(main, ["worktree", "remove", "nope"])
    assert refused.exit_code == 1 and "no worktree named 'nope'" in refused.output
