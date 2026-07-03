# pyright: reportPrivateUsage=none
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow.export import _find_chromium, build_pdf, build_static_html

# ── fixtures ──────────────────────────────────────────────────────────────────

_ASSET_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080">
      <image xlink:href="assets/pic.png" x="0" y="0" width="100" height="100"/>
      <image href="assets/pic2.png" x="0" y="0" width="100" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

_PLAIN_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

# Deck bodies (kept at module level so source lines stay short); each is spliced
# into `def main() -> Deck:` by _write_deck.
_ASSET_DECK = """\
return Deck(
    embed_fonts=False,
    slides=[
        Slide('slides/s.svg', zones={'content': '![cat](assets/cat.png)'}),
        Slide('slides/s.svg', zones={'content': Media('media/photo.png')}),
    ],
)"""

_REMOTE_DECK = """\
return Deck(
    embed_fonts=False,
    slides=[
        Slide('slides/s.svg', zones={'content': (
            '![remote](https://example.com/x.png)\\n\\n'
            '![data](data:image/png;base64,AAAA)'
        )}),
    ],
)"""

_EMPTY_DECK = """\
return Deck(
    embed_fonts=False,
    slides=[Slide('slides/s.svg', visible=False)],
)"""

_ONE_SLIDE_DECK = """\
return Deck(
    embed_fonts=False,
    slides=[Slide('slides/s.svg', zones={'content': 'hi'})],
)"""

# Placeholder asset bytes; the copy path only cares that the file exists.
_ASSET_BYTES = b"\x89PNG\r\n\x1a\n placeholder"


def _write_asset(project_dir: Path, rel: str) -> None:
    p = project_dir / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(_ASSET_BYTES)


def _write_slide(project_dir: Path, svg: str) -> None:
    p = project_dir / "slides" / "s.svg"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(svg, encoding="utf-8")


def _write_deck(project_dir: Path, body: str) -> Path:
    """Write a deck.py exposing main() -> Deck around `body`, return the deck path."""
    deck_path = project_dir / "deck.py"
    deck_path.write_text(
        "from inkflow import Deck, Media, Slide\n\n\n"
        + f"def main() -> Deck:\n{textwrap.indent(body, '    ')}\n",
        encoding="utf-8",
    )
    return deck_path


# ── F-023: asset copying ──────────────────────────────────────────────────────


class TestBuildCopiesAssets:
    def test_copies_media_markdown_and_svg_image_assets(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _ASSET_SLIDE_SVG)
        for rel in (
            "assets/pic.png",
            "assets/pic2.png",
            "assets/cat.png",
            "media/photo.png",
        ):
            _write_asset(tmp_path, rel)
        deck_path = _write_deck(tmp_path, _ASSET_DECK)

        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "index.html").exists()
        # SVG <image xlink:href> and <image href>
        assert (out_dir / "assets" / "pic.png").exists()
        assert (out_dir / "assets" / "pic2.png").exists()
        # markdown ![](...)
        assert (out_dir / "assets" / "cat.png").exists()
        # Media zone (already worked, must not regress)
        assert (out_dir / "media" / "photo.png").exists()

    def test_skips_remote_and_data_uri_refs(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        deck_path = _write_deck(tmp_path, _REMOTE_DECK)

        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "index.html").exists()
        # No stray files copied from URL/data refs.
        copied = [
            p for p in out_dir.rglob("*") if p.is_file() and p.name != "index.html"
        ]
        assert copied == []


# ── F-026: empty deck ─────────────────────────────────────────────────────────


class TestEmptyDeck:
    def test_static_html_handles_empty_deck(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        deck_path = _write_deck(tmp_path, _EMPTY_DECK)
        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)
        assert (out_dir / "index.html").exists()

    def test_pdf_refuses_empty_deck(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        deck_path = _write_deck(tmp_path, _EMPTY_DECK)
        # A truthy chromium path bypasses discovery; the guard fires before any
        # subprocess runs, so no browser is needed here.
        with pytest.raises(RuntimeError, match="no visible slides"):
            build_pdf(deck_path, tmp_path / "out.pdf", chromium="/does-not-run")


# ── PDF happy path (needs a browser) ──────────────────────────────────────────


class TestBuildPdf:
    @pytest.mark.skipif(_find_chromium() is None, reason="chromium not available")
    def test_produces_pdf_file(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        deck_path = _write_deck(tmp_path, _ONE_SLIDE_DECK)
        out = tmp_path / "out.pdf"
        build_pdf(deck_path, out, no_sandbox=True)
        assert out.exists()
        assert out.stat().st_size > 0
