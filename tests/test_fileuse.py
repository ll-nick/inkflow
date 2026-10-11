"""Which project files a deck uses (``filerename.file_uses``), what git could
bring back of a deleted file (``gitops.file_states``), and deleting files from
disk: the session's ``files``/``delete-files`` actions, a slide delete that
takes its files along, and ``inkflow files``."""

from __future__ import annotations

import json
import subprocess
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner, Result
from websockets.sync.client import connect

from inkflow import instances
from inkflow.cli import main
from inkflow.editor import gitops
from inkflow.editor.filerename import (
    ORPHAN,
    TEMPLATE,
    UNUSED,
    USED,
    FileUse,
    file_uses,
    slide_drop_files,
)
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import file_hash
from inkflow.manifest import Deck
from inkflow.server import load_deck
from tests import test_slides_cli as slides_tests

served = slides_tests.served

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="800"/>
    </svg>
""")

SPARE_LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <image href="../assets/template.png" width="10" height="10"/>
    </svg>
""")

BASE_COPY = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:copy-of="builtin:base" viewBox="0 0 1920 1080">
      <image href="../assets/brand.png" width="10" height="10"/>
    </svg>
""")

# A slide's own drawing; its preview layer (as `inkflow sync` writes it) is a
# copy of its layout, whose picture is not a use.
LIVE = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="plain" viewBox="0 0 1920 1080">
      <g inkflow:layout-src="plain" inkflow:layout-hash="1">
        <image href="../assets/copied.png"/>
      </g>
      <image id="a" href="../assets/shared.png" width="10" height="10"/>
      <image id="b" href="../assets/live.png" width="10" height="10"/>
    </svg>
""")

# Left behind by a slide deleted from deck.py.
OLD = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <image href="../assets/shared.png" width="10" height="10"/>
      <image href="../assets/old-only.png" width="10" height="10"/>
    </svg>
""")

INTRO_MD = textwrap.dedent("""\
    # Intro

    ![a picture](../assets/md.png)

    ```chart
    data: ../data/intro.csv
    kind: bar
    ```
""")

GONE_MD = "# Gone\n\n![x](../assets/gone.png)\n"

DECK = textwrap.dedent("""\
    from inkflow import Deck, Image, Overlay, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            overlays=[Overlay("footer")],
            slides=[
                Slide("live.svg", notes="notes/live.md"),
                Slide("plain", md="intro.md"),
                Slide(
                    "plain",
                    md="pics.md",
                    zones={"content": Image("assets/zone.png")},
                ),
                Slide("plain", md="hidden.md", visible=False),
                Slide("content", md="built.md"),
            ],
        )
