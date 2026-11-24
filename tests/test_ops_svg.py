from __future__ import annotations

import json
import logging
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow import git_setup, ns
from inkflow.cli import main
from inkflow.enums import ColorMode
from inkflow.manifest import Deck, Slide
from inkflow.ops import OpContext, OpError, layout, svg, theme
from inkflow.svgio import parse_svg_file

_NO_DECK = OpContext(None, None)

_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="0" y="0" width="10" height="10"/>
    </svg>
""")

_DIRTY_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
         inkscape:version="1.3.2" viewBox="0 0 1920 1080">
      <sodipodi:namedview id="namedview1" inkscape:zoom="1.0"/>
      <rect id="box" x="0" y="0" width="10" height="10"/>
    </svg>
""")

_LABELLED_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
      <g id="g12" inkscape:label="Headline Box"/>
      <use href="#g12"/>
      <rect id="taken"/>
      <rect id="rect3" inkscape:label="taken"/>
    </svg>
""")

_PARENTED_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="builtin:base" viewBox="0 0 1920 1080">
    </svg>
""")


def _write(path: Path, content: str = _SLIDE_SVG) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _project(tmp_path: Path) -> OpContext:
    """One parented slide and one bare slide, both in the deck."""
    _write(tmp_path / "slides" / "01.svg", _PARENTED_SVG)
    _write(tmp_path / "slides" / "02.svg")
    deck = Deck(slides=[Slide("slides/01.svg"), Slide("slides/02.svg")])
    return OpContext(deck, tmp_path)


class TestClean:
    def test_strips_metadata(self, tmp_path: Path) -> None:
        dirty = _write(tmp_path / "d.svg", _DIRTY_SVG)
        changes = svg.clean(svg.SvgCleanRequest((dirty,)), _NO_DECK)
        assert [edit.path for edit in changes.edits] == [dirty.resolve()]
        changes.apply()
        assert "inkscape:" not in dirty.read_text(encoding="utf-8")

    def test_clean_file_is_left_as_written(self, tmp_path: Path) -> None:
        # No metadata, but not in the pretty-printed form clean writes either.
        plain = _write(tmp_path / "p.svg", _SLIDE_SVG.replace('"', "'"))
        changes = svg.clean(svg.SvgCleanRequest((plain,)), _NO_DECK)
        assert not changes.changed
        assert changes.summary == "nothing to clean in 1 file(s)"

    def test_cleaned_matches_what_clean_writes(self, tmp_path: Path) -> None:
        dirty = _write(tmp_path / "d.svg", _DIRTY_SVG)
        printed = svg.cleaned(svg.SvgCleanedRequest(dirty), _NO_DECK)
        svg.clean(svg.SvgCleanRequest((dirty,)), _NO_DECK).apply()
        assert printed.render() == dirty.read_text(encoding="utf-8")
        assert printed.to_json()["path"] == printed.path

    def test_cleaned_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(OpError, match="file not found"):
            svg.cleaned(svg.SvgCleanedRequest(tmp_path / "ghost.svg"), _NO_DECK)


