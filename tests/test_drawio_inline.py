"""A draw.io diagram drawn into its slide (``inkflow:drawio`` on its picture)."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from inkflow import Deck, Slide, animations
from inkflow.assets import AssetRoots
from inkflow.drawio_inline import inline_diagrams
from inkflow.fonts import extract_font_specs
from inkflow.logging import collect_logs
from inkflow.pipeline import process_deck
from inkflow.svgio import SvgElement, parse_svg, serialize_svg

# The source inside: two shapes, an arrow between them and its label.
MXFILE = (
    '&lt;mxfile compressed="false"&gt;&lt;diagram id="p"&gt;'
    + "&lt;mxGraphModel&gt;&lt;root&gt;"
    + '&lt;mxCell id="0"/&gt;&lt;mxCell id="1" parent="0"/&gt;'
    + '&lt;mxCell id="client" vertex="1" parent="1"/&gt;'
    + '&lt;UserObject id="note" label="code"&gt;'
    + '&lt;mxCell vertex="1" parent="1"/&gt;&lt;/UserObject&gt;'
    + '&lt;mxCell id="e1" edge="1" parent="1" source="client" target="note"/&gt;'
    + '&lt;mxCell id="e1-label" vertex="1" parent="e1"/&gt;'
    + "&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"
)

# Shaped like draw.io's own export: cells as <g data-cell-id>, an HTML label
# with an SVG <text> fallback, light-dark() colours, a root-id style rule.
DIAGRAM = (
    '<svg xmlns="http://www.w3.org/2000/svg" style="color-scheme: light dark;"'
    + ' width="442px" height="202px" viewBox="0 0 442 202" id="ge-svg-x"'
    + f' content="{MXFILE.replace(chr(34), "&quot;")}">'
    + "<style>#ge-svg-x { --ge-adaptive-bg: light-dark(#ffffff, #121212); }</style>"
    + '<defs><linearGradient id="grad"/></defs>'
    + '<g data-cell-id="0"><g data-cell-id="1">'
    + '<g data-cell-id="client"><rect width="160" height="70" fill="#dae8fc"'
    + ' stroke="#6c8ebf" style="fill: light-dark(rgb(218, 232, 252), rgb(29, 41, 59));'
    + ' stroke: light-dark(rgb(108, 142, 191), rgb(92, 121, 163));"/>'
    + '<switch><foreignObject width="100%" height="100%">'
    + '<div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Helvetica;'
    + ' color: light-dark(#000000, #ffffff);">Client</div></foreignObject>'
    + '<text font-family="Helvetica" fill="#000000">Client</text></switch></g>'
    + '<g data-cell-id="note"><rect width="100" height="40" fill="url(#grad)"/>'
    + '<text font-family="Courier New" fill="#ffffff">code</text></g>'
    + "</g></g></svg>"
)


def _project(tmp_path: Path) -> Path:
    (tmp_path / "diagrams").mkdir()
    (tmp_path / "diagrams" / "flow.drawio.svg").write_text(DIAGRAM, encoding="utf-8")
    return tmp_path


def _slide(mode: str | None, extra: str = 'id="flow" ') -> SvgElement:
    attr = f' inkflow:drawio="{mode}"' if mode else ""
    return parse_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        + ' viewBox="0 0 1920 1080">'
        + f'<image {extra}href="diagrams/flow.drawio.svg" x="100" y="200"'
        + f' width="884" height="404" data-ink="0:0" data-ink-top=""{attr}/></svg>'
    )


def test_a_picture_stays_a_picture(tmp_path: Path) -> None:
    root = inline_diagrams(_slide(None), AssetRoots(_project(tmp_path)))
    assert root[0].tag.endswith("image")


def test_drawn_on_the_slide(tmp_path: Path) -> None:
    root = inline_diagrams(_slide("inline"), AssetRoots(_project(tmp_path)))
    drawn = root[0]
    assert drawn.tag.endswith("}svg")
    # The picture's box, id and provenance: the editor moves it as the <image>.
    assert {k: drawn.get(k) for k in ("x", "y", "width", "height", "id")} == {
        "x": "100",
        "y": "200",
        "width": "884",
        "height": "404",
        "id": "flow",
    }
    assert drawn.get("viewBox") == "0 0 442 202"
    assert drawn.get("data-ink") == "0:0" and drawn.get("data-ink-tag") == "image"
    assert drawn.get("data-drawio") == "diagrams/flow.drawio.svg"
    assert "inkflow-diagram" in (drawn.get("class") or "")
    out = serialize_svg(root)
    # Each shape is named after its cell; every id is namespaced, references too.
    assert 'id="flow-client"' in out and 'id="flow-note"' in out
    assert 'id="flow-grad"' in out and 'fill="url(#flow-grad)"' in out
    # Which cells arrows can attach to: shapes, not layers (nor arrows).
    kinds = {
        el.get("data-cell-id"): el.get("data-cell-kind")
        for el in root.iter()
        if el.get("data-cell-id") is not None
    }
    assert kinds == {"0": "other", "1": "other", "client": "vertex", "note": "vertex"}
    assert "#flow { --ge-adaptive-bg" in out and "ge-svg-x" not in out
    assert "content=" not in out
    # draw.io's default font is the deck's; a font chosen in draw.io stays.
    assert "Helvetica" not in out
    assert "font-family: var(--inkflow-body-font)" in out
    assert 'font-family="Courier New"' in out
    # As drawn: draw.io's own colours (contract.css sets the colour scheme).
    assert "light-dark(rgb(218, 232, 252)" in out


def test_drawn_in_the_deck_theme(tmp_path: Path) -> None:
    root = inline_diagrams(_slide("themed"), AssetRoots(_project(tmp_path)))
    out = serialize_svg(root)
    # draw.io's blue: a tint for the area, the colour for its line.
    assert (
        "fill: color-mix(in srgb, var(--inkflow-blue) 25%, var(--inkflow-surface))"
        in out
    )
    assert "stroke: var(--inkflow-blue)" in out
    assert "color: var(--inkflow-text)" in out
    assert "light-dark(" not in out.split("</style>", 1)[1]
    # Presentation attributes cannot hold var(): moved into the style.
    assert 'fill="#dae8fc"' not in out and 'fill="#000000"' not in out
    assert "fill: var(--inkflow-text)" in out
    assert "fill: var(--inkflow-bg)" in out  # white text
    assert "font-family: var(--inkflow-mono-font)" in out
    assert "url(#flow-grad)" in out  # not a colour: left alone
    assert "--ge-adaptive-bg: var(--inkflow-bg)" in (root[0].get("style") or "")


def test_named_after_the_file_without_an_id(tmp_path: Path) -> None:
    root = inline_diagrams(_slide("inline", extra=""), AssetRoots(_project(tmp_path)))
    assert root[0].get("id") == "flow"
    assert root[0].find(".//*[@data-cell-id='client']").get("id") == "flow-client"  # pyright: ignore[reportOptionalMemberAccess]


@pytest.mark.parametrize("content", [None, "<svg not closed"])
def test_a_missing_or_broken_diagram_keeps_its_picture(
    tmp_path: Path, content: str | None
) -> None:
    if content is not None:
        (tmp_path / "diagrams").mkdir()
        (tmp_path / "diagrams" / "flow.drawio.svg").write_text(content)
    with collect_logs(logging.WARNING) as warnings:
        root = inline_diagrams(_slide("inline"), AssetRoots(tmp_path))
    assert root[0].tag.endswith("image")
    assert any("flow.drawio.svg" in w.message for w in warnings)


@pytest.mark.parametrize("editor", [False, True])
def test_the_deck_animates_its_shapes(tmp_path: Path, editor: bool) -> None:
    project = _project(tmp_path)
    (project / "slides").mkdir()
    (project / "slides" / "s.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        + ' viewBox="0 0 1920 1080"><image id="flow" inkflow:drawio="inline"'
        + ' href="../diagrams/flow.drawio.svg" x="0" y="0" width="442"'
        + ' height="202"/></svg>',
        encoding="utf-8",
    )
    deck = Deck(
        slides=[
            Slide(
                "slides/s.svg",
                animations=[animations.FadeIn("flow-client")],
            )
        ],
        embed_fonts=False,
    )
    with collect_logs(logging.WARNING) as warnings:
        slides = process_deck(deck, project, project / "deck.py", editor=editor)
    assert not warnings
    svg = slides[0]["svg"]
    client = parse_svg(svg).find(".//*[@id='flow-client']")
    assert client is not None and "anim-pending" in (client.get("class") or "")
    # The deck's font is embedded from its styles, never looked up by name.
    assert all(spec.family != "Helvetica" for spec in extract_font_specs(slides))
    assert all(
        not spec.family.startswith("var(") for spec in extract_font_specs(slides)
    )


def test_cell_kinds_from_the_source() -> None:
    from inkflow.drawio import cells

    found = cells(MXFILE.replace("&lt;", "<").replace("&gt;", ">"))
    assert {k: c.kind for k, c in found.items()} == {
        "0": "other",
        "1": "other",
        "client": "vertex",
        "note": "vertex",
        "e1": "edge",
        "e1-label": "label",
    }


def test_renaming_a_diagram_keeps_its_shapes_arrows_and_animations(
    tmp_path: Path,
) -> None:
    from inkflow.editor.provenance import child_path
    from inkflow.editor.session import EditorSession
    from inkflow.editor.svgops import SvgFile, file_hash

    project = _project(tmp_path)
    (project / "slides").mkdir()
    slide = project / "slides" / "s.svg"
    slide.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        + ' viewBox="0 0 1920 1080"><image id="flow" inkflow:drawio="inline"'
        + ' href="../diagrams/flow.drawio.svg" width="442" height="202"/>'
        + '<path id="a" d="M0 0L1 1" inkflow:connector="straight"'
        + ' inkflow:connect-start="flow:left" inkflow:connect-end="flow-client:top"/>'
        + "</svg>",
        encoding="utf-8",
    )
    (project / "deck.py").write_text(
        "from inkflow import Deck, Slide, animations\n\n\n"
        + "def main() -> Deck:\n"
        + "    return Deck(\n"
        + "        slides=[\n"
        + "            Slide(\n"
        + '                "slides/s.svg",\n'
        + '                animations=[animations.FadeIn("flow-client")],\n'
        + "            ),\n"
        + "        ],\n"
        + "    )\n",
        encoding="utf-8",
    )
    session = EditorSession(project / "deck.py")
    svg = SvgFile.from_bytes(slide, slide.read_bytes())
    image = svg.root.find(".//*[@id='flow']")
    assert image is not None
    from inkflow.server import load_deck

    result = session.apply(
        {
            "action": "svg",
            "file": str(slide),
            "hash": file_hash(slide.read_bytes()),
            "ops": [
                {
                    "kind": "id",
                    "loc": f"0:{child_path(image)}",
                    "id": "chart",
                    "from": "flow",
                }
            ],
        },
        load_deck(project / "deck.py"),
    )
    assert result["ok"]
    text = slide.read_text()
    assert 'inkflow:connect-start="chart:left"' in text
    assert 'inkflow:connect-end="chart-client:top"' in text
    assert 'FadeIn("chart-client")' in (project / "deck.py").read_text()
