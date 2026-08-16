from __future__ import annotations

import textwrap
from collections.abc import Sequence
from pathlib import Path

from inkflow import sync
from inkflow.animations import FadeIn, PlayVideo
from inkflow.manifest import Deck, Image, Slide, Video
from inkflow.overlay import Overlay
from inkflow.sync import PreviewContext
from inkflow.verify import verify_slide

_LAYOUT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

_OVERLAY_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <text id="footer-label" x="80" y="1050">chrome</text>
    </svg>
""")

_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkflow="urn:inkflow"
         viewBox="0 0 1920 1080">
      <rect id="my-rect" x="0" y="0" width="100" height="100"/>
      <rect id="zone-media" x="0" y="0" width="100" height="100"/>
    </svg>
""")


def _preview(project_dir: Path, overlays: Sequence[Overlay] = ()) -> PreviewContext:
    """A minimal context: a deck carrying only the overlays under test."""
    return PreviewContext(
        deck=Deck(slides=[], overlays=list(overlays)),
        project_dir=project_dir,
        theme=None,
    )


def _setup(tmp_path: Path) -> Path:
    slides = tmp_path / "slides"
    slides.mkdir()
    slide = slides / "01-title.svg"
    slide.write_text(_SLIDE_SVG, encoding="utf-8")
    return slide


class TestVerifySlideSource:
    def test_missing_svg_is_error(self, tmp_path: Path) -> None:
        slide = Slide("slides/missing.svg")
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any(level == "error" and "not found" in msg for level, msg in issues)

    def test_missing_layout_lists_available(self, tmp_path: Path) -> None:
        # A bare, unresolvable layout name enumerates the layouts that do exist
        # (here just the built-ins, since there is no project/theme layouts dir).
        slide = Slide("nonexistent-layout")
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        errors = [msg for level, msg in issues if level == "error"]
        assert any("nonexistent-layout" in m and "not found" in m for m in errors)
        assert any("Available:" in m and "default" in m for m in errors)

    def test_clean_slide_has_no_issues(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src))
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert issues == []


class TestVerifyFiles:
    def test_missing_md_is_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), md="slides/missing.md")
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any("markdown not found" in msg for _, msg in issues)

    def test_present_md_no_issue(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        md = tmp_path / "slides" / "01-title.md"
        md.write_text("# Hello\n", encoding="utf-8")
        slide = Slide(str(src), md="slides/01-title.md")
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("markdown not found" in msg for _, msg in issues)

    def test_missing_notes_path_is_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), notes="notes/missing.md")
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any("notes file not found" in msg for _, msg in issues)


