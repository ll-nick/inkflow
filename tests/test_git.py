"""The editor's git operations and deck management (editor/gitops.py,
editor/projects.py), against throwaway repositories."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import cast

import pytest

from inkflow import instances, lfs
from inkflow.editor import gitops, nativedialog, places, projects
from inkflow.editor.session import EditError, EditorSession

pytestmark = pytest.mark.skipif(not gitops.available(), reason="needs git")


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Nobody's own git config, and a fixed identity from the environment.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for who in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{who}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{who}_EMAIL", "test@example.com")
    monkeypatch.setattr(projects, "_recent_file", lambda: tmp_path / "recent.json")
    monkeypatch.setattr(instances, "_dir", lambda: tmp_path / "servers")
    monkeypatch.setattr(places, "_file", lambda: tmp_path / "places.json")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repository with a deck in ``talk/`` and one unrelated file, committed."""
    root = tmp_path / "repo"
    deck = root / "talk"
    (deck / "slides").mkdir(parents=True)
    (deck / "deck.py").write_text("# deck\n", encoding="utf-8")
    (deck / "slides" / "intro.md").write_text("# Hi\n", encoding="utf-8")
    (root / "README.md").write_text("readme\n", encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "First")
    return deck


def _repo(deck: Path) -> gitops.Repo:
    r = gitops.open_repo(deck)
    assert r is not None
    return r


def test_status_names_the_branch_and_the_deck_changes(repo: Path) -> None:
    (repo / "slides" / "intro.md").write_text("# Changed\n", encoding="utf-8")
    (repo / "slides" / "new.md").write_text("new\n", encoding="utf-8")
    (repo.parent / "README.md").write_text("other\n", encoding="utf-8")
    status = gitops.status(repo)
    assert status["repo"] and status["branch"] == "main" and status["scope"] == "talk"
    changes = cast("list[dict[str, object]]", status["changes"])
    assert [(c["path"], c["status"], c["inDeck"]) for c in changes] == [
        ("talk/slides/intro.md", "modified", True),
        ("talk/slides/new.md", "new", True),
        ("README.md", "modified", False),
    ]
    assert str(status["suggestedMessage"]).startswith("Update slides (")
    assert gitops.status(repo.parent.parent)["repo"] is False


def test_commit_only_the_chosen_files(repo: Path) -> None:
    (repo / "slides" / "intro.md").write_text("# Changed\n", encoding="utf-8")
    (repo.parent / "README.md").write_text("other\n", encoding="utf-8")
    r = _repo(repo)
    gitops.commit(r, "Edit intro", ["talk/slides/intro.md"])
    assert _git(r.root, "log", "-1", "--format=%s").strip() == "Edit intro"
    left = cast("list[dict[str, object]]", gitops.status(repo)["changes"])
    assert [c["path"] for c in left] == ["README.md"]
    with pytest.raises(gitops.GitError, match="message"):
        gitops.commit(r, "  ", None)


def test_discard_restores_and_deletes(repo: Path) -> None:
    intro = repo / "slides" / "intro.md"
    intro.write_text("# Changed\n", encoding="utf-8")
    (repo / "slides" / "new.md").write_text("new\n", encoding="utf-8")
    r = _repo(repo)
    gitops.discard(r, ["talk/slides/intro.md", "talk/slides/new.md"])
    assert intro.read_text() == "# Hi\n"
    assert not (repo / "slides" / "new.md").exists()
    assert gitops.status(repo)["changes"] == []


