from __future__ import annotations

import textwrap
from collections.abc import Callable
from pathlib import Path

import pytest
from lxml import etree

from inkflow import ns
from inkflow.layout import (
    AssetKind,
    LayoutInfo,
    PreviewLayer,
    PreviewLayers,
    are_preview_layers_current,
    chain_layers,
    create_slide,
    discover_layouts,
    discover_overlays,
    inject_preview_layers,
    layout_zones,
    resolve_chain,
    resolve_parent_path,
)
from inkflow.themes import Theme

_SIMPLE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkflow="urn:inkflow"
         viewBox="0 0 1920 1080" width="1920" height="1080">
      <rect id="bg" width="1920" height="1080" fill="#1e1e2e"/>
    </svg>
""")


def _write_svg(path: Path, content: str = _SIMPLE_SVG) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _svg_with_parent(parent: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg"\n'
        f'     xmlns:inkflow="{ns.INKFLOW}"\n'
        f'     inkflow:parent="{parent}"\n'
        f'     viewBox="0 0 1920 1080">\n'
        f"</svg>\n"
    )


# ── resolve_parent_path ───────────────────────────────────────────────────────


class TestResolveParentPath:
    def test_local_prefix(self, tmp_path: Path) -> None:
        svg = tmp_path / "slides" / "01.svg"
        layout = tmp_path / "layouts" / "main.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_SIMPLE_SVG, encoding="utf-8")
        result = resolve_parent_path("local:main", svg, tmp_path, None)
        assert result == layout.resolve()

    def test_file_relative(self, tmp_path: Path) -> None:
        slides_dir = tmp_path / "slides"
        result = resolve_parent_path("../layouts/main", slides_dir, tmp_path, None)
        assert result == (tmp_path / "layouts" / "main.svg").resolve()

    def test_theme_prefix(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        theme_dir = tmp_path / "themes" / "my-theme"
        layout = theme_dir / "layouts" / "bullets.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_SIMPLE_SVG, encoding="utf-8")
        svg = tmp_path / "slides" / "01.svg"
        result = resolve_parent_path(
            "theme:bullets", svg, tmp_path, dir_theme(theme_dir)
        )
        assert result == layout.resolve()

    def test_svg_extension_auto_appended(self, tmp_path: Path) -> None:
        svg = tmp_path / "01.svg"
        result = resolve_parent_path("../main", svg, tmp_path, None)
        assert result.suffix == ".svg"

    def test_svg_extension_not_doubled(self, tmp_path: Path) -> None:
        svg = tmp_path / "01.svg"
        result = resolve_parent_path("../main.svg", svg, tmp_path, None)
        assert str(result).endswith("main.svg")
        assert not str(result).endswith("main.svg.svg")

    def test_theme_prefix_without_theme_raises(self, tmp_path: Path) -> None:
        svg = tmp_path / "01.svg"
        with pytest.raises(ValueError, match="requires Deck"):
            resolve_parent_path("theme:bullets", svg, tmp_path, None)

    def test_bare_name_found_in_project_layouts(self, tmp_path: Path) -> None:
        layout = tmp_path / "layouts" / "default.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_SIMPLE_SVG, encoding="utf-8")
        svg = tmp_path / "slides" / "01.svg"
        result = resolve_parent_path("default", svg, tmp_path, None)
        assert result == layout.resolve()

    def test_bare_name_not_found_raises(self, tmp_path: Path) -> None:
        svg = tmp_path / "01.svg"
        with pytest.raises(ValueError, match="not found"):
            resolve_parent_path("nonexistent-layout", svg, tmp_path, None)

    def test_os_native_absolute_path(self, tmp_path: Path) -> None:
        # Exercises the OS-native absolute-path branch with whatever separator
        # style the host OS actually produces (backslash-drive on Windows,
        # leading-slash on POSIX) rather than hardcoding one platform's syntax.
        layout = tmp_path / "elsewhere" / "layout.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_SIMPLE_SVG, encoding="utf-8")
        svg = tmp_path / "01.svg"
        result = resolve_parent_path(str(layout), svg, tmp_path, None)
        assert result == layout.resolve()


# ── resolve_chain ─────────────────────────────────────────────────────────────


class TestResolveChain:
    def test_no_parent_returns_empty(self, tmp_path: Path) -> None:
        slide = _write_svg(tmp_path / "slide.svg", _SIMPLE_SVG)
        assert resolve_chain(slide, tmp_path, None) == []

    def test_single_parent(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        chain = resolve_chain(slide, tmp_path, None)
        assert chain == [main.resolve()]

    def test_two_level_chain_root_first(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        layout = _write_svg(
            tmp_path / "layouts" / "bullets.svg",
            _svg_with_parent("../main.svg"),
        )
        slide = _write_svg(
            tmp_path / "slide.svg",
            _svg_with_parent("./layouts/bullets.svg"),
        )
        chain = resolve_chain(slide, tmp_path, None)
        assert chain == [main.resolve(), layout.resolve()]

    def test_cycle_detection(self, tmp_path: Path) -> None:
        a = tmp_path / "a.svg"
        b = tmp_path / "b.svg"
        _write_svg(a, _svg_with_parent("./b.svg"))
        _write_svg(b, _svg_with_parent("./a.svg"))
        with pytest.raises(ValueError, match="Circular"):
            resolve_chain(a, tmp_path, None)


# ── inject_preview_layers / are_preview_layers_current ───────────────────────


def _behind(slide: Path, chain: list[Path]) -> PreviewLayers:
    return PreviewLayers(behind=chain_layers(slide, chain))


class TestInjectPreviewLayers:
    def test_injects_and_returns_true(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        layers = _behind(slide, [main.resolve()])
        assert inject_preview_layers(slide, layers) is True
        root = etree.parse(slide).getroot()
        injected = [el for el in root if el.get(ns.INKFLOW_LAYOUT_SRC)]
        assert len(injected) == 1
        assert injected[0].get(ns.INKFLOW_LAYOUT_SRC) == "./main.svg"

    def test_idempotent_returns_false(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        layers = _behind(slide, [main.resolve()])
        inject_preview_layers(slide, layers)
        assert inject_preview_layers(slide, layers) is False

    def test_current_after_inject(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        layers = _behind(slide, [main.resolve()])
        inject_preview_layers(slide, layers)
        assert are_preview_layers_current(slide, layers) is True

    def test_stale_after_ancestor_change(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        layers = _behind(slide, [main.resolve()])
        inject_preview_layers(slide, layers)
        main.write_text(_SIMPLE_SVG.replace("1e1e2e", "313244"), encoding="utf-8")
        assert are_preview_layers_current(slide, layers) is False

    def test_ancestor_content_appears_in_slide(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        inject_preview_layers(slide, _behind(slide, [main.resolve()]))
        content = slide.read_text(encoding="utf-8")
        assert "1e1e2e" in content  # rect from main.svg is present

    def test_ancestor_defs_included_in_layer_group(self, tmp_path: Path) -> None:
        main_svg = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
              <defs>
                <linearGradient id="bg-grad">
                  <stop offset="0" stop-color="#1e1e2e"/>
                </linearGradient>
              </defs>
              <rect width="1920" height="1080" fill="url(#bg-grad)"/>
            </svg>
        """)
        main = _write_svg(tmp_path / "main.svg", main_svg)
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        inject_preview_layers(slide, _behind(slide, [main.resolve()]))
        content = slide.read_text(encoding="utf-8")
        assert "bg-grad" in content
        assert "linearGradient" in content


