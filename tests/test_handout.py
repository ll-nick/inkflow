"""Handouts (inkflow.handout): the slides with their speaker notes."""

from __future__ import annotations

import re
import textwrap
from pathlib import Path

import pytest

from inkflow.export import build_handout_pdf, find_chromium
from inkflow.handout import handout_body, handout_page
from inkflow.pipeline import SlideData


def _slide(n: int, notes: str) -> SlideData:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg"'
        + f' id="inkflow-slide-{n}" viewBox="0 0 1920 1080"/>'
    )
    return {"id": f"s{n}", "title": f"Slide <{n}>", "svg": svg, "notes": notes}  # pyright: ignore[reportReturnType]


def test_each_slide_with_its_notes() -> None:
    body = handout_body([_slide(1, "<p>Say hi</p>"), _slide(2, "")], "compact")
    assert body.startswith('<main class="h-pages layout-compact">')
    assert body.count('class="h-item"') == 2
    assert "Slide &lt;1&gt;" in body  # the title escaped
    assert '<div class="h-notes"><p>Say hi</p></div>' in body
    assert '<div class="h-notes empty">No notes</div>' in body
    # In a .trim frame, which fit.js shrinks text in.
    assert '<div class="trim"><svg' in body


def test_the_page_its_paper_and_bar() -> None:
    page = handout_page(
        [_slide(1, "")], "/* deck */", title="Talk", data_theme="light", paper="letter"
    )
    assert "size: 8.5in 11in" in page and "/* deck */" in page
    assert 'data-theme="light"' in page and "h-bar" not in page.split("<body>")[1]
    viewed = handout_page(
        [_slide(1, "")], "", title="Talk", data_theme="", layout="nope", bar=True
    )
    assert "layout-notes" in viewed  # (an unknown layout is the default)
    assert '<option value="compact">' in viewed and "window.print()" in viewed


DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide, Inline

    def main() -> Deck:
        return Deck(slides=[
            Slide("a.svg", notes=Inline("First **note**")),
            Slide("a.svg", notes=Inline("Second")),
        ])
""")


@pytest.mark.skipif(find_chromium() is None, reason="no Chromium available")
def test_handout_pdf(tmp_path: Path) -> None:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "a.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + '<rect width="1920" height="1080" fill="#246"/></svg>',
        "utf-8",
    )
    (tmp_path / "deck.py").write_text(DECK, "utf-8")
    out = tmp_path / "handout.pdf"
    build_handout_pdf(tmp_path / "deck.py", out, no_sandbox=True)
    data = out.read_bytes()
    assert data.startswith(b"%PDF")
    assert len(re.findall(rb"/Type\s*/Page[^s]", data)) == 2
    assert b"/MediaBox [0 0 594.9" in data  # A4
