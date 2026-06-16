from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from lxml import etree

from inkflow import ns
from inkflow.layout import (
    LayoutInfo,
    discover_layouts,
    inject_layout_layers,
    is_layout_current,
    layout_zones,
    resolve_chain,
    resolve_parent_path,
)

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

    def test_theme_prefix(self, tmp_path: Path) -> None:
        theme_dir = tmp_path / "themes" / "my-theme"
        layout = theme_dir / "layouts" / "bullets.svg"
        layout.parent.mkdir(parents=True, exist_ok=True)
        layout.write_text(_SIMPLE_SVG, encoding="utf-8")
        svg = tmp_path / "slides" / "01.svg"
        result = resolve_parent_path(
            "theme:bullets", svg, tmp_path, "./themes/my-theme"
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


# ── inject_layout_layers / is_layout_current ─────────────────────────────────


class TestInjectLayoutLayers:
    def test_injects_and_returns_true(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        chain = [main.resolve()]
        assert inject_layout_layers(slide, chain) is True
        root = etree.parse(slide).getroot()
        layers = [el for el in root if el.get(ns.INKFLOW_LAYOUT_SRC)]
        assert len(layers) == 1
        assert layers[0].get(ns.INKFLOW_LAYOUT_SRC) == "./main.svg"

    def test_idempotent_returns_false(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        chain = [main.resolve()]
        inject_layout_layers(slide, chain)
        assert inject_layout_layers(slide, chain) is False

    def test_is_layout_current_after_inject(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        chain = [main.resolve()]
        inject_layout_layers(slide, chain)
        assert is_layout_current(slide, chain) is True

    def test_stale_after_ancestor_change(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        chain = [main.resolve()]
        inject_layout_layers(slide, chain)
        main.write_text(_SIMPLE_SVG.replace("1e1e2e", "313244"), encoding="utf-8")
        assert is_layout_current(slide, chain) is False

    def test_ancestor_content_appears_in_slide(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("./main.svg"))
        inject_layout_layers(slide, [main.resolve()])
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
        inject_layout_layers(slide, [main.resolve()])
        content = slide.read_text(encoding="utf-8")
        assert "bg-grad" in content
        assert "linearGradient" in content


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
