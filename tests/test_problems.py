"""Each slide's problems for the editor's marks (editor/problems.py)."""

from __future__ import annotations

import textwrap
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import pytest

from inkflow.editor.comparesrc import build_side
from inkflow.editor.problems import Problems
from inkflow.export import find_chromium
from inkflow.incremental import set_keys
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData
from inkflow.render import check_built
from inkflow.server import load_deck

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide

    def main() -> Deck:
        return Deck(
            slides=[
                Slide("one.svg", zones={"nope": "text"}),
                Slide("two.svg"),
            ],
        )
""")

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#123"/>
  {body}
</svg>
"""

_modules = iter(range(10_000))


def _deck(tmp_path: Path, two: str = "") -> Path:
    (tmp_path / "slides").mkdir(exist_ok=True)
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    (tmp_path / "slides" / "one.svg").write_text(SVG.format(body=""), "utf-8")
    (tmp_path / "slides" / "two.svg").write_text(SVG.format(body=two), "utf-8")
    return tmp_path / "deck.py"


def _build(deck_py: Path) -> tuple[Deck, list[SlideData], dict[str, object]]:
    side = build_side(deck_py, f"_problems_{next(_modules)}", load_deck)
    entries: list[dict[str, object]] = side.model["slides"]  # pyright: ignore[reportAssignmentType]
    set_keys(entries)
    return side.deck, side.slides, side.model


def _marks(
    problems: Problems, model: dict[str, object], slides: list[SlideData]
) -> list[list[dict[str, object]]]:
    return cast("list[list[dict[str, object]]]", problems.json(model, slides)["slides"])


def test_verify_marks_a_slide_and_keeps_what_did_not_change(tmp_path: Path) -> None:
    deck, slides, model = _build(_deck(tmp_path))
    problems = Problems()
    problems.verify(deck, tmp_path, model, "h1")
    msg = problems.json(model, slides)
    marks = _marks(problems, model, slides)
    assert [len(m) for m in marks] == [1, 0]
    assert marks[0][0]["level"] == "error"
    assert "zone-nope" in str(marks[0][0]["message"])
    assert msg["layout"] == {
        "on": False,
        "contrast": False,
        "running": False,
        "error": None,
    }
    # Same entries, same deck.py: nothing checked again.
    kept = dict(problems.verified)
    problems.verify(deck, tmp_path, model, "h1")
    assert problems.verified == kept
    # Another deck.py: checked again, the old results forgotten.
    problems.verify(deck, tmp_path, model, "h2")
    assert all(k.startswith("h2:") for k in problems.verified)


@dataclass(frozen=True)
class _Finding:
    kind: str
    is_problem: bool
    said: str

    def message(self) -> str:
        return f"slide 2 (two): text: {self.said}"


def test_layout_findings_by_slide_svg(tmp_path: Path) -> None:
    deck, slides, model = _build(_deck(tmp_path))
    asked: list[tuple[list[int], bool]] = []

    def check(
        deck: Deck,
        project_dir: Path,
        slides: list[SlideData],
        indices: list[int],
        *,
        contrast: bool = False,
        chromium: str | None = None,
        no_sandbox: bool = False,
    ) -> Mapping[int, Sequence[_Finding]]:
        _ = (deck, project_dir, slides, chromium, no_sandbox)
        asked.append((indices, contrast))
        return {i: [_Finding("small-text", False, "too small")] for i in indices}

    problems = Problems(layout_on=True)
    problems.verify(deck, tmp_path, model, "h")
    problems.measure(deck, tmp_path, slides, check)
    problems.measure(deck, tmp_path, slides, check)
    assert asked == [([0, 1], False)]  # (the second time: nothing new)
    marks = _marks(problems, model, slides)
    assert marks[1] == [
        {
            "level": "hint",
            "message": "text: too small",
            "source": "layout",
            "kind": "small-text",
        }
    ]
    # Contrast on is another measurement.
    problems.contrast = True
    problems.measure(deck, tmp_path, slides, check)
    assert asked[-1] == ([0, 1], True)


def test_a_failing_check_is_said(tmp_path: Path) -> None:
    deck, slides, _ = _build(_deck(tmp_path))

    def broken(*_a: object, **_k: object) -> Mapping[int, Sequence[_Finding]]:
        raise RuntimeError("Chromium not found")

    problems = Problems(layout_on=True)
    problems.measure(deck, tmp_path, slides, broken)
    assert problems.error == "Chromium not found"


@pytest.mark.skipif(find_chromium() is None, reason="no Chromium available")
def test_check_built_finds_an_object_outside_the_slide(tmp_path: Path) -> None:
    body = '<rect id="far" x="2100" y="100" width="200" height="100" fill="#fff"/>'
    deck, slides, model = _build(_deck(tmp_path, body))
    problems = Problems(layout_on=True)
    problems.verify(deck, tmp_path, model, "h")
    problems.measure(deck, tmp_path, slides, check_built)
    assert problems.error is None
    marks = _marks(problems, model, slides)
    assert any(m["kind"] == "outside" for m in marks[1])
    assert not [m for m in marks[0] if m["source"] == "layout"]