class TestVerifyMedia:
    def test_missing_local_media_is_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), zones={"content": Image("assets/missing.jpg")})
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any("media not found" in msg for _, msg in issues)

    def test_present_local_media_no_issue(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        assets = tmp_path / "assets"
        assets.mkdir()
        img = assets / "photo.jpg"
        img.write_bytes(b"")
        slide = Slide(str(src), zones={"content": Image("assets/photo.jpg")})
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("media" in msg for _, msg in issues)

    def test_url_media_skipped(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(
            str(src), zones={"content": Image("https://example.com/photo.jpg")}
        )
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("media" in msg for _, msg in issues)

    def test_protocol_relative_url_skipped(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), zones={"content": Image("//example.com/photo.jpg")})
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("media" in msg for _, msg in issues)


class TestVerifyZones:
    def _write_layout(self, tmp_path: Path) -> Path:
        layouts = tmp_path / "layouts"
        layouts.mkdir()
        layout = layouts / "content.svg"
        layout.write_text(_LAYOUT_SVG, encoding="utf-8")
        return layout

    def test_zone_from_slide_zones_missing_in_svg_is_error(
        self, tmp_path: Path
    ) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), zones={"nonexistent": "text"})
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any("zone #zone-nonexistent not found" in msg for _, msg in issues)

    def test_zone_from_slide_zones_present_in_svg_no_error(
        self, tmp_path: Path
    ) -> None:
        layout = self._write_layout(tmp_path)
        slide = Slide(str(layout), zones={"content": "hello"})
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("zone" in msg for _, msg in issues)

    def test_zone_from_md_missing_in_svg_is_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        md = tmp_path / "slides" / "01-title.md"
        md.write_text("::missing-zone::\nhello\n", encoding="utf-8")
        slide = Slide(str(src), md="slides/01-title.md")
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any(
            "zone #zone-missing-zone" in msg and "from markdown" in msg
            for _, msg in issues
        )

    def test_notes_zone_in_md_not_flagged(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        md = tmp_path / "slides" / "01-title.md"
        md.write_text("::notes::\nsome speaker notes\n", encoding="utf-8")
        slide = Slide(str(src), md="slides/01-title.md")
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("zone" in msg for _, msg in issues)


class TestVerifyAnimations:
    def test_missing_animation_element_is_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), animations=[FadeIn("nonexistent")])
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any(
            "animation element #nonexistent not found" in msg for _, msg in issues
        )

    def test_present_animation_element_no_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), animations=[FadeIn("my-rect")])
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("animation element" in msg for _, msg in issues)

    def test_missing_play_video_target_is_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), animations=[PlayVideo("nope")])
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any("PlayVideo target #zone-nope not found" in msg for _, msg in issues)

    def test_present_play_video_target_no_error(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        slide = Slide(str(src), animations=[PlayVideo("media")])
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("not found" in msg for _, msg in issues)

    def test_autoplay_with_play_video_cue_warns(self, tmp_path: Path) -> None:
        src = _setup(tmp_path)
        (tmp_path / "clip.mp4").write_bytes(b"")
        slide = Slide(
            str(src),
            zones={"media": Video("clip.mp4", autoplay=True)},
            animations=[PlayVideo("media")],
        )
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any(
            level == "warn" and "autoplay overridden" in msg for level, msg in issues
        )


# ── Verify default zone ───────────────────────────────────────────────────────

_QUOTE_LAYOUT_NO_DEFAULT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkflow="urn:inkflow"
         viewBox="0 0 1920 1080">
      <rect id="zone-quote" x="80" y="200" width="1760" height="500"/>
    </svg>
""")

_QUOTE_LAYOUT_WITH_DEFAULT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkflow="urn:inkflow"
         inkflow:default-zone="quote"
         viewBox="0 0 1920 1080">
      <rect id="zone-quote" x="80" y="200" width="1760" height="500"/>
    </svg>
""")


class TestVerifyDefaultZone:
    def _write_layout(self, tmp_path: Path, content: str, name: str) -> Path:
        layouts = tmp_path / "layouts"
        layouts.mkdir(exist_ok=True)
        layout = layouts / name
        layout.write_text(content, encoding="utf-8")
        return layout

    def test_no_default_zone_with_unrouted_content_is_error(
        self, tmp_path: Path
    ) -> None:
        layout = self._write_layout(tmp_path, _QUOTE_LAYOUT_NO_DEFAULT, "quote.svg")
        md = tmp_path / "slide.md"
        md.write_text("This is a quote body.\n", encoding="utf-8")
        slide = Slide(str(layout), md=str(md))
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any(
            level == "error" and "inkflow:default-zone" in msg for level, msg in issues
        )

    def test_declared_default_zone_no_error(self, tmp_path: Path) -> None:
        layout = self._write_layout(tmp_path, _QUOTE_LAYOUT_WITH_DEFAULT, "quote.svg")
        md = tmp_path / "slide.md"
        md.write_text("This is a quote body.\n", encoding="utf-8")
        slide = Slide(str(layout), md=str(md))
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert not any("inkflow:default-zone" in msg for _, msg in issues)