class TestInjectOverlayLayers:
    def _slide_with_overlay(self, tmp_path: Path) -> tuple[Path, PreviewLayers]:
        main = _write_svg(tmp_path / "main.svg")
        overlay = _write_svg(
            tmp_path / "overlays" / "footer.svg",
            _SIMPLE_SVG.replace('id="bg"', 'id="footer-mark"'),
        )
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        layers = PreviewLayers(
            behind=chain_layers(slide, [main.resolve()]),
            overlays=[[PreviewLayer(overlay.resolve(), "footer")]],
        )
        return slide, layers

    def test_overlay_layers_come_last(self, tmp_path: Path) -> None:
        slide, layers = self._slide_with_overlay(tmp_path)
        inject_preview_layers(slide, layers)
        root = etree.parse(slide).getroot()
        markers = [
            "layout" if el.get(ns.INKFLOW_LAYOUT_SRC) else "overlay"
            for el in root
            if el.get(ns.INKFLOW_LAYOUT_SRC) or el.get(ns.INKFLOW_OVERLAY_SRC)
        ]
        assert markers == ["layout", "overlay"]
        assert root[-1].get(ns.INKFLOW_OVERLAY_SRC) == "footer"

    def test_stale_when_overlay_changes(self, tmp_path: Path) -> None:
        slide, layers = self._slide_with_overlay(tmp_path)
        inject_preview_layers(slide, layers)
        assert are_preview_layers_current(slide, layers) is True
        overlay = layers.overlays[0][0].path
        overlay.write_text(_SIMPLE_SVG.replace("1e1e2e", "313244"), encoding="utf-8")
        assert are_preview_layers_current(slide, layers) is False

    def test_stale_when_overlay_removed(self, tmp_path: Path) -> None:
        slide, layers = self._slide_with_overlay(tmp_path)
        inject_preview_layers(slide, layers)
        without = PreviewLayers(behind=layers.behind)
        assert are_preview_layers_current(slide, without) is False
        assert inject_preview_layers(slide, without) is True
        root = etree.parse(slide).getroot()
        assert not [el for el in root if el.get(ns.INKFLOW_OVERLAY_SRC)]

    def test_ancestor_overlay_layers_do_not_leak_into_child(
        self, tmp_path: Path
    ) -> None:
        # A synced layout carries its own overlay preview. Inlining it as an
        # ancestor layer must not drag that chrome in a second time.
        layout, layout_layers = self._slide_with_overlay(tmp_path)
        inject_preview_layers(layout, layout_layers)
        slide = _write_svg(tmp_path / "child.svg", _svg_with_parent("./slide.svg"))
        inject_preview_layers(slide, _behind(slide, [layout.resolve()]))
        assert "footer-mark" not in slide.read_text(encoding="utf-8")


