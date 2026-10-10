"""Compare sides: commits materialized from git, deck folders, worktrees, the
server's compare hub (asset route, models, Take this slide) and the CLI."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow.assets import AssetRoots
from inkflow.cli import main
from inkflow.editor import comparesrc, gitops, transfer
from inkflow.editor.compare import compare_decks
from inkflow.editor.comparehub import CompareHub, in_place, side_build_from
from inkflow.editor.comparesrc import (
    CompareError,
    Source,
    build_side,
    deck_facts,
    display_svg,
    materialize,
    prune,
    resolve,
    shadow_css,
    spec_source,
)
from inkflow.editor.session import EditorSession
from inkflow.export import find_chromium
from inkflow.pipeline import process_deck
from inkflow.server import load_deck

pytestmark = pytest.mark.skipif(not gitops.available(), reason="needs git")

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide

    def main() -> Deck:
        return Deck(
            slides=[
                Slide("intro.svg", notes="notes/intro.md"),
                Slide("two", md="text.md"),
                Slide("two", md="more.md"),
            ],
        )
""")

INTRO = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
      <image id="pic" href="../assets/pic.png" x="400" y="100" width="50" height="50"/>
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


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    ).stdout


def write_deck(deck: Path) -> Path:
    for sub in ("slides", "layouts", "notes", "assets"):
        (deck / sub).mkdir(parents=True, exist_ok=True)
    (deck / "deck.py").write_text(DECK, encoding="utf-8")
    (deck / "slides" / "intro.svg").write_text(INTRO, encoding="utf-8")
    (deck / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (deck / "slides" / "text.md").write_text("# Text\n\nFirst words\n", "utf-8")
    (deck / "slides" / "more.md").write_text("# More\n\nAnd more\n", "utf-8")
    (deck / "notes" / "intro.md").write_text("Say hello.\n", "utf-8")
    (deck / "assets" / "pic.png").write_bytes(PNG)
    return deck / "deck.py"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repository with the deck in ``talk/``, two commits; returns deck.py."""
    root = tmp_path / "repo"
    deck_py = write_deck(root / "talk")
    (root / "README.md").write_text("readme\n", encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "First")
    (root / "talk" / "slides" / "text.md").write_text("# Text\n\nNew words\n", "utf-8")
    _git(root, "commit", "-qam", "Second")
    return deck_py


# ── Commits ───────────────────────────────────────────────────────────────────


def test_commit_materialized_with_its_subfolder(repo: Path) -> None:
    side = resolve(Source("commit", "HEAD~1"), repo)
    assert side.kind == "commit" and side.deck_path is not None
    sha = _git(repo.parent, "rev-parse", "HEAD~1").strip()
    assert side.key == f"commit:{sha}"
    assert side.label == f"{sha[:7]} First"
    cache = repo.parent / ".inkflow" / "cache" / "compare" / sha
    assert side.deck_path == cache / "talk" / "deck.py"
    text = (cache / "talk" / "slides" / "text.md").read_text(encoding="utf-8")
    assert "First words" in text
    assert not (cache / "README.md").exists()  # only the deck's folder
    # Git ignores the cache; nothing became a worktree.
    assert _git(repo.parent, "status", "--porcelain") == ""
    assert len(comparesrc.worktrees(repo.parent)) == 1
    # Asked again, the same files are used.
    again = resolve(Source("commit", sha[:8]), repo)
    assert again.deck_path == side.deck_path


def test_bad_revisions_are_refused(repo: Path) -> None:
    for rev in ("--output=x", "no-such-thing", ""):
        with pytest.raises(CompareError):
            comparesrc.resolve_commit(repo.parent, rev)


def test_prune_keeps_the_newest_and_those_in_use(tmp_path: Path) -> None:
    for i, name in enumerate(["a", "b", "c", "d"]):
        (tmp_path / name).mkdir()
        os.utime(tmp_path / name, (1000 + i, 1000 + i))
    prune(tmp_path, keep=2, in_use={"a"})
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a", "c", "d"]


def test_lfs_pointers_come_from_the_working_copy(tmp_path: Path) -> None:
    root = tmp_path / "lfsrepo"
    deck_py = write_deck(root)
    real = PNG + b"real picture"
    oid = hashlib.sha256(real).hexdigest()

    def pointer(o: str) -> str:
        return f"version https://git-lfs.github.com/spec/v1\noid sha256:{o}\nsize 9\n"

    (root / "assets" / "pic.png").write_text(pointer(oid), encoding="utf-8")
    (root / "assets" / "gone.png").write_text(pointer("0" * 64), encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "Pointers")
    (root / "assets" / "pic.png").write_bytes(real)  # what LFS would smudge
    sha = _git(root, "rev-parse", "HEAD").strip()
    deck, missing = materialize(deck_py.parent, sha)
    assert (deck.parent / "assets" / "pic.png").read_bytes() == real
    assert missing == ["assets/gone.png"]


# ── Folders, branches, worktrees ──────────────────────────────────────────────


def test_specs_paths_and_branches(repo: Path, tmp_path: Path) -> None:
    root = repo.parent.parent
    _git(root, "branch", "idea")
    assert spec_source("idea", tmp_path, repo.parent) == Source("branch", "idea")
    assert spec_source("HEAD~1", tmp_path, repo.parent) == Source("commit", "HEAD~1")
    assert spec_source(str(repo.parent), tmp_path, None) == Source(
        "path", str(repo.resolve())
    )
    with pytest.raises(CompareError):
        spec_source(str(tmp_path), tmp_path, None)  # a folder without a deck
    # The served deck itself is the live side.
    assert resolve(Source("path", str(repo.parent)), repo).kind == "live"
    # A branch nobody has checked out is its commit.
    idea = resolve(Source("branch", "idea"), repo)
    assert idea.kind == "commit" and idea.branch == "idea"
    # The current branch is the working copy.
    assert resolve(Source("branch", "main"), repo).kind == "live"


def test_branch_in_a_worktree_is_that_folder(repo: Path, tmp_path: Path) -> None:
    root = repo.parent.parent
    wt = tmp_path / "wt"
    _git(root, "worktree", "add", "-q", "-b", "agent/idea", str(wt))
    side = resolve(Source("branch", "agent/idea"), repo)
    assert side.kind == "path" and side.branch == "agent/idea"
    assert side.deck_path == (wt / "talk" / "deck.py").resolve()
    assert side.watched
    # A remote page may not read a folder outside the project: the commit.
    remote = resolve(Source("branch", "agent/idea"), repo, local=False)
    assert remote.kind == "commit"
    with pytest.raises(CompareError):
        resolve(Source("path", str(wt / "talk")), repo, local=False)
    trees = comparesrc.worktrees(root)
    assert [t["branch"] for t in trees] == ["main", "agent/idea"]
    # A deck folder in a worktree is labelled with its branch.
    assert resolve(Source("path", str(wt / "talk")), repo).label == "agent/idea"


def test_source_parsing() -> None:
    assert Source.parse({"kind": "commit", "rev": "abc"}) == Source("commit", "abc")
    assert Source.parse({"kind": "path", "deck": "x", "label": "Y"}).label == "Y"
    assert Source.parse({"kind": "live"}).as_json() == {"kind": "live"}
    for bad in ({"kind": "commit"}, {"kind": "nope"}, "live", {"kind": "spec"}):
        with pytest.raises(CompareError):
            Source.parse(bad)


# ── Building and comparing ────────────────────────────────────────────────────


def _two_folders(tmp_path: Path) -> tuple[Path, Path]:
    left = write_deck(tmp_path / "left")
    right = write_deck(tmp_path / "right")
    (right.parent / "slides" / "text.md").write_text(
        "# Text\n\nChanged words\n", "utf-8"
    )
    (right.parent / "notes" / "intro.md").write_text("Say hi.\n", "utf-8")
    return left, right


def test_two_folders_differ_in_files_notes_and_elements(tmp_path: Path) -> None:
    left, right = _two_folders(tmp_path)
    a = build_side(left, "_inkflow_test_left", load_deck)
    b = build_side(right, "_inkflow_test_right", load_deck)
    try:
        result = compare_decks(deck_facts(a), deck_facts(b))
    finally:
        sys.modules.pop("_inkflow_test_left", None)
        sys.modules.pop("_inkflow_test_right", None)
    statuses = [p.status for p in result.pairs]
    assert statuses == ["changed", "changed", "same"]
    intro, text, _ = result.pairs
    assert intro.notes and not intro.visual
    assert [(f.path, f.role) for f in intro.files] == [("notes/intro.md", "notes")]
    assert text.visual and [f.path for f in text.files] == ["slides/text.md"]
    assert [e.change for e in text.elements] == ["changed"]
    assert result.deck == []


def test_shadow_css_and_display_svg(tmp_path: Path) -> None:
    css, fonts = shadow_css(
        ':root { --a: 1 }\n:root[data-theme="light"] { --a: 2 }\n'
        + "@font-face { font-family: X; src: url(data:x) }\n.y { color: red }"
    )
    assert ".cmp-root { --a: 1 }" in css
    assert '.cmp-root[data-theme="light"]' in css
    assert "@font-face" not in css and fonts.startswith("@font-face")
    deck_py = write_deck(tmp_path / "d")
    roots = AssetRoots(deck_py.parent)
    svg = '<svg><image data-ink="0:2" href="assets/pic.png#x"/></svg>'
    out = display_svg(svg, "TOK", roots)
    assert "data-ink" not in out
    assert 'href="/_cmp/TOK/assets/pic.png?v=' in out and out.endswith('#x"/></svg>')


# ── The server's hub ──────────────────────────────────────────────────────────


class FakeWs:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []

    async def send(self, text: str) -> None:
        self.sent.append(cast("dict[str, object]", json.loads(text)))


def _live_hub(deck_py: Path) -> CompareHub:
    hub = CompareHub(deck_py, load_deck)
    deck = load_deck(deck_py)
    slides = process_deck(deck, deck_py.parent, deck_py, editor=True)
    from inkflow.editor.model import build_model

    model = build_model(deck, deck_py, slides)
    asyncio.run(hub.live_built(side_build_from(deck, deck_py, slides, model)))
    return hub


def test_hub_models_assets_and_take(tmp_path: Path) -> None:
    left, right = _two_folders(tmp_path)
    (right.parent / "slides" / "extra.md").write_text("# Extra\n\nNew\n", "utf-8")
    right.write_text(
        DECK.replace(
            'Slide("two", md="more.md"),',
            'Slide("two", md="more.md"),\n                Slide("two", md="extra.md"),',
        ),
        encoding="utf-8",
    )
    hub = _live_hub(left)
    ws = FakeWs()
    msg: dict[str, object] = {
        "view": 1,
        "left": {"kind": "live"},
        "right": {"kind": "path", "deck": str(right)},
    }
    model = asyncio.run(hub.open(ws, msg, local=True))  # pyright: ignore[reportArgumentType]
    assert model["type"] == "compare-model" and model["view"] == 1
    pairs = cast("list[dict[str, object]]", model["pairs"])
    assert [p["status"] for p in pairs] == ["changed", "changed", "same", "added"]
    sides = cast("dict[str, object]", model["right"])
    assert sides["label"] == "right" and sides["kind"] == "path"
    token = str(sides["token"])
    slides = cast("list[dict[str, object]]", sides["slides"])
    assert f"/_cmp/{token}/assets/pic.png" in str(slides[0]["svg"])
    assert ".cmp-root" in str(sides["css"])

    # The asset route serves this side's files and nothing outside them.
    found = hub.asset(f"/_cmp/{token}/assets/pic.png?v=1")
    assert found == (right.parent / "assets" / "pic.png").resolve()
    assert hub.asset(f"/_cmp/{token}/../left/assets/pic.png") is None
    assert hub.asset(f"/_cmp/{token}/%2e%2e/left/assets/pic.png") is None
    assert hub.asset(f"/_cmp/{token}/deck.py") is None  # not a servable kind
    assert hub.asset("/_cmp/unknown/assets/pic.png") is None

    # Take this slide: the right's version replaces the live one, undoably.
    session = EditorSession(left)
    deck = load_deck(left)
    take = hub.take_request(ws, {"pair": 1, "left": 1, "right": 1})  # pyright: ignore[reportArgumentType]
    assert take["replace"] == 1
    result = session.apply({"action": "compare-take", "_take": take}, deck)
    assert result["ok"] and result["label"] == "Take text from right"
    text_md = left.parent / "slides" / "text.md"
    assert "Changed words" in text_md.read_text(encoding="utf-8")
    session.apply({"action": "undo"}, deck)
    assert "First words" in text_md.read_text(encoding="utf-8")
    # A stale pair is refused.
    with pytest.raises(CompareError):
        hub.take_request(ws, {"pair": 1, "left": 0, "right": 1})  # pyright: ignore[reportArgumentType]

    # A slide only on the right is inserted, its files at their own paths.
    take = hub.take_request(ws, {"pair": 3, "left": None, "right": 3})  # pyright: ignore[reportArgumentType]
    assert take["replace"] is None and take["after"] == 2 and take["inPlace"]
    result = session.apply({"action": "compare-take", "_take": take}, deck)
    assert result["ok"] and result["select"] == 3
    assert 'md="extra.md"' in left.read_text(encoding="utf-8")
    assert (left.parent / "slides" / "extra.md").is_file()

    # Closing drops the side, its token and its module.
    module = hub.sides[f"path:{right.resolve()}"].build
    assert module is not None
    hub.close(ws)  # pyright: ignore[reportArgumentType]
    assert hub.asset(f"/_cmp/{token}/assets/pic.png") is None
    assert module.module not in sys.modules


def test_take_needs_the_working_copy(tmp_path: Path) -> None:
    left, right = _two_folders(tmp_path)
    hub = _live_hub(left)
    ws = FakeWs()
    msg = {
        "view": 2,
        "left": {"kind": "path", "deck": str(right)},
        "right": {"kind": "path", "deck": str(right)},
    }
    asyncio.run(hub.open(ws, msg, local=True))  # pyright: ignore[reportArgumentType]
    with pytest.raises(CompareError, match="working copy"):
        hub.take_request(ws, {"pair": 0, "left": 0, "right": 0})  # pyright: ignore[reportArgumentType]


def test_in_place_only_over_files_no_slide_uses(tmp_path: Path) -> None:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "a.md").write_text("old", "utf-8")

    def bundle(role: str) -> dict[str, object]:
        data = base64.b64encode(b"new").decode()
        return {"files": {"slides/a.md": {"role": role, "data": data}}}

    assert in_place(tmp_path, bundle("md"), used=set())
    assert not in_place(tmp_path, bundle("md"), used={"slides/a.md"})
    assert not in_place(tmp_path, bundle("asset"), used=set())


def test_replace_plan_refuses_paths_outside() -> None:
    bad = {
        "type": "inkflow-slides",
        "version": transfer.BUNDLE_VERSION,
        "slides": [{"code": 'Slide("x.svg")'}],
        "files": {"../evil.md": {"role": "md", "data": ""}},
    }
    with pytest.raises(transfer.TransferError):
        transfer.plan_slide_replace(Path("/tmp"), bad)
    code = dict(bad, files={}, slides=[{"code": "__import__('os')"}])
    with pytest.raises(transfer.TransferError):
        transfer.plan_slide_replace(Path("/tmp"), code)


# ── The command line ──────────────────────────────────────────────────────────


def test_cli_text_and_json(repo: Path) -> None:
    (repo.parent / "slides" / "more.md").write_text("# More\n\nEdited\n", "utf-8")
    runner = CliRunner()
    result = runner.invoke(main, ["compare", "--deck", str(repo), "HEAD"])
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    sha = _git(repo.parent, "rev-parse", "--short=7", "HEAD").strip()
    assert lines[0] == f"Working copy ⟷ {sha} Second"
    assert "~ 3 more: slides/more.md" in lines
    assert lines[-1] == "= 2 unchanged: 1-2"
    result = runner.invoke(main, ["compare", "--deck", str(repo), "HEAD~1", "HEAD"])
    assert "~ 2 text: slides/text.md" in result.output
    result = runner.invoke(main, ["compare", "--deck", str(repo), "--json", "HEAD"])
    data = cast("dict[str, object]", json.loads(result.output))
    assert cast("dict[str, object]", data["left"])["label"] == "Working copy"
    pairs = cast("list[dict[str, object]]", data["pairs"])
    assert [p["status"] for p in pairs] == ["same", "same", "changed"]
    result = runner.invoke(main, ["compare", "--deck", str(repo), "nope"])
    assert result.exit_code == 1 and "no commit" in result.output
    result = runner.invoke(main, ["compare", "--deck", str(repo)])
    assert result.exit_code == 2


def test_cli_compares_a_folder(tmp_path: Path) -> None:
    left, right = _two_folders(tmp_path)
    result = CliRunner().invoke(
        main, ["compare", "--deck", str(left), str(right.parent)]
    )
    assert result.exit_code == 0, result.output
    assert "~ 1 intro: notes" in result.output.splitlines()
    shutil.rmtree(right.parent)


# ── The comparison sheet ──────────────────────────────────────────────────────


def test_pair_sheet_layout_and_html() -> None:
    from inkflow.render import PairCell, pair_sheet_html, pair_sheet_layout

    layout = pair_sheet_layout(2, 1920, 1080)
    assert layout.columns == 2 and layout.thumb_width * 2 < layout.width
    assert layout.thumb_height == round(layout.thumb_width * 1080 / 1920)
    rows = [
        PairCell(
            "~ 2 text: slides/text.md",
            "changed",
            "left-1.png",
            "right-1.png",
            [("changed", 80.0, 200.0, 1760.0, 780.0)],
            [("changed", 80.0, 200.0, 1760.0, 780.0)],
        ),
        PairCell("+ 4 extra: only on the right", "added", None, "right-3.png"),
    ]
    html = pair_sheet_html(layout, ("Working copy", "abc <x>"), rows, 1920)
    assert "abc &lt;x&gt;" in html
    assert html.count('class="box"') == 2 and "not in this deck" in html
    assert 'class="label s-added"' in html


@pytest.mark.skipif(find_chromium() is None, reason="needs Chromium")
def test_cli_sheet_renders_the_changed_pairs(tmp_path: Path) -> None:
    left, right = _two_folders(tmp_path)
    out = tmp_path / "cmp.png"
    result = CliRunner().invoke(
        main,
        ["compare", "--deck", str(left), str(right.parent), "--sheet", "-o", str(out)],
    )
    assert result.exit_code == 0, result.output
    assert out.is_file() and out.read_bytes()[:4] == b"\x89PNG"