class TestLabel2Id:
    def test_renames_and_reports_each_rename(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "s.svg", _LABELLED_SVG)
        changes = svg.label2id(svg.SvgLabel2IdRequest((path,)), _NO_DECK)
        (edit,) = changes.edits
        assert edit.detail == "g12 → Headline-Box (1 reference(s))"
        assert 'href="#Headline-Box"' in edit.new_content

    def test_no_refs_leaves_references(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "s.svg", _LABELLED_SVG)
        request = svg.SvgLabel2IdRequest((path,), refs=False)
        (edit,) = svg.label2id(request, _NO_DECK).edits
        assert 'href="#g12"' in edit.new_content

    def test_clash_is_a_warning(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        path = _write(tmp_path / "s.svg", _LABELLED_SVG)
        with caplog.at_level(logging.WARNING, logger="inkflow"):
            svg.label2id(svg.SvgLabel2IdRequest((path,)), _NO_DECK)
        assert "already in use" in caplog.text

    def test_no_labels_is_a_no_op(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "s.svg")
        changes = svg.label2id(svg.SvgLabel2IdRequest((path,)), _NO_DECK)
        assert changes.summary == "no labels to promote in 1 file(s)"


class TestSync:
    def test_sweep_skips_bare_files(self, tmp_path: Path) -> None:
        context = _project(tmp_path)
        changes = svg.sync(svg.SvgSyncRequest(), context)
        assert [context.label(edit.path) for edit in changes.edits] == ["slides/01.svg"]

    def test_named_bare_file_gets_the_preview_style(self, tmp_path: Path) -> None:
        context = _project(tmp_path)
        bare = tmp_path / "slides" / "02.svg"
        svg.sync(svg.SvgSyncRequest((bare,)), context).apply()
        assert 'id="inkflow-preview"' in bare.read_text(encoding="utf-8")

    def test_second_run_is_a_no_op(self, tmp_path: Path) -> None:
        context = _project(tmp_path)
        svg.sync(svg.SvgSyncRequest(), context).apply()
        assert not svg.sync(svg.SvgSyncRequest(), context).changed

    def test_mode_overrides_the_deck(self, tmp_path: Path) -> None:
        context = _project(tmp_path)
        svg.sync(svg.SvgSyncRequest(), context).apply()
        light = svg.SvgSyncRequest(mode=ColorMode.LIGHT)
        assert svg.sync(light, context).changed

    def test_no_deck_reports_the_rule(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "s.svg", _PARENTED_SVG)
        (edit,) = svg.sync(svg.SvgSyncRequest((path,)), _NO_DECK).edits
        assert edit.detail == "no deck, inkflow:preview-overlays only"


class TestColorize:
    def test_replaces_theme_hex_with_a_class(self, tmp_path: Path) -> None:
        tokens = theme.palette(theme.ThemePaletteRequest(), _NO_DECK).gpl
        accent = next(line for line in tokens.splitlines() if line.endswith("\taccent"))
        red, green, blue = (int(part) for part in accent.split()[:3])
        hex_value = f"#{red:02x}{green:02x}{blue:02x}"
        path = _write(
            tmp_path / "s.svg", _SLIDE_SVG.replace("/>", f' fill="{hex_value}"/>')
        )
        (edit,) = svg.colorize(svg.SvgColorizeRequest((path,)), _NO_DECK).edits
        assert "inkflow-fill-accent" in edit.new_content
        assert hex_value not in edit.new_content

    def test_nothing_to_replace(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "s.svg")
        assert not svg.colorize(svg.SvgColorizeRequest((path,)), _NO_DECK).changed


class TestNew:
    def test_blank_slide(self, tmp_path: Path) -> None:
        out = tmp_path / "blank.svg"
        changes = svg.new(svg.SvgNewRequest(out), _NO_DECK)
        assert not out.exists()
        changes.apply()
        root = parse_svg_file(out)
        assert root.get(ns.INKFLOW_PARENT) is None
        assert root.get("viewBox") == "0 0 1920 1080"
        assert out.read_text(encoding="utf-8").endswith("\n")

    def test_parented_slide_takes_the_layout_canvas(self, tmp_path: Path) -> None:
        _write(
            tmp_path / "layouts" / "wide.svg",
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2560 1080"/>',
        )
        out = tmp_path / "slides" / "child.svg"
        context = OpContext(Deck(slides=[]), tmp_path)
        svg.new(svg.SvgNewRequest(out, parent="wide"), context).apply()
        root = parse_svg_file(out)
        assert root.get(ns.INKFLOW_PARENT) == "wide"
        assert root.get("viewBox") == "0 0 2560 1080"
        assert root.find(f"*[@{{{ns.INKFLOW}}}layout-src]") is not None

    def test_summary_names_the_deck_line(self, tmp_path: Path) -> None:
        context = OpContext(Deck(slides=[]), tmp_path)
        out = tmp_path / "slides" / "new.svg"
        changes = svg.new(svg.SvgNewRequest(out), context)
        assert 'Slide("slides/new.svg")' in changes.summary

    def test_existing_file_is_refused(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "s.svg")
        with pytest.raises(OpError, match="already exists"):
            svg.new(svg.SvgNewRequest(path), _NO_DECK)

    def test_unresolvable_parent(self, tmp_path: Path) -> None:
        request = svg.SvgNewRequest(tmp_path / "s.svg", parent="local:missing")
        with pytest.raises(OpError):
            svg.new(request, OpContext(Deck(slides=[]), tmp_path))


class TestThemePalette:
    def test_named_after_mode(self) -> None:
        light = theme.ThemePaletteRequest(ColorMode.LIGHT)
        assert theme.palette(light, _NO_DECK).name == "inkflow (light)"

    def test_json(self) -> None:
        result = CliRunner().invoke(main, ["theme", "palette", "--no-deck", "--json"])
        assert result.exit_code == 0, result.output
        payload = cast("dict[str, str]", json.loads(result.stdout))
        assert payload["op"] == "theme.palette"
        assert payload["gpl"].startswith("GIMP Palette")


class TestLayoutList:
    def test_lists_builtins_with_chain_and_zones(self) -> None:
        listing = layout.list_assets(layout.LayoutListRequest(), _NO_DECK)
        content = next(entry for entry in listing.layouts if entry.name == "content")
        assert content.source == "builtin"
        assert content.parents == ["base", "numbered", "title"]
        assert "title" in content.zones
        assert content.numbered

    def test_local_overlay_is_listed(self, tmp_path: Path) -> None:
        _write(tmp_path / "overlays" / "footer.svg")
        context = OpContext(Deck(slides=[]), tmp_path)
        listing = layout.list_assets(layout.LayoutListRequest(), context)
        assert [(entry.name, entry.source) for entry in listing.overlays] == [
            ("footer", "local")
        ]

    def test_table_goes_to_stdout(self) -> None:
        result = CliRunner().invoke(main, ["layout", "list", "--no-deck"])
        assert result.exit_code == 0, result.output
        assert "content" in result.stdout


class TestHook:
    def test_rewrites_a_hook_an_older_setup_installed(self, tmp_path: Path) -> None:
        hook = _write(
            tmp_path / "pre-commit",
            git_setup.HOOK_SCRIPT.replace("svg clean", "clean"),
        )
        assert git_setup.ensure_hook(tmp_path) is git_setup.FileStatus.UPDATED
        assert hook.read_text(encoding="utf-8") == git_setup.HOOK_SCRIPT
        assert git_setup.ensure_hook(tmp_path) is git_setup.FileStatus.UNCHANGED

    def test_leaves_the_users_own_hook(self, tmp_path: Path) -> None:
        own = "#!/bin/sh\nexit 0\n"
        hook = _write(tmp_path / "pre-commit", own)
        assert git_setup.ensure_hook(tmp_path) is git_setup.FileStatus.UNCHANGED
        assert hook.read_text(encoding="utf-8") == own
