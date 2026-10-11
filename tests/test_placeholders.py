"""Placeholders in the slide master: adding one with a prompt, renaming one
with every slide's content following, prompts, removing, making one from a
drawn shape, and the ``inkflow layout placeholder`` commands."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner
from websockets.sync.client import connect

from inkflow import instances, ns
from inkflow.cli import main
from inkflow.editor.placeholders import name_problem, zone_name
from inkflow.editor.provenance import INK, stamper
from inkflow.editor.session import EditError, EditorSession
from inkflow.layout import builtin_theme_dir
from inkflow.pipeline import SlideData, process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg_file
from inkflow.zones import rename_zone, zone_names
from tests.test_master import served as served

BUILTIN = builtin_theme_dir() / "layouts"

CODE = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="title" viewBox="0 0 1920 1080">
      <style>#zone-code { --inkflow-padding: 20px; }</style>
      <rect id="frame" x="80" y="280" width="1760" height="700"/>
      <rect id="zone-code" x="100" y="300" width="1000" height="600"/>
      <inkflow:hint zone="code">The code example</inkflow:hint>
    </svg>
""")

CHILD = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="code" viewBox="0 0 1920 1080">
      <rect id="zone-note" x="1200" y="300" width="600" height="600"/>
    </svg>
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="code" viewBox="0 0 1920 1080">
      <path id="arrow" d="M 0 0 L 10 10" inkflow:connector="straight"
            inkflow:connect-end="zone-code:left"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide
    from inkflow.animations import FadeIn


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("code", md="a.md"),
                Slide("code-child", md="b.md"),
                Slide(
                    "code",
                    zones={"code": "Inline code"},  # keep this comment
                    animations=[FadeIn("zone-code")],
                ),
                Slide("content", md="c.md"),
                Slide("drawn.svg", md="d.md"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts"):
        (tmp_path / sub).mkdir()
    (tmp_path / "layouts" / "code.svg").write_text(CODE, encoding="utf-8")
    (tmp_path / "layouts" / "code-child.svg").write_text(CHILD, encoding="utf-8")
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    texts = {
        "a": "# A\n\n::code::\nprint(1)\n",
        "b": "# B\n\n::code lang=py::\nprint(2)\n\n::note::\nA note\n",
        "c": "# C\n\n::code::\nnot on the code layout\n",
        "d": "# D\n\n::code::\nprint(4)\n",
    }
    for name, text in texts.items():
        (tmp_path / "slides" / f"{name}.md").write_text(text, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _session(project: Path) -> EditorSession:
    return EditorSession(project / "deck.py")


def _apply(
    session: EditorSession, project: Path, msg: dict[str, object]
) -> dict[str, object]:
    deck = load_deck(project / "deck.py")
    return session.apply({**msg, "_local": True}, deck)


def _snapshot(project: Path) -> dict[str, bytes]:
    return {
        p.relative_to(project).as_posix(): p.read_bytes()
        for p in sorted(project.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts and ".inkflow" not in p.parts
    }


def _hints(path: Path) -> dict[str, str]:
    root = parse_svg_file(path)
    return {str(el.get("zone")): (el.text or "") for el in root.iter(ns.INKFLOW_HINT)}


def _empty(built: list[SlideData], index: int) -> list[dict[str, object]]:
    edit = built[index].get("edit")
    assert edit is not None
    return cast("list[dict[str, object]]", edit["emptyZones"])


# ── Names ─────────────────────────────────────────────────────────────────────


def test_names() -> None:
    assert zone_name("text", "Code example") == "code-example"
    assert zone_name("text", "codeExample") == "code-example"
    assert zone_name("picture", "hero") == "picture-hero"
    assert zone_name("picture", "Logo") == "logo"
    assert name_problem("") is not None
    assert name_problem("notes") is not None
    assert name_problem("step") is not None
    assert name_problem("steps-1") is not None
    assert name_problem("stepper") is None
    assert name_problem("2col") is not None
    assert name_problem("code-example") is None


def test_markdown_rename_keeps_params_and_auto_zones() -> None:
    text = "# T\n\n::code lang=py::\nx\n"
    assert rename_zone(text, "code", "sample") == "# T\n\n::sample lang=py::\nx\n"
    # An auto-extracted body gets a marker of its own.
    assert rename_zone("# T\n\n- one\n", "content", "body") == (
        "# T\n\n::body::\n- one\n"
    )
    # A renamed title: what followed it keeps its zone through a marker.
    renamed = rename_zone("# T\n\n- one\n", "title", "heading")
    assert renamed == "::heading::\n# T\n\n::content::\n- one\n"
    assert zone_names(renamed) == {"heading", "content"}
    assert rename_zone("# T\n", "other", "x") == "# T\n"


# ── Adding ────────────────────────────────────────────────────────────────────


def test_add_a_placeholder_with_a_prompt(project: Path) -> None:
    session = _session(project)
    path = project / "layouts" / "code.svg"
    result = _apply(
        session,
        project,
        {
            "action": "master",
            "op": "add-zone",
            "file": str(path),
            "zoneKind": "text",
            "name": "Caption",
            "prompt": "Say what the code does",
            "exact": True,
        },
    )
    assert result["zone"] == "caption"
    assert result["label"] == "Add text placeholder"
    root = parse_svg_file(path)
    rect = root.find(f".//{{{ns.SVG}}}rect[@id='zone-caption']")
    assert rect is not None and rect.get("width") == "960"  # half the canvas
    assert _hints(path)["caption"] == "Say what the code does"
    # A new slide on the layout shows the prompt in the empty zone.
    deck = load_deck(project / "deck.py")
    built = process_deck(deck, project, project / "deck.py", editor=True)
    empty = _empty(built, 0)
    assert {"zone": "caption", "hint": "Say what the code does"}.items() <= next(
        z for z in empty if z["zone"] == "caption"
    ).items()
    assert "Say what the code does" not in built[0]["svg"]
    # A name in use (here, the child layout's) is refused, not numbered on.
    with pytest.raises(EditError, match="zone-note is already used"):
        _apply(
            session,
            project,
            {
                "action": "master",
                "op": "add-zone",
                "file": str(path),
                "name": "note",
                "exact": True,
            },
        )
    # A picture placeholder says it is one.
    result = _apply(
        session,
        project,
        {
            "action": "master",
            "op": "add-zone",
            "layout": "code",
            "zoneKind": "picture",
            "name": "hero",
            "exact": True,
            "x": 0,
            "y": 0,
            "width": 100,
            "height": 50,
        },
    )
    assert result["zone"] == "picture-hero"
    _apply(session, project, {"action": "undo"})
    _apply(session, project, {"action": "undo"})
    assert "zone-caption" not in path.read_text()


def test_a_theme_layout_is_copied_on_its_first_placeholder(project: Path) -> None:
    session = _session(project)
    before = _snapshot(project)
    result = _apply(
        session,
        project,
        {
            "action": "master",
            "op": "add-zone",
            "file": str(BUILTIN / "content.svg"),
            "name": "aside",
            "prompt": "A side note",
            "exact": True,
        },
    )
    copy = project / "layouts" / "content.svg"
    assert cast("dict[str, str]", result["copied"])["name"] == "content"
    assert 'id="zone-aside"' in copy.read_text()
    assert parse_svg_file(copy).get(ns.INKFLOW_COPY_OF) == "builtin:content"
    assert "zone-aside" not in (BUILTIN / "content.svg").read_text()
    _apply(session, project, {"action": "undo"})
    assert _snapshot(project) == before


# ── Renaming ──────────────────────────────────────────────────────────────────


def test_rename_follows_every_slide(project: Path) -> None:
    session = _session(project)
    before = _snapshot(project)
    msg: dict[str, object] = {
        "action": "master",
        "op": "zone-rename",
        "file": str(project / "layouts" / "code.svg"),
        "zone": "code",
        "to": "sample",
    }
    dry = _apply(session, project, {**msg, "dryRun": True})
    plan = cast("dict[str, object]", dry["placeholder"])
    assert plan["slides"] == [0, 1, 2, 4]
    assert _snapshot(project) == before  # a dry run writes nothing
    result = _apply(session, project, msg)
    assert result["zone"] == "sample"
    layout = (project / "layouts" / "code.svg").read_text()
    assert 'id="zone-sample"' in layout and "zone-code" not in layout
    assert "#zone-sample {" in layout
    assert _hints(project / "layouts" / "code.svg") == {"sample": "The code example"}
    slides = project / "slides"
    assert (slides / "a.md").read_text() == "# A\n\n::sample::\nprint(1)\n"
    # The child layout's slide follows too, its marker's parameters kept.
    assert "::sample lang=py::" in (slides / "b.md").read_text()
    # A slide on another layout keeps its own "code".
    assert (slides / "c.md").read_text() == before["slides/c.md"].decode()
    deck_py = (project / "deck.py").read_text()
    assert 'zones={"sample": "Inline code"},  # keep this comment' in deck_py
    assert 'FadeIn("zone-sample")' in deck_py
    # An arrow on a slide's own drawing stays attached.
    assert (
        'inkflow:connect-end="zone-sample:left"' in (slides / "drawn.svg").read_text()
    )
    # The slides build with the content in the renamed zone.
    built = process_deck(load_deck(project / "deck.py"), project, project / "deck.py")
    assert "print(1)" in built[0]["svg"] and 'id="zone-sample"' in built[0]["svg"]
    assert "print(2)" in built[1]["svg"]
    assert "Inline code" in built[2]["svg"]
    # One step: undo restores every file.
    assert len(session.history.done) == 1
    _apply(session, project, {"action": "undo"})
    assert _snapshot(project) == before


def test_rename_refuses_a_name_a_slide_already_uses(project: Path) -> None:
    session = _session(project)
    (project / "slides" / "a.md").write_text("# A\n\n::code::\nx\n\n::sample::\ny\n")
    msg: dict[str, object] = {
        "action": "master",
        "op": "zone-rename",
        "layout": "code",
        "zone": "code",
        "to": "sample",
    }
    with pytest.raises(EditError, match="slide 1 already has a 'sample' zone"):
        _apply(session, project, msg)
    with pytest.raises(EditError, match="zone-note is already used"):
        _apply(session, project, {**msg, "to": "note"})
    with pytest.raises(EditError, match="reserved"):
        _apply(session, project, {**msg, "to": "notes"})
    with pytest.raises(EditError, match="layout 'code''s"):
        _apply(
            session,
            project,
            {**msg, "layout": "code-child", "zone": "code", "to": "x"},
        )
    assert not session.history.done


def test_rename_content_of_a_theme_layout(project: Path) -> None:
    """The deck's copy is made in the same step; the auto-extracted body of
    the slide's Markdown gets a marker, and the zone stays the default."""
    session = _session(project)
    (project / "slides" / "c.md").write_text("# C\n\n- one\n")
    result = _apply(
        session,
        project,
        {
            "action": "master",
            "op": "zone-rename",
            "file": str(BUILTIN / "content.svg"),
            "zone": "content",
            "to": "body",
        },
    )
    copy = project / "layouts" / "content.svg"
    assert 'id="zone-body"' in copy.read_text()
    assert parse_svg_file(copy).get(ns.INKFLOW_DEFAULT_ZONE) == "body"
    assert (project / "slides" / "c.md").read_text() == "# C\n\n::body::\n- one\n"
    warnings = cast("dict[str, list[str]]", result["placeholder"])["warnings"]
    assert any("#zone-content" in w for w in warnings)
    built = process_deck(load_deck(project / "deck.py"), project, project / "deck.py")
    assert "one" in built[3]["svg"]


# ── Prompt, remove, make ──────────────────────────────────────────────────────


def test_prompt_edit_and_clear(project: Path) -> None:
    session = _session(project)
    path = project / "layouts" / "code.svg"
    base: dict[str, object] = {
        "action": "master",
        "op": "zone-prompt",
        "file": str(path),
        "zone": "code",
    }
    _apply(session, project, {**base, "prompt": "Paste the code here"})
    assert _hints(path) == {"code": "Paste the code here"}
    _apply(session, project, {**base, "prompt": ""})
    assert _hints(path) == {}
    # A zone of a layout it is built on gets its prompt here.
    child = project / "layouts" / "code-child.svg"
    _apply(session, project, {**base, "file": str(child), "prompt": "Child code"})
    assert _hints(child) == {"code": "Child code"}
    deck = load_deck(project / "deck.py")
    built = process_deck(deck, project, project / "deck.py", editor=True)
    (project / "slides" / "b.md").write_text("# B\n")
    built = process_deck(
        load_deck(project / "deck.py"), project, project / "deck.py", editor=True
    )
    empty = _empty(built, 1)
    assert next(z for z in empty if z["zone"] == "code")["hint"] == "Child code"
    with pytest.raises(EditError, match="no placeholder 'nope'"):
        _apply(session, project, {**base, "zone": "nope", "prompt": "x"})


def test_remove_a_placeholder(project: Path) -> None:
    session = _session(project)
    path = project / "layouts" / "code.svg"
    before = _snapshot(project)
    msg: dict[str, object] = {
        "action": "master",
        "op": "zone-remove",
        "file": str(path),
        "zone": "code",
    }
    result = _apply(session, project, msg)
    assert 'id="zone-code"' not in path.read_text()
    assert _hints(path) == {}
    warnings = cast("dict[str, list[str]]", result["placeholder"])["warnings"]
    assert "still have content for 'code'" in warnings[0]
    assert (project / "slides" / "a.md").read_bytes() == before["slides/a.md"]
    _apply(session, project, {"action": "undo"})
    # With the slides' content.
    _apply(session, project, {**msg, "dropContent": True})
    assert "::code::" not in (project / "slides" / "a.md").read_text()
    deck_py = (project / "deck.py").read_text()
    assert "Inline code" not in deck_py and "FadeIn" not in deck_py.split("def main")[1]
    _apply(session, project, {"action": "undo"})
    assert _snapshot(project) == before


def _locator(path: Path, element_id: str) -> str:
    root = parse_svg_file(path)
    stamper(0)(root)
    for el in root.iter():
        if el.get("id") == element_id:
            return el.get(INK, "")
    raise AssertionError(element_id)


def test_make_a_drawn_shape_a_placeholder(project: Path) -> None:
    session = _session(project)
    path = project / "layouts" / "code.svg"
    result = _apply(
        session,
        project,
        {
            "action": "master",
            "op": "zone-make",
            "file": str(path),
            "loc": _locator(path, "frame"),
            "zoneKind": "text",
            "name": "Summary",
            "prompt": "One line on what it does",
        },
    )
    assert result["zone"] == "summary"
    root = parse_svg_file(path)
    rect = root.find(f".//{{{ns.SVG}}}rect[@id='zone-summary']")
    assert rect is not None
    assert rect.get(ns.INKFLOW_SHOW_SHAPE) == "true"
    assert "--inkflow-align:center" in (rect.get("style") or "")
    assert _hints(path)["summary"] == "One line on what it does"
    # Kept on the slides as a box; offered empty, with its prompt.
    built = process_deck(
        load_deck(project / "deck.py"), project, project / "deck.py", editor=True
    )
    empty = _empty(built, 0)
    assert any(z["zone"] == "summary" for z in empty)
    with pytest.raises(EditError, match="already"):
        _apply(
            session,
            project,
            {
                "action": "master",
                "op": "zone-make",
                "file": str(path),
                "loc": _locator(path, "zone-summary"),
            },
        )
    # Removing it gives the plain shape back.
    _apply(
        session,
        project,
        {"action": "master", "op": "zone-remove", "file": str(path), "zone": "summary"},
    )
    rect = parse_svg_file(path).find(f".//{{{ns.SVG}}}rect[@id='summary']")
    assert rect is not None and rect.get(ns.INKFLOW_SHOW_SHAPE) is None


def test_placeholder_listing(project: Path) -> None:
    session = _session(project)
    deck = load_deck(project / "deck.py")
    info = session.apply(
        {"action": "master-placeholders", "layout": "code-child"}, deck
    )
    found = {
        str(p["name"]): p for p in cast("list[dict[str, object]]", info["placeholders"])
    }
    assert found["note"]["own"] is True and found["note"]["filled"] == [1]
    assert found["code"]["own"] is False and found["code"]["layout"] == "code"
    assert found["code"]["prompt"] == "The code example"
    assert found["title"]["kind"] == "text"
    assert "zone-code" in cast("list[str]", info["taken"])


# ── The command line ──────────────────────────────────────────────────────────


def _cli(project: Path, *args: str) -> str:
    result = CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])
    assert result.exit_code == 0, result.output
    return result.output


def test_cli_offline(project: Path) -> None:
    out = _cli(
        project,
        "layout",
        "placeholder",
        "add",
        "code",
        "Caption",
        "--prompt",
        "What it does",
        "--box",
        "100,950,800,80",
    )
    assert "Add text placeholder" in out
    rect = parse_svg_file(project / "layouts" / "code.svg").find(
        f".//{{{ns.SVG}}}rect[@id='zone-caption']"
    )
    assert rect is not None and rect.get("y") == "950"
    out = _cli(project, "layout", "placeholders", "code")
    assert "caption" in out and "What it does" in out
    data = cast(
        "dict[str, list[dict[str, object]]]",
        json.loads(_cli(project, "layout", "placeholders", "code", "--json")),
    )
    assert {p["name"] for p in data["placeholders"]} >= {"code", "caption", "title"}
    out = _cli(
        project, "layout", "placeholder", "rename", "code", "code", "sample", "-n"
    )
    assert "slides/a.md" in out
    assert "zone-code" in (project / "layouts" / "code.svg").read_text()
    _cli(project, "layout", "placeholder", "rename", "code", "code", "sample")
    assert "::sample::" in (project / "slides" / "a.md").read_text()
    _cli(project, "layout", "placeholder", "prompt", "code", "sample", "Your code")
    assert _hints(project / "layouts" / "code.svg")["sample"] == "Your code"
    _cli(project, "layout", "placeholder", "prompt", "code", "sample", "--clear")
    assert "sample" not in _hints(project / "layouts" / "code.svg")
    _cli(project, "layout", "placeholder", "remove", "code", "caption")
    assert "zone-caption" not in (project / "layouts" / "code.svg").read_text()
    # A theme's layout is copied on write.
    _cli(project, "layout", "placeholder", "add", "content", "aside")
    assert 'id="zone-aside"' in (project / "layouts" / "content.svg").read_text()
    result = CliRunner().invoke(
        main,
        [
            "layout",
            "placeholder",
            "rename",
            "code",
            "sample",
            "note",
            "--deck",
            str(project / "deck.py"),
        ],
    )
    assert result.exit_code != 0 and "zone-note is already used" in result.output


def test_cli_through_the_server_is_an_undoable_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, port = served
    with connect(
        f"ws://127.0.0.1:{port}/_inkflow/ws", proxy=None, max_size=None
    ) as editor:
        editor.send(json.dumps({"type": "hello", "role": "editor"}))
        out = _cli(project, "layout", "placeholder", "rename", "code", "code", "sample")
        assert "Ctrl+Z in the editor" in out
    assert [s.label for s in session.history.done] == [
        "Agent: Rename placeholder code to sample on layout code"
    ]
    session.apply({"action": "undo"}, load_deck(project / "deck.py"))
    assert "::code::" in (project / "slides" / "a.md").read_text()
