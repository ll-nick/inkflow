from __future__ import annotations

import textwrap
from pathlib import Path

from click.testing import CliRunner

from inkflow.cli import main
from inkflow.label2id import plan_renames, promote_labels_to_ids, slugify_label
from inkflow.svgio import parse_svg

_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         xmlns:inkflow="urn:inkflow"
         xmlns:xlink="http://www.w3.org/1999/xlink"
         viewBox="0 0 100 100">
      <defs>
        <linearGradient id="grad1" inkscape:label="My Gradient">
          <stop offset="0"/>
        </linearGradient>
      </defs>
      <g inkflow:layout-src="./base" inkflow:layout-hash="abc">
        <rect id="rect99" inkscape:label="in-preview-layer" width="10" height="10"/>
      </g>
      <rect id="rect1" inkscape:label="Headline Box"
            width="10" height="10" fill="url(#grad1)"/>
      <circle id="c1" inkscape:label="dot" cx="1" cy="1" r="1"/>
      <use id="u1" xlink:href="#c1" inkscape:label="dot-ref"/>
      <text inkscape:label="no-id-here" x="0" y="0">hi</text>
    </svg>
""")


class TestSlugify:
    def test_spaces_become_dashes(self) -> None:
        assert slugify_label("Headline Box") == "Headline-Box"

    def test_strips_accents_and_symbols(self) -> None:
        assert slugify_label("café — überschrift!") == "cafe-uberschrift"

    def test_leading_digit_gets_prefix(self) -> None:
        assert slugify_label("3 blind mice") == "_3-blind-mice"


class TestPlanRenames:
    def _plan(self, svg: str, **kwargs: bool):
        return plan_renames(parse_svg(svg), **kwargs)

    def test_valid_label_used_verbatim(self) -> None:
        plan = self._plan(_SVG)
        by_old = {r.old_id: r.new_id for r in plan.renames}
        assert by_old["c1"] == "dot"

    def test_invalid_label_is_slugified(self) -> None:
        plan = self._plan(_SVG)
        by_old = {r.old_id: r.new_id for r in plan.renames}
        assert by_old["rect1"] == "Headline-Box"

    def test_skips_elements_in_preview_layers(self) -> None:
        plan = self._plan(_SVG)
        assert all(r.old_id != "rect99" for r in plan.renames)

    def test_skips_non_shape_tags_by_default(self) -> None:
        plan = self._plan(_SVG)
        assert all(r.old_id != "grad1" for r in plan.renames)

    def test_all_tags_includes_gradient(self) -> None:
        plan = self._plan(_SVG, all_tags=True)
        by_old = {r.old_id: r.new_id for r in plan.renames}
        assert by_old["grad1"] == "My-Gradient"

    def test_duplicate_labels_first_wins_rest_skipped(self) -> None:
        svg = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg"
                 xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
              <rect id="a" inkscape:label="box"/>
              <rect id="b" inkscape:label="box"/>
            </svg>
        """)
        plan = self._plan(svg)
        assert [r.old_id for r in plan.renames] == ["a"]
        assert any("already in use" in s.reason for s in plan.skips)

    def test_label_colliding_with_existing_id_is_skipped(self) -> None:
        svg = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg"
                 xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
              <rect id="x" inkscape:label="taken"/>
              <rect id="taken"/>
            </svg>
        """)
        plan = self._plan(svg)
        assert plan.renames == []
        assert plan.skips[0].reason == "id 'taken' already in use"

    def test_label_matching_current_id_is_noop(self) -> None:
        svg = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg"
                 xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
              <rect id="box" inkscape:label="box"/>
            </svg>
        """)
        plan = self._plan(svg)
        assert plan.renames == []
        assert plan.skips == []


class TestPromoteLabelsToIds:
    def test_rewrites_ids_and_preserves_formatting(self) -> None:
        result = promote_labels_to_ids(_SVG)
        assert 'id="Headline-Box"' in result.text
        assert 'id="dot"' in result.text
        # Untouched lines keep their exact original text.
        assert (
            '  <text inkscape:label="no-id-here" x="0" y="0">hi</text>' in result.text
        )

    def test_rewrites_href_reference(self) -> None:
        result = promote_labels_to_ids(_SVG)
        assert 'xlink:href="#dot"' in result.text
        assert "#c1" not in result.text

    def test_leaves_unrelated_url_reference_alone(self) -> None:
        result = promote_labels_to_ids(_SVG)
        assert 'fill="url(#grad1)"' in result.text

    def test_no_refs_keeps_dangling_reference(self) -> None:
        result = promote_labels_to_ids(_SVG, rewrite_refs=False)
        assert 'xlink:href="#c1"' in result.text
        assert result.reference_edits == 0

    def test_element_without_id_is_reported_not_renamed(self) -> None:
        result = promote_labels_to_ids(_SVG)
        assert any(s.label == "no-id-here" for s in result.skips)
        assert all(r.label != "no-id-here" for r in result.renames)

    def test_clean_document_is_unchanged(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="a"/></svg>'
        result = promote_labels_to_ids(svg)
        assert not result.changed
        assert result.text == svg


class TestLabel2IdCli:
    def _write(self, tmp_path: Path) -> Path:
        svg_file = tmp_path / "slide.svg"
        svg_file.write_text(_SVG, encoding="utf-8")
        return svg_file

    def test_writes_renamed_ids_in_place(self, tmp_path: Path) -> None:
        svg_file = self._write(tmp_path)
        result = CliRunner().invoke(main, ["label2id", str(svg_file)])
        assert result.exit_code == 0
        assert 'id="Headline-Box"' in svg_file.read_text(encoding="utf-8")

    def test_dry_run_does_not_write(self, tmp_path: Path) -> None:
        svg_file = self._write(tmp_path)
        original = svg_file.read_text(encoding="utf-8")
        CliRunner().invoke(main, ["label2id", "-n", str(svg_file)])
        assert svg_file.read_text(encoding="utf-8") == original

    def test_check_exits_nonzero_when_dirty(self, tmp_path: Path) -> None:
        svg_file = self._write(tmp_path)
        result = CliRunner().invoke(main, ["label2id", "--check", str(svg_file)])
        assert result.exit_code == 1

    def test_check_exits_zero_when_clean(self, tmp_path: Path) -> None:
        svg_file = tmp_path / "slide.svg"
        svg_file.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg"><rect id="a"/></svg>',
            encoding="utf-8",
        )
        result = CliRunner().invoke(main, ["label2id", "--check", str(svg_file)])
        assert result.exit_code == 0

    def test_missing_file_errors(self, tmp_path: Path) -> None:
        result = CliRunner().invoke(main, ["label2id", str(tmp_path / "ghost.svg")])
        assert result.exit_code != 0
