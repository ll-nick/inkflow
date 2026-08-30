# pyright: reportPrivateUsage=none
from __future__ import annotations

import logging
import textwrap
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.export import _find_chromium, build_pdf, build_static_html
from inkflow.logging import collect_logs

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

# An <image> href as an SVG editor writes it: resolved relative to the slide
# file, so a slide in slides/ points one level up at the shared assets dir.
_ESCAPING_ASSET_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080">
      <image xlink:href="../assets/pic.png" x="0" y="0" width="100" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

# A reference that leaves the project entirely: no root can hold it.
_OUTSIDE_ASSET_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080">
      <image xlink:href="../../outside/pic.png" x="0" y="0" width="1" height="1"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

# A theme layout referencing its own branding, relative to the layout file.
_THEME_LAYOUT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080">
      <image xlink:href="../logo.png" x="0" y="0" width="100" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

_MISSING_ASSET_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1920 1080">
      <image xlink:href="assets/missing.png" x="0" y="0" width="100" height="100"/>
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
        Slide('slides/s.svg', zones={'content': Image('media/photo.png')}),
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

_NOTES_IMAGE_DECK = """\
return Deck(
    embed_fonts=False,
    slides=[
        Slide('slides/s.svg', notes='notes/s.md', zones={'content': 'hi'}),
    ],
)"""

_MD_FILE_DECK = """\
return Deck(
    embed_fonts=False,
    slides=[Slide('slides/s.svg', md='slides/guide.md')],
)"""

_THEME_DECK = """\
import sys

sys.path.insert(0, {theme_dir!r})
from mytheme import MyTheme

return Deck(
    embed_fonts=False,
    theme=MyTheme(),
    slides=[Slide('theme:branded', zones={{'content': 'hi'}})],
)"""