# ── discover_layouts ──────────────────────────────────────────────────────────


class TestDiscoverLayouts:
    def test_builtins_always_included(self) -> None:
        results = discover_layouts(None, None)
        labels = [label for label, _ in results]
        assert "builtin" in labels

    def test_local_layouts_included(self, tmp_path: Path) -> None:
        local = tmp_path / "layouts"
        local.mkdir()
        (local / "custom.svg").write_text(_SIMPLE_SVG, encoding="utf-8")
        results = discover_layouts(tmp_path, None)
        local_results = [(label, p) for label, p in results if label == "local"]
        assert len(local_results) == 1
        assert local_results[0][1].stem == "custom"

    def test_order_builtin_then_local(self, tmp_path: Path) -> None:
        local = tmp_path / "layouts"
        local.mkdir()
        (local / "custom.svg").write_text(_SIMPLE_SVG, encoding="utf-8")
        results = discover_layouts(tmp_path, None)
        labels = [label for label, _ in results]
        builtin_idx = next(i for i, lbl in enumerate(labels) if lbl == "builtin")
        local_idx = next(i for i, lbl in enumerate(labels) if lbl == "local")
        assert builtin_idx < local_idx

    def test_no_project_dir_no_local(self) -> None:
        results = discover_layouts(None, None)
        assert all(label != "local" for label, _ in results)

    def test_missing_local_layouts_dir_no_error(self, tmp_path: Path) -> None:
        results = discover_layouts(tmp_path, None)
        assert all(label != "local" for label, _ in results)


