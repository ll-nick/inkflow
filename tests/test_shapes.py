"""``inkflow shape``: the editor's drawing actions from the command line.

The commands run the session's own actions, so these tests check the files
come out as the editor writes them: unique ids, the arrow marker, a text box's
Markdown section, arrows routed where the editor routes them (the routing
itself is held to the editor's by tests/test_routing.py) and following the
shapes they connect, renames carrying arrows and cues along, and a batch being
one undoable step through a running editor server.
"""

from __future__ import annotations

import json
import shutil
import textwrap
import time
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner, Result
from websockets.sync.client import connect

from inkflow import instances
from inkflow.cli import main
from inkflow.editor.bbox import Geometry, path_bbox
from inkflow.editor.geometry import Box
from inkflow.editor.scene import Scene
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import file_hash
from inkflow.server import load_deck
from inkflow.svgio import parse_svg
from tests import test_slides_cli

# The `served` fixture of `inkflow slide`'s tests: the deck served as
# `inkflow edit` would (WebSocket, watcher, rebuild) on a thread.
served = test_slides_cli.served

DATA = Path(__file__).parent / "data"

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="logo" x="1700" y="980" width="120" height="60"/>
    </svg>
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="plain" viewBox="0 0 1920 1080">
      <rect id="a" x="100" y="100" width="200" height="100"/>
      <rect id="b" x="700" y="400" width="200" height="100"/>
      <ellipse id="c" cx="1400" cy="300" rx="100" ry="50"/>
      <text id="label" x="100" y="900" style="font-size:40px">Hello</text>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide, animations


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "drawn.svg",
                    animations=[animations.FadeIn("a")],
                ),
                Slide("plain", md="intro.md"),
                Slide("plain", md="other.md"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts", "data", "assets"):
        (tmp_path / sub).mkdir()
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    (tmp_path / "slides" / "intro.md").write_text("# Intro\n", encoding="utf-8")
    (tmp_path / "slides" / "other.md").write_text("# Other\n", encoding="utf-8")
    (tmp_path / "data" / "sales.csv").write_text("q,v\nA,1\nB,2\n", encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    """Offline unless a test starts a server: never find a real one."""

    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _run(project: Path, *args: str, input: str | None = None) -> Result:
    return CliRunner().invoke(
        main, ["shape", *args, "--deck", str(project / "deck.py")], input=input
    )


def _ok(project: Path, *args: str, input: str | None = None) -> str:
    result = _run(project, *args, input=input)
    assert result.exit_code == 0, result.output
    return result.output


def _objects(output: str) -> dict[str, dict[str, object]]:
    """`shape list --json`'s objects, by id."""
    data = cast("dict[str, list[dict[str, object]]]", json.loads(output))
    return {str(o["id"]): o for o in data["objects"] if o.get("id")}


def _svg(project: Path, name: str = "drawn") -> str:
    return (project / "slides" / f"{name}.svg").read_text(encoding="utf-8")


def _el(project: Path, element_id: str, name: str = "drawn") -> dict[str, str]:
    root = parse_svg(_svg(project, name))
    for el in root.iter():
        if el.get("id") == element_id:
            return {str(k).split("}")[-1]: str(v) for k, v in el.attrib.items()}
    raise AssertionError(f"no #{element_id}")


def _scene(project: Path, index: int = 0) -> Scene:
    deck = load_deck(project / "deck.py")
    slide = deck.slides[index]
    return Scene.compose(project, deck, slide, "drawn" if index == 0 else "s")


# ── Boxes without a browser ────────────────────────────────────────────────────


def _geometry(body: str) -> Geometry:
    root = parse_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500">'
        + body
        + "</svg>"
    )

    def by_id(i: str):
        return next((e for e in root.iter() if e.get("id") == i), None)

    return Geometry(root, by_id)


def _box(g: Geometry, element_id: str) -> tuple[float, ...]:
    el = g.by_id(element_id)
    assert el is not None
    box = g.slide_box(el)
    assert box is not None
    return tuple(round(v, 6) for v in (box.x, box.y, box.width, box.height))


def test_boxes_follow_nested_transforms() -> None:
    g = _geometry(
        '<g transform="translate(100,50)"><g transform="scale(2)">'
        + '<rect id="r" x="10" y="10" width="20" height="10"/></g></g>'
        + '<rect id="t" x="0" y="0" width="10" height="20" transform="rotate(90)"/>'
        + '<g id="grp" transform="translate(5,5)"><circle cx="0" cy="0" r="5"/>'
        + '<line x1="0" y1="0" x2="50" y2="0" style="display:none"/></g>'
    )
    assert _box(g, "r") == (120, 70, 40, 20)
    assert _box(g, "t") == (-20, 0, 20, 10)
    # A hidden child is left out of its group's box.
    assert _box(g, "grp") == (0, 0, 10, 10)


def test_a_cropped_picture_and_a_use() -> None:
    g = _geometry(
        '<svg id="crop" x="100" y="100" width="200" height="100" viewBox="50 0 100 50"'
        + ' preserveAspectRatio="none"><image id="pic" x="0" y="0" width="400"'
        + ' height="200"/></svg>'
        + '<defs><rect id="proto" width="30" height="10"/></defs>'
        + '<use id="u" href="#proto" x="5" y="7"/>'
    )
    # The picture inside the frame: viewBox 50..150 shown at 100..300 (x2).
    assert _box(g, "pic") == (0, 100, 800, 400)
    assert _box(g, "u") == (5, 7, 30, 10)


def test_path_bounds_include_curve_and_arc_extremes() -> None:
    assert path_bbox("M0,0 C0,-10 10,-10 10,0") == Box(0, -7.5, 10, 7.5)
    box = path_bbox("M10,0 A10 10 0 1 1 -10 0 A10 10 0 1 1 10 0")
    assert box is not None
    assert (round(box.x, 9), round(box.width, 9)) == (-10, 20)
    # Arc flags written without separators, and a smooth quadratic.
    assert path_bbox("M0 0 a5,5 0 0110,0") is not None
    assert path_bbox("M 0 0 Q 5 10 10 0 T 20 0") == Box(0, -5, 20, 10)


def test_text_boxes_are_estimated_from_the_font_size() -> None:
    g = _geometry('<text id="t" x="10" y="100" font-size="20">abcd</text>')
    x, y, w, h = _box(g, "t")
    assert (x, y, h) == (10, 84, 20)
    assert w == pytest.approx(4 * 0.55 * 20)


def test_round_shapes_put_their_sites_on_the_ellipse(project: Path) -> None:
    scene = _scene(project)
    c = scene.by_id("c")
    assert c is not None
    top = scene.site_of(c, "top@0.25")
    assert top is not None
    # On the ellipse (cx 1400, cy 300, rx 100, ry 50), not on its box.
    assert ((top.x - 1400) / 100) ** 2 + ((top.y - 300) / 50) ** 2 == pytest.approx(1)


# ── Adding things ──────────────────────────────────────────────────────────────


def test_add_a_rect_with_text_makes_a_text_zone(project: Path) -> None:
    out = _ok(project, "add", "rect", "-s", "1", "--id", "box", "--at", "300,600")
    assert "box" in out
    rect = _el(project, "box")
    # The editor's look and default size.
    assert rect["class"] == "inkflow-fill-surface inkflow-stroke-accent"
    assert (rect["x"], rect["y"], rect["width"], rect["height"]) == (
        "300",
        "600",
        "360",
        "220",
    )
    _ok(project, "add", "rect", "-s", "1", "--id", "start", "--text", "Go **now**")
    zone = _el(project, "zone-start")
    assert zone["show-shape"] == "true"
    assert "--inkflow-align:center" in zone["style"]
    md = (project / "slides" / "drawn.md").read_text(encoding="utf-8")
    assert "::start::\nGo **now**" in md
    assert "md='drawn.md'" in (project / "deck.py").read_text().replace('"', "'")


def test_ids_stay_unique_and_a_taken_id_is_refused(project: Path) -> None:
    _ok(project, "add", "ellipse", "-s", "1")
    _ok(project, "add", "ellipse", "-s", "1")
    ids = [e.get("id") for e in parse_svg(_svg(project)).iter()]
    assert ids.count("ellipse") == 1 and "ellipse-2" in ids
    result = _run(project, "add", "rect", "-s", "1", "--id", "a")
    assert result.exit_code != 0
    assert "already used" in result.output


def test_a_textbox_is_its_zone_and_its_markdown_in_one_step(project: Path) -> None:
    out = _ok(
        project,
        "add",
        "textbox",
        "-s",
        "intro",
        "--text",
        "Hello *world*",
        "--id",
        "note",
    )
    assert "zone-note" in out
    # The shared layout slide got a drawing of its own first.
    svg = _svg(project, "intro")
    assert 'id="zone-note"' in svg
    md = (project / "slides" / "intro.md").read_text(encoding="utf-8")
    assert md.startswith("# Intro") and "::note::\nHello *world*" in md


def test_text_line_image_and_chart(project: Path) -> None:
    shutil.copy(DATA / "flow.drawio.svg", project / "assets" / "pic.svg")
    _ok(project, "add", "text", "-s", "1", "--text", "Two\nlines", "--id", "t2")
    text = _svg(project)
    assert 'dy="1.2em">lines</tspan>' in text
    _ok(project, "add", "line", "-s", "1", "--from", "0,0", "--to", "100,0")
    assert 'inkflow:connector="straight"' in _svg(project)
    assert "inkflow-arrow" not in _svg(project)
    _ok(
        project, "add", "image", "-s", "1", "--src", str(project / "assets" / "pic.svg")
    )
    image = _el(project, "image")
    # Its natural size (442x202), the href relative to the slide's SVG.
    assert image["href"] == "../assets/pic.svg"
    assert (image["width"], image["height"]) == ("442", "202")
    _ok(
        project,
        "add",
        "chart",
        "-s",
        "1",
        "--data",
        str(project / "data" / "sales.csv"),
    )
    deck = (project / "deck.py").read_text(encoding="utf-8")
    assert "Chart('data/sales.csv')" in deck.replace('"', "'")
    assert not (project / "data" / "chart-1.csv").exists()


# ── Arrows ─────────────────────────────────────────────────────────────────────


def test_connect_attaches_and_routes_like_the_editor(project: Path) -> None:
    _ok(project, "connect", "-s", "1", "a", "b", "--style", "elbow", "--id", "ab")
    arrow = _el(project, "ab")
    # The nearest sites: a's right side to b's left side; the elbow turns halfway.
    assert arrow["connect-start"] == "a:right"
    assert arrow["connect-end"] == "b:left"
    assert arrow["d"] == "M300,150 L500,150 L500,450 L700,450"
    assert arrow["marker-end"] == "url(#inkflow-arrow)"
    assert 'id="inkflow-arrow"' in _svg(project)
    _ok(project, "connect", "-s", "1", "b", "c", "--from", "top@0.25", "--to", "bottom")
    arrow = _el(project, "arrow")
    assert arrow["connect-start"] == "b:top@0.25"
    assert arrow["d"] == "M750,400 L1400,350"


def test_a_bend_and_arrowheads(project: Path) -> None:
    _ok(
        project,
        "connect",
        "-s",
        "1",
        "a",
        "b",
        "--style",
        "elbow",
        "--bend",
        "x:400",
        "--arrow",
        "both",
    )
    arrow = _el(project, "arrow")
    assert arrow["bend"] == "x:400"
    assert arrow["d"] == "M300,150 L400,150 L400,450 L700,450"
    assert arrow["marker-start"] == arrow["marker-end"] == "url(#inkflow-arrow)"
    result = _run(
        project, "connect", "-s", "1", "a", "b", "--style", "elbow", "--bend", "y:3"
    )
    assert result.exit_code != 0 and "runs along x" in result.output


def test_arrows_attach_to_layout_objects_but_not_to_text(project: Path) -> None:
    out = _ok(project, "connect", "-s", "1", "a", "logo")
    assert "logo" in out
    result = _run(project, "connect", "-s", "1", "a", "label")
    assert result.exit_code != 0
    assert "plain <text>" in result.output


def test_arrows_follow_moved_shapes_and_let_go_when_moved_alone(project: Path) -> None:
    _ok(project, "connect", "-s", "1", "a", "b", "--id", "ab")
    _ok(project, "move", "-s", "1", "b", "--by", "100,50")
    assert _el(project, "b")["x"] == "800"
    assert _el(project, "ab")["d"] == "M300,150 L800,500"
    _ok(project, "resize", "-s", "1", "a", "--size", "300,100")
    assert _el(project, "ab")["d"] == "M400,150 L800,500"
    # The arrow dragged on its own: both ends let go of their shapes.
    _ok(project, "move", "-s", "1", "ab", "--by", "0,10")
    arrow = _el(project, "ab")
    assert "connect-start" not in arrow and "connect-end" not in arrow
    assert arrow["d"] == "M400,160 L800,510"


def test_align_and_distribute(project: Path) -> None:
    _ok(project, "align", "-s", "1", "a", "b", "top")
    assert _el(project, "b")["y"] == "100"
    _ok(project, "align", "-s", "1", "a", "center", "--to", "slide")
    assert _el(project, "a")["x"] == "860"
    _ok(
        project,
        "add",
        "rect",
        "-s",
        "1",
        "--id",
        "m",
        "--at",
        "0,600",
        "--size",
        "100,100",
    )
    _ok(project, "distribute", "-s", "1", "a", "b", "m", "horizontal")
    xs = sorted(float(_el(project, i)["x"]) for i in ("a", "b", "m"))
    assert xs[0] == 0


def test_reroute_and_verify_flag_arrows_left_behind(project: Path) -> None:
    _ok(project, "connect", "-s", "1", "a", "b", "--id", "ab")
    path = project / "slides" / "drawn.svg"
    # b moved by hand (Inkscape, an agent's raw edit): the arrow stays behind.
    path.write_text(_svg(project).replace('x="700" y="400"', 'x="750" y="400"'))
    out = CliRunner().invoke(main, ["verify", "--deck", str(project / "deck.py")])
    assert "arrow #ab no longer meets b" in " ".join(out.output.split())
    assert "inkflow shape reroute" in out.output
    arrow = _objects(_ok(project, "list", "-s", "1", "--json"))["ab"]
    assert arrow["stale"] is True
    assert cast("dict[str, str]", arrow["ends"])["end"] == "b:left"
    _ok(project, "reroute", "-s", "1")
    assert _el(project, "ab")["d"] == "M300,150 L750,450"
    out = CliRunner().invoke(main, ["verify", "--deck", str(project / "deck.py")])
    assert "no longer meets" not in out.output


def test_sites_offer_more_connection_points(project: Path) -> None:
    _ok(project, "sites", "-s", "1", "b", "3")
    assert _el(project, "b")["sites"] == "3"
    # The nearest offered point now is a's right to b's left@0.75 (its upper third).
    _ok(project, "connect", "-s", "1", "a", "b")
    assert _el(project, "arrow")["connect-end"] == "b:left@0.75"
    _ok(project, "sites", "-s", "1", "b", "1")
    assert "sites" not in _el(project, "b")


# ── Changing things ────────────────────────────────────────────────────────────


def test_rename_carries_arrows_and_animations(project: Path) -> None:
    _ok(project, "connect", "-s", "1", "a", "b", "--id", "ab")
    _ok(project, "rename", "-s", "1", "a", "first")
    assert _el(project, "ab")["connect-start"] == "first:right"
    deck = (project / "deck.py").read_text(encoding="utf-8")
    assert "FadeIn('first')" in deck.replace('"', "'")
    result = _run(project, "rename", "-s", "1", "first", "b")
    assert result.exit_code != 0


def test_style_text_and_visibility(project: Path) -> None:
    _ok(project, "style", "-s", "1", "a", "--fill", "accent", "--stroke", "#ff0000")
    a = _el(project, "a")
    assert a["class"] == "inkflow-fill-accent"
    assert "stroke:#ff0000" in a["style"]
    assert _run(project, "style", "-s", "1", "a", "--fill", "chartreuse").exit_code != 0
    _ok(project, "text", "-s", "1", "label", "Bye")
    assert ">Bye</text>" in _svg(project)
    # Typing into a plain rect makes it a text zone.
    _ok(project, "text", "-s", "1", "b", "Inside")
    assert _el(project, "zone-text")["show-shape"] == "true"
    _ok(project, "hide", "-s", "1", "c")
    assert "display:none" in _el(project, "c")["style"]
    _ok(project, "show", "-s", "1", "c")
    assert "style" not in _el(project, "c")
    _ok(project, "lock", "-s", "1", "c")
    assert _el(project, "c")["locked"] == "true"
    _ok(project, "link", "-s", "1", "c", "2")
    assert '<a href="slide:intro">' in _svg(project)


def test_delete_duplicate_group_order(project: Path) -> None:
    _ok(project, "add", "textbox", "-s", "1", "--id", "note", "--text", "Note")
    _ok(project, "duplicate", "-s", "1", "note")
    md = (project / "slides" / "drawn.md").read_text(encoding="utf-8")
    assert "::note::" in md and "::note-2::" in md
    _ok(project, "delete", "-s", "1", "note-2")
    md = (project / "slides" / "drawn.md").read_text(encoding="utf-8")
    assert "::note-2::" not in md
    _ok(project, "group", "-s", "1", "a", "b")
    group = parse_svg(_svg(project)).find(".//{http://www.w3.org/2000/svg}g")
    assert group is not None and group.get("id") == "group"
    _ok(project, "ungroup", "-s", "1", "group")
    _ok(project, "order", "-s", "1", "a", "front")
    ids = [e.get("id") for e in parse_svg(_svg(project))]
    assert ids[-1] == "a"


def test_layout_objects_are_refused_like_in_the_editor(project: Path) -> None:
    result = _run(project, "move", "-s", "1", "logo", "--by", "1,1")
    assert result.exit_code != 0
    assert "layouts/plain.svg" in result.output
    assert "Edit layout" in result.output


# ── Batch, the server, the editor's slide ─────────────────────────────────────


BATCH = [
    {"add": "rect", "id": "x", "at": [100, 600], "size": [200, 100], "text": "X"},
    {"add": "rect", "id": "y", "at": [600, 800], "size": [200, 100], "text": "Y"},
    {"add": "rect", "id": "z", "at": [1100, 600], "size": [200, 100], "text": "Z"},
    {"connect": ["x", "y"], "style": "elbow"},
    {"connect": ["y", "z"], "style": "elbow"},
]


def test_batch_is_one_step_and_all_or_nothing(project: Path) -> None:
    deck_path = project / "deck.py"
    session = EditorSession(deck_path)
    session.built_hash = file_hash(deck_path.read_bytes())
    deck = load_deck(deck_path)
    before = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
    result = session.apply(
        {"action": "shape", "slide": 1, "commands": BATCH, "agent": "Diagram"}, deck
    )
    assert result["created"] == ["zone-x", "zone-y", "zone-z", "arrow", "arrow-2"]
    assert [s.label for s in session.history.done] == ["Agent: Diagram"]
    # One undo takes it all back: the slide's new drawing, Markdown, deck.py.
    session.apply({"action": "undo"}, deck)
    after = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
    assert after == before
    # A refused command leaves nothing behind.
    bad = [*BATCH, {"connect": ["x", "nowhere"]}]
    session.history.undone.clear()
    with pytest.raises(EditError, match="command 6"):
        session.apply({"action": "shape", "slide": 1, "commands": bad}, deck)
    after = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
    assert after == before
    assert not session.history.done and not session.history.undone


def test_batch_from_the_command_line(project: Path) -> None:
    out = _ok(project, "batch", "-s", "1", "--json", input=json.dumps(BATCH))
    data = cast("dict[str, list[str]]", json.loads(out[out.index("{") :]))
    assert data["created"][-1] == "arrow-2"
    assert _el(project, "arrow")["connect-end"] == "zone-y:left"
    listed = _ok(project, "list", "-s", "1")
    assert "zone-x  text in rect  100,600 200x100" in listed
    assert "zone-x:right -> zone-y:left" in listed


def test_commands_are_checked_before_anything_is_sent(project: Path) -> None:
    result = _run(project, "batch", "-s", "1", input='[{"add": "rect", "colour": 1}]')
    assert result.exit_code != 0 and "no option --colour" in result.output
    result = _run(project, "add", "rect")
    assert result.exit_code != 0 and "--slide" in result.output


def test_the_editors_slide_is_the_default(project: Path) -> None:
    context = project / ".inkflow" / "context.json"
    context.parent.mkdir()
    context.write_text(
        json.dumps(
            {
                "deck": str(project / "deck.py"),
                "slide": {"id": "drawn", "deckIndex": 0},
                "updatedAt": time.time(),
            }
        )
    )
    out = _ok(project, "add", "ellipse")
    assert "open in the editor" in out
    assert 'id="ellipse"' in _svg(project)


def test_a_drawio_diagrams_shapes_take_arrows(project: Path) -> None:
    (project / "diagrams").mkdir()
    shutil.copy(DATA / "flow.drawio.svg", project / "diagrams" / "flow.drawio.svg")
    _ok(
        project,
        "add",
        "image",
        "-s",
        "1",
        "--src",
        str(project / "diagrams" / "flow.drawio.svg"),
        "--drawio",
        "inline",
        "--id",
        "flow",
        "--at",
        "1000,600",
        "--size",
        "442,202",
    )
    _ok(project, "connect", "-s", "1", "a", "flow-client", "--to", "left")
    arrow = _el(project, "arrow")
    assert arrow["connect-end"] == "flow-client:left"
    # The cell's shape (a 160x70 rect at 0.5,0.5 in the picture's 442x202 page,
    # drawn 1:1 at 1000,600): its left side's middle.
    assert arrow["d"].endswith("L1000.5,635.5")
    flow = _objects(_ok(project, "list", "-s", "1", "--json"))["flow"]
    assert "flow-client" in cast("list[str]", flow["shapes"])
    # Moving the diagram takes the arrow along.
    _ok(project, "move", "-s", "1", "flow", "--by", "10,0")
    assert _el(project, "arrow")["d"].endswith("L1010.5,635.5")


def test_through_the_server_it_is_one_agent_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, port = served
    original = {p: p.read_bytes() for p in project.rglob("*") if p.is_file()}
    with connect(f"ws://127.0.0.1:{port}", proxy=None, max_size=None) as editor:
        editor.send(json.dumps({"type": "hello", "role": "editor"}))
        out = _ok(project, "batch", "-s", "1", input=json.dumps(BATCH))
        assert "Ctrl+Z in the editor" in out
        labels = [s.label for s in session.history.done]
        assert labels == ["Agent: 5 shape commands on slide 1 (drawn)"]
        while True:
            msg = cast("dict[str, object]", json.loads(editor.recv(timeout=10)))
            if msg["type"] == "agent-edit":
                break
        assert msg["label"] == labels[0]
        # The next command finds the server's build of the changed deck.py.
        _ok(project, "move", "-s", "1", "zone-y", "--by", "0,40")
        assert len(session.history.done) == 2
    deck = load_deck(project / "deck.py")
    session.apply({"action": "undo"}, deck)
    session.apply({"action": "undo", "step": msg["step"]}, deck)
    now = {
        p: p.read_bytes()
        for p in project.rglob("*")
        if p.is_file() and ".inkflow" not in p.parts
    }
    assert now == {p: d for p, d in original.items() if ".inkflow" not in p.parts}
