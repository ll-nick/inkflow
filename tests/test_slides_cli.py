"""``inkflow slide``: slide-list edits from the command line, applied to the
files directly or through the server that has the deck open (one undoable
step in its editor's History)."""

from __future__ import annotations

import asyncio
import json
import os
import textwrap
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner, Result
from websockets.asyncio.server import serve as ws_serve
from websockets.sync.client import connect

from inkflow import instances, server
from inkflow.cli import main
from inkflow.edit import NO_EDIT_COMMANDS
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import file_hash
from inkflow.logging import resolve_levels
from inkflow.server import load_deck
from inkflow.tui import LiveUI

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="800"/>
    </svg>
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                # The opening slide.
                Slide("drawn.svg", notes="notes/drawn.md"),
                Slide("plain", md="intro.md", notes="notes/intro.md"),
                Slide("plain", md="shared.md"),  # shares its text
                Slide("plain", md="shared.md", visible=False),
                # The closing slide.
                Slide("plain", md="end.md"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts", "notes", "ink"):
        (tmp_path / sub).mkdir()
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    for name, text in {
        "intro": "# Intro\n\nSee [the end](slide:end).\n",
        "shared": "# Shared\n",
        "end": "# The end\n\nBack to [intro](slide:intro).\n",
    }.items():
        (tmp_path / "slides" / f"{name}.md").write_text(text, encoding="utf-8")
    for name in ("drawn", "intro"):
        (tmp_path / "notes" / f"{name}.md").write_text(f"{name} notes\n", "utf-8")
    for name in ("drawn", "intro", "end"):
        (tmp_path / "ink" / f"{name}.svg").write_text(DRAWN, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    """Offline unless a test starts a server: never find a real one."""

    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _run(project: Path, *args: str, input: str | None = None) -> Result:
    result = CliRunner().invoke(
        main, ["slide", *args, "--deck", str(project / "deck.py")], input=input
    )
    return result


def _ok(project: Path, *args: str, input: str | None = None) -> str:
    result = _run(project, *args, input=input)
    assert result.exit_code == 0, result.output
    return result.output


def _srcs(project: Path) -> list[tuple[str, str | None]]:
    deck = load_deck(project / "deck.py")
    return [(s.src, s.md if isinstance(s.md, str) else None) for s in deck.slides]


# ── Offline: the files change directly ─────────────────────────────────────────


def test_delete_takes_the_slides_own_files_along(project: Path) -> None:
    out = _ok(project, "delete", "2")
    assert "Delete slide 2 (intro)" in out
    assert "slides/intro.md" in out and "notes/intro.md" in out
    assert not (project / "slides" / "intro.md").exists()
    assert not (project / "notes" / "intro.md").exists()
    assert not (project / "ink" / "intro.svg").exists()
    # The shared layout and everything of the other slides stay.
    assert (project / "layouts" / "plain.svg").exists()
    assert (project / "ink" / "end.svg").exists()
    code = (project / "deck.py").read_text(encoding="utf-8")
    assert "intro.md" not in code
    assert "# The opening slide." in code and "# The closing slide." in code
    assert "# shares its text" in code


def test_delete_keeps_files_another_slide_uses(project: Path) -> None:
    _ok(project, "delete", "3")
    # shared.md is still the hidden slide's text.
    assert (project / "slides" / "shared.md").exists()
    _ok(project, "delete", "1")
    assert not (project / "slides" / "drawn.svg").exists()
    assert not (project / "notes" / "drawn.md").exists()


def test_delete_can_keep_the_files(project: Path) -> None:
    out = _ok(project, "delete", "2", "1", "--keep-files")
    assert "Delete slide 1 (drawn), slide 2 (intro)" in out
    assert (project / "slides" / "intro.md").exists()
    assert (project / "slides" / "drawn.svg").exists()
    assert [src for src, _ in _srcs(project)] == ["plain", "plain", "plain"]


def test_numbers_skip_hidden_slides_and_ids_reach_them(project: Path) -> None:
    # Number 4 is the last slide: the hidden one has no number.
    _ok(project, "delete", "4")
    assert _srcs(project)[-1] == ("plain", "shared.md")
    # A hidden slide goes by its id, numbered on past a shown slide's.
    out = _ok(project, "show", "shared-2")
    assert "Show hidden slide shared-2" in out
    assert all(s.visible for s in load_deck(project / "deck.py").slides)


def test_unknown_slides_are_refused(project: Path) -> None:
    result = _run(project, "delete", "9")
    assert result.exit_code != 0 and "no slide 9" in result.output
    result = _run(project, "delete", "nope")
    assert result.exit_code != 0 and "no slide with id 'nope'" in result.output


def test_a_refused_edit_exits_with_the_reason(project: Path) -> None:
    result = _run(project, "delete", "1", "2", "3", "4", "shared-2")
    assert result.exit_code != 0
    assert "at least one slide" in result.output


def test_add_builds_on_a_layout_with_its_text(project: Path) -> None:
    out = _ok(
        project,
        "add",
        "--layout",
        "plain",
        "--after",
        "1",
        "--id",
        "agenda-new",
        "--title",
        "Agenda",
        "--md",
        "-",
        input="- one\n- two\n",
    )
    assert "slide 2 (agenda-new) is the new one" in out
    svg = (project / "slides" / "agenda-new.svg").read_text(encoding="utf-8")
    assert 'inkflow:parent="plain"' in svg
    md = (project / "slides" / "agenda-new.md").read_text(encoding="utf-8")
    assert md == "# Agenda\n\n- one\n- two\n"
    assert _srcs(project)[1] == ("agenda-new.svg", "agenda-new.md")


def test_add_first_and_like_another_slide(project: Path) -> None:
    _ok(project, "add", "--like", "intro", "--after", "0", "--id", "opening")
    assert _srcs(project)[0] == ("opening.svg", None)
    svg = (project / "slides" / "opening.svg").read_text(encoding="utf-8")
    assert 'inkflow:parent="plain"' in svg


def test_duplicate_copies_the_slides_files(project: Path) -> None:
    out = _ok(project, "duplicate", "2")
    assert "slide 3 (intro-copy) is the new one" in out
    assert (project / "slides" / "intro-copy.md").exists()
    assert (project / "notes" / "intro-copy.md").exists()
    assert (project / "ink" / "intro-copy.svg").exists()
    assert (project / "ink" / "intro.svg").exists()


def test_move_puts_the_slide_at_that_number(project: Path) -> None:
    _ok(project, "move", "1", "--to", "3")
    shown = [s for s in load_deck(project / "deck.py").slides if s.visible]
    assert [s.md for s in shown] == ["intro.md", "shared.md", None, "end.md"]
    _ok(project, "move", "end", "--to", "1")
    assert _srcs(project)[0] == ("plain", "end.md")
    out = _ok(project, "move", "1", "--to", "1")
    assert "Unchanged" in out


def test_hide_and_show(project: Path) -> None:
    _ok(project, "hide", "2")
    assert load_deck(project / "deck.py").slides[1].visible is False
    out = _ok(project, "hide", "intro")
    assert "already hidden" in out
    _ok(project, "show", "intro")
    assert load_deck(project / "deck.py").slides[1].visible is True


def test_rename_moves_the_ink_and_rewrites_links(project: Path) -> None:
    out = _ok(project, "rename", "end", "finale")
    assert "ink/end.svg -> ink/finale.svg" in out
    assert "Relinked" in out
    assert load_deck(project / "deck.py").slides[4].id == "finale"
    intro = (project / "slides" / "intro.md").read_text(encoding="utf-8")
    assert "slide:finale" in intro
    result = _run(project, "rename", "finale", "intro")
    assert result.exit_code != 0 and "already called 'intro'" in result.output


def test_title_sets_and_clears(project: Path) -> None:
    _ok(project, "title", "1", "Opening")
    assert load_deck(project / "deck.py").slides[0].title == "Opening"
    _ok(project, "title", "1", "")
    assert load_deck(project / "deck.py").slides[0].title is None


# ── Through the server that has the deck open ──────────────────────────────────


class _UI:
    def refresh(self) -> None:
        pass

    def set_building(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, _trace: str) -> None:
        pass


@pytest.fixture
def served(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[EditorSession, int]]:
    """The deck served as `inkflow edit` would (WebSocket, watcher, rebuild),
    on a thread; yields its session and WebSocket port."""
    deck_path = project / "deck.py"
    session = EditorSession(deck_path)
    ui = cast("LiveUI", cast("object", _UI()))
    levels = resolve_levels()
    started = threading.Event()
    port: list[int] = []
    loop = asyncio.new_event_loop()
    stop = asyncio.Event()

    async def run() -> None:
        server._editor["session"] = session  # pyright: ignore[reportPrivateUsage]
        await server.rebuild(deck_path, ui, levels)
        handler = server.make_ws_handler(ui, NO_EDIT_COMMANDS, session)
        async with ws_serve(handler, "127.0.0.1", 0) as ws:
            port.append(
                cast("tuple[str, int]", next(iter(ws.sockets)).getsockname())[1]
            )
            watch = asyncio.create_task(
                server._watch(deck_path, ui, asyncio.Lock(), levels)  # pyright: ignore[reportPrivateUsage]
            )
            await asyncio.sleep(0.3)  # the watcher is watching
            started.set()
            await stop.wait()
            watch.cancel()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    record = instances.Instance(os.getpid(), "127.0.0.1", 0, port[0], str(deck_path))

    def serving(_deck: Path, _exclude_pid: int | None = None) -> instances.Instance:
        return record

    monkeypatch.setattr(instances, "serving", serving)
    try:
        yield session, port[0]
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()
        server._editor.update(  # pyright: ignore[reportPrivateUsage]
            {"session": None, "deck": None, "model": None, "failed_hash": None}
        )
        server._editor["clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["ws_clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["error"] = None  # pyright: ignore[reportPrivateUsage]


def test_through_the_server_the_edit_is_an_undoable_agent_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, port = served
    with connect(f"ws://127.0.0.1:{port}", proxy=None, max_size=None) as editor:
        editor.send(json.dumps({"type": "hello", "role": "editor"}))
        out = _ok(project, "delete", "2")
        assert "Ctrl+Z in the editor" in out
        assert not (project / "slides" / "intro.md").exists()
        assert [s.label for s in session.history.done] == [
            "Agent: Delete slide 2 (intro)"
        ]
        # Every open editor hears of it, with the step its Undo button names.
        while True:
            msg = cast("dict[str, object]", json.loads(editor.recv(timeout=10)))
            if msg["type"] == "agent-edit":
                break
        assert msg["label"] == "Agent: Delete slide 2 (intro)"
        assert msg["undoLabel"] == msg["label"]
        step = msg["step"]
        # The next command waits for nothing: the server built the last one.
        _ok(project, "move", "1", "--to", "3")
        assert len(session.history.done) == 2
    # The editor's Undo button on the first edit: only while it is the last.
    deck = load_deck(project / "deck.py")
    with pytest.raises(EditError, match="other edits came after"):
        session.apply({"action": "undo", "step": step}, deck)
    session.apply({"action": "undo"}, deck)
    session.apply({"action": "undo", "step": step}, deck)
    assert (project / "slides" / "intro.md").exists()
    assert (project / "notes" / "intro.md").exists()
    assert (project / "ink" / "intro.svg").exists()
    assert (project / "deck.py").read_text(encoding="utf-8") == DECK


def test_a_request_for_another_build_of_the_deck_is_refused(project: Path) -> None:
    # Slide numbers resolved against one deck.py mean nothing for another.
    session = EditorSession(project / "deck.py")
    session.built_hash = file_hash((project / "deck.py").read_bytes())
    request: dict[str, object] = {
        "action": "slide",
        "op": "delete",
        "slide": 0,
        "deckHash": "stale",
    }
    with pytest.raises(EditError, match="changed since the last build"):
        session.apply(request, load_deck(project / "deck.py"))
    assert (project / "deck.py").read_text(encoding="utf-8") == DECK
    assert not session.history.done


# ── Sections ──────────────────────────────────────────────────────────────────


def _sections(project: Path) -> list[tuple[str, list[str | None]]]:
    deck = load_deck(project / "deck.py")
    out: list[tuple[str, list[str | None]]] = []
    for section, span in zip(deck.sections, deck.section_ranges(), strict=True):
        mds = [deck.slides[i].md for i in span]
        out.append((section.name, [md if isinstance(md, str) else None for md in mds]))
    return out


def test_sections_from_the_command_line(project: Path) -> None:
    out = _ok(project, "section", "add", "Middle", "--at", "intro")
    assert "Add section Middle at slide 2 (intro)" in out
    _ok(project, "section", "add", "End", "--at", "4")
    assert _sections(project) == [
        ("Middle", ["intro.md", "shared.md", "shared.md"]),
        ("End", ["end.md"]),
    ]
    # Comments stay with their slides.
    text = (project / "deck.py").read_text(encoding="utf-8")
    assert (
        '# The closing slide.\n                    Slide("plain", md="end.md")' in text
    )
    # Sections by name (any case) or number.
    _ok(project, "section", "rename", "middle", "Body")
    _ok(project, "section", "move", "2", "--before", "body")
    assert [name for name, _ in _sections(project)] == ["End", "Body"]
    _ok(project, "section", "move", "End", "--to", "2")
    assert [name for name, _ in _sections(project)] == ["Body", "End"]
    # A slide into a section: at its end, or at a number within it.
    out = _ok(project, "move", "1", "--section", "end")
    assert "into section 'End'" in out
    assert _sections(project)[1] == ("End", ["end.md", None])
    _ok(project, "move", "drawn", "--to", "1", "--section", "Body")
    assert _sections(project)[0][1][0] is None
    # Removing a section keeps its slides (they join the one before)...
    _ok(project, "section", "remove", "End")
    assert _sections(project) == [
        ("Body", [None, "intro.md", "shared.md", "shared.md", "end.md"])
    ]
    # ...unless they go too, with their files.
    _ok(project, "section", "add", "Last", "--at", "end")
    _ok(project, "section", "remove", "Last", "--with-slides")
    assert not (project / "slides" / "end.md").exists()
    assert [name for name, _ in _sections(project)] == ["Body"]


def test_section_references_are_checked(project: Path) -> None:
    result = _run(project, "section", "rename", "Nope", "x")
    assert result.exit_code != 0 and "no sections" in result.output
    _ok(project, "section", "add", "Part", "--at", "2")
    _ok(project, "section", "add", "Part", "--at", "3")
    result = _run(project, "section", "rename", "part", "x")
    assert result.exit_code != 0 and "2 sections are called 'part'" in result.output
    _ok(project, "section", "rename", "2", "Second")
    result = _run(project, "move", "1")
    assert result.exit_code != 0 and "--to, --section" in result.output


def test_section_commands_through_the_server_are_agent_steps(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, _ = served
    _ok(project, "section", "add", "Body", "--at", "2")
    _ok(project, "move", "1", "--section", "Body")
    assert [s.label for s in session.history.done] == [
        "Agent: Add section Body at slide 2 (intro)",
        "Agent: Move slide 1 (drawn) into section 'Body'",
    ]
    session.apply({"action": "undo"}, load_deck(project / "deck.py"))
    session.apply({"action": "undo"}, load_deck(project / "deck.py"))
    assert (project / "deck.py").read_text(encoding="utf-8") == DECK