# ── layout_zones ──────────────────────────────────────────────────────────────


_ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="80" width="1760" height="120"/>
      <rect id="zone-content" x="80" y="240" width="1760" height="720"/>
      <text id="zone-slide-number" x="960" y="1060">1</text>
    </svg>
""")

_NO_ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="bg" width="1920" height="1080"/>
    </svg>
""")

_DEFAULT_ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkflow="urn:inkflow"
         inkflow:default-zone="quote"
         viewBox="0 0 1920 1080">
      <rect id="zone-quote" x="80" y="200" width="1760" height="600"/>
    </svg>
""")


class TestLayoutZones:
    def test_zones_returned_without_prefix(self, tmp_path: Path) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _ZONE_SVG)
        info = layout_zones(layout, tmp_path, None)
        assert isinstance(info, LayoutInfo)
        assert "title" in info.zones
        assert "content" in info.zones

    def test_slide_number_zones_excluded_from_list(self, tmp_path: Path) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _ZONE_SVG)
        info = layout_zones(layout, tmp_path, None)
        assert "slide-number" not in info.zones
        assert "slide-total" not in info.zones

    def test_numbered_true_when_slide_number_present(self, tmp_path: Path) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _ZONE_SVG)
        assert layout_zones(layout, tmp_path, None).numbered is True

    def test_numbered_false_when_no_slide_number(self, tmp_path: Path) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _NO_ZONE_SVG)
        assert layout_zones(layout, tmp_path, None).numbered is False

    def test_zones_sorted_alphabetically(self, tmp_path: Path) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _ZONE_SVG)
        info = layout_zones(layout, tmp_path, None)
        assert info.zones == sorted(info.zones)

    def test_zones_from_ancestor_included(self, tmp_path: Path) -> None:
        _write_svg(tmp_path / "base.svg", _ZONE_SVG)
        child_svg = (
            '<svg xmlns="http://www.w3.org/2000/svg"'
            '     xmlns:inkflow="urn:inkflow"'
            '     inkflow:parent="./base.svg"'
            '     viewBox="0 0 1920 1080">'
            '  <rect id="zone-extra" x="0" y="0" width="100" height="100"/>'
            "</svg>"
        )
        child = _write_svg(tmp_path / "child.svg", child_svg)
        info = layout_zones(child, tmp_path, None)
        assert "extra" in info.zones
        assert "title" in info.zones  # inherited from base

    def test_default_zone_explicit_attribute(self, tmp_path: Path) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _DEFAULT_ZONE_SVG)
        info = layout_zones(layout, tmp_path, None)
        assert info.default_zone == "quote"

    def test_default_zone_implicit_when_zone_content_present(
        self, tmp_path: Path
    ) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _ZONE_SVG)
        info = layout_zones(layout, tmp_path, None)
        assert info.default_zone == "content"

    def test_default_zone_empty_when_no_zone_content_and_no_attribute(
        self, tmp_path: Path
    ) -> None:
        layout = _write_svg(tmp_path / "layout.svg", _NO_ZONE_SVG)
        info = layout_zones(layout, tmp_path, None)
        assert info.default_zone == ""


# ── create_slide ──────────────────────────────────────────────────────────────


class TestCreateSlide:
    def test_blank_slide_has_no_parent(self, tmp_path: Path) -> None:
        out = tmp_path / "blank.svg"
        create_slide(None, out, tmp_path, None)
        svg = out.read_text(encoding="utf-8")
        assert "inkflow:parent" not in svg
        assert 'viewBox="0 0 1920 1080"' in svg

    def test_blank_slide_needs_no_project_dir(self, tmp_path: Path) -> None:
        out = tmp_path / "blank.svg"
        create_slide(None, out, None, None)
        assert out.exists()

    def test_parented_slide_records_parent(self, tmp_path: Path) -> None:
        _write_svg(tmp_path / "base.svg")
        out = tmp_path / "child.svg"
        create_slide("base", out, tmp_path, None)
        assert 'inkflow:parent="base"' in out.read_text(encoding="utf-8")

    def test_unresolvable_parent_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            create_slide("local:missing", tmp_path / "child.svg", tmp_path, None)


# ── Overlay namespace ─────────────────────────────────────────────────────────


class TestOverlayResolution:
    """The overlay kind resolves the same grammar against ``overlays/``.

    Keeping the two namespaces apart is what stops a bare name on an overlay from
    silently picking up a layout, whose full-bleed background would hide the slide.
    """

    def _overlay(self, root: Path, name: str) -> Path:
        path = root / "overlays" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_SIMPLE_SVG, encoding="utf-8")
        return path

    def test_bare_name_found_in_project_overlays(self, tmp_path: Path) -> None:
        overlay = self._overlay(tmp_path, "footer.svg")
        result = resolve_parent_path(
            "footer", tmp_path, tmp_path, None, AssetKind.OVERLAY
        )
        assert result == overlay.resolve()

    def test_local_prefix(self, tmp_path: Path) -> None:
        overlay = self._overlay(tmp_path, "footer.svg")
        result = resolve_parent_path(
            "local:footer", tmp_path, tmp_path, None, AssetKind.OVERLAY
        )
        assert result == overlay.resolve()

    def test_theme_prefix(
        self, tmp_path: Path, dir_theme: Callable[[Path], Theme]
    ) -> None:
        theme_dir = tmp_path / "themes" / "my-theme"
        overlay = self._overlay(theme_dir, "brand.svg")
        result = resolve_parent_path(
            "theme:brand", tmp_path, tmp_path, dir_theme(theme_dir), AssetKind.OVERLAY
        )
        assert result == overlay.resolve()

    def test_layout_not_reachable_by_bare_name(self, tmp_path: Path) -> None:
        layout = tmp_path / "layouts" / "default.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_SIMPLE_SVG, encoding="utf-8")
        with pytest.raises(ValueError, match="Overlay 'default' not found"):
            resolve_parent_path("default", tmp_path, tmp_path, None, AssetKind.OVERLAY)

    def test_relative_path_still_escapes_the_namespace(self, tmp_path: Path) -> None:
        # The escape hatch stays open: an explicit path resolves wherever it points.
        target = tmp_path / "chrome" / "footer.svg"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(_SIMPLE_SVG, encoding="utf-8")
        result = resolve_parent_path(
            "./chrome/footer", tmp_path, tmp_path, None, AssetKind.OVERLAY
        )
        assert result == target.resolve()

    def test_chain_stays_in_overlay_namespace(self, tmp_path: Path) -> None:
        self._overlay(tmp_path, "brand.svg")
        child = tmp_path / "overlays" / "footer.svg"
        child.write_text(
            _SIMPLE_SVG.replace("<svg", '<svg inkflow:parent="brand"', 1),
            encoding="utf-8",
        )
        chain = resolve_chain(child, tmp_path, None, AssetKind.OVERLAY)
        assert [p.stem for p in chain] == ["brand"]


class TestDiscoverOverlays:
    def test_finds_project_overlays(self, tmp_path: Path) -> None:
        overlays = tmp_path / "overlays"
        overlays.mkdir()
        (overlays / "footer.svg").write_text(_SIMPLE_SVG, encoding="utf-8")
        found = discover_overlays(tmp_path, None)
        assert ("local", (overlays / "footer.svg")) in found

    def test_empty_without_overlays_dir(self, tmp_path: Path) -> None:
        assert discover_overlays(tmp_path, None) == []