def test_branches_history_revert_restore_and_view(repo: Path) -> None:
    r = _repo(repo)
    intro = repo / "slides" / "intro.md"
    intro.write_text("# Two\n", encoding="utf-8")
    gitops.commit(r, "Second", None)
    (repo.parent / "README.md").write_text("not the deck\n", encoding="utf-8")
    gitops.commit(r, "Readme only", None)

    log = gitops.log(r)
    assert [c["subject"] for c in log] == ["Second", "First"]  # deck commits only

    gitops.revert(r, str(log[0]["sha"]))
    assert intro.read_text() == "# Hi\n"
    assert _git(r.root, "log", "-1", "--format=%s").startswith('Revert "Second"')

    gitops.restore_deck(r, str(log[0]["sha"]))
    assert intro.read_text() == "# Two\n"  # as uncommitted changes
    gitops.commit(r, "Back to two", None)

    gitops.create_branch(r, "draft")
    assert gitops.status(repo)["branch"] == "draft"
    names = [b["name"] for b in gitops.branches(r)]
    assert set(names) == {"main", "draft"}
    gitops.switch(r, "main")
    with pytest.raises(gitops.GitError, match="valid branch"):
        gitops.create_branch(r, "no spaces")

    gitops.view_commit(r, str(log[-1]["sha"]))
    status = gitops.status(repo)
    assert status["branch"] is None and status["detached"]
    assert intro.read_text() == "# Hi\n"
    gitops.switch(r, "main")


def test_restore_removes_files_added_since(repo: Path) -> None:
    r = _repo(repo)
    first = str(gitops.log(r)[0]["sha"])
    (repo / "slides" / "later.md").write_text("later\n", encoding="utf-8")
    gitops.commit(r, "Add later", None)
    gitops.restore_deck(r, first)
    assert not (repo / "slides" / "later.md").exists()


def test_undo_commit_only_before_pushing(repo: Path, tmp_path: Path) -> None:
    r = _repo(repo)
    (repo / "slides" / "intro.md").write_text("# Two\n", encoding="utf-8")
    gitops.commit(r, "Second", None)
    assert gitops.status(repo)["canUndoCommit"] is True
    gitops.undo_commit(r)
    assert _git(r.root, "log", "-1", "--format=%s").strip() == "First"
    assert (repo / "slides" / "intro.md").read_text() == "# Two\n"  # kept

    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote))
    _git(r.root, "remote", "add", "origin", str(remote))
    gitops.commit(r, "Second", None)
    assert gitops.push(r) == "Pushed main to origin"
    status = gitops.status(repo)
    assert status["upstream"] == "origin/main" and status["ahead"] == 0
    assert status["canUndoCommit"] is False
    with pytest.raises(gitops.GitError, match="pushed"):
        gitops.undo_commit(r)
    assert gitops.pull(r) == "Already up to date"


# ── Through the editor session ──


def test_session_git_actions(repo: Path) -> None:
    session = EditorSession(repo / "deck.py")
    out = session.apply({"action": "git", "op": "status"}, None)
    assert cast("dict[str, object]", out["git"])["branch"] == "main"
    (repo / "slides" / "intro.md").write_text("# Changed\n", encoding="utf-8")
    out = session.apply(
        {"action": "git", "op": "commit", "message": "Edit", "paths": None}, None
    )
    assert str(out["message"]).startswith("Committed ")
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "git", "op": "push"}, None)
    with pytest.raises(EditError, match="unknown git operation"):
        session.apply({"action": "git", "op": "rebase"}, None)
    log = cast(
        "list[dict[str, object]]",
        session.apply({"action": "git", "op": "log"}, None)["log"],
    )
    session.apply({"action": "git", "op": "revert", "sha": log[0]["sha"]}, None)
    assert (repo / "slides" / "intro.md").read_text() == "# Hi\n"


def test_session_creates_a_repository(tmp_path: Path) -> None:
    deck = tmp_path / "solo"
    deck.mkdir()
    (deck / "deck.py").write_text("# deck\n", encoding="utf-8")
    session = EditorSession(deck / "deck.py")
    assert (
        cast("dict[str, object]", session.apply({"action": "git"}, None)["git"])["repo"]
        is False
    )
    out = session.apply({"action": "git", "op": "init", "_local": True}, None)
    assert cast("dict[str, object]", out["git"])["repo"] is True
    assert (deck / ".gitignore").exists() and (deck / ".git").is_dir()


