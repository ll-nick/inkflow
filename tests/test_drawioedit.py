"""Editing a draw.io diagram's shapes on the slide (editor/drawioedit.py)."""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
from lxml import etree

from inkflow import drawio
from inkflow.editor.drawioedit import DiagramEditError, apply_cell_ops
from inkflow.svgio import SvgElement, parse_svg

# A real draw.io export: Client (40,40 160x70) -> Server (320,40 160x200),
# an arrow "e1" between them; the picture is cropped, Client drawn at 0,0.
FLOW = (Path(__file__).parent / "data" / "flow.drawio.svg").read_bytes()


def _cell(data: bytes, cell_id: str) -> drawio.Cell:
    return drawio.cells(drawio.source(data))[cell_id]


def _drawn(data: bytes, cell_id: str) -> SvgElement:
    found = parse_svg(data).find(f".//*[@data-cell-id='{cell_id}']")
    assert found is not None
    return found


def test_moving_a_shape_changes_its_geometry_and_its_drawing() -> None:
    out = apply_cell_ops(
        FLOW,
        [
            {
                "kind": "cell-geometry",
                "cell": "client",
                "x": 60,
                "y": 140,
                "width": 160,
                "height": 70,
                "offset": [-40, -40],
            }
        ],
    )
    assert _cell(out, "client").box == (60, 140, 160, 70)
    # Until draw.io redraws it, its drawing moves by the same amount.
    drawn = _drawn(out, "client")
    assert drawn.get("transform") == "matrix(1 0 0 1 20 100)"
    assert drawn.get("data-drawn-geometry") == "40 40 160 70"
    # A second move is relative to what the picture still draws.
    again = apply_cell_ops(
        out,
        [
            {
                "kind": "cell-geometry",
                "cell": "client",
                "x": 40,
                "y": 40,
                "width": 320,
                "height": 70,
                "offset": [-40, -40],
            }
        ],
    )
    assert _drawn(again, "client").get("transform") == "matrix(2 0 0 1 0 0)"
    # The other shapes and the source's own form are untouched.
    assert _cell(again, "server").box == (320, 40, 160, 200)
    assert drawio.is_drawio_svg(again)


def test_deleting_a_shape_takes_its_arrows() -> None:
    out = apply_cell_ops(FLOW, [{"kind": "cell-delete", "cell": "client"}])
    left = drawio.cells(drawio.source(out))
    assert "client" not in left and "e1" not in left and "server" in left
    picture = parse_svg(out)
    assert picture.find(".//*[@data-cell-id='client']") is None
    assert picture.find(".//*[@data-cell-id='e1']") is None


def test_label_and_colours() -> None:
    out = apply_cell_ops(
        FLOW,
        [
            {"kind": "cell-label", "cell": "client", "text": "Browser"},
            {
                "kind": "cell-style",
                "cell": "client",
                "key": "fillColor",
                "value": "#ff0000",
            },
            {"kind": "cell-style", "cell": "client", "key": "strokeWidth", "value": 3},
        ],
    )
    model = drawio.model(drawio.source(out))
    client = model.find(".//mxCell[@id='client']")
    assert client is not None and client.get("value") == "Browser"
    style = client.get("style") or ""
    assert "fillColor=#ff0000;" in style and "strokeWidth=3;" in style
    assert "#dae8fc" not in style
    drawn = etree.tostring(_drawn(out, "client"), encoding="unicode")
    assert ">Browser<" in drawn and ">Client<" not in drawn
    assert "fill: #ff0000" in drawn


