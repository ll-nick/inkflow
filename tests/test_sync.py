from __future__ import annotations

import textwrap
from pathlib import Path

from inkflow import sync
from inkflow.layout import PreviewLayer
from inkflow.manifest import Deck, Slide
from inkflow.overlay import Overlay
from inkflow.sync import PreviewRule

_PLAIN_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")


def _svg(path: Path, attrs: str = "", body: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    head = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"'
    path.write_text(
        f'{head} viewBox="0 0 1920 1080" {attrs}>{body}</svg>', encoding="utf-8"
    )
    return path


def _project(tmp_path: Path) -> Path:
    """A project with two overlays, one layout, and two slides on that layout."""
    _svg(tmp_path / "layouts" / "content.svg", body='<rect id="zone-content"/>')
    _svg(tmp_path / "overlays" / "footer.svg", body='<text id="footer">f</text>')
    _svg(tmp_path / "overlays" / "logo.svg", body='<circle id="logo" r="5"/>')
    _svg(tmp_path / "slides" / "01.svg", attrs='inkflow:parent="content"')
    _svg(tmp_path / "slides" / "02.svg", attrs='inkflow:parent="content"')
    return tmp_path


def _ctx(tmp_path: Path, deck: Deck | None) -> sync.PreviewContext:
    return sync.build_context(deck, tmp_path, None, dark_mode=True)


def _overlay_refs(layers: list[list[PreviewLayer]]) -> list[str]:
    return [layer.ref for chain in layers for layer in chain]


class TestOverlayRules:
    def test_attribute_wins(self, tmp_path: Path) -> None:
        _project(tmp_path)
        slide = _svg(
            tmp_path / "slides" / "01.svg",
            attrs='inkflow:parent="content" inkflow:preview-overlays="logo"',
        )
        deck = Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
        layers, rule = sync.resolve_overlay_preview(slide, _ctx(tmp_path, deck))
        assert rule is PreviewRule.ATTRIBUTE
        assert _overlay_refs(layers) == ["logo"]

    def test_empty_attribute_means_none(self, tmp_path: Path) -> None:
        _project(tmp_path)
        slide = _svg(
            tmp_path / "slides" / "01.svg",
            attrs='inkflow:parent="content" inkflow:preview-overlays=""',
        )
        deck = Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
        layers, rule = sync.resolve_overlay_preview(slide, _ctx(tmp_path, deck))
        assert rule is PreviewRule.ATTRIBUTE
        assert layers == []

    def test_unanimous_slides(self, tmp_path: Path) -> None:
        _project(tmp_path)
        deck = Deck(
            slides=[Slide("slides/01.svg"), Slide("slides/02.svg")],
            overlays=[Overlay("footer")],
        )
        ctx = _ctx(tmp_path, deck)
        layers, rule = sync.resolve_overlay_preview(tmp_path / "slides" / "01.svg", ctx)
        assert rule is PreviewRule.SLIDES
        assert _overlay_refs(layers) == ["footer"]

    def test_unanimous_opt_out(self, tmp_path: Path) -> None:
        _project(tmp_path)
        deck = Deck(
            slides=[Slide("slides/01.svg", overlays=[])], overlays=[Overlay("footer")]
        )
        ctx = _ctx(tmp_path, deck)
        layers, rule = sync.resolve_overlay_preview(tmp_path / "slides" / "01.svg", ctx)
        assert rule is PreviewRule.SLIDES
        assert layers == []

    def test_equivalent_refs_still_agree(self, tmp_path: Path) -> None:
        # Two slides naming the same file differently is agreement, since the rule
        # compares resolved chains rather than the src strings.
        _project(tmp_path)
        deck = Deck(
            slides=[
                Slide("slides/01.svg", overlays=[Overlay("footer")]),
                Slide("slides/02.svg", overlays=[Overlay("local:footer")]),
            ]
        )
        ctx = _ctx(tmp_path, deck)
        layout = tmp_path / "layouts" / "content.svg"
        _, rule = sync.resolve_overlay_preview(layout, ctx)
        assert rule is PreviewRule.SLIDES

    def test_disagreeing_slides_fall_back_to_deck(self, tmp_path: Path) -> None:
        _project(tmp_path)
        deck = Deck(
            slides=[Slide("slides/01.svg", overlays=[]), Slide("slides/02.svg")],
            overlays=[Overlay("footer")],
        )
        ctx = _ctx(tmp_path, deck)
        layout = tmp_path / "layouts" / "content.svg"
        layers, rule = sync.resolve_overlay_preview(layout, ctx)
        assert rule is PreviewRule.DECK
        assert _overlay_refs(layers) == ["footer"]

    def test_unbacked_file_falls_back_to_deck(self, tmp_path: Path) -> None:
        _project(tmp_path)
        orphan = _svg(tmp_path / "slides" / "unused.svg")
        deck = Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
        _, rule = sync.resolve_overlay_preview(orphan, _ctx(tmp_path, deck))
        assert rule is PreviewRule.DECK

    def test_overlay_file_gets_no_chrome(self, tmp_path: Path) -> None:
        _project(tmp_path)
        deck = Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
        ctx = _ctx(tmp_path, deck)
        footer = tmp_path / "overlays" / "footer.svg"
        layers, rule = sync.resolve_overlay_preview(footer, ctx)
        assert rule is PreviewRule.OVERLAY_FILE
        assert layers == []

    def test_overlay_outside_the_directory_gets_no_chrome(self, tmp_path: Path) -> None:
        # Parked outside the convention, so only the deck reference identifies it.
        _project(tmp_path)
        chrome = _svg(tmp_path / "chrome" / "badge.svg")
        deck = Deck(
            slides=[Slide("slides/01.svg")], overlays=[Overlay("./chrome/badge")]
        )
        _, rule = sync.resolve_overlay_preview(chrome, _ctx(tmp_path, deck))
        assert rule is PreviewRule.OVERLAY_FILE

    def test_no_deck_uses_the_attribute_only(self, tmp_path: Path) -> None:
        _project(tmp_path)
        bare = _svg(tmp_path / "slides" / "03.svg")
        ctx = sync.build_context(None, None, None, dark_mode=True)
        _, rule = sync.resolve_overlay_preview(bare, ctx)
        assert rule is PreviewRule.NO_DECK

        pinned = _svg(
            tmp_path / "slides" / "04.svg",
            attrs='inkflow:preview-overlays="../overlays/footer"',
        )
        layers, rule = sync.resolve_overlay_preview(pinned, ctx)
        assert rule is PreviewRule.ATTRIBUTE
        assert _overlay_refs(layers) == ["../overlays/footer"]


class TestBackdrop:
    def test_declared_backdrop_and_its_chain(self, tmp_path: Path) -> None:
        _project(tmp_path)
        _svg(tmp_path / "layouts" / "base.svg", body='<rect id="bg"/>')
        _svg(
            tmp_path / "layouts" / "content.svg",
            attrs='inkflow:parent="base"',
            body='<rect id="zone-content"/>',
        )
        overlay = _svg(
            tmp_path / "overlays" / "footer.svg", attrs='inkflow:preview="content"'
        )
        deck = Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
        plan = sync.plan_preview(overlay, _ctx(tmp_path, deck))
        assert [layer.path.stem for layer in plan.layers.behind] == ["base", "content"]
        assert plan.backdrop is not None and plan.backdrop.ref == "content"
        assert not plan.layers.overlays

    def test_no_attribute_means_no_backdrop(self, tmp_path: Path) -> None:
        # No default: an overlay cannot know what it lands on, and a deck of raw
        # SVGs is built on no layout at all, so any guess previews chrome against
        # a canvas the deck never paints.
        _project(tmp_path)
        _svg(tmp_path / "layouts" / "base.svg", body='<rect id="bg"/>')
        overlay = tmp_path / "overlays" / "logo.svg"
        deck = Deck(slides=[Slide("slides/01.svg")])
        plan = sync.plan_preview(overlay, _ctx(tmp_path, deck))
        assert plan.layers.behind == []
        assert plan.backdrop is None
        assert plan.is_overlay

    def test_backdrop_may_be_a_slide(self, tmp_path: Path) -> None:
        # The answer for a deck of raw SVGs: preview against a real slide.
        _project(tmp_path)
        overlay = _svg(
            tmp_path / "overlays" / "logo.svg",
            attrs='inkflow:preview="../slides/01.svg"',
        )
        deck = Deck(slides=[Slide("slides/01.svg")])
        plan = sync.plan_preview(overlay, _ctx(tmp_path, deck))
        # The slide's own layout chain comes with it, exactly as when editing it.
        assert [layer.path.name for layer in plan.layers.behind] == [
            "content.svg",
            "01.svg",
        ]

    def test_overlay_ancestors_sit_above_the_backdrop(self, tmp_path: Path) -> None:
        _project(tmp_path)
        _svg(tmp_path / "layouts" / "base.svg", body='<rect id="bg"/>')
        _svg(tmp_path / "overlays" / "brand.svg", body='<rect id="rule"/>')
        overlay = _svg(
            tmp_path / "overlays" / "footer.svg",
            attrs='inkflow:parent="brand" inkflow:preview="base"',
        )
        deck = Deck(slides=[Slide("slides/01.svg")])
        plan = sync.plan_preview(overlay, _ctx(tmp_path, deck))
        assert [layer.path.stem for layer in plan.layers.behind] == ["base", "brand"]

    def test_unresolvable_backdrop_is_skipped(self, tmp_path: Path) -> None:
        _project(tmp_path)
        overlay = _svg(
            tmp_path / "overlays" / "logo.svg", attrs='inkflow:preview="nope"'
        )
        deck = Deck(slides=[Slide("slides/01.svg")])
        plan = sync.plan_preview(overlay, _ctx(tmp_path, deck))
        assert plan.layers.behind == []


class TestSyncSlides:
    def test_slide_gets_layout_and_overlay_layers(self, tmp_path: Path) -> None:
        _project(tmp_path)
        slide = tmp_path / "slides" / "01.svg"
        deck = Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
        sync.sync_slides([slide], _ctx(tmp_path, deck))
        content = slide.read_text(encoding="utf-8")
        assert "layout-src" in content
        assert "overlay-src" in content
        assert content.index("layout-src") < content.index("overlay-src")

    def test_injected_chrome_is_stripped_for_the_pipeline(self, tmp_path: Path) -> None:
        # The double-chrome guard: the pipeline composes overlays itself, so a
        # synced slide must hand it a tree with no preview layers left.
        from inkflow.clean import clean_inkscape_tree

        _project(tmp_path)
        slide = tmp_path / "slides" / "01.svg"
        deck = Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
        sync.sync_slides([slide], _ctx(tmp_path, deck))
        root = clean_inkscape_tree(slide)
        assert root.find('.//{http://www.w3.org/2000/svg}text[@id="footer"]') is None