""")


def _write(path: Path, text: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        _ = path.write_bytes(text)
    else:
        _ = path.write_text(text, encoding="utf-8")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "talk"
    _write(root / "layouts" / "plain.svg", LAYOUT)
    _write(root / "layouts" / "spare.svg", SPARE_LAYOUT)
    _write(root / "layouts" / "base.svg", BASE_COPY)
    _write(root / "overlays" / "footer.svg", LAYOUT)
    _write(root / "overlays" / "draft.svg", LAYOUT)
    _write(root / "slides" / "live.svg", LIVE)
    _write(root / "slides" / "old.svg", OLD)
    _write(root / "slides" / "intro.md", INTRO_MD)
    _write(root / "slides" / "pics.md", "# Pics\n\n![p](../assets/pics.png)\n")
    _write(root / "slides" / "hidden.md", "# Hidden\n")
    _write(root / "slides" / "built.md", "# Built\n")
    _write(root / "slides" / "gone.md", GONE_MD)
    _write(root / "notes" / "live.md", "Talk.\n")
    for name in (
        "shared",
        "live",
        "copied",
        "old-only",
        "md",
        "gone",
        "pics",
        "zone",
        "template",
        "brand",
        "spare",
    ):
        _write(root / "assets" / f"{name}.png", f"PNG {name}".encode())
    _write(root / "data" / "intro.csv", "a,b\nx,1\n")
    _write(root / "ink" / "intro.svg", LAYOUT)
    _write(root / "ink" / "hidden.svg", LAYOUT)
    _write(root / "ink" / "stale.svg", LAYOUT)
    _write(root / "README.md", "# The talk\n")
    _write(root / "deck.py", DECK)
    return root


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Nobody's own git config, a fixed identity; never a real server.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))
    for who in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{who}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{who}_EMAIL", "test@example.com")

    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    ).stdout


def _uses(project: Path) -> dict[str, FileUse]:
    return file_uses(project, project / "deck.py", load_deck(project / "deck.py"))


def _session(project: Path) -> EditorSession:
    session = EditorSession(project / "deck.py")
    session.built_hash = file_hash((project / "deck.py").read_bytes())
    return session


def _deck(project: Path) -> Deck:
    return load_deck(project / "deck.py")


# ── Reachability ──────────────────────────────────────────────────────────────


def test_what_the_deck_reaches_is_used(project: Path) -> None:
    uses = _uses(project)
    for rel in (
        "slides/live.svg",
        "notes/live.md",
        "assets/shared.png",
        "assets/live.png",
        "slides/intro.md",
        "assets/md.png",  # through the Markdown
        "data/intro.csv",  # a chart fence in the Markdown
        "ink/intro.svg",  # found by the slide's id
        "slides/pics.md",
        "assets/pics.png",
        "assets/zone.png",  # a zones= value
        "slides/hidden.md",  # a hidden slide is still the deck's
        "ink/hidden.svg",  # and so is its ink
        "layouts/plain.svg",
        "layouts/base.svg",  # the copy standing in for builtin:base
        "assets/brand.png",  # through that copy
        "overlays/footer.svg",
    ):
        assert uses[rel].state == USED, rel
    # Counted from the files the deck uses: old.svg names it too, unused.
    assert uses["assets/shared.png"].uses == 1
    assert uses["overlays/footer.svg"].uses == 1


def test_a_deleted_slides_drawing_and_its_pictures(project: Path) -> None:
    uses = _uses(project)
    assert uses["slides/old.svg"] == FileUse(UNUSED, 0)
    assert uses["assets/old-only.png"] == FileUse(ORPHAN, 0, ("slides/old.svg",))
    assert uses["slides/gone.md"].state == UNUSED
    assert uses["assets/gone.png"] == FileUse(ORPHAN, 0, ("slides/gone.md",))
    # Shared with a slide the deck shows: used, counted from used files only.
    assert uses["assets/shared.png"].state == USED


def test_templates_previews_and_leftovers(project: Path) -> None:
    uses = _uses(project)
    assert uses["layouts/spare.svg"].state == TEMPLATE
    assert uses["overlays/draft.svg"].state == TEMPLATE
    assert uses["assets/template.png"] == FileUse(TEMPLATE, 0, ("layouts/spare.svg",))
    # A preview layer's contents are a copy of the layout: not a use.
    assert uses["assets/copied.png"].state == UNUSED
    assert uses["ink/stale.svg"].state == UNUSED
    assert uses["assets/spare.png"].state == UNUSED
    # The project's own documents are not deck files.
    assert "README.md" not in uses and "deck.py" not in uses


def test_the_readme_keeps_its_pictures(project: Path) -> None:
    _write(project / "README.md", "# The talk\n\n![shot](assets/spare.png)\n")
    assert _uses(project)["assets/spare.png"] == FileUse(USED, 1)


def test_a_string_in_deck_py_keeps_a_file(project: Path) -> None:
    code = (project / "deck.py").read_text(encoding="utf-8")
    code = code.replace("def main()", 'EXTRA = "assets/spare.png"\n\n\ndef main()')
    _ = (project / "deck.py").write_text(code, encoding="utf-8")
    assert _uses(project)["assets/spare.png"].state == USED


def test_slide_drop_files_takes_only_what_no_other_slide_reaches(
    project: Path,
) -> None:
    deck = _deck(project)
    kept = [s for i, s in enumerate(deck.slides) if i != 0]
    code = (project / "deck.py").read_text(encoding="utf-8")
    code = code.replace('            Slide("live.svg", notes="notes/live.md"),\n', "")
    gone = slide_drop_files(project, project / "deck.py", deck, kept, code)
    assert [p.relative_to(project).as_posix() for p in gone] == [
        "assets/live.png",
        "assets/shared.png",
        "notes/live.md",
        "slides/live.svg",
    ]


# ── Git ───────────────────────────────────────────────────────────────────────


@pytest.fixture
def repo(project: Path) -> Path:
    """The deck in ``talk/`` of a repository, committed; then a new picture,
    a changed Markdown file and an ignored one."""
    root = project.parent
    _write(root / ".gitignore", "talk/assets/ignored.png\n")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "First")
    _write(project / "assets" / "new.png", b"PNG new")
    _write(project / "assets" / "ignored.png", b"PNG ignored")
    _write(project / "slides" / "gone.md", GONE_MD + "\nMore.\n")
    return project


@pytest.mark.skipif(not gitops.available(), reason="needs git")
def test_git_states(repo: Path) -> None:
    names = ["assets/old-only.png", "slides/gone.md", "assets/new.png"]
    names.append("assets/ignored.png")
    states = gitops.file_states(repo, [repo / n for n in names])
    assert [states[repo / n] for n in names] == [
        gitops.COMMITTED,
        gitops.MODIFIED,
        gitops.UNTRACKED,
        gitops.IGNORED,
    ]
    _git(repo, "add", "assets/new.png")
    assert gitops.file_states(repo, [repo / "assets/new.png"]) == {
        repo / "assets/new.png": gitops.UNTRACKED
    }


def test_no_repository(project: Path) -> None:
    assert gitops.file_states(project, [project / "slides/old.svg"]) == {
        project / "slides/old.svg": gitops.NO_REPO
    }


@pytest.mark.skipif(not gitops.available(), reason="needs git")
def test_an_lfs_file_checked_out_is_committed(repo: Path) -> None:
    pointer = (
        "version https://git-lfs.github.com/spec/v1\n"
        + "oid sha256:"
        + "0" * 64
        + "\nsize 12\n"
    )
    _write(repo / "assets" / "clip.mp4", pointer)
    _git(repo, "add", "assets/clip.mp4")
    _git(repo, "commit", "-q", "-m", "Clip")
    states = gitops.file_states(repo, [repo / "assets" / "clip.mp4"])
    assert states[repo / "assets" / "clip.mp4"] == gitops.COMMITTED


# ── The session ───────────────────────────────────────────────────────────────


@pytest.mark.skipif(not gitops.available(), reason="needs git")
def test_files_lists_states_and_git(repo: Path) -> None:
    result = _session(repo).apply({"action": "files"}, _deck(repo))
    assert result["repo"] is True
    files = {f["path"]: f for f in cast("list[dict[str, object]]", result["files"])}
    assert files["assets/old-only.png"]["state"] == ORPHAN
    assert files["assets/old-only.png"]["by"] == ["slides/old.svg"]
    assert files["assets/old-only.png"]["git"] == gitops.COMMITTED
    assert files["slides/gone.md"]["git"] == gitops.MODIFIED
    assert files["assets/new.png"]["git"] == gitops.UNTRACKED
    assert files["assets/live.png"]["state"] == USED


@pytest.mark.skipif(not gitops.available(), reason="needs git")
def test_delete_files_dry_run_then_delete_and_undo(repo: Path) -> None:
    session = _session(repo)
    deck = _deck(repo)
    paths = ["slides/old.svg", "assets/old-only.png", "assets/new.png"]
    plan = session.apply(
        {"action": "delete-files", "paths": paths, "dryRun": True}, deck
    )
    assert plan["dryRun"] is True and plan["repo"] is True
    assert plan["deleted"] == [
        {"path": "assets/new.png", "git": gitops.UNTRACKED, "size": 7},
        {"path": "assets/old-only.png", "git": gitops.COMMITTED, "size": 12},
        {"path": "slides/old.svg", "git": gitops.COMMITTED, "size": len(OLD)},
    ]
    assert all((repo / p).exists() for p in paths)
    assert not session.history.done
    result = session.apply({"action": "delete-files", "paths": paths}, deck)
    assert result["label"] == "Delete 3 files"
    assert [d["git"] for d in cast("list[dict[str, str]]", result["deleted"])] == [
        gitops.UNTRACKED,
        gitops.COMMITTED,
        gitops.COMMITTED,
    ]
    assert not any((repo / p).exists() for p in paths)
    session.apply({"action": "undo"}, deck)
    assert all((repo / p).exists() for p in paths)


def test_delete_files_refuses_a_used_file(project: Path) -> None:
    session = _session(project)
    deck = _deck(project)
    for msg in ({"dryRun": True}, {}):
        with pytest.raises(
            EditError, match=r"assets/live\.png is in use \(1 reference\)"
        ):
            session.apply(
                {"action": "delete-files", "paths": ["assets/live.png"], **msg}, deck
            )
    with pytest.raises(EditError, match="not a deck file"):
        session.apply({"action": "delete-files", "paths": ["README.md"]}, deck)
    assert (project / "assets" / "live.png").exists()


@pytest.mark.skipif(not gitops.available(), reason="needs git")
def test_slide_delete_dry_run_lists_exactly_the_files(repo: Path) -> None:
    session = _session(repo)
    deck = _deck(repo)
    before = (repo / "deck.py").read_text(encoding="utf-8")
    _write(repo / "assets" / "live.png", b"PNG changed")  # uncommitted change
    request: dict[str, object] = {
        "action": "slide",
        "op": "delete",
        "slide": 1,
        "files": True,
    }
    plan = session.apply({**request, "dryRun": True}, deck)
    deleted = cast("list[dict[str, object]]", plan["deleted"])
    assert sorted((str(d["path"]), str(d["git"])) for d in deleted) == [
        ("assets/md.png", gitops.COMMITTED),
        ("data/intro.csv", gitops.COMMITTED),
        ("ink/intro.svg", gitops.COMMITTED),
        ("slides/intro.md", gitops.COMMITTED),
    ]
    assert plan["written"] == ["deck.py"]
    assert (repo / "slides" / "intro.md").exists()
    assert not session.history.done
    session.apply(request, deck)
    for rel in ("slides/intro.md", "assets/md.png", "data/intro.csv", "ink/intro.svg"):
        assert not (repo / rel).exists(), rel
    assert "intro.md" not in (repo / "deck.py").read_text(encoding="utf-8")
    session.apply({"action": "undo"}, deck)
    for rel in ("slides/intro.md", "assets/md.png", "data/intro.csv", "ink/intro.svg"):
        assert (repo / rel).exists(), rel
    assert (repo / "deck.py").read_text(encoding="utf-8") == before


def test_slide_delete_takes_pictures_only_it_shows(project: Path) -> None:
    session = _session(project)
    session.apply(
        {"action": "slide", "op": "delete", "slide": 0, "files": True}, _deck(project)
    )
    assert not (project / "slides" / "live.svg").exists()
    assert not (project / "assets" / "live.png").exists()
    assert not (project / "notes" / "live.md").exists()
    # old.svg still names it, but old.svg is no slide: it goes too.
    assert not (project / "assets" / "shared.png").exists()
    # The layout it was built on stays.
    assert (project / "layouts" / "plain.svg").exists()


def test_slide_delete_without_files_keeps_them(project: Path) -> None:
    session = _session(project)
    plan = session.apply(
        {"action": "slide", "op": "delete", "slide": 2, "dryRun": True},
        _deck(project),
    )
    assert plan["deleted"] == []
    session.apply({"action": "slide", "op": "delete", "slide": 2}, _deck(project))
    assert (project / "slides" / "pics.md").exists()
    assert _uses(project)["assets/pics.png"] == FileUse(ORPHAN, 0, ("slides/pics.md",))


# ── The command line ──────────────────────────────────────────────────────────


def _cli(project: Path, *args: str) -> Result:
    return CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])


def test_files_lists_and_filters(project: Path) -> None:
    result = _cli(project, "files")
    assert result.exit_code == 0, result.output
    assert "assets/live.png" in result.output and "used" in result.output
    unused = _cli(project, "files", "--unused")
    assert "assets/live.png" not in unused.output
    assert "assets/old-only.png" in unused.output
    assert "only slides/old.svg" in unused.output
    listed = cast(
        "dict[str, list[dict[str, object]]]",
        json.loads(_cli(project, "files", "--json").output),
    )
    entry = next(f for f in listed["files"] if f["path"] == "assets/old-only.png")
    assert entry == {
        "path": "assets/old-only.png",
        "state": ORPHAN,
        "uses": 0,
        "by": ["slides/old.svg"],
        "git": gitops.NO_REPO,
        "size": 12,
    }


def test_files_clean_offline(project: Path) -> None:
    dry = _cli(project, "files", "clean", "-n")
    assert dry.exit_code == 0, dry.output
    assert "Would delete" in dry.output and "slides/old.svg" in dry.output
    assert "not in a git repository" in dry.output
    assert (project / "slides" / "old.svg").exists()
    done = _cli(project, "files", "clean")
    assert done.exit_code == 0, done.output
    for rel in (
        "slides/old.svg",
        "assets/old-only.png",
        "slides/gone.md",
        "assets/gone.png",
        "assets/copied.png",
        "ink/stale.svg",
    ):
        assert not (project / rel).exists(), rel
    # Templates stay unless asked for.
    assert (project / "layouts" / "spare.svg").exists()
    assert (project / "assets" / "template.png").exists()
    assert (project / "assets" / "live.png").exists()
    again = _cli(project, "files", "clean", "--templates")
    assert again.exit_code == 0, again.output
    assert not (project / "layouts" / "spare.svg").exists()
    assert not (project / "overlays" / "draft.svg").exists()
    assert not (project / "assets" / "template.png").exists()
    nothing = _cli(project, "files", "clean")
    assert nothing.exit_code == 0 and "Nothing to delete" in nothing.output


@pytest.mark.skipif(not gitops.available(), reason="needs git")
def test_files_clean_warns_about_git(repo: Path) -> None:
    dry = _cli(repo, "files", "clean", "-n")
    assert dry.exit_code == 0, dry.output
    assert "Not in git" in dry.output and "assets/new.png" in dry.output
    assert "Uncommitted changes" in dry.output and "slides/gone.md" in dry.output


def test_slide_delete_names_the_files_and_the_git_warning(project: Path) -> None:
    out = slides_tests._ok(project, "delete", "1")  # pyright: ignore[reportPrivateUsage]
    assert "Deleted" in out and "assets/live.png" in out
    assert "not in a git repository" in out


def test_files_clean_through_the_server_is_an_undoable_agent_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, port = served
    with connect(
        f"ws://127.0.0.1:{port}/_inkflow/ws", proxy=None, max_size=None
    ) as editor:
        editor.send(json.dumps({"type": "hello", "role": "editor"}))
        result = _cli(project, "files", "clean")
        assert result.exit_code == 0, result.output
        assert "Ctrl+Z in the editor" in result.output
    assert [s.label for s in session.history.done] == ["Agent: Delete unused files"]
    assert not (project / "slides" / "old.svg").exists()
    session.apply({"action": "undo"}, _deck(project))
    assert (project / "slides" / "old.svg").exists()
    assert (project / "assets" / "old-only.png").exists()