# ── New decks ──


def test_new_deck_inside_a_repository_is_a_new_folder_of_it(repo: Path) -> None:
    info = projects.new_deck_info(repo / "deck.py", None)
    assert info["repo"] == str(repo.parent)
    assert info["parent"] == str(repo.parent)  # next to the open deck
    deck_py = projects.create_deck(
        repo.parent / "second", title="Second talk", theme="starter", git=True
    )
    assert deck_py.is_file() and 'title="Second talk"' in deck_py.read_text()
    assert not (repo.parent / "second" / ".git").exists()
    assert projects.recent() == [str(deck_py)]


def test_new_deck_elsewhere_gets_its_own_repository(tmp_path: Path) -> None:
    target = tmp_path / "decks" / "talk"
    deck_py = projects.create_deck(target, title="T", theme="example", git=True)
    assert (target / ".git").is_dir() and (target / ".gitignore").is_file()
    assert (target / "overlays" / "footer.svg").is_file()
    assert 'overlays=[Overlay("footer")]' in deck_py.read_text()
    plain = projects.create_deck(
        tmp_path / "plain", title="", theme="starter", git=False
    )
    assert not (plain.parent / ".git").exists()
    with pytest.raises(projects.ProjectError, match="already has a deck"):
        projects.create_deck(target, title="T", theme="starter", git=False)
    (tmp_path / "busy").mkdir()
    (tmp_path / "busy" / "file.txt").write_text("x", encoding="utf-8")
    with pytest.raises(projects.ProjectError, match="not empty"):
        projects.create_deck(tmp_path / "busy", title="", theme="starter", git=False)


def test_new_deck_reusing_the_open_decks_look(tmp_path: Path) -> None:
    demo = Path(__file__).parent.parent / "demo" / "deck.py"
    deck_py = projects.create_deck(
        tmp_path / "mine", title="Mine", theme="current", git=False, current=demo
    )
    code = deck_py.read_text()
    assert "class Flip(Transition)" in code  # the deck's own classes come along
    assert 'Slide("title", notes="notes/title.md")' in code
    assert code.count("Slide(") == 3  # the starter's three slides
    for name in ("styles.css", "scripts.js", "overlays/footer.svg"):
        assert (deck_py.parent / name).is_file()


def test_browse_and_open_deck(repo: Path, tmp_path: Path) -> None:
    listing = projects.browse(str(repo.parent), tmp_path)
    assert listing["dirs"] == ["talk"] and listing["repo"] == str(repo.parent)
    assert projects.browse(str(repo), tmp_path)["isDeck"] is True

    session = EditorSession(None)
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "browse", "path": str(repo)}, None)
    out = session.apply(
        {"action": "open-deck", "path": str(repo), "_local": True}, None
    )
    assert out["deck"] == str((repo / "deck.py").resolve())
    assert session.switch_to == (repo / "deck.py").resolve()
    # The deck already open here: nothing to switch to.
    here = EditorSession(repo / "deck.py")
    again = here.apply({"action": "open-deck", "path": str(repo), "_local": True}, None)
    assert again["opening"] is False and here.switch_to is None
    with pytest.raises(EditError, match=r"no deck\.py"):
        session.apply(
            {"action": "open-deck", "path": str(tmp_path), "_local": True}, None
        )


# ── Git LFS ──


needs_lfs = pytest.mark.skipif(not lfs.available(), reason="needs git-lfs")


