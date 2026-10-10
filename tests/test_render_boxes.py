"""`inkflow render --boxes`: where the browser drew each element, in slide units."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.export import find_chromium
from inkflow.render import (
    ElementBox,
    Rect,
    RenderResult,
    SlideBoxes,
    parse_boxes,
    render_json,
    render_slides,
)


def test_parse_boxes_keeps_what_it_understands() -> None:
    raw = [
        {"id": "logo", "kind": "rect", "box": {"x": 1, "y": 2, "w": 3, "h": 4}},
        {
            "id": "zone-content",
            "kind": "zone",
            "box": {"x": 80, "y": 200, "w": 1760, "h": 800},
            "text": "Hello",
            "content": {"x": 80, "y": 204, "w": 600, "h": 120.5},
            "free": 679.5,
        },
        {
            "id": "zone-content/1",
            "kind": "p",
            "box": {"x": 80, "y": 204, "w": 600, "h": 40},
            "block": {"x": 80, "y": 200, "w": 1760, "h": 48},
            "depth": 1,
            "parent": "zone-content",
            "zone": "zone-content",
            "hidden": True,
        },
        {"id": "broken", "kind": "rect", "box": {"x": "a"}},
        {"kind": "rect"},
        "nonsense",
    ]
    boxes = parse_boxes(raw)
    assert [b.id for b in boxes] == ["logo", "zone-content", "zone-content/1"]
    assert boxes[0].box == Rect(1, 2, 3, 4)
    assert boxes[1].free == 679.5
    assert boxes[2].block == Rect(80, 200, 1760, 48)
    assert boxes[2].hidden
    assert parse_boxes(None) == []


def test_lines_are_terse_and_nested() -> None:
    zone = ElementBox(
        "zone-content",
        "zone",
        Rect(80, 200, 1760, 800),
        text="Hello",
        content=Rect(80, 204, 600, 120.5),
        free=679.5,
    )
    block = ElementBox(
        "zone-content/1", "p", Rect(80, 204, 600, 40), depth=1, text="Hello"
    )
    slide = SlideBoxes(2, "intro", 1920, 1080, [zone, block])
    assert slide.text().splitlines() == [
        "slide 2 (intro): 1920x1080",
        'zone-content  80,200 1760x800  zone  "Hello"  content 600x120.5, free 679.5',
        '  zone-content/1  80,204 600x40  p  "Hello"',
    ]


def test_render_json_carries_boxes_and_messages() -> None:
    result = RenderResult(
        slides=[1],
        boxes=[
            SlideBoxes(1, "a", 100, 50, [ElementBox("x", "rect", Rect(0, 0, 1, 1))])
        ],
    )
    text = json.dumps(render_json(result))
    assert '"box": {"x": 0, "y": 0, "w": 1, "h": 1}' in text
    assert '"findings": []' in text


# ── the command ───────────────────────────────────────────────────────────────

_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "slide.svg",
                    zones={
                        "content": "# Title\\n\\nA paragraph.\\n\\n- one\\n- two",
                        "side": "\\n\\n".join(["A paragraph of text."] * 14),
                    },
                ),
            ],
        )
""")
_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#fff"/>
      <rect id="zone-content" x="100" y="100" width="800" height="600"/>
      <rect id="zone-side" x="1000" y="100" width="800" height="200"/>
      <g id="group" transform="translate(100 50)">
        <rect id="logo" x="1700" y="850" width="100" height="100" fill="red"/>
      </g>
      <text id="label" x="100" y="900" font-size="40">Label text</text>
    </svg>
""")


@pytest.fixture
def deck(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "slide.svg").write_text(_SVG)
    (tmp_path / "deck.py").write_text(_DECK)
    return tmp_path / "deck.py"


def test_boxes_alone_write_no_images(
    monkeypatch: pytest.MonkeyPatch, deck: Path
) -> None:
    calls: list[dict[str, object]] = []

    def spy(_path: Path, numbers: object, output: object, **kw: object) -> RenderResult:
        calls.append({"numbers": numbers, "output": output, **kw})
        box = ElementBox("logo", "rect", Rect(1800, 900, 100, 100))
        return RenderResult(slides=[1], boxes=[SlideBoxes(1, "s", 1920, 1080, [box])])

    monkeypatch.setattr("inkflow.cli.agent.render_slides", spy)
    result = CliRunner().invoke(main, ["render", "--deck", str(deck), "--boxes"])
    assert result.exit_code == 0, result.output
    assert calls[0]["output"] is None
    assert calls[0]["boxes"] is True
    assert "logo  1800,900 100x100  rect" in result.output
    result = CliRunner().invoke(
        main, ["render", "--deck", str(deck), "--boxes", "--sheet"]
    )
    assert result.exit_code == 2


needs_chromium = pytest.mark.skipif(
    find_chromium() is None, reason="no Chromium available"
)


@needs_chromium
def test_boxes_measure_the_rendered_slide(deck: Path) -> None:
    result = render_slides(deck, [1], None, boxes=True, no_sandbox=True)
    boxes = {b.id: b for b in result.boxes[0].elements}
    # After the group's transform, in slide units.
    assert boxes["logo"].box == Rect(1800, 900, 100, 100)
    assert boxes["logo"].parent == "group"
    assert boxes["label"].text == "Label text"
    assert boxes["label"].box.h > 30
    content = boxes["zone-content"]
    assert content.kind == "zone"
    assert content.free is not None and content.content is not None
    assert 0 < content.content.h < 600
    assert content.free == pytest.approx(600 - content.content.h, abs=0.2)
    blocks = [b for b in result.boxes[0].elements if b.zone == "zone-content"]
    assert [b.kind for b in blocks] == ["h1", "p", "list"]
    assert blocks[1].text == "A paragraph."
    # The text's extent, not the paragraph's full width.
    assert blocks[1].block is not None
    assert blocks[1].box.w < blocks[1].block.w
    # Glyphs may reach a hair past a line box tighter than the font's own
    # ascent and descent (Inter's 1.21 em against a 1.2 heading line).
    assert all(b.box.y >= 99 for b in blocks)
    # Too much text: negative free space.
    side = boxes["zone-side"]
    assert side.free is not None and side.free < 0


@needs_chromium
def test_outline_adds_boxes(deck: Path) -> None:
    result = CliRunner().invoke(
        main, ["outline", "--deck", str(deck), "-s", "1", "--boxes"]
    )
    assert result.exit_code == 0, result.output
    assert "boxes (as rendered, slide units):" in result.output
    assert "logo  1800,900 100x100  rect" in result.output
    result = CliRunner().invoke(main, ["outline", "--deck", str(deck), "--boxes"])
    assert result.exit_code == 2
