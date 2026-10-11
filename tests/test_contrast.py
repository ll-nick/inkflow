"""Text contrast in `inkflow render`: text against what is actually behind it."""

from __future__ import annotations

import struct
import textwrap
import zlib
from pathlib import Path

import pytest

from inkflow.export import find_chromium
from inkflow.render import Finding, parse_findings, render_slides, summary


def _contrast(ratio: float, needs: float, **kw: object) -> Finding:
    raw = {
        "kind": "contrast",
        "target": "#label",
        "ratio": ratio,
        "needs": needs,
        "color": "#777777",
        "background": "#888888",
        "text": "Some text",
        **kw,
    }
    found = parse_findings(4, "x", [raw])
    assert len(found) == 1
    return found[0]


def test_low_contrast_is_a_problem_and_says_what_it_needs() -> None:
    f = _contrast(2.1, 4.5)
    assert f.is_problem
    assert f.message() == (
        "slide 4 (x): #label: contrast 2.1:1 against its background"
        + ' (needs 4.5:1): #777777 on #888888 "Some text"'
    )


def test_between_three_and_four_and_a_half_is_a_hint() -> None:
    f = _contrast(3.8, 4.5)
    assert not f.is_problem
    assert summary([f], 1) == "1 hint in 1 slide"


# ── in Chromium ───────────────────────────────────────────────────────────────


def _png(pixels: list[list[tuple[int, int, int]]]) -> bytes:
    """A tiny RGB PNG, rows of pixels."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    height, width = len(pixels), len(pixels[0])
    raw = b"".join(b"\0" + bytes(c for px in row for c in px) for row in pixels)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


_SLIDE = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#ffffff"/>
      <text id="fine" x="40" y="80" font-size="40" fill="#000000">Black on white</text>
      <rect x="600" y="30" width="500" height="70" fill="#777777"/>
      <text id="grey" x="620" y="75" font-size="20" fill="#888888">Grey on grey</text>
      <text id="faint" x="1200" y="80" font-size="20" fill="#8a8a8a">Faint body</text>
      <text id="faint-big" x="1200" y="160" font-size="64" fill="#8a8a8a">Big</text>
      <rect x="40" y="200" width="380" height="34" rx="17" fill="#202020"/>
      <text id="pill" x="60" y="229" font-size="40" fill="#ffffff">Label pill</text>
      <image x="600" y="180" width="600" height="120" preserveAspectRatio="none"
             href="half.png"/>
      <text id="photo" x="640" y="260" font-size="60" fill="#ffffff">Over a photo</text>
      <rect x="1250" y="200" width="600" height="100" fill="#000000"/>
      <text id="faded" x="1280" y="270" font-size="40" fill="#ffffff"
            opacity="0.25">Faded</text>
      <text id="halo" x="40" y="420" font-size="60" fill="#ffffff" stroke="#000000"
            stroke-width="6" paint-order="stroke">Haloed</text>
      <text id="bolder" x="600" y="420" font-size="40" fill="#222222"
            stroke="#222222" stroke-width="3">Stroked bolder</text>
      <rect x="40" y="500" width="900" height="120" class="inkflow-fill-bg"/>
      <text id="themed-on-bg" x="60" y="580" font-size="40"
            class="inkflow-fill-text-muted">Muted on the theme background</text>
      <text id="emoji" x="1200" y="580" font-size="60">✏️</text>
      <rect id="zone-content" x="40" y="700" width="900" height="300"/>
      <image x="1000" y="700" width="880" height="300" preserveAspectRatio="none"
             href="half.png"/>
      <rect id="zone-side" x="1000" y="700" width="880" height="300"/>
    </svg>
""")

_DECK = textwrap.dedent("""\
    from inkflow import ColorMode, Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            mode=ColorMode.{mode},
            slides=[
                Slide(
                    "slide.svg",
                    zones={{
                        "content": 'Plain text, <span style="color:#f4f4f4">'
                        + "almost invisible</span>.",
                        "side": '<span style="color:#4c4f69;background:#e6e9ef;'
                        + 'text-shadow:0 2px 12px rgba(0,0,0,0.45)">'
                        + "Dark text on a light box, over a photo</span>",
                    }},
                ),
            ],
        )
""")

needs_chromium = pytest.mark.skipif(
    find_chromium() is None, reason="no Chromium available"
)


def _deck(root: Path, mode: str) -> Path:
    (root / "slides").mkdir()
    (root / "slides" / "slide.svg").write_text(_SLIDE, encoding="utf-8")
    black, white = (0, 0, 0), (255, 255, 255)
    (root / "slides" / "half.png").write_bytes(_png([[black, white]] * 2))
    (root / "deck.py").write_text(_DECK.format(mode=mode), encoding="utf-8")
    return root / "deck.py"


@needs_chromium
@pytest.mark.parametrize("mode", ["LIGHT", "DARK"])
@pytest.mark.parametrize("scale", [0.5, 1.0])
def test_contrast_against_what_is_behind_the_text(
    tmp_path: Path, mode: str, scale: float
) -> None:
    deck = _deck(tmp_path, mode)
    result = render_slides(deck, [1], None, scale=scale, no_sandbox=True)
    found = {f.target: f for f in result.findings if f.kind == "contrast"}
    # Too low anywhere: grey on grey, white over the light half of a photo,
    # faded text, and HTML text in a zone.
    assert found["#grey"].is_problem
    assert found["#grey"].ratio < 1.5
    assert found["#grey"].needs == 4.5
    assert found["#photo"].is_problem
    assert found["#faded"].is_problem
    assert found["#zone-content"].is_problem
    assert found["#zone-content"].text == "almost invisible"
    # Between 3:1 and 4.5:1: a hint for body text, fine for large text.
    assert not found["#faint"].is_problem
    assert found["#faint"].needs == 4.5
    assert "#faint-big" not in found
    # Fine: a label whose box sticks out of its pill, a halo, a stroke that
    # only makes text bolder, theme tokens in either mode, an emoji, and text
    # on a box over a photo with a shadow of its own.
    fines = ("#fine", "#pill", "#halo", "#bolder", "#themed-on-bg", "#emoji")
    for fine in (*fines, "#zone-side"):
        assert fine not in found, found[fine].message()
    assert set(found) == {"#grey", "#photo", "#faded", "#zone-content", "#faint"}


@needs_chromium
def test_contrast_can_be_skipped(tmp_path: Path) -> None:
    deck = _deck(tmp_path, "LIGHT")
    result = render_slides(deck, [1], None, no_sandbox=True, contrast=False)
    assert not any(f.kind == "contrast" for f in result.findings)
