"""``inkflow anim``: a slide's click timeline as the build resolves it, and
changes to ``animations=[...]`` through the session's own ``anim`` action
(offline, or as one undoable "Agent: …" step on the server that has the deck
open)."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner, Result

from inkflow import instances
from inkflow.animations import FadeIn, Highlight, SlideIn
from inkflow.cli import main
from inkflow.editor.session import EditorSession
from inkflow.enums import Direction, Trigger
from inkflow.server import load_deck
from tests import test_slides_cli as slides_tests

# The deck served as `inkflow edit` would, from the `inkflow slide` tests.
served = slides_tests.served

DECK = textwrap.dedent("""\
    from dataclasses import dataclass

    from inkflow import Chart, Deck, Slide, Trigger, animations


    @dataclass
    class Glow(animations.Emphasis):
        strength: float = 1.0


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "drawn.svg",
                    md="drawn.md",
                    zones={"chart": Chart(data={"q": [1, 2], "sales": [3, 4]})},
                    animations=[
                        animations.FadeIn("box"),
                        animations.SlideIn("label", Trigger.WITH_PREVIOUS),
                    ],
                ),
                Slide("drawn.svg", id="plain"),
            ],
        )
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-content" x="80" y="60" width="800" height="600"/>
      <rect id="zone-chart" x="1000" y="60" width="800" height="600"/>
      <rect id="box" x="100" y="800" width="200" height="100"/>
      <text id="label" x="400" y="850">Label</text>
    </svg>
""")

MD = "First point\n\n::step::\n\nSecond point\n\n::step::\n\nThird point\n"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    (tmp_path / "slides" / "drawn.md").write_text(MD, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _run(project: Path, *args: str) -> Result:
    return CliRunner().invoke(main, ["anim", *args, "--deck", str(project / "deck.py")])


def _ok(project: Path, *args: str) -> str:
    result = _run(project, *args)
    assert result.exit_code == 0, result.output
    return result.output


def _anims(project: Path, slide: int = 0) -> list[object]:
    return list(load_deck(project / "deck.py").slides[slide].animations)


def _rows(out: str) -> list[list[str]]:
    """The timeline's rows: click, #, animation… (header and notes left out)."""
    return [
        line.split()
        for line in out.splitlines()
        if line.startswith("  ") and line.split()[0].isdigit()
    ]


def test_list_numbers_reveals_then_deck_animations(project: Path) -> None:
    out = _ok(project, "list", "-s", "1")
    assert out.splitlines()[0] == "slide 1 (drawn): 3 clicks"
    rows = _rows(out)
    assert [r[:2] for r in rows] == [["1", "-"], ["2", "-"], ["3", "1"], ["3", "2"]]
    assert rows[0][2:4] == ["FadeIn", "zone-content"]
    assert '"Second point"' in out
    assert rows[2][2:4] == ["FadeIn", "#box"]
    assert rows[3][2:5] == ["SlideIn", "#label", "with"]
    data = cast(
        "dict[str, object]", json.loads(_ok(project, "list", "-s", "1", "--json"))
    )
    assert data["clicks"] == 3
    steps = cast("list[dict[str, object]]", data["steps"])
    assert [s["source"] for s in steps] == ["md", "md", "deck.py", "deck.py"]
    assert _ok(project, "list", "-s", "plain").strip().endswith("nothing animated")


def test_add_validates_type_and_target(project: Path) -> None:
    out = _ok(
        project,
        "add",
        "slide-in",
        "box",
        "-s",
        "1",
        "--trigger",
        "after",
        "--duration",
        "250",
        "--direction",
        "up",
        "--at",
        "1",
    )
    assert "Done  Add SlideIn on box to slide 1 (drawn)" in out
    assert _anims(project)[0] == SlideIn(
        "box", Trigger.AFTER_PREVIOUS, duration=0.25, direction=Direction.UP
    )
    # The new timeline follows the change.
    assert _rows(out)[2][1:5] == ["1", "SlideIn", "direction=up", "#box"]

    bad = _run(project, "add", "FadeInn", "box", "-s", "1")
    assert bad.exit_code == 2
    assert "did you mean FadeIn" in bad.output
    bad = _run(project, "add", "FadeIn", "bx", "-s", "1")
    assert bad.exit_code == 2
    assert "no element 'bx'" in bad.output and "box" in bad.output
    bad = _run(project, "add", "FadeIn", "box", "-s", "1", "--direction", "up")
    assert bad.exit_code == 2
    assert "FadeIn has no direction" in bad.output


def test_add_targets_chart_series_and_custom_types(project: Path) -> None:
    _ok(project, "add", "FadeIn", "chart-series-sales", "-s", "1")
    _ok(project, "add", "Glow", "#label", "-s", "1", "--set", "strength=2.5")
    anims = _anims(project)
    assert cast("FadeIn", anims[2]).element == "chart-series-sales"
    assert type(anims[3]).__name__ == "Glow"
    assert getattr(anims[3], "strength") == 2.5  # noqa: B009
    assert 'Glow("label", strength=2.5)' in (project / "deck.py").read_text()


def test_set_changes_what_it_is_told(project: Path) -> None:
    _ok(project, "set", "2", "-s", "1", "--trigger", "click", "--delay", "0.5s")
    assert _anims(project)[1] == SlideIn("label", delay=0.5)
    _ok(project, "set", "1", "-s", "1", "--type", "Highlight", "--trigger", "at:5")
    assert _anims(project)[0] == Highlight("box", Trigger.at(5), duration=0.4)
    assert _run(project, "set", "1", "-s", "1").exit_code == 2  # nothing to change
    assert _run(project, "set", "9", "-s", "1", "--trigger", "with").exit_code == 2


def test_move_and_remove(project: Path) -> None:
    _ok(project, "move", "2", "--to", "1", "-s", "1")
    assert [cast("FadeIn", a).element for a in _anims(project)] == ["label", "box"]
    out = _ok(project, "remove", "1", "2", "-s", "1")
    assert "Remove animations 1, 2 from slide 1 (drawn)" in out
    assert _anims(project) == []
    assert "animations=" not in (project / "deck.py").read_text()


def test_through_the_server_it_is_an_undoable_agent_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, _ = served
    before = (project / "deck.py").read_text()
    out = _ok(project, "remove", "1", "2", "-s", "drawn")
    assert "Ctrl+Z in the editor" in out
    assert [s.label for s in session.history.done] == [
        "Agent: Remove animations 1, 2 from slide 1 (drawn)"
    ]
    session.apply({"action": "undo"}, load_deck(project / "deck.py"))
    assert (project / "deck.py").read_text() == before
