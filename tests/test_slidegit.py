"""Each slide's changes since the last commit, its diff, and commits of chosen
slides only (editor/slidegit.py, the session's git action)."""

from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path
from typing import BinaryIO, cast

import pytest

from inkflow import instances
from inkflow.editor import gitops, projects, slidegit
from inkflow.editor.comparesrc import build_side
from inkflow.editor.session import EditError, EditorSession
from inkflow.manifest import Deck
from inkflow.server import load_deck

pytestmark = pytest.mark.skipif(not gitops.available(), reason="needs git")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide

    def main() -> Deck:
        return Deck(
            slides=[
                Slide("intro.svg", notes="notes/intro.md"),
                Slide("two", md="a.md"),
                Slide("two", md="b.md"),
                Slide("two", md="c.md"),
            ],
        )
""")

INTRO = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
    </svg>
""")

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for who in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{who}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{who}_EMAIL", "test@example.com")
    monkeypatch.setattr(projects, "_recent_file", lambda: tmp_path / "recent.json")
    monkeypatch.setattr(instances, "_dir", lambda: tmp_path / "servers")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture
def deck_py(tmp_path: Path) -> Path:
    """The deck in ``talk/`` of a repository, committed once."""
    root = tmp_path / "repo"
    deck = root / "talk"
    for sub in ("slides", "layouts", "notes"):
        (deck / sub).mkdir(parents=True)
    (deck / "deck.py").write_text(DECK, encoding="utf-8")
    (deck / "slides" / "intro.svg").write_text(INTRO, encoding="utf-8")
    (deck / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    for name in "abc":
        (deck / "slides" / f"{name}.md").write_text(f"# {name.upper()}\n", "utf-8")
    (deck / "notes" / "intro.md").write_text("Say hello.\n", "utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "First")
    return deck / "deck.py"


_modules = iter(range(10_000))


def _changes(deck_py: Path) -> slidegit.Changes:
    build = build_side(deck_py, f"_slidegit_{next(_modules)}", load_deck)
    repo = gitops.open_repo(deck_py.parent)
    assert repo is not None
    return slidegit.changes(build, repo)


def _edit_deck(deck_py: Path, old: str, new: str) -> None:
    text = deck_py.read_text(encoding="utf-8")
    assert old in text
    deck_py.write_text(text.replace(old, new), encoding="utf-8")


def _work(deck_py: Path) -> None:
    """b.md changed, slide c titled, a new slide d, the layout changed."""
    slides = deck_py.parent / "slides"
    (slides / "b.md").write_text("# B\n\nMore\n", "utf-8")
    (slides / "d.md").write_text("# D\n", "utf-8")
    _edit_deck(deck_py, 'md="c.md")', 'md="c.md", title="C")')
    _edit_deck(
        deck_py,
        'md="c.md", title="C"),\n',
        'md="c.md", title="C"),\n            Slide("two", md="d.md"),\n',
    )


def _head_files(deck_py: Path) -> list[str]:
    out = _git(deck_py.parent, "show", "--name-only", "--format=", "HEAD")
    return sorted(out.split())


def _head_deck(deck_py: Path) -> str:
    return _git(deck_py.parent, "show", "HEAD:talk/deck.py")


# ── deck.py entry by entry ──


def test_entries_match_by_code_then_by_name() -> None:
    head = slidegit.entries(DECK)
    assert head is not None
    assert [e.key for e in head] == ["src:intro.svg", "md:a.md", "md:b.md", "md:c.md"]
    moved = DECK.replace('            Slide("two", md="a.md"),\n', "").replace(
        'md="c.md"),\n',
        'md="c.md"),\n            Slide("two", md="a.md"),\n',
    )
    changed = moved.replace('md="b.md")', 'md="b.md", id="bee")')
    work = slidegit.entries(changed)
    assert work is not None
    # intro, b (now with an id: same md), c, a (moved).
    assert slidegit.match_entries(head, work) == [0, 2, 3, 1]
    diff = slidegit.deck_diff(DECK, changed)
    assert [diff.entry_state(i) for i in range(4)] == [None, "modified", None, None]
    assert diff.removed() == []


def test_a_list_built_in_code_reads_as_one_change() -> None:
    code = "from inkflow import Deck\n\ndef main():\n    return Deck(slides=make())\n"
    diff = slidegit.deck_diff(code, code + "# more\n")
    assert not diff.readable
    with pytest.raises(slidegit.PartialError):
        slidegit.partial_deck(diff, {0}, with_removed=False)


def test_partial_deck_keeps_the_other_slides_as_committed() -> None:
    work = DECK.replace('md="a.md")', 'md="a.md", title="A")').replace(
        'md="c.md")', 'md="c.md", title="C")'
    )
    work = work.replace('            Slide("intro.svg", notes="notes/intro.md"),\n', "")
    diff = slidegit.deck_diff(DECK, work)
    assert diff.removed() == [0]
    # Slide a (now index 0) only: c as committed, intro put back first.
    text = slidegit.partial_deck(diff, {0}, with_removed=False)
    assert 'md="a.md", title="A")' in text
    assert 'title="C"' not in text
    assert text.index("intro.svg") < text.index("a.md")
    # With the removal: intro gone.
    text = slidegit.partial_deck(diff, {0, 2}, with_removed=True)
    assert text == work


def test_slides_put_back_keep_their_comments() -> None:
    head = DECK.replace(
        '            Slide("two", md="c.md"),\n',
        '            # The third one.\n            Slide("two", md="c.md"),  # (c)\n',
    )
    c = '            # The third one.\n            Slide("two", md="c.md"),  # (c)\n'
    work = head.replace(c, "")
    work = work.replace(
        'md="a.md"),\n', 'md="a.md"),\n            Slide("two", md="z.md"),\n'
    )
    diff = slidegit.deck_diff(head, work)
    assert diff.removed() == [3]
    assert slidegit.partial_deck(diff, set(), with_removed=False) == head


# ── Slide states ──


def test_states_of_new_modified_and_shared_slides(deck_py: Path) -> None:
    _work(deck_py)
    (deck_py.parent / "layouts" / "two.svg").write_text(
        LAYOUT.replace('y="60"', 'y="70"'), "utf-8"
    )
    found = _changes(deck_py)
    states = [s.state for s in found.slides]
    assert states == [None, "shared", "modified", "modified", "new"]
    b = found.slides[2]
    assert b.entry is None
    assert [(f.path, f.status, f.shared) for f in b.files] == [
        ("talk/slides/b.md", "modified", False),
        ("talk/layouts/two.svg", "modified", True),
    ]
    assert found.slides[3].entry == "modified"
    d = found.slides[4]
    assert d.entry == "new"
    assert ("talk/slides/d.md", "new", False) in [
        (f.path, f.status, f.shared) for f in d.files
    ]
    data = found.json()
    assert data["deck"] == {
        "path": "talk/deck.py",
        "status": "modified",
        "readable": True,
        "other": False,
    }


def test_untracked_deck_makes_every_slide_new(tmp_path: Path) -> None:
    deck = tmp_path / "fresh"
    (deck / "slides").mkdir(parents=True)
    (deck / "layouts").mkdir()
    (deck / "deck.py").write_text(DECK, encoding="utf-8")
    (deck / "slides" / "intro.svg").write_text(INTRO, encoding="utf-8")
    (deck / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (deck / "notes").mkdir()
    for name in "abc":
        (deck / "slides" / f"{name}.md").write_text(f"# {name}\n", "utf-8")
    (deck / "notes" / "intro.md").write_text("Hi\n", "utf-8")
    _git(deck, "init", "-q", "-b", "main")
    found = _changes(deck / "deck.py")
    assert {s.state for s in found.slides} == {"new"}
    # The first commit: the chosen slide alone, in a deck.py of its own.
    sha = slidegit.commit_slides(found, [1], "A first", False, [])
    assert sha
    head = _git(deck, "show", "HEAD:deck.py")
    assert 'md="a.md"' in head
    assert "intro.svg" not in head and 'md="b.md"' not in head
    files = _git(deck, "show", "--name-only", "--format=", "HEAD").split()
    # Complete: the layout it is drawn on goes in too.
    assert sorted(files) == ["deck.py", "layouts/two.svg", "slides/a.md"]


# ── Committing chosen slides ──


def test_commit_a_slide_whose_files_changed_leaves_deck_py(deck_py: Path) -> None:
    _work(deck_py)
    before = deck_py.read_text(encoding="utf-8")
    found = _changes(deck_py)
    plan = slidegit.commit_plan(found, [2], with_removed=False)
    assert plan.paths == [
        {"path": "talk/slides/b.md", "status": "modified", "why": "own"}
    ]
    assert plan.deck == "none"
    assert plan.left == 2
    slidegit.commit_slides(found, [2], "B", False, [])
    assert _head_files(deck_py) == ["talk/slides/b.md"]
    assert deck_py.read_text(encoding="utf-8") == before
    status = _git(deck_py.parent, "status", "--porcelain")
    assert "b.md" not in status
    assert " M talk/deck.py" in status


def test_commit_a_slide_whose_entry_changed_commits_part_of_deck_py(
    deck_py: Path,
) -> None:
    _work(deck_py)
    before = deck_py.read_text(encoding="utf-8")
    found = _changes(deck_py)
    plan = slidegit.commit_plan(found, [3], with_removed=False)
    assert plan.deck == "partial"
    assert plan.paths == []
    assert plan.missing == []
    slidegit.commit_slides(found, [3], "C titled", False, [])
    head = _head_deck(deck_py)
    assert 'title="C"' in head
    assert "d.md" not in head
    assert _head_files(deck_py) == ["talk/deck.py"]
    # The working copy is untouched; what is left is the new slide.
    assert deck_py.read_text(encoding="utf-8") == before
    left = _git(deck_py.parent, "diff", "HEAD", "--", "deck.py")
    assert '+            Slide("two", md="d.md"),' in left
    assert 'title="C"),\n+' in left  # (a context line now)
    assert not [line for line in left.splitlines() if line.startswith("-   ")]
    assert _git(deck_py.parent, "diff", "--cached") == ""
    # Then the new slide: its untracked Markdown and its entry.
    found = _changes(deck_py)
    assert [s.state for s in found.slides] == [None, None, "modified", None, "new"]
    slidegit.commit_slides(found, [4], "D", False, [])
    assert _head_files(deck_py) == ["talk/deck.py", "talk/slides/d.md"]
    assert _head_deck(deck_py) == before


def test_removed_slides_stay_unless_their_removal_goes_in(deck_py: Path) -> None:
    (deck_py.parent / "slides" / "a.md").write_text("# A!\n", "utf-8")
    _edit_deck(deck_py, '            Slide("two", md="c.md"),\n', "")
    (deck_py.parent / "slides" / "c.md").unlink()
    found = _changes(deck_py)
    assert [r["key"] for r in found.removed_json()] == ["md:c.md"]
    plan = slidegit.commit_plan(found, [1], with_removed=False)
    assert plan.deck == "none"
    assert {"path": "talk/slides/c.md", "status": "deleted", "why": "deleted"} in (
        plan.offered
    )
    slidegit.commit_slides(found, [1], "A", False, [])
    assert 'md="c.md"' in _head_deck(deck_py)
    found = _changes(deck_py)
    plan = slidegit.commit_plan(found, [0], with_removed=True)
    assert plan.deck == "whole"
    slidegit.commit_slides(found, [0], "Remove c", True, ["talk/slides/c.md"])
    assert 'md="c.md"' not in _head_deck(deck_py)
    assert _git(deck_py.parent, "status", "--porcelain") == ""


def test_nothing_to_commit_is_said(deck_py: Path) -> None:
    found = _changes(deck_py)
    with pytest.raises(gitops.GitError, match="no changes"):
        slidegit.commit_plan(found, [0], with_removed=False)
    with pytest.raises(gitops.GitError, match="choose"):
        slidegit.commit_plan(found, [], with_removed=False)


def test_slide_diff_has_the_entry_and_the_files(deck_py: Path) -> None:
    _work(deck_py)
    found = _changes(deck_py)
    text = slidegit.slide_diff(found, 2)
    assert "+More" in text
    assert "a/talk/slides/b.md" in text
    text = slidegit.slide_diff(found, 3)
    assert '+Slide("two", md="c.md", title="C")\n' in text
    text = slidegit.slide_diff(found, 4)
    assert "+# D" in text
    assert "/dev/null" in text


# ── Through the session ──


def _session(deck_py: Path) -> tuple[EditorSession, Deck]:
    build = build_side(deck_py, f"_slidegit_{next(_modules)}", load_deck)
    session = EditorSession(deck_py)
    session.live = (build.slides, build.model)
    return session, build.deck


def test_session_status_lists_slide_changes_and_commits(deck_py: Path) -> None:
    _work(deck_py)
    session, deck = _session(deck_py)
    res = session.apply({"action": "git", "op": "status", "slides": True}, deck)
    slides = cast("dict[str, list[dict[str, object]]]", res["slides"])["slides"]
    assert [s["state"] for s in slides] == [None, None, "modified", "modified", "new"]
    plan = session.apply(
        {"action": "git", "op": "commit-slides", "slides": [2, 3], "dryRun": True},
        deck,
    )
    assert cast("dict[str, object]", plan["plan"])["deck"] == "partial"
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply(
            {"action": "git", "op": "commit-slides", "slides": [2], "message": "x"},
            deck,
        )
    res = session.apply(
        {
            "action": "git",
            "op": "commit-slides",
            "slides": [2, 3],
            "message": "B and C",
            "_local": True,
        },
        deck,
    )
    assert "2 slides" in str(res["message"])
    assert _head_files(deck_py) == ["talk/deck.py", "talk/slides/b.md"]
    diff = session.apply({"action": "git", "op": "slide-diff", "slide": 4}, deck)
    assert "d.md" in str(diff["diff"])


def test_session_without_a_build_says_so(deck_py: Path) -> None:
    session = EditorSession(deck_py)
    res = session.apply({"action": "git", "op": "status", "slides": True}, None)
    assert "slides" not in res
    with pytest.raises(EditError, match="not built"):
        session.apply({"action": "git", "op": "slide-diff", "slide": 0}, None)


# ── Another deck in a server of its own ──


class _Process:
    code: int | None

    def __init__(self, code: int | None) -> None:
        self.code = code

    def poll(self) -> int | None:
        return self.code


def test_serve_elsewhere_uses_a_running_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deck = tmp_path / "other" / "deck.py"
    found = instances.Instance(
        pid=1, host="127.0.0.1", port=7790, ws_port=7790, deck=str(deck)
    )

    def serving(*_a: object, **_k: object) -> instances.Instance:
        return found

    monkeypatch.setattr(instances, "serving", serving)
    assert projects.serve_elsewhere(deck) is found


def test_serve_elsewhere_starts_one_and_waits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deck = tmp_path / "other" / "deck.py"
    deck.parent.mkdir()
    started: list[list[str]] = []
    answers: list[instances.Instance | None] = [None, None]
    ready = instances.Instance(
        pid=2, host="127.0.0.1", port=7791, ws_port=7791, deck=str(deck)
    )

    def serving(*_a: object, **_k: object) -> instances.Instance | None:
        return answers.pop(0) if answers else ready

    def popen(args: list[str], **kwargs: object) -> _Process:
        started.append(args)
        assert kwargs["cwd"] == deck.parent
        return _Process(None)

    monkeypatch.setattr(instances, "serving", serving)
    monkeypatch.setattr(subprocess, "Popen", popen)
    assert projects.serve_elsewhere(deck) is ready
    assert started[0][1:6] == ["-m", "inkflow", "edit", "--deck", str(deck)]
    assert "--no-open" in started[0]
    assert ready.owner_url("/edit") == "http://127.0.0.1:7791/edit"


def test_serve_elsewhere_reports_a_server_that_stopped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deck = tmp_path / "other" / "deck.py"
    deck.parent.mkdir()

    def popen(_args: list[str], **kwargs: object) -> _Process:
        err = cast("BinaryIO", kwargs["stderr"])
        _ = err.write(b"Error: deck.py:3: NameError: nope\n")
        return _Process(1)

    def nobody(*_a: object, **_k: object) -> None:
        return None

    monkeypatch.setattr(instances, "serving", nobody)
    monkeypatch.setattr(subprocess, "Popen", popen)
    with pytest.raises(projects.ProjectError, match="NameError: nope"):
        projects.serve_elsewhere(deck)


def test_open_deck_tab_is_the_owners(deck_py: Path) -> None:
    session = EditorSession(deck_py)
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply({"action": "open-deck-tab", "path": str(deck_py)}, None)
    res = session.apply(
        {"action": "open-deck-tab", "path": str(deck_py), "_local": True}, None
    )
    assert res["url"] == "/edit"


# ── A committed slide is complete ──


def test_shared_and_deck_wide_files_go_in(deck_py: Path) -> None:
    deck = deck_py.parent
    (deck / "slides" / "b.md").write_text("# B\n\nMore\n", "utf-8")
    (deck / "layouts" / "two.svg").write_text(
        LAYOUT.replace('y="60"', 'y="70"'), "utf-8"
    )
    (deck / "styles.css").write_text(":root { --x: 1; }\n", "utf-8")
    found = _changes(deck_py)
    # styles.css is new: every slide is drawn with it.
    assert [s.state for s in found.slides] == ["shared", "shared", "modified", "shared"]
    plan = slidegit.commit_plan(found, [2], with_removed=False)
    assert plan.paths == [
        {"path": "talk/slides/b.md", "status": "modified", "why": "own"},
        {"path": "talk/layouts/two.svg", "status": "modified", "why": "shared"},
        {"path": "talk/styles.css", "status": "new", "why": "deck"},
    ]
    # Slides a and c are on the layout, intro is drawn with styles.css.
    assert plan.touched == 3
    assert plan.left == 0
    slidegit.commit_slides(found, [2], "B", False, [])
    assert _head_files(deck_py) == [
        "talk/layouts/two.svg",
        "talk/slides/b.md",
        "talk/styles.css",
    ]
    assert _git(deck, "status", "--porcelain") == ""


def test_python_the_deck_imports_goes_in(
    deck_py: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deck = deck_py.parent
    name = f"slidegit_helpers_{next(_modules)}"
    (deck / f"{name}.py").write_text("TITLE = 'A'\n", "utf-8")
    monkeypatch.setattr(sys, "path", [str(deck), *sys.path])
    _edit_deck(
        deck_py,
        "from inkflow import Deck, Slide\n",
        f"from inkflow import Deck, Slide\nfrom {name} import TITLE\n",
    )
    _edit_deck(deck_py, 'md="a.md")', 'md="a.md", title=TITLE)')
    found = _changes(deck_py)
    plan = slidegit.commit_plan(found, [1], with_removed=False)
    assert {"path": f"talk/{name}.py", "status": "new", "why": "deck"} in plan.paths
    assert plan.deck == "whole"


def test_files_a_clone_would_lack_are_named(deck_py: Path) -> None:
    deck = deck_py.parent
    (deck / ".gitignore").write_text("secret/\n", "utf-8")
    (deck / "secret").mkdir()
    (deck / "secret" / "pic.svg").write_text(INTRO, "utf-8")
    (deck / "slides" / "b.md").write_text("# B\n\n![](../secret/pic.svg)\n", "utf-8")
    found = _changes(deck_py)
    plan = slidegit.commit_plan(found, [2], with_removed=False)
    assert plan.missing == [{"path": "talk/secret/pic.svg", "why": "ignored"}]


# ── Discarding a slide's changes ──


def test_discard_puts_one_slide_back_and_undo_restores_it(deck_py: Path) -> None:
    _work(deck_py)
    deck = deck_py.parent
    (deck / "layouts" / "two.svg").write_text(
        LAYOUT.replace('y="60"', 'y="70"'), "utf-8"
    )
    before = deck_py.read_text(encoding="utf-8")
    session, built = _session(deck_py)
    req: dict[str, object] = {"action": "git", "op": "discard-slides", "slides": [3]}
    plan = cast(
        "dict[str, object]", session.apply({**req, "dryRun": True}, built)["plan"]
    )
    assert plan["deck"] == "partial"
    assert plan["paths"] == []
    assert plan["shared"] == [{"path": "talk/layouts/two.svg", "status": "modified"}]
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply(req, built)
    res = session.apply({**req, "_local": True}, built)
    assert res["label"] == "Discard changes to slide 4"
    text = deck_py.read_text(encoding="utf-8")
    # Slide c as committed; the new slide d stays, so does the layout.
    assert 'title="C"' not in text
    assert 'md="d.md"' in text
    assert 'y="70"' in (deck / "layouts" / "two.svg").read_text("utf-8")
    session.apply({"action": "undo"}, built)
    assert deck_py.read_text(encoding="utf-8") == before


def test_discard_a_new_slide_deletes_its_files(deck_py: Path) -> None:
    _work(deck_py)
    deck = deck_py.parent
    (deck / "slides" / "b.md").write_text("# B\n\nMore\n", "utf-8")
    session, built = _session(deck_py)
    session.apply(
        {"action": "git", "op": "discard-slides", "slides": [2, 4], "_local": True},
        built,
    )
    assert not (deck / "slides" / "d.md").exists()
    assert (deck / "slides" / "b.md").read_text("utf-8") == "# B\n"
    text = deck_py.read_text(encoding="utf-8")
    assert 'md="d.md"' not in text
    assert 'title="C"' in text  # (slide c was not chosen)


# ── One slide's history ──


def test_slide_log_lists_the_commits_that_changed_it(deck_py: Path) -> None:
    deck = deck_py.parent
    (deck / "slides" / "b.md").write_text("# B\n\nMore\n", "utf-8")
    _git(deck, "commit", "-qam", "B text")
    _edit_deck(deck_py, 'md="c.md")', 'md="c.md", title="C")')
    _git(deck, "commit", "-qam", "C title")
    (deck / "slides" / "a.md").write_text("# A!\n", "utf-8")
    _git(deck, "commit", "-qam", "A text")
    found = _changes(deck_py)
    b = slidegit.slide_log(found, 2)
    assert [(c["subject"], c["files"], c["entry"]) for c in b] == [
        ("B text", ["talk/slides/b.md"], None),
        ("First", ["talk/slides/b.md"], "added"),
    ]
    c = slidegit.slide_log(found, 3)
    assert [(c["subject"], c["entry"]) for c in c] == [
        ("C title", "changed"),
        ("First", "added"),
    ]
