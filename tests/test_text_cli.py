"""``inkflow find`` / ``inkflow replace``: the editor's Find and Replace from the
command line, applied to the files directly or through the server that has the
deck open (one undoable "Agent: …" step in its editor's History)."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner, Result

from inkflow import instances
from inkflow.cli import main
from inkflow.editor.session import EditorSession
from inkflow.server import load_deck
from tests import test_slides_cli as slides_tests

# The deck served as `inkflow edit` would, from the `inkflow slide` tests.
served = slides_tests.served

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("drawn.svg", title="Widgets", notes="notes/drawn.md"),
                Slide("plain", md="intro.md", title="More widgets"),
                Slide("plain", zones={"title": "Widgets again"}, visible=False),
                Slide("plain", md="end.md"),
            ],
        )
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <text id="label" x="100" y="100">Blue widgets</text>
    </svg>
""")

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="800"/>
    </svg>
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts", "notes"):
        (tmp_path / sub).mkdir()
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    (tmp_path / "slides" / "intro.md").write_text(
        "# Intro\n\nAll about widgets.\n\n::title::\n\nWidget world\n", "utf-8"
    )
    (tmp_path / "slides" / "end.md").write_text(
        "# Thanks\n\nNo widgets here? Widgets!\n"
    )
    (tmp_path / "notes" / "drawn.md").write_text("Say widgets twice.\n", "utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _run(project: Path, *args: str) -> Result:
    return CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])


def _ok(project: Path, *args: str) -> str:
    result = _run(project, *args)
    assert result.exit_code == 0, result.output
    return result.output


def test_find_lists_every_match_with_where_it_is(project: Path) -> None:
    lines = _ok(project, "find", "widget").splitlines()
    assert 'slide 1 (drawn): slides/drawn.svg #label: "Blue [widget]s"' in lines
    assert 'slide 1 (drawn): notes/drawn.md:1: "Say [widget]s twice."' in lines
    assert 'slide 2 (intro): slides/intro.md:3 [content]: "All about [widget]s."' in (
        lines
    )
    assert 'slide 2 (intro): slides/intro.md:7 [title]: "[Widget] world"' in lines
    # deck.py's author text, named by its slide, hidden ones by id.
    assert 'slide 1 (drawn): deck.py: "[Widget]s"' in lines
    assert 'hidden slide plain: deck.py: "[Widget]s again"' in lines
    assert lines[-1] == "9 matches on 4 slides"


def test_find_options(project: Path) -> None:
    out = _ok(project, "find", "Widgets", "--case", "--word")
    assert out.splitlines()[-1] == "3 matches on 3 slides"
    out = _ok(project, "find", r"widgets?\b", "--regex", "-s", "3")
    assert out.splitlines() == [
        'slide 3 (end): slides/end.md:3 [content]: "No [widgets] here? Widgets!"',
        'slide 3 (end): slides/end.md:3 [content]: "No widgets here? [Widgets]!"',
        "2 matches on 1 slide",
    ]
    assert _ok(project, "find", "nothing like it").strip() == "no matches"
    data = cast(
        "list[dict[str, object]]", json.loads(_ok(project, "find", "Blue", "--json"))
    )
    assert data[0]["file"] == "slides/drawn.svg"
    assert data[0]["slides"] == [{"number": 1, "id": "drawn"}]


def test_find_on_one_slide_keeps_to_its_deck_text(project: Path) -> None:
    out = _ok(project, "find", "widgets", "-s", "intro")
    assert "deck.py" in out  # its own title
    assert "Widgets again" not in out and "[Widgets]" not in out
    assert "drawn" not in out


def test_replace_everywhere_in_one_step(project: Path) -> None:
    out = _ok(project, "replace", "widget", "gadget")
    assert 'Done  Replace "widget" with "gadget"' in out
    assert "Replaced  9 matches" in out
    assert "Gadget world" not in (project / "slides" / "intro.md").read_text()
    assert "gadget world" in (project / "slides" / "intro.md").read_text()
    assert ">Blue gadgets<" in (project / "slides" / "drawn.svg").read_text()
    deck = load_deck(project / "deck.py")
    assert [s.title for s in deck.slides][:2] == ["gadgets", "More gadgets"]


def test_replace_on_one_slide_with_a_pattern(project: Path) -> None:
    out = _ok(project, "replace", r"(\w+) widgets", r"\1 gizmos", "--regex", "-s", "2")
    assert "on slide 2 (intro)" in out
    assert "Replaced  2 matches" in out
    assert "More gizmos" in (project / "deck.py").read_text()
    assert "about gizmos" in (project / "slides" / "intro.md").read_text()
    assert "Blue widgets" in (project / "slides" / "drawn.svg").read_text()


def test_dry_run_writes_nothing(project: Path) -> None:
    before = (project / "deck.py").read_text()
    out = _ok(project, "replace", r"(\w+) widgets", r"\1 gizmos", "-r", "--dry-run")
    assert (
        'slide 1 (drawn): slides/drawn.svg #label: "[Blue widgets -> Blue gizmos]"'
        in (out)
    )
    assert out.splitlines()[-1].endswith("would be replaced")
    assert (project / "deck.py").read_text() == before


def test_nothing_to_replace_fails(project: Path) -> None:
    result = _run(project, "replace", "nothing like it", "x")
    assert result.exit_code == 1
    assert "no matches" in result.output


def test_a_search_of_one_slide_only_touches_its_deck_text(project: Path) -> None:
    # The session's own rule, which the editor's "This slide" uses too.
    session = EditorSession(project / "deck.py")
    deck = load_deck(project / "deck.py")
    request: dict[str, object] = {
        "query": "widgets",
        "files": [],
        "deckSlide": 1,
    }
    hits = cast(
        "list[dict[str, object]]",
        session.apply({**request, "action": "find"}, deck)["hits"],
    )
    assert [h["match"] for h in hits] == ["widgets"]
    session.apply({**request, "action": "replace", "replacement": "things"}, deck)
    text = (project / "deck.py").read_text()
    assert 'title="More things"' in text
    assert 'title="Widgets"' in text


def test_through_the_server_it_is_one_undoable_agent_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, _ = served
    before = {p: p.read_bytes() for p in project.rglob("*") if p.is_file() and p.suffix}
    out = _ok(project, "replace", "widget", "gadget")
    assert "Ctrl+Z in the editor" in out
    assert [s.label for s in session.history.done] == [
        'Agent: Replace "widget" with "gadget"'
    ]
    session.apply({"action": "undo"}, load_deck(project / "deck.py"))
    for path, data in before.items():
        if path.exists() and ".inkflow" not in path.parts:
            assert path.read_bytes() == data, path