class TestVerifyOverlays:
    def _overlay(self, tmp_path: Path, name: str, body: str, attrs: str = "") -> None:
        overlays = tmp_path / "overlays"
        overlays.mkdir(parents=True, exist_ok=True)
        namespaces = 'xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
        size = 'viewBox="0 0 1920 1080" width="1920" height="1080"'
        (overlays / f"{name}.svg").write_text(
            f"<svg {namespaces} {size} {attrs}>{body}</svg>",
            encoding="utf-8",
        )

    def test_overlay_zone_is_not_reported_missing(self, tmp_path: Path) -> None:
        _setup(tmp_path)
        self._overlay(
            tmp_path, "footer", '<rect id="zone-note" width="10" height="10"/>'
        )
        slide = Slide(
            "slides/01-title.svg",
            zones={"note": "hi"},
            overlays=[Overlay("footer")],
        )
        assert verify_slide(slide, tmp_path, None, _preview(tmp_path)) == []

    def test_overlay_animation_target_is_not_reported_missing(
        self, tmp_path: Path
    ) -> None:
        _setup(tmp_path)
        self._overlay(tmp_path, "footer", '<g id="badge"/>')
        slide = Slide(
            "slides/01-title.svg",
            animations=[FadeIn("badge")],
            overlays=[Overlay("footer")],
        )
        assert verify_slide(slide, tmp_path, None, _preview(tmp_path)) == []

    def test_opaque_overlay_is_error(self, tmp_path: Path) -> None:
        _setup(tmp_path)
        self._overlay(tmp_path, "solid", '<rect width="1920" height="1080"/>')
        slide = Slide("slides/01-title.svg", overlays=[Overlay("solid")])
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any(level == "error" and "full-canvas" in msg for level, msg in issues)

    def test_opaque_overlay_named_via_its_parent(self, tmp_path: Path) -> None:
        # The offending file is the ancestor, so the message must name it, not the leaf.
        self._overlay(tmp_path, "solid", '<rect width="1920" height="1080"/>')
        self._overlay(tmp_path, "chrome", '<g id="badge"/>', 'inkflow:parent="solid"')
        _setup(tmp_path)
        slide = Slide("slides/01-title.svg", overlays=[Overlay("chrome")])
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any("solid.svg" in msg for _, msg in issues)

    def test_zone_collision_is_warning(self, tmp_path: Path) -> None:
        _setup(tmp_path)
        self._overlay(
            tmp_path, "footer", '<rect id="zone-media" width="10" height="10"/>'
        )
        slide = Slide("slides/01-title.svg", overlays=[Overlay("footer")])
        issues = verify_slide(slide, tmp_path, None, _preview(tmp_path))
        assert any(level == "warn" and "zone-media" in msg for level, msg in issues)

    def test_deck_overlays_used_when_slide_sets_none(self, tmp_path: Path) -> None:
        _setup(tmp_path)
        self._overlay(tmp_path, "solid", '<rect width="1920" height="1080"/>')
        slide = Slide("slides/01-title.svg")
        preview = _preview(tmp_path, [Overlay("solid")])
        issues = verify_slide(slide, tmp_path, None, preview)
        assert any("full-canvas" in msg for _, msg in issues)

    def test_slide_opt_out_beats_deck_overlays(self, tmp_path: Path) -> None:
        _setup(tmp_path)
        self._overlay(tmp_path, "solid", '<rect width="1920" height="1080"/>')
        slide = Slide("slides/01-title.svg", overlays=[])
        preview = _preview(tmp_path, [Overlay("solid")])
        issues = verify_slide(slide, tmp_path, None, preview)
        assert not any("full-canvas" in msg for _, msg in issues)


class TestVerifySyncCheck:
    def test_synced_slide_with_overlays_is_not_stale(self, tmp_path: Path) -> None:
        slide_path = _setup(tmp_path)
        overlays = tmp_path / "overlays"
        overlays.mkdir()
        (overlays / "footer.svg").write_text(_OVERLAY_SVG, encoding="utf-8")
        slide = Slide("slides/01-title.svg", overlays=[Overlay("footer")])
        preview = _preview(tmp_path)
        sync.sync_slides([slide_path], preview)
        assert not any(
            "stale" in msg for _, msg in verify_slide(slide, tmp_path, None, preview)
        )

    def test_layout_outside_the_project_is_never_stale(self, tmp_path: Path) -> None:
        # A built-in layout can never carry a project's chrome, and nothing may
        # write into the installed package, so it must not be reported.
        _setup(tmp_path)
        slide = Slide("builtin:center")
        preview = _preview(tmp_path, [Overlay("footer")])
        assert not any(
            "stale" in msg for _, msg in verify_slide(slide, tmp_path, None, preview)
        )