def test_lfs_attributes_block_and_rules(tmp_path: Path) -> None:
    attrs = tmp_path / ".gitattributes"
    attrs.write_text("*.svg diff=inkscape-svg", encoding="utf-8")
    assert lfs.ensure_attributes(attrs, True) == "updated"
    text = attrs.read_text()
    assert text.startswith("*.svg diff=inkscape-svg\n")
    assert "*.mp4 filter=lfs diff=lfs merge=lfs -text" in text
    assert lfs.ensure_attributes(attrs, False) == "ok"  # one section only
    assert lfs.mode(tmp_path, tmp_path) == "on"

    off = tmp_path / "off"
    off.mkdir()
    lfs.ensure_attributes(off / ".gitattributes", False)
    assert lfs.mode(tmp_path, off) == "off"  # the deck's own choice wins
    assert lfs.add_rules(off / ".gitattributes", ["*.mp4", "/data.bin"]) == [
        "*.mp4",
        "/data.bin",
    ]
    assert lfs.mode(tmp_path, off) == "on"
    assert lfs.OFF_MARKER not in (off / ".gitattributes").read_text()


def test_lfs_status_reports_media_outside_lfs(repo: Path) -> None:
    (repo / "assets").mkdir()
    (repo / "assets" / "clip.mp4").write_bytes(b"\0" * 100)
    (repo / "assets" / "notes.txt").write_text("small", encoding="utf-8")
    (repo / "assets" / "dump.bin").write_bytes(b"\0" * lfs.LARGE_BYTES)
    report = gitops.lfs_status(_repo(repo))
    assert report["mode"] == "none"
    assert [
        (f["path"], f["kind"])
        for f in cast("list[dict[str, object]]", report["uncovered"])
    ] == [
        ("talk/assets/clip.mp4", "video"),
        ("talk/assets/dump.bin", "large"),
    ]
    gitops.lfs_off(_repo(repo))
    report = gitops.lfs_status(_repo(repo))
    assert report["mode"] == "off" and report["uncovered"] == []


@needs_lfs
def test_lfs_track_converts_files_and_finds_old_copies(repo: Path) -> None:
    r = _repo(repo)
    (repo / "assets").mkdir()
    clip = repo / "assets" / "clip.mp4"
    clip.write_bytes(b"\0" * 100)
    gitops.commit(r, "Video, before LFS", None)

    added = gitops.lfs_track(r, ["talk/assets/clip.mp4"])
    assert added == ["*.mp4"]
    assert "*.mp4 filter=lfs" in (repo / ".gitattributes").read_text()
    gitops.commit(r, "Video in LFS", None)
    pointers = _git(r.root, "lfs", "ls-files", "-n").split()
    assert pointers == ["talk/assets/clip.mp4"]
    report = gitops.lfs_status(r)
    assert report["mode"] == "on"
    assert report["uncovered"] == [] and report["unconverted"] == []

    # Committed before a rule covered it: reported until it is converted.
    (repo / "assets" / "still.png").write_bytes(b"\x89PNG" + b"\0" * 50)
    gitops.commit(r, "Picture, no rule yet", None)
    attrs = repo / ".gitattributes"
    attrs.write_text(attrs.read_text() + lfs.rule("*.png") + "\n", encoding="utf-8")
    gitops.commit(r, "PNGs in LFS", ["talk/.gitattributes"])
    unconverted = cast("list[dict[str, object]]", gitops.lfs_status(r)["unconverted"])
    assert [f["path"] for f in unconverted] == ["talk/assets/still.png"]


def test_new_deck_gets_lfs_rules_or_git_only(tmp_path: Path) -> None:
    on = projects.create_deck(tmp_path / "on", title="", theme="starter", git=True)
    text = (on.parent / ".gitattributes").read_text()
    assert "*.svg diff=inkscape-svg" in text and "*.mp4 filter=lfs" in text
    off = projects.create_deck(
        tmp_path / "off", title="", theme="starter", git=True, lfs=False
    )
    text = (off.parent / ".gitattributes").read_text()
    assert lfs.OFF_MARKER in text and "filter=lfs" not in text


