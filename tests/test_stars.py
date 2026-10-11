"""Starred slides (``inkflow.editor.stars``): the author's own marks, kept by
slide id beside the editor's context, outside the deck and its builds."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner
from watchfiles import Change

from inkflow.cli import main
from inkflow.editor.model import build_model
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.stars import (
    follow,
    read_stars,
    set_starred,
    stars_path,
    write_stars,
)
from inkflow.manifest import Deck
from inkflow.pipeline import process_deck, slide_ids
from inkflow.server import (
    _WatchFilter,  # pyright: ignore[reportPrivateUsage]
    load_deck,
)

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
                Slide("plain", md="shared.md"),
                Slide("plain", md="shared.md", title="Again"),
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
    for name in ("intro", "shared", "hidden", "end"):
        text = f"# {name.title()}\n"
        (tmp_path / "slides" / f"{name}.md").write_text(text, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _deck(project: Path) -> Deck:
    return load_deck(project / "deck.py")


def _ids(project: Path) -> list[str]:
    return slide_ids([s for s in _deck(project).slides if s.visible])


def _apply(
    session: EditorSession, project: Path, **request: object
) -> dict[str, object]:
    """One request against the deck as it is on disk now (as after a rebuild)."""
    session.built_hash = None
    return session.apply({**request, "_local": True}, _deck(project))


# ── The file ─────────────────────────────────────────────────────────────────


def test_stars_are_kept_by_id_in_the_editors_own_folder(tmp_path: Path) -> None:
    assert read_stars(tmp_path) == []
    assert write_stars(tmp_path, ["b", "a", "b"]) == ["b", "a"]
    assert stars_path(tmp_path) == tmp_path / ".inkflow" / "stars.json"
    assert json.loads(stars_path(tmp_path).read_text()) == {"starred": ["b", "a"]}
    # The folder ignores itself in git: the stars are this working copy's.
    assert (tmp_path / ".inkflow" / ".gitignore").read_text() == "*\n"
    assert read_stars(tmp_path) == ["b", "a"]


def test_a_file_that_cannot_be_read_is_no_stars(tmp_path: Path) -> None:
    (tmp_path / ".inkflow").mkdir()
    for text in ("not json", "[1, 2]", '{"starred": "a"}', '{"other": []}'):
        _ = stars_path(tmp_path).write_text(text, encoding="utf-8")
        assert read_stars(tmp_path) == []
    _ = stars_path(tmp_path).write_text('{"starred": ["a", 3, "", "a"]}')
    assert read_stars(tmp_path) == ["a"]


def test_starring_drops_the_stars_of_slides_that_are_gone(tmp_path: Path) -> None:
    _ = write_stars(tmp_path, ["gone", "a"])
    assert set_starred(tmp_path, ["b"], True, known=["a", "b", "c"]) == ["a", "b"]
    assert set_starred(tmp_path, ["a", "c"], False, known=["a", "b", "c"]) == ["b"]
    assert set_starred(tmp_path, ["b"], True, known=["a", "b", "c"]) == ["b"]


def test_follow_renames_all_at_once_and_new_slides_start_without(
    tmp_path: Path,
) -> None:
    _ = write_stars(tmp_path, ["shared", "end", "old"])
    # Two slides swapping ids keep their own stars; a new slide that takes a
    # starred id's name does not inherit the star.
    follow(tmp_path, {"shared": "shared-2", "shared-2": "shared"}, created=["old"])
    assert read_stars(tmp_path) == ["shared-2", "end"]
    before = stars_path(tmp_path).stat().st_mtime_ns
    follow(tmp_path, {"intro": "start"})  # no star concerned: nothing written
    assert stars_path(tmp_path).stat().st_mtime_ns == before


# ── The session ──────────────────────────────────────────────────────────────


def test_starring_persists_and_changes_no_file_of_the_deck(project: Path) -> None:
    deck_before = (project / "deck.py").read_bytes()
    built_before = process_deck(_deck(project), project, project / "deck.py")
    session = EditorSession(project / "deck.py")
    result = _apply(session, project, action="star", slides=[0, 4])
    assert result["stars"] == ["intro", "end"] and result["starred"] is True
    # No History step, no change to report, nothing of the deck written.
    assert "changes" not in result
    assert session.history_state()["canUndo"] is False
    assert (project / "deck.py").read_bytes() == deck_before
    assert process_deck(_deck(project), project, project / "deck.py") == built_before
    # Another session (the editor restarted) finds them.
    again = EditorSession(project / "deck.py")
    toggled = _apply(again, project, action="star", slides=[0])
    assert toggled["starred"] is False and toggled["stars"] == ["end"]
    # Asked for several: on unless every one is starred already.
    assert _apply(again, project, action="star", slides=[0, 4])["starred"] is True
    assert _apply(again, project, action="star", slides=[0, 4])["starred"] is False
    assert read_stars(project) == []


def test_a_hidden_slide_has_no_id_to_star(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    with pytest.raises(EditError, match="hidden slide"):
        _ = _apply(session, project, action="star", slides=[3])


def test_the_watcher_does_not_see_a_star(project: Path) -> None:
    watching = _WatchFilter(project)
    assert not watching(Change.modified, str(stars_path(project)))
    assert watching(Change.modified, str(project / "slides" / "intro.md"))


def test_stars_stay_on_their_slides_through_insert_delete_and_reorder(
    project: Path,
) -> None:
    session = EditorSession(project / "deck.py")
    assert _ids(project) == ["intro", "shared", "shared-2", "end"]
    _ = _apply(session, project, action="star", slides=[2, 4])
    assert read_stars(project) == ["shared-2", "end"]

    # Insert a slide before them: ids, not numbers, hold the stars.
    _ = _apply(
        session, project, action="slide", op="new", after=0, layout="plain", name="new"
    )
    assert _ids(project) == ["intro", "new", "shared", "shared-2", "end"]
    assert read_stars(project) == ["shared-2", "end"]

    # Reorder: the second "shared" slide moves in front of the first, which
    # swaps their inferred ids. The star stays on the slide that had it.
    _ = _apply(session, project, action="slide", op="move", **{"from": 3, "to": 2})
    assert _ids(project) == ["intro", "new", "shared", "shared-2", "end"]
    assert read_stars(project) == ["shared", "end"]
    # Undo puts the slides, and the star, back.
    _ = _apply(session, project, action="undo")
    assert read_stars(project) == ["shared-2", "end"]
    _ = _apply(session, project, action="redo")
    assert read_stars(project) == ["shared", "end"]

    # Delete the unstarred slide of that pair: the starred one is now the
    # only "shared".
    _ = _apply(session, project, action="slide", op="delete", slide=3)
    assert _ids(project) == ["intro", "new", "shared", "end"]
    assert read_stars(project) == ["shared", "end"]

    # Delete a starred slide and bring it back: its star is still there.
    _ = _apply(session, project, action="slide", op="delete", slide=4)
    assert _ids(project) == ["intro", "new", "shared"]
    _ = _apply(session, project, action="undo")
    assert _ids(project) == ["intro", "new", "shared", "end"]
    model = build_model(
        _deck(project),
        project / "deck.py",
        process_deck(_deck(project), project, project / "deck.py", editor=True),
    )
    assert model["stars"] == ["shared", "end"]


def test_a_star_follows_a_renamed_id_and_renamed_files(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    _ = _apply(session, project, action="star", slides=[0, 4])
    _ = _apply(session, project, action="slide", op="id", slide=0, id="opening")
    assert read_stars(project) == ["opening", "end"]
    _ = _apply(session, project, action="rename", slide=4, stem="closing")
    assert _ids(project)[-1] == "closing"
    assert read_stars(project) == ["opening", "closing"]
    _ = _apply(session, project, action="undo")
    assert read_stars(project) == ["opening", "end"]


def test_a_new_slide_does_not_inherit_a_deleted_slides_star(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    _ = _apply(session, project, action="slide", op="new", after=4, layout="plain")
    new_id = _ids(project)[-1]
    _ = _apply(session, project, action="star", slides=[5])
    assert read_stars(project) == [new_id]
    _ = _apply(session, project, action="slide", op="delete", slide=5, files=True)
    assert read_stars(project) == [new_id]  # kept, in case the delete is undone
    _ = _apply(session, project, action="slide", op="new", after=4, layout="plain")
    assert _ids(project)[-1] == new_id
    assert read_stars(project) == []


# ── The model and the command line ───────────────────────────────────────────


def test_the_model_lists_the_starred_slides_in_deck_order(project: Path) -> None:
    _ = write_stars(project, ["end", "nowhere", "intro"])
    deck = _deck(project)
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    model = build_model(deck, project / "deck.py", slides)
    assert model["stars"] == ["intro", "end"]


def _run(project: Path, *args: str) -> str:
    result = CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])
    assert result.exit_code == 0, result.output
    return result.output


def test_outline_marks_starred_slides_and_lists_only_them(project: Path) -> None:
    assert "STARRED" not in _run(project, "outline")
    out = _run(project, "slide", "star", "2", "end")
    assert "shared" in out and "end" in out
    assert read_stars(project) == ["shared", "end"]
    outline = _run(project, "outline")
    assert "2 starred" in outline.splitlines()[0]
    starred = [line for line in outline.splitlines() if "STARRED" in line]
    assert [line.split()[1] for line in starred] == ["shared", "end"]
    only = _run(project, "outline", "--starred")
    heads = [line for line in only.splitlines() if line[:1].isdigit()]
    assert [line.split()[1] for line in heads] == ["shared", "end"]
    data = cast(
        "dict[str, object]",
        json.loads(_run(project, "outline", "--starred", "--json")),
    )
    slides = cast("list[dict[str, object]]", data["slides"])
    assert [(s["id"], s["starred"]) for s in slides] == [
        ("shared", True),
        ("end", True),
    ]
    whole = cast("dict[str, object]", json.loads(_run(project, "outline", "--json")))
    marked = [s["starred"] for s in cast("list[dict[str, object]]", whole["slides"])]
    assert marked == [False, True, False, False, True]
    _ = _run(project, "slide", "unstar", "end")
    assert read_stars(project) == ["shared"]
    assert "no starred slides" not in _run(project, "outline", "--starred")
    _ = _run(project, "slide", "unstar", "2")
    assert "no starred slides" in _run(project, "outline", "--starred")
