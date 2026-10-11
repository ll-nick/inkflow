"""Review comments (``inkflow.editor.comments``): threads on slides, kept by
slide id beside the editor's context, outside the deck and its builds."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.editor import comments
from inkflow.editor.outline import build_outline, format_outline
from inkflow.editor.session import EditError, EditorSession
from inkflow.manifest import Deck
from inkflow.pipeline import process_deck
from inkflow.server import load_deck

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="800"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("plain", md="intro.md"),
                Slide("plain", md="hidden.md", visible=False),
                Slide("plain", md="end.md"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts"):
        (tmp_path / sub).mkdir()
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    for name in ("intro", "hidden", "end"):
        (tmp_path / "slides" / f"{name}.md").write_text(f"# {name}\n", "utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _deck(project: Path) -> Deck:
    return load_deck(project / "deck.py")


def _apply(
    session: EditorSession, project: Path, **request: object
) -> dict[str, object]:
    return session.apply({"action": "comment", **request}, _deck(project))


def _threads(result: dict[str, object]) -> list[dict[str, object]]:
    return cast("list[dict[str, object]]", result["comments"])


def test_a_thread_is_added_answered_resolved_and_deleted(project: Path) -> None:
    deck_before = (project / "deck.py").read_bytes()
    session = EditorSession(project / "deck.py")
    added = _apply(
        session,
        project,
        op="add",
        slide=2,
        x=100,
        y=200.25,
        text="  Bigger title?  ",
        _author="guest:a",
        _name="Ana",
        _role="editor",
    )
    [thread] = _threads(added)
    assert thread["slide"] == "end"
    assert (thread["x"], thread["y"]) == (100.0, 200.2)
    messages = cast("list[dict[str, object]]", thread["messages"])
    assert messages[0]["text"] == "Bigger title?"
    assert messages[0]["name"] == "Ana"
    # No History step, nothing of the deck written.
    assert "changes" not in added
    assert session.history_state()["canUndo"] is False
    assert (project / "deck.py").read_bytes() == deck_before

    thread_id = added["thread"]
    replied = _apply(
        session, project, op="reply", thread=thread_id, text="Done", _local=True
    )
    assert len(cast("list[object]", _threads(replied)[0]["messages"])) == 2
    resolved = _apply(session, project, op="resolve", thread=thread_id, on=True)
    assert _threads(resolved)[0]["resolved"] is True
    # Someone else's thread is theirs (or the owner's) to delete.
    with pytest.raises(EditError, match="only who started"):
        _ = _apply(session, project, op="delete", thread=thread_id, _author="guest:b")
    gone = _apply(session, project, op="delete", thread=thread_id, _role="owner")
    assert _threads(gone) == []


def test_comments_need_text_and_a_shown_slide(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    with pytest.raises(EditError, match="write a comment"):
        _ = _apply(session, project, op="add", slide=0, text="  ")
    with pytest.raises(EditError, match="hidden slide"):
        _ = _apply(session, project, op="add", slide=1, text="Hi")
    with pytest.raises(EditError, match="gone"):
        _ = _apply(session, project, op="reply", thread="nope", text="Hi")


def test_threads_follow_their_slide_and_hide_with_it(project: Path) -> None:
    thread = comments.add(project, "end", "Hi", "owner", "Me", target="zone-title")
    comments.follow(project, {"end": "finale", "intro": "start"})
    assert comments.read_threads(project)[0]["slide"] == "finale"
    assert comments.visible(comments.read_threads(project), ["start"]) == []
    assert comments.open_count(comments.read_threads(project)) == 1
    assert thread["target"] == "zone-title"


def test_outline_and_the_cli_list_the_open_ones(project: Path) -> None:
    comments.add(project, "end", "Bigger\\ntitle?", "owner", "Me", target="zone-title")
    done = comments.add(project, "intro", "Typo", "owner", "Me")
    comments.resolve(project, done["id"], True)
    deck = _deck(project)
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    text = format_outline(build_outline(deck, project / "deck.py", slides))
    assert "2. end" in text and "COMMENTS 1" in text
    assert "  comment @zone-title Me: Bigger\\ntitle?" in text
    assert "Typo" not in text

    runner = CliRunner()
    out = runner.invoke(main, ["comments", "--deck", str(project / "deck.py")])
    assert out.exit_code == 0, out.output
    assert "2. end @zone-title" in out.output
    assert "Typo" not in out.output
    every = runner.invoke(
        main, ["comments", "--all", "--json", "--deck", str(project / "deck.py")]
    )
    data = cast("list[dict[str, object]]", json.loads(every.output))
    assert [(t["slide"], t["number"], t["resolved"]) for t in data] == [
        ("intro", 1, True),
        ("end", 2, False),
    ]
