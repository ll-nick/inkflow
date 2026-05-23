from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from lxml import etree

from inkflow import ns
from inkflow.layout import (
    inject_layout_layers,
    is_layout_current,
    resolve_chain,
    resolve_parent_path,
    strip_layout_layers,
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
    def test_project_relative(self, tmp_path: Path) -> None:
        svg = tmp_path / "slides" / "01.svg"
        result = resolve_parent_path("root:layouts/main", svg, tmp_path, {})
        assert result == (tmp_path / "layouts" / "main.svg").resolve()

    def test_file_relative(self, tmp_path: Path) -> None:
        svg = tmp_path / "slides" / "01.svg"
        result = resolve_parent_path("../layouts/main", svg, tmp_path, {})
        assert result == (tmp_path / "layouts" / "main.svg").resolve()

    def test_theme_relative(self, tmp_path: Path) -> None:
        themes = {"my-theme": "themes/my-theme"}
        svg = tmp_path / "slides" / "01.svg"
        result = resolve_parent_path("my-theme:layouts/bullets", svg, tmp_path, themes)
        assert (
            result
            == (tmp_path / "themes" / "my-theme" / "layouts" / "bullets.svg").resolve()
        )

    def test_svg_extension_auto_appended(self, tmp_path: Path) -> None:
        svg = tmp_path / "01.svg"
        result = resolve_parent_path("root:main", svg, tmp_path, {})
        assert result.suffix == ".svg"

    def test_svg_extension_not_doubled(self, tmp_path: Path) -> None:
        svg = tmp_path / "01.svg"
        result = resolve_parent_path("root:main.svg", svg, tmp_path, {})
        assert str(result).endswith("main.svg")
        assert not str(result).endswith("main.svg.svg")

    def test_unknown_theme_raises(self, tmp_path: Path) -> None:
        svg = tmp_path / "01.svg"
        with pytest.raises(ValueError, match="Unknown theme 'missing'"):
            resolve_parent_path("missing:layouts/foo", svg, tmp_path, {})


# ── resolve_chain ─────────────────────────────────────────────────────────────


class TestResolveChain:
    def test_no_parent_returns_empty(self, tmp_path: Path) -> None:
        slide = _write_svg(tmp_path / "slide.svg", _SIMPLE_SVG)
        assert resolve_chain(slide, tmp_path, {}) == []

    def test_single_parent(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("root:main.svg"))
        chain = resolve_chain(slide, tmp_path, {})
        assert chain == [main.resolve()]

    def test_two_level_chain_root_first(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        layout = _write_svg(
            tmp_path / "layouts" / "bullets.svg",
            _svg_with_parent("root:main.svg"),
        )
        slide = _write_svg(
            tmp_path / "slide.svg",
            _svg_with_parent("root:layouts/bullets.svg"),
        )
        chain = resolve_chain(slide, tmp_path, {})
        assert chain == [main.resolve(), layout.resolve()]

    def test_cycle_detection(self, tmp_path: Path) -> None:
        a = tmp_path / "a.svg"
        b = tmp_path / "b.svg"
        _write_svg(a, _svg_with_parent("root:b.svg"))
        _write_svg(b, _svg_with_parent("root:a.svg"))
        with pytest.raises(ValueError, match="Circular"):
            resolve_chain(a, tmp_path, {})


# ── strip_layout_layers ──────────────────────────────────────────────────────


class TestStripLayoutLayers:
    def _root_with_layers(self) -> etree._Element:  # pyright: ignore[reportPrivateUsage]
        return etree.fromstring(
            b"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow">
              <g inkflow:layout-src="/some/file.svg" inkflow:layout-hash="abc123"/>
              <g id="content"/>
              <rect id="bg"/>
            </svg>"""
        )

    def test_removes_marked_direct_children(self) -> None:
        root = self._root_with_layers()
        strip_layout_layers(root)
        ids = [el.get("id") or el.get(ns.INKFLOW_LAYOUT_SRC) for el in root]
        assert "/some/file.svg" not in ids
        assert "content" in ids
        assert "bg" in ids

    def test_leaves_unmarked_groups(self) -> None:
        root = self._root_with_layers()
        strip_layout_layers(root)
        assert root.find('.//{http://www.w3.org/2000/svg}g[@id="content"]') is not None

    def test_does_not_descend_into_nested(self) -> None:
        root = etree.fromstring(
            b"""<svg xmlns="http://www.w3.org/2000/svg">
              <g id="outer">
                <g inkflow:layout-src="/nested.svg" xmlns:inkflow="urn:inkflow"/>
              </g>
            </svg>"""
        )
        strip_layout_layers(root)
        # The outer group remains; the nested marked group is NOT removed
        # (only direct children are stripped).
        outer = root.find('.//{http://www.w3.org/2000/svg}g[@id="outer"]')
        assert outer is not None
        assert len(outer) == 1


# ── inject_layout_layers / is_layout_current ─────────────────────────────────


class TestInjectLayoutLayers:
    def test_injects_and_returns_true(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("root:main.svg"))
        chain = [main.resolve()]
        assert inject_layout_layers(slide, chain) is True
        root = etree.parse(slide).getroot()
        layers = [el for el in root if el.get(ns.INKFLOW_LAYOUT_SRC)]
        assert len(layers) == 1
        assert layers[0].get(ns.INKFLOW_LAYOUT_SRC) == "root:main.svg"

    def test_idempotent_returns_false(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("root:main.svg"))
        chain = [main.resolve()]
        inject_layout_layers(slide, chain)
        assert inject_layout_layers(slide, chain) is False

    def test_is_layout_current_after_inject(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("root:main.svg"))
        chain = [main.resolve()]
        inject_layout_layers(slide, chain)
        assert is_layout_current(slide, chain) is True

    def test_stale_after_ancestor_change(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("root:main.svg"))
        chain = [main.resolve()]
        inject_layout_layers(slide, chain)
        main.write_text(_SIMPLE_SVG.replace("1e1e2e", "313244"), encoding="utf-8")
        assert is_layout_current(slide, chain) is False

    def test_ancestor_content_appears_in_slide(self, tmp_path: Path) -> None:
        main = _write_svg(tmp_path / "main.svg")
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("root:main.svg"))
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
        slide = _write_svg(tmp_path / "slide.svg", _svg_with_parent("root:main.svg"))
        inject_layout_layers(slide, [main.resolve()])
        content = slide.read_text(encoding="utf-8")
        assert "bg-grad" in content
        assert "linearGradient" in content
