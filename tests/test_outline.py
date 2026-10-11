"""``inkflow outline``: the deck overview an agent reads instead of every file."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.editor.outline import build_outline, format_outline
from inkflow.pipeline import process_deck
from inkflow.server import load_deck

DRAWING = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="two" viewBox="0 0 1600 900">
      <g id="boxes">
        <rect id="box-a" x="100" y="300" width="200" height="100"/>
        <text id="label-a" x="120" y="360">Alpha</text>
      </g>
      <rect id="rect12" x="0" y="0" width="10" height="10"/>
      <rect id="zone-note" x="900" y="300" width="500" height="200"/>
    </svg>
""")

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
      <rect width="1600" height="900" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1440" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1440" height="600"/>
    </svg>
""")

TEXT_MD = textwrap.dedent("""\
    # Plan

    First point

    ::step::

    Second point, which is long enough that the outline has to cut it short
""")

DECK = textwrap.dedent("""\
    from inkflow import Chart, Deck, Image, Slide, TextBox, Trigger, animations
    from inkflow import transitions


    def main() -> Deck:
        return Deck(
            slides=[
                Slide(
                    "drawing.svg",
                    notes="notes/drawing.md",
                    zones={"note": TextBox("A boxed note"), "title": "# Drawn"},
                    animations=[
                        animations.FadeIn("box-a"),
                        animations.FadeIn("label-a", Trigger.WITH_PREVIOUS),
                    ],
                    transition=transitions.Push(),
                ),
                Slide("two", md="plan.md"),
                Slide(
                    "two",
                    zones={
                        "title": "# Numbers",
                        "content": Chart(data={"q": ["a", "b"], "n": [1, 2]}),
                    },
                ),
                Slide("two", zones={"content": Image("pic.png")}, visible=False),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for name in ("slides", "layouts", "notes"):
        (tmp_path / name).mkdir()
    (tmp_path / "slides" / "drawing.svg").write_text(DRAWING, encoding="utf-8")
    (tmp_path / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "plan.md").write_text(TEXT_MD, encoding="utf-8")
    (tmp_path / "notes" / "drawing.md").write_text("Speak.\n", encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _run(*args: str) -> str:
    result = CliRunner().invoke(main, ["outline", *args])
    assert result.exit_code == 0, result.output
    return result.output


def test_text_outline_names_every_slide_and_zone(project: Path) -> None:
    text = _run("-d", str(project / "deck.py"))
    lines = text.splitlines()
    assert lines[0].startswith("deck.py: 3 slides (+1 hidden), 1600x900")
    assert "1. drawing  slides[0]  Push()" in text
    assert "  svg slides/drawing.svg < two  notes notes/drawing.md" in text
    # Zones in reading order, with where each one is written.
    first = text.split("\n\n")[1]
    assert [ln.split()[0] for ln in first.splitlines()[2:5]] == [
        "title",
        "content",
        "note",
    ]
    assert "  title   deck.py # Drawn" in first
    assert "  content empty" in first
    assert "  note    deck.py TextBox A boxed note" in first
    assert "anims 2, 1 click: fade-in box-a, +fade-in label-a" in first
    # Markdown zones: a preview cut at the limit, and the reveal counted.
    assert "  layout two  md slides/plan.md" in text
    assert "  title   md      # Plan" in text
    content = next(ln for ln in lines if ln.startswith("  content md"))
    assert content.endswith("… (1 reveal)")
    assert "1 click" in text
    assert "  content deck.py chart inline data bar" in text
    assert "-. two  slides[3] HIDDEN" in text
    assert "  content deck.py image pic.png" in text


def test_one_slide_in_detail(project: Path) -> None:
    text = _run("-d", str(project / "deck.py"), "--slide", "1")
    assert text.startswith("1. drawing")
    assert "  canvas 1600x900" in text
    assert "  content empty   @80,200 1440x600" in text
    assert "  note    deck.py @900,300 500x200 TextBox" in text
    assert "      A boxed note" in text
    assert '    1: FadeIn("box-a")' in text
    assert '    1: FadeIn("label-a", Trigger.WITH_PREVIOUS)' in text
    # Named ids of the slide's own SVG, nested; made-up and zone ids left out.
    assert '  ids: boxes{box-a label-a="Alpha"}' in text
    assert "rect12" not in text
    assert "notes: Speak." in text
    detail = _run("-d", str(project / "deck.py"), "-s", "2")
    assert "Second point, which is long enough" in detail
    assert "      ::step::" in detail


def test_missing_slide_is_an_error(project: Path) -> None:
    result = CliRunner().invoke(
        main, ["outline", "-d", str(project / "deck.py"), "-s", "9"]
    )
    assert result.exit_code != 0
    assert "no slide 9" in result.output


def test_json_shape(project: Path) -> None:
    data = cast(
        "dict[str, object]", json.loads(_run("-d", str(project / "deck.py"), "--json"))
    )
    assert data["canvas"] == [1600, 900]
    assert data["transition"] == "Cut()"
    slides = cast("list[dict[str, object]]", data["slides"])
    assert [s["number"] for s in slides] == [1, 2, 3, None]
    first = slides[0]
    assert first["layout"] == ["two"]
    assert first["steps"] == 1
    zones = {
        cast("str", z["name"]): z
        for z in cast("list[dict[str, object]]", first["zones"])
    }
    assert zones["note"]["kind"] == "textbox"
    assert zones["note"]["box"] == [900, 300, 500, 200]
    assert zones["content"]["origin"] == "empty"
    anims = cast("list[dict[str, object]]", first["animations"])
    assert [(a["element"], a["step"]) for a in anims] == [("box-a", 1), ("label-a", 1)]
    plan = slides[1]
    assert plan["md"] == "slides/plan.md"
    plan_zones = cast("list[dict[str, object]]", plan["zones"])
    assert [(z["name"], z["reveals"]) for z in plan_zones] == [
        ("title", 0),
        ("content", 1),
    ]
    chart = cast("list[dict[str, object]]", slides[2]["zones"])[1]
    assert (chart["kind"], chart["src"]) == ("chart", "inline data")
    hidden = slides[3]
    assert hidden["hidden"] is True
    one = cast(
        "dict[str, object]",
        json.loads(_run("-d", str(project / "deck.py"), "--json", "-s", "2")),
    )
    assert one["id"] == "plan"


def test_markdown_animations_continue_after_reveals(project: Path) -> None:
    """deck.py animations number after the Markdown reveals, as the build does."""
    deck_py = project / "deck.py"
    deck_py.write_text(
        DECK.replace(
            'Slide("two", md="plan.md")',
            'Slide("two", md="plan.md", animations=[animations.FadeIn("zone-title")])',
        ),
        encoding="utf-8",
    )
    deck = load_deck(deck_py)
    outline = build_outline(
        deck, deck_py, process_deck(deck, project, deck_py, editor=True)
    )
    plan = outline.slides[1]
    assert [c.step for c in plan.animations] == [2]
    assert plan.steps == 2
    assert "anims 1, 2 clicks: fade-in zone-title" in format_outline(outline)