def test_git_actions_that_rewrite_files_clear_the_undo_history(repo: Path) -> None:
    session = EditorSession(repo / "deck.py")
    (repo / "slides" / "intro.md").write_text("# Changed\n", encoding="utf-8")
    out = session.apply(
        {"action": "git", "op": "discard", "paths": ["talk/slides/intro.md"]}, None
    )
    assert out["historyCleared"] is True
    out = session.apply({"action": "git", "op": "status"}, None)
    assert "historyCleared" not in out


def test_the_start_page_only_opens_or_creates_decks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    session = EditorSession(None)
    info = session.apply({"action": "project-info"}, None)
    assert info["parent"] == str(tmp_path) and info["name"] == "new-deck"
    assert "current" not in {
        t["id"] for t in cast("list[dict[str, str]]", info["themes"])
    }
    with pytest.raises(EditError, match="open or create a deck first"):
        session.apply({"action": "undo"}, None)
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "new-deck", "path": str(tmp_path / "t")}, None)
    made = session.apply(
        {
            "action": "new-deck",
            "path": str(tmp_path / "talk"),
            "theme": "starter",
            "git": False,
            "_local": True,
        },
        None,
    )
    assert made["opening"] and session.switch_to == tmp_path / "talk" / "deck.py"
    assert projects.recent() == [str(tmp_path / "talk" / "deck.py")]


def test_favourites_and_the_default_location(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    talks = tmp_path / "talks"
    talks.mkdir()
    session = EditorSession(None)
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "places-set", "op": "add", "path": str(talks)}, None)
    local = {"action": "places-set", "_local": True}
    out = session.apply({**local, "op": "add", "path": str(talks)}, None)
    assert out["places"] == {"favorites": [str(talks)], "default": None}
    with pytest.raises(EditError, match="not a folder"):
        session.apply({**local, "op": "add", "path": str(tmp_path / "nope")}, None)
    session.apply({**local, "op": "default", "path": str(talks)}, None)
    # New decks go to the default location; Open deck starts there.
    info = session.apply({"action": "project-info"}, None)
    assert info["parent"] == str(talks)
    assert cast("dict[str, object]", info["places"])["default"] == str(talks)
    listing = session.apply(
        {"action": "browse", "path": str(tmp_path), "_local": True}, None
    )
    assert cast("dict[str, object]", listing["places"])["favorites"] == [str(talks)]
    assert "systemPicker" in listing
    session.apply({**local, "op": "remove", "path": str(talks)}, None)
    session.apply({**local, "op": "default", "path": None}, None)
    assert places.load() == {"favorites": [], "default": None}


def test_the_system_dialog_answers_through_the_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked: dict[str, object] = {}

    def pick(**kwargs: object) -> str | None:
        asked.update(kwargs)
        return str(tmp_path)

    monkeypatch.setattr(nativedialog, "pick", pick)
    session = EditorSession(None)
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "system-pick"}, None)
    out = session.apply(
        {"action": "system-pick", "path": str(tmp_path), "_local": True}, None
    )
    assert out == {"ok": True, "path": str(tmp_path)}
    assert asked["files"] is False and asked["start"] == tmp_path
    session.apply({"action": "system-pick", "files": "video", "_local": True}, None)
    assert asked["files"] is True


def test_native_dialog_commands(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import sys

    if sys.platform in ("darwin", "win32"):
        pytest.skip("the Linux choosers")
    monkeypatch.setenv("DISPLAY", ":0")

    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name == "zenity" else None

    monkeypatch.setattr("inkflow.editor.nativedialog.shutil.which", which)
    assert nativedialog.available()
    folder = nativedialog._command(False, tmp_path, "Pick", frozenset())  # pyright: ignore[reportPrivateUsage]
    assert folder[:2] == ["zenity", "--file-selection"] and "--directory" in folder
    video = nativedialog._command(True, tmp_path, "Pick", frozenset({".mkv"}))  # pyright: ignore[reportPrivateUsage]
    assert "--directory" not in video and "--file-filter=Videos | *.mkv" in video
    monkeypatch.delenv("DISPLAY")
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    assert not nativedialog.available()
