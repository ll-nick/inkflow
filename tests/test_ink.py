"""Ink: per-slide stroke files, their composition, and the paths that write them."""

from __future__ import annotations

import asyncio
import json
import textwrap
from collections.abc import AsyncIterator
from pathlib import Path
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from inkflow import server
from inkflow.clean import clean_inkscape_svg
from inkflow.edit import NO_EDIT_COMMANDS
from inkflow.editor.model import build_model
from inkflow.editor.session import EditError, EditorSession
from inkflow.ink import (
    INK_CLASS,
    InkError,
    Stroke,
    add_strokes,
    erase_strokes,
    ink_path,
    stroke_ids,
)
from inkflow.manifest import Deck, Slide
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg
from inkflow.tui import LiveUI

SVG_NS = "http://www.w3.org/2000/svg"
BOX = (0.0, 0.0, 1920.0, 1080.0)

SLIDE = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
    </svg>
""")

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
    </svg>
""")

OVERLAY = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="logo" x="1800" y="1000" width="40" height="40"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Overlay, Slide


    def main() -> Deck:
        return Deck(
            overlays=[Overlay("chrome")],
            slides=[
                Slide("drawn.svg"),
                Slide("plain", zones={"title": "One"}),
                Slide("plain", zones={"title": "Two"}),
                Slide("drawn.svg", id="named", ink="notes/named-ink.svg"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts", "overlays", "notes"):
        (tmp_path / sub).mkdir()
    (tmp_path / "slides" / "drawn.svg").write_text(SLIDE, encoding="utf-8")
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "overlays" / "chrome.svg").write_text(OVERLAY, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _stroke(stroke_id: str = "ink-a1", **fields: object) -> dict[str, object]:
    return {
        "id": stroke_id,
        "d": "M10 10Q20 20 30 30 40 10 50 50Z",
        "fill": "#ff0000",
        "tool": "pen",
        "size": 6,
        **fields,
    }


def _write_ink(path: Path, *ids: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = add_strokes(None, [Stroke.from_json(_stroke(i)) for i in ids], BOX)
    path.write_bytes(data)


def _build(project: Path, *, editor: bool = False):
    deck = load_deck(project / "deck.py")
    return deck, process_deck(deck, project, project / "deck.py", editor=editor)


# ── Where a slide's ink lives ─────────────────────────────────────────────────


def test_ink_file_is_named_after_the_slide_id(tmp_path: Path) -> None:
    assert ink_path(Slide("a"), "intro", tmp_path) == tmp_path / "ink" / "intro.svg"


def test_explicit_ink_path_is_relative_to_the_project(tmp_path: Path) -> None:
    slide = Slide("a", ink="notes/x.svg")
    assert ink_path(slide, "intro", tmp_path) == tmp_path / "notes" / "x.svg"


def test_an_id_cannot_name_a_file_outside_the_ink_folder(tmp_path: Path) -> None:
    path = ink_path(Slide("a"), "../../etc/passwd", tmp_path)
    assert path.parent == tmp_path / "ink"


# ── Composition ───────────────────────────────────────────────────────────────


def test_ink_is_painted_on_top_after_the_overlays(project: Path) -> None:
    _write_ink(project / "ink" / "drawn.svg", "ink-a1", "ink-b2")
    _, slides = _build(project)
    root = parse_svg(slides[0]["svg"])
    last = root[-1]
    assert last.tag == f"{{{SVG_NS}}}g" and last.get("class") == INK_CLASS
    assert [el.get("id") for el in last] == ["ink-a1", "ink-b2"]
    ids = [el.get("id") for el in root.iter()]
    assert ids.index("logo") < ids.index("ink-a1")


def test_a_slide_without_an_ink_file_has_no_ink_group(project: Path) -> None:
    _, slides = _build(project)
    assert all(INK_CLASS not in s["svg"] for s in slides)


def test_ink_follows_the_deduplicated_slide_id(project: Path) -> None:
    _write_ink(project / "ink" / "plain-2.svg", "ink-second")
    _, slides = _build(project)
    assert [s["id"] for s in slides[:3]] == ["drawn", "plain", "plain-2"]
    assert "ink-second" not in slides[1]["svg"]
    assert "ink-second" in slides[2]["svg"]


def test_slide_ink_parameter_names_the_file(project: Path) -> None:
    _write_ink(project / "notes" / "named-ink.svg", "ink-named")
    _write_ink(project / "ink" / "named.svg", "ink-ignored")
    _, slides = _build(project)
    assert "ink-named" in slides[3]["svg"]
    assert "ink-ignored" not in slides[3]["svg"]


def test_a_broken_ink_file_loses_the_ink_not_the_slide(
    project: Path, caplog: pytest.LogCaptureFixture
) -> None:
    (project / "ink").mkdir()
    (project / "ink" / "drawn.svg").write_text("<svg", encoding="utf-8")
    _, slides = _build(project)
    assert 'id="box"' in slides[0]["svg"] and INK_CLASS not in slides[0]["svg"]
    assert "ink not shown" in caplog.text


def test_ink_drawn_on_another_canvas_is_stretched_onto_this_one(
    project: Path,
) -> None:
    path = project / "ink" / "drawn.svg"
    path.parent.mkdir()
    path.write_bytes(
        add_strokes(None, [Stroke.from_json(_stroke())], (0.0, 0.0, 960.0, 540.0))
    )
    _, slides = _build(project)
    group = parse_svg(slides[0]["svg"])[-1]
    assert group.get("transform") == "matrix(2 0 0 2 0 0)"


def test_an_editor_build_names_the_ink_file_and_stamps_its_strokes(
    project: Path,
) -> None:
    _write_ink(project / "ink" / "drawn.svg", "ink-a1")
    deck, slides = _build(project, editor=True)
    edit = slides[0].get("edit")
    assert edit is not None
    assert edit["ink"] == str(project / "ink" / "drawn.svg")
    stroke = parse_svg(slides[0]["svg"]).find(".//*[@id='ink-a1']")
    assert stroke is not None and stroke.get("data-ink-top") == ""
    model = build_model(deck, project / "deck.py", slides)
    entry = cast("list[dict[str, object]]", model["slides"])[0]
    roles = {s["role"] for s in cast("list[dict[str, str]]", entry["sources"])}
    assert "ink" in roles
    assert cast("dict[str, object]", entry["ink"])["exists"] is True


# ── The file format ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad",
    [
        {"id": "box"},
        {"id": 'ink-x" onload="alert(1)'},
        {"d": "M0 0<script>"},
        {"d": "L0 0"},
        {"fill": "red"},
        {"fill": "url(#x)"},
        {"tool": "laser"},
        {"token": "nope"},
        {"size": 0},
        {"size": float("inf")},
        {"size": True},
        {"opacity": 2},
    ],
)
def test_a_stroke_is_checked_field_by_field(bad: dict[str, object]) -> None:
    with pytest.raises(InkError):
        Stroke.from_json({**_stroke(), **bad})


def test_a_stroke_is_a_plain_filled_path() -> None:
    el = Stroke.from_json(
        _stroke(tool="highlighter", token="yellow", opacity=0.35, size=36)
    ).element()
    assert el.get("fill") == "#ff0000"
    assert el.get("fill-opacity") == "0.35"
    assert el.get("class") == "inkflow-fill-yellow inkflow-highlighter"
    assert el.get("{urn:inkflow}tool") == "highlighter"
    assert el.get("{urn:inkflow}size") == "36"


def test_strokes_are_appended_and_a_resent_one_replaces_itself() -> None:
    data = add_strokes(None, [Stroke.from_json(_stroke("ink-a"))], BOX)
    data = add_strokes(data, [Stroke.from_json(_stroke("ink-b"))], BOX)
    data = add_strokes(data, [Stroke.from_json(_stroke("ink-a", fill="#00ff00"))], BOX)
    assert stroke_ids(data) == ["ink-a", "ink-b"]
    root = parse_svg(data)
    assert root.get("viewBox") == "0 0 1920 1080"
    assert root[0].get("fill") == "#00ff00"


def test_erasing_the_last_stroke_leaves_no_file() -> None:
    data = add_strokes(
        None,
        [Stroke.from_json(_stroke("ink-a")), Stroke.from_json(_stroke("ink-b"))],
        BOX,
    )
    rest = erase_strokes(data, {"ink-a"})
    assert rest is not None and stroke_ids(rest) == ["ink-b"]
    assert erase_strokes(rest, {"ink-b"}) is None


def test_the_cleaner_leaves_an_ink_file_alone(tmp_path: Path) -> None:
    path = tmp_path / "ink.svg"
    data = add_strokes(None, [Stroke.from_json(_stroke("ink-a", token="red"))], BOX)
    path.write_bytes(add_strokes(data, [Stroke.from_json(_stroke("ink-b"))], BOX))
    assert clean_inkscape_svg(path, keep_preview=True) == path.read_text("utf-8")


# ── Writing through the editor session ────────────────────────────────────────


def _ink_request(**fields: object) -> dict[str, object]:
    return {"action": "ink", "_local": True, **fields}


def test_session_appends_a_stroke_as_one_undoable_step(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    target = project / "ink" / "plain-2.svg"
    out = session.apply(
        _ink_request(op="add", slideId="plain-2", strokes=[_stroke("ink-a")]), deck
    )
    assert out["ok"] and out["ink"] == "ink/plain-2.svg"
    session.apply(_ink_request(op="add", slide=2, strokes=[_stroke("ink-b")]), deck)
    assert stroke_ids(target.read_bytes()) == ["ink-a", "ink-b"]
    assert parse_svg(target.read_bytes()).get("viewBox") == "0 0 1920 1080"
    session.apply({"action": "undo"}, None)
    assert stroke_ids(target.read_bytes()) == ["ink-a"]
    session.apply({"action": "undo"}, None)
    assert not target.exists()


def test_session_erases_and_clears(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    target = project / "ink" / "drawn.svg"
    _write_ink(target, "ink-a", "ink-b", "ink-c")
    session.apply(_ink_request(op="erase", slide=0, ids=["ink-b"]), deck)
    assert stroke_ids(target.read_bytes()) == ["ink-a", "ink-c"]
    session.apply(_ink_request(op="clear", slide=0), deck)
    assert not target.exists()
    session.apply({"action": "undo"}, None)
    assert stroke_ids(target.read_bytes()) == ["ink-a", "ink-c"]


@pytest.mark.parametrize("local", [False, "true", None])
def test_only_a_page_on_this_machine_saves_ink(project: Path, local: object) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    request = {**_ink_request(op="add", slide=0, strokes=[_stroke()]), "_local": local}
    with pytest.raises(EditError, match="on this machine"):
        session.apply(request, deck)
    assert not (project / "ink").exists()


def test_a_malformed_stroke_writes_nothing(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    with pytest.raises(EditError, match="colour"):
        session.apply(
            _ink_request(op="add", slide=0, strokes=[_stroke(fill="javascript:")]),
            deck,
        )
    assert not (project / "ink").exists()


# ── Ink follows its slide through slide edits ─────────────────────────────────


def test_detaching_a_slide_renames_its_ink(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "plain-2.svg", "ink-second")
    _write_ink(project / "ink" / "plain.svg", "ink-first")
    session.apply(
        {"action": "slide", "op": "detach", "slide": 2, "name": "second"}, deck
    )
    assert not (project / "ink" / "plain-2.svg").exists()
    assert stroke_ids((project / "ink" / "second.svg").read_bytes()) == ["ink-second"]
    assert stroke_ids((project / "ink" / "plain.svg").read_bytes()) == ["ink-first"]
    _, slides = _build(project)
    assert "ink-second" in slides[2]["svg"] and "ink-first" in slides[1]["svg"]
    session.apply({"action": "undo"}, None)
    assert (project / "ink" / "plain-2.svg").exists()
    assert not (project / "ink" / "second.svg").exists()


def test_deleting_a_slide_deletes_its_ink(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "drawn.svg", "ink-a")
    session.apply({"action": "slide", "op": "delete", "slide": 0}, deck)
    assert not (project / "ink" / "drawn.svg").exists()
    session.apply({"action": "undo"}, None)
    assert (project / "ink" / "drawn.svg").exists()


def test_a_duplicate_gets_its_own_copy_of_the_ink(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "drawn.svg", "ink-a")
    _write_ink(project / "notes" / "named-ink.svg", "ink-named")
    session.apply({"action": "slide", "op": "duplicate", "slide": 0}, deck)
    _, slides = _build(project)
    # slides/drawn.svg is shared, so the copy keeps it and is "drawn-2".
    assert [s["id"] for s in slides][:2] == ["drawn", "drawn-2"]
    assert "ink-a" in slides[0]["svg"] and "ink-a" in slides[1]["svg"]
    deck = load_deck(project / "deck.py")
    session.apply({"action": "slide", "op": "duplicate", "slide": 4}, deck)
    copy = load_deck(project / "deck.py").slides[5]
    assert copy.ink == "notes/named-ink-copy.svg"
    assert (project / "notes" / "named-ink-copy.svg").exists()


def test_moving_a_slide_keeps_each_ink_with_its_slide(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "plain.svg", "ink-one")
    _write_ink(project / "ink" / "plain-2.svg", "ink-two")
    # The two "plain" slides swap places, and with them their inferred ids.
    session.apply({"action": "slide", "op": "move", "from": 2, "to": 1}, deck)
    _, slides = _build(project)
    one = next(s for s in slides if "One" in s["svg"])
    two = next(s for s in slides if "Two" in s["svg"])
    assert "ink-one" in one["svg"] and "ink-two" in two["svg"]


def test_slide_edits_that_keep_ids_leave_ink_alone(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "drawn.svg", "ink-a")
    session.apply({"action": "slide", "op": "new", "after": 0, "layout": "plain"}, deck)
    session.apply(
        {"action": "slide", "op": "title", "slide": 0, "title": "Renamed"},
        load_deck(project / "deck.py"),
    )
    assert stroke_ids((project / "ink" / "drawn.svg").read_bytes()) == ["ink-a"]
    _, slides = _build(project)
    assert "ink-a" in slides[0]["svg"]


def test_ink_in_the_way_is_never_overwritten(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    _write_ink(project / "ink" / "plain-2.svg", "ink-second")
    # Someone else's file already where the renamed ink would go.
    _write_ink(project / "ink" / "second.svg", "ink-stray")
    session.apply(
        {"action": "slide", "op": "detach", "slide": 2, "name": "second"}, deck
    )
    assert stroke_ids((project / "ink" / "second.svg").read_bytes()) == ["ink-stray"]
    assert (project / "ink" / "plain-2.svg").exists()


# ── The server: relay for the talk, saving only for this machine ──────────────


class _Peer:
    """A WebSocket peer: what it sends, and what the server sends it."""

    remote_address: tuple[str, int]
    sent: list[str]
    inbox: list[str]

    def __init__(self, host: str, inbox: list[str] | None = None) -> None:
        self.remote_address = (host, 5000)
        self.sent = []
        self.inbox = inbox or []

    async def send(self, msg: str) -> None:
        self.sent.append(msg)

    def __aiter__(self) -> AsyncIterator[str]:
        return self._messages()

    async def _messages(self) -> AsyncIterator[str]:
        for msg in self.inbox:
            yield msg


class _UI:
    def refresh(self) -> None:
        pass


def test_ink_is_relayed_to_every_other_window() -> None:
    ink = {"type": "ink", "op": "erase", "slide": "intro", "ids": ["ink-a"]}
    drawer = _Peer("127.0.0.1", [json.dumps(ink)])
    audience = _Peer("192.168.1.20")
    clients = server._state["ws_clients"]  # pyright: ignore[reportPrivateUsage]
    clients.add(cast("ServerConnection", cast("object", audience)))
    try:
        handler = server.make_ws_handler(
            cast("LiveUI", cast("object", _UI())), NO_EDIT_COMMANDS
        )

        async def connect() -> None:
            await handler(cast("ServerConnection", cast("object", drawer)))

        asyncio.run(connect())
    finally:
        clients.discard(cast("ServerConnection", cast("object", audience)))
    assert [json.loads(m) for m in audience.sent] == [ink]
    assert all(json.loads(m)["type"] != "ink" for m in drawer.sent)


def test_a_save_from_another_machine_is_refused(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    server._editor["deck"] = load_deck(project / "deck.py")  # pyright: ignore[reportPrivateUsage]
    request = {
        "type": "edit-op",
        "id": "ink-1",
        "action": "ink",
        "op": "add",
        "slide": 0,
        "strokes": [_stroke()],
        "_local": True,  # what a page claims is overwritten by the server
    }
    remote = _Peer("192.168.1.20")
    try:
        asyncio.run(
            server._handle_edit_op(  # pyright: ignore[reportPrivateUsage]
                cast("ServerConnection", cast("object", remote)), dict(request), session
            )
        )
        reply = cast("dict[str, object]", json.loads(remote.sent[0]))
        assert reply["id"] == "ink-1" and reply["ok"] is False
        assert not (project / "ink").exists()
        local = _Peer("127.0.0.1")
        asyncio.run(
            server._handle_edit_op(  # pyright: ignore[reportPrivateUsage]
                cast("ServerConnection", cast("object", local)), dict(request), session
            )
        )
        assert json.loads(local.sent[0])["ok"] is True
        assert (project / "ink" / "drawn.svg").exists()
    finally:
        server._editor["deck"] = None  # pyright: ignore[reportPrivateUsage]


def test_a_deck_with_ink_round_trips_through_load(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    assert isinstance(deck, Deck)
    assert deck.slides[3].ink == "notes/named-ink.svg"
