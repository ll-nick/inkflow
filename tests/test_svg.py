from __future__ import annotations

import textwrap
from pathlib import Path

from inkflow.svg import compose_with_ancestors

_ANCESTOR_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <defs><style>.anc{fill:red}</style></defs>
      <rect id="anc-bg" class="anc" width="1920" height="1080"/>
    </svg>
""")

_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="slide-content" width="100" height="100"/>
    </svg>
""")


class TestComposeWithAncestors:
    def test_ancestor_content_prepended(self, tmp_path: Path) -> None:
        anc = tmp_path / "main.svg"
        anc.write_text(_ANCESTOR_SVG, encoding="utf-8")
        result = compose_with_ancestors(_SLIDE_SVG, [anc])
        # ancestor rect appears before slide content
        assert result.index("anc-bg") < result.index("slide-content")

    def test_ancestor_defs_merged(self, tmp_path: Path) -> None:
        anc = tmp_path / "main.svg"
        anc.write_text(_ANCESTOR_SVG, encoding="utf-8")
        result = compose_with_ancestors(_SLIDE_SVG, [anc])
        assert ".anc{fill:red}" in result or ".anc" in result

    def test_existing_layout_layers_stripped_from_slide(self, tmp_path: Path) -> None:
        anc = tmp_path / "main.svg"
        anc.write_text(_ANCESTOR_SVG, encoding="utf-8")
        slide_with_layer = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
              <g xmlns:inkflow="urn:inkflow"
                 inkflow:layout-src="/stale/layer.svg"
                 inkflow:layout-hash="000000"/>
              <rect id="slide-content" width="100" height="100"/>
            </svg>
        """)
        result = compose_with_ancestors(slide_with_layer, [anc])
        assert "stale/layer.svg" not in result
        assert "slide-content" in result