@pytest.mark.parametrize(
    ("op", "message"),
    [
        ({"kind": "cell-delete", "cell": "e1"}, "no shape"),
        (
            {
                "kind": "cell-style",
                "cell": "client",
                "key": "fillColor",
                "value": "red;x=1",
            },
            "colour",
        ),
        (
            {"kind": "cell-style", "cell": "client", "key": "shape", "value": "x"},
            "cannot set",
        ),
        ({"kind": "duplicate", "cell": "client"}, "in draw.io"),
    ],
)
def test_refused(op: dict[str, object], message: str) -> None:
    with pytest.raises(DiagramEditError, match=message):
        apply_cell_ops(FLOW, [op])


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "diagrams").mkdir()
    (tmp_path / "diagrams" / "flow.drawio.svg").write_bytes(FLOW)
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "s.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        + ' viewBox="0 0 1920 1080"><image id="flow" inkflow:drawio="inline"'
        + ' inkflow:drawio-edit="shapes" href="../diagrams/flow.drawio.svg"'
        + ' x="100" y="100" width="442" height="202"/></svg>',
        encoding="utf-8",
    )
    (tmp_path / "deck.py").write_text(
        "from inkflow import Deck, Slide\n\n\n"
        + "def main() -> Deck:\n"
        + '    return Deck(slides=[Slide("slides/s.svg")], embed_fonts=False)\n',
        encoding="utf-8",
    )
    return tmp_path


def test_the_editor_gets_the_shapes_of_the_diagram(project: Path) -> None:
    from inkflow.editor.model import build_model
    from inkflow.pipeline import process_deck
    from inkflow.server import load_deck

    deck = load_deck(project / "deck.py")
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    root = parse_svg(slides[0]["svg"])
    client = root.find(".//*[@id='flow-client']")
    layer = root.find(".//*[@data-cell-id='1']")
    edge = root.find(".//*[@id='flow-e1']")
    assert client is not None and layer is not None and edge is not None
    key = int(client.get("data-ink", "").split(":")[0])
    assert client.get("data-ink") == f"{key}:#client"
    assert layer.get("data-ink") == f"{key}:#1"  # entered like a group
    assert edge.get("data-ink") is None  # draw.io's arrows are draw.io's
    assert client.get("data-cell-geometry") == "40 40 160 70"
    model = build_model(deck, project / "deck.py", slides)
    slide = cast("list[dict[str, object]]", model["slides"])[0]
    sources = cast("list[dict[str, object]]", slide["sources"])
    assert sources[key]["role"] == "diagram" and sources[key]["writable"]


def test_session_edits_a_diagram_and_redraws_it_in_one_step(project: Path) -> None:
    from inkflow.editor.session import EditError, EditorSession
    from inkflow.editor.svgops import file_hash
    from inkflow.server import load_deck

    session = EditorSession(project / "deck.py")
    deck = load_deck(project / "deck.py")
    diagram = project / "diagrams" / "flow.drawio.svg"
    slide = project / "slides" / "s.svg"
    original = (diagram.read_bytes(), slide.read_bytes())
    moved = session.apply(
        {
            "action": "svg",
            "file": str(diagram),
            "hash": file_hash(diagram.read_bytes()),
            "ops": [{"kind": "cell-delete", "cell": "client"}],
            "coalesce": "s1",
        },
        deck,
    )
    assert moved["ok"]
    assert "client" not in drawio.cells(drawio.source(diagram.read_bytes()))
    # draw.io's redraw: the picture takes the box given, into the same step.
    loaded = session.apply(
        {"action": "drawio-load", "path": "diagrams/flow.drawio.svg"}, None
    )
    redraw = {
        "action": "drawio-save",
        "path": "diagrams/flow.drawio.svg",
        "svg": diagram.read_text(),
        "expect": loaded["hash"],
        "image": {
            "file": str(slide),
            "hash": file_hash(slide.read_bytes()),
            "loc": "0:0",
        },
        "box": {"x": 380, "y": 100, "width": 162, "height": 202},
        "coalesce": "s1",
    }
    assert session.apply(redraw, deck)["ok"]
    assert 'x="380"' in slide.read_text() and 'width="162"' in slide.read_text()
    # A redraw of a source changed meanwhile is refused.
    with pytest.raises(EditError, match="changed meanwhile"):
        session.apply({**redraw, "expect": "stale"}, deck)
    session.apply({"action": "undo"}, deck)
    assert (diagram.read_bytes(), slide.read_bytes()) == original