_POSTER_DECK = """\
return Deck(
    embed_fonts=False,
    slides=[
        Slide('slides/s.svg', zones={
            'content': Video('media/clip.mp4', poster='assets/thumb.png'),
        }),
    ],
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
        "from inkflow import Deck, Image, Slide, Video\n\n\n"
        + f"def main() -> Deck:\n{textwrap.indent(body, '    ')}\n",
        encoding="utf-8",
    )
    return deck_path


class TestBuildCopiesAssets:
    def test_copies_media_markdown_and_svg_image_assets(self, tmp_path: Path) -> None:
        # Each reference resolves against the file that wrote it: the two <image>
        # hrefs live in slides/s.svg, the markdown and the Image() in deck.py. The
        # build mirrors that tree, so the two land in different directories even
        # though both were written as "assets/…".
        _write_slide(tmp_path, _ASSET_SLIDE_SVG)
        for rel in (
            "slides/assets/pic.png",
            "slides/assets/pic2.png",
            "assets/cat.png",
            "media/photo.png",
        ):
            _write_asset(tmp_path, rel)
        deck_path = _write_deck(tmp_path, _ASSET_DECK)

        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "index.html").exists()
        # SVG <image xlink:href> and <image href>, relative to the slide file
        assert (out_dir / "slides" / "assets" / "pic.png").exists()
        assert (out_dir / "slides" / "assets" / "pic2.png").exists()
        # markdown ![](...) written in deck.py, relative to the project root
        assert (out_dir / "assets" / "cat.png").exists()
        # Media zone (already worked, must not regress)
        assert (out_dir / "media" / "photo.png").exists()

    def test_markdown_file_refs_resolve_against_the_markdown_file(
        self, tmp_path: Path
    ) -> None:
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        (tmp_path / "slides" / "guide.md").write_text(
            "::content::\n\n![cat](assets/cat.png)\n", encoding="utf-8"
        )
        _write_asset(tmp_path, "slides/assets/cat.png")
        deck_path = _write_deck(tmp_path, _MD_FILE_DECK)

        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "slides" / "assets" / "cat.png").exists()
        index = (out_dir / "index.html").read_text(encoding="utf-8")
        assert "slides/assets/cat.png" in index

    def test_copies_an_image_referenced_from_notes(self, tmp_path: Path) -> None:
        # Notes are Markdown too, so they can carry images, and they resolve
        # against the notes file: "../assets" from notes/ is the project root.
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        (tmp_path / "notes").mkdir()
        (tmp_path / "notes" / "s.md").write_text(
            "![a diagram](../assets/diagram.png)\n", encoding="utf-8"
        )
        _write_asset(tmp_path, "assets/diagram.png")
        deck_path = _write_deck(tmp_path, _NOTES_IMAGE_DECK)

        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "assets" / "diagram.png").exists()
        index = (out_dir / "index.html").read_text(encoding="utf-8")
        assert "../assets/diagram.png" not in index
        assert "assets/diagram.png" in index

    def test_copies_video_source_and_poster(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        _write_asset(tmp_path, "media/clip.mp4")
        _write_asset(tmp_path, "assets/thumb.png")
        deck_path = _write_deck(tmp_path, _POSTER_DECK)

        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "media" / "clip.mp4").exists()
        # A video's poster is a local asset too and must be copied.
        assert (out_dir / "assets" / "thumb.png").exists()

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


class TestEditorRelativeAssetRefs:
    def test_parent_ref_resolves_against_the_slide_and_stays_inside(
        self, tmp_path: Path
    ) -> None:
        # ../assets/pic.png is what an SVG editor writes for a slide in slides/
        # pointing at the project's shared assets dir. It must resolve there, and
        # the ".." must not survive into the output, where it would climb out of
        # the build and collide with the source.
        _write_slide(tmp_path, _ESCAPING_ASSET_SLIDE_SVG)
        _write_asset(tmp_path, "assets/pic.png")
        deck_path = _write_deck(tmp_path, _ONE_SLIDE_DECK)

        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "assets" / "pic.png").exists()
        # Nothing written next to the build via a ".." that climbed out.
        assert not (tmp_path / "out.png").exists()
        assert list((tmp_path / "assets").iterdir()) == [
            tmp_path / "assets" / "pic.png"
        ]

        # The slide SVG is JSON-embedded in index.html, so match on the bare ref:
        # the escaping "../" form is gone, canonicalised to a project-root path.
        index = (out_dir / "index.html").read_text(encoding="utf-8")
        assert "../assets/pic.png" not in index
        assert "assets/pic.png" in index

    def test_ref_outside_every_root_warns_and_is_left_alone(
        self, tmp_path: Path
    ) -> None:
        # Nothing can serve or export a file above the project, so the reference
        # is reported and kept as written rather than re-anchored somewhere it
        # never pointed at.
        project = tmp_path / "project"
        project.mkdir()
        _write_slide(project, _OUTSIDE_ASSET_SLIDE_SVG)
        _write_asset(tmp_path, "outside/pic.png")
        deck_path = _write_deck(project, _ONE_SLIDE_DECK)

        out_dir = project / "out"
        with collect_logs(logging.WARNING) as warnings:
            build_static_html(deck_path, out_dir)

        assert any("outside the project" in w.message for w in warnings)
        assert not (out_dir / "outside").exists()
        index = (out_dir / "index.html").read_text(encoding="utf-8")
        assert "../../outside/pic.png" in index

    def test_missing_asset_warns_and_build_still_succeeds(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _MISSING_ASSET_SLIDE_SVG)
        deck_path = _write_deck(tmp_path, _ONE_SLIDE_DECK)

        out_dir = tmp_path / "out"
        with collect_logs(logging.WARNING) as warnings:
            build_static_html(deck_path, out_dir)

        assert (out_dir / "index.html").exists()
        assert any("missing.png" in w.message for w in warnings)


class TestThemeAssets:
    def test_theme_asset_is_copied_under_its_own_namespace(
        self, tmp_path: Path
    ) -> None:
        # A theme installed outside the project is the second allowed root, so its
        # branding travels with the build under a namespace of its own.
        theme_dir = tmp_path / "external"
        (theme_dir / "theme" / "layouts").mkdir(parents=True)
        (theme_dir / "mytheme.py").write_text(
            "from inkflow.themes import Theme\n\n\nclass MyTheme(Theme):\n    pass\n",
            encoding="utf-8",
        )
        (theme_dir / "theme" / "layouts" / "branded.svg").write_text(
            _THEME_LAYOUT_SVG, encoding="utf-8"
        )
        _write_asset(theme_dir, "theme/logo.png")

        project = tmp_path / "project"
        project.mkdir()
        deck_path = _write_deck(project, _THEME_DECK.format(theme_dir=str(theme_dir)))

        out_dir = project / "out"
        build_static_html(deck_path, out_dir)

        assert (out_dir / "_theme" / "logo.png").exists()
        index = (out_dir / "index.html").read_text(encoding="utf-8")
        assert "_theme/logo.png" in index


class TestCustomTypeMarker:
    def test_custom_animation_type_resolves_from_marker(self, tmp_path: Path) -> None:
        # A ::step type=<Name>:: marker only holds the class *name*, so the deck
        # module must stay alive for Animation.__subclasses__() to find a custom
        # type. Regression for the module being GC'd after load_deck returns.
        _write_slide(tmp_path, _PLAIN_SLIDE_SVG)
        deck_path = tmp_path / "deck.py"
        deck_path.write_text(
            textwrap.dedent("""\
                import gc
                from dataclasses import dataclass
                from inkflow import Deck, Inline, Slide, animations


                @dataclass
                class Spark(animations.Emphasis):
                    intensity: float = 1.0


                def main() -> Deck:
                    gc.collect()  # collect before the pipeline resolves markers
                    marker = "::content::\\n::step type=Spark intensity=4::\\nHi\\n"
                    slide = Slide("slides/s.svg", md=Inline(marker))
                    return Deck(embed_fonts=False, slides=[slide])
            """),
            encoding="utf-8",
        )
        out_dir = tmp_path / "out"
        build_static_html(deck_path, out_dir)
        html = (out_dir / "index.html").read_text(encoding="utf-8")
        # Resolved to the custom type (not the FadeIn fallback): the cue's name is the
        # type slug and its param flows into the data-cues encoding.
        assert "spark" in html
        assert "intensity" in html
        assert "4.0" in html


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


_MALFORMED_SVG = "<svg><rect></svg>"


class TestMalformedSvg:
    def test_build_static_html_raises_naming_the_file(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _MALFORMED_SVG)
        deck_path = _write_deck(tmp_path, _ONE_SLIDE_DECK)
        with pytest.raises(ValueError, match=r"s\.svg"):
            build_static_html(deck_path, tmp_path / "out")

    def test_build_cli_reports_clean_error(self, tmp_path: Path) -> None:
        _write_slide(tmp_path, _MALFORMED_SVG)
        deck_path = _write_deck(tmp_path, _ONE_SLIDE_DECK)
        result = CliRunner().invoke(
            main, ["build", "--deck", str(deck_path), "-o", str(tmp_path / "out")]
        )
        assert result.exit_code != 0
        # click renders the ClickException as "Error: invalid SVG ..." naming the file,
        # rather than letting a raw XMLSyntaxError traceback escape
        assert "invalid SVG" in result.output
        assert not isinstance(result.exception, ValueError)
