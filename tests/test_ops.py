# pyright: reportPrivateUsage=false
from __future__ import annotations

import json
import os
import stat
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypedDict, cast

import click
import pytest
from click.testing import CliRunner

from inkflow import ns
from inkflow.cli import main
from inkflow.cli.op_commands import _request_params
from inkflow.ops import ChangeSet, ConflictError, OpContext, OpError, parent
from inkflow.ops.changeset import file_hash
from inkflow.ops.parent import ParentSetRequest
from inkflow.ops.registry import described
from inkflow.svgio import parse_svg_file

_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="0" y="0" width="10" height="10"/>
    </svg>
""")

_NO_DECK = OpContext(None, None)


class _EditJson(TypedDict):
    path: str
    before_hash: str | None
    after_hash: str


class _ResultJson(TypedDict):
    api: str
    op: str
    applied: bool
    summary: str
    edits: list[_EditJson]


def _write(path: Path, content: str = _SLIDE_SVG) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class TestChangeSet:
    def test_unchanged_files_are_dropped(self, tmp_path: Path) -> None:
        same = _write(tmp_path / "same.txt", "a")
        other = _write(tmp_path / "other.txt", "a")
        changes = ChangeSet.from_contents("s", {same: "a", other: "b"})
        assert [edit.path for edit in changes.edits] == [other]

    def test_nothing_is_written_before_apply(self, tmp_path: Path) -> None:
        target = _write(tmp_path / "f.txt", "old")
        changes = ChangeSet.from_contents("s", {target: "new"})
        assert target.read_text(encoding="utf-8") == "old"
        changes.apply()
        assert target.read_text(encoding="utf-8") == "new"

    def test_creates_missing_files(self, tmp_path: Path) -> None:
        target = tmp_path / "sub" / "new.txt"
        changes = ChangeSet.from_contents("s", {target: "hello"})
        assert changes.edits[0].before_hash is None
        changes.apply()
        assert target.read_text(encoding="utf-8") == "hello"

    def test_after_hash_is_what_lands_on_disk(self, tmp_path: Path) -> None:
        target = _write(tmp_path / "f.txt", "old")
        changes = ChangeSet.from_contents("s", {target: "line\nline\n"})
        changes.apply()
        assert file_hash(target) == changes.edits[0].after_hash

    def test_conflict_writes_nothing(self, tmp_path: Path) -> None:
        first = _write(tmp_path / "a.txt", "a")
        second = _write(tmp_path / "b.txt", "b")
        changes = ChangeSet.from_contents("s", {first: "A", second: "B"})
        second.write_text("edited meanwhile", encoding="utf-8")
        with pytest.raises(ConflictError) as raised:
            changes.apply()
        assert raised.value.paths == [second]
        assert first.read_text(encoding="utf-8") == "a"

    def test_file_created_meanwhile_conflicts(self, tmp_path: Path) -> None:
        target = tmp_path / "new.txt"
        changes = ChangeSet.from_contents("s", {target: "mine"})
        _write(target, "theirs")
        with pytest.raises(ConflictError):
            changes.apply()

    @pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")
    def test_keeps_permissions(self, tmp_path: Path) -> None:
        target = _write(tmp_path / "f.txt", "old")
        target.chmod(0o640)
        ChangeSet.from_contents("s", {target: "new"}).apply()
        assert stat.S_IMODE(target.stat().st_mode) == 0o640

    def test_leaves_no_temporary_files(self, tmp_path: Path) -> None:
        target = _write(tmp_path / "f.txt", "old")
        ChangeSet.from_contents("s", {target: "new"}).apply()
        assert [path.name for path in tmp_path.iterdir()] == ["f.txt"]


class TestParentSet:
    def test_plans_parent_and_layers_without_writing(self, tmp_path: Path) -> None:
        slide = _write(tmp_path / "s.svg")
        changes = parent.set(ParentSetRequest(slide, "builtin:content"), _NO_DECK)
        assert slide.read_text(encoding="utf-8") == _SLIDE_SVG
        (edit,) = changes.edits
        assert 'inkflow:parent="builtin:content"' in edit.new_content
        assert "inkflow:layout-src" in edit.new_content

    def test_layers_follow_the_new_parent(self, tmp_path: Path) -> None:
        # The file on disk still names the old parent while the change is planned.
        slide = _write(tmp_path / "s.svg")
        parent.set(ParentSetRequest(slide, "builtin:content"), _NO_DECK).apply()
        parent.set(ParentSetRequest(slide, "builtin:title"), _NO_DECK).apply()
        root = parse_svg_file(slide)
        refs = [ref for el in root if (ref := el.get(ns.INKFLOW_LAYOUT_SRC))]
        assert refs[-1] == "builtin:title"
        assert "builtin:content" not in refs

    def test_same_parent_again_is_a_no_op(self, tmp_path: Path) -> None:
        slide = _write(tmp_path / "s.svg")
        parent.set(ParentSetRequest(slide, "builtin:content"), _NO_DECK).apply()
        again = parent.set(ParentSetRequest(slide, "builtin:content"), _NO_DECK)
        assert not again.changed

    def test_relative_parent_resolves_against_the_file(self, tmp_path: Path) -> None:
        _write(tmp_path / "layouts" / "main.svg")
        slide = _write(tmp_path / "slides" / "s.svg")
        request = ParentSetRequest(slide, "../layouts/main.svg")
        assert parent.set(request, _NO_DECK).changed

    def test_missing_relative_parent(self, tmp_path: Path) -> None:
        slide = _write(tmp_path / "s.svg")
        with pytest.raises(OpError, match="parent not found"):
            parent.set(ParentSetRequest(slide, "./nope.svg"), _NO_DECK)

    def test_own_ancestor_is_refused(self, tmp_path: Path) -> None:
        slide = _write(tmp_path / "s.svg")
        _write(
            tmp_path / "layout.svg",
            _SLIDE_SVG.replace(
                "<svg ",
                f'<svg xmlns:inkflow="{ns.INKFLOW}" inkflow:parent="./s.svg" ',
            ),
        )
        with pytest.raises(OpError, match="own ancestor"):
            parent.set(ParentSetRequest(slide, "./layout.svg"), _NO_DECK)

    def test_missing_file(self, tmp_path: Path) -> None:
        request = ParentSetRequest(tmp_path / "ghost.svg", "builtin:base")
        with pytest.raises(OpError, match="file not found"):
            parent.set(request, _NO_DECK)


class TestParentSetCli:
    @pytest.fixture
    def slide(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        monkeypatch.chdir(tmp_path)
        return _write(tmp_path / "s.svg")

    def test_dry_run_writes_nothing(self, slide: Path) -> None:
        result = CliRunner().invoke(
            main, ["parent", "set", "s.svg", "builtin:base", "--no-deck", "-n"]
        )
        assert result.exit_code == 0, result.output
        assert "Would write" in result.output
        assert slide.read_text(encoding="utf-8") == _SLIDE_SVG

    @pytest.mark.parametrize("dry_run", [False, True])
    def test_json(self, slide: Path, dry_run: bool) -> None:
        args = ["parent", "set", "s.svg", "builtin:base", "--no-deck", "--json"]
        result = CliRunner().invoke(main, [*args, "--dry-run"] if dry_run else args)
        assert result.exit_code == 0, result.output
        report = cast(_ResultJson, json.loads(result.stdout))
        assert report["api"] == "v0"
        assert report["op"] == "parent.set"
        assert report["applied"] is not dry_run
        assert [edit["path"] for edit in report["edits"]] == ["s.svg"]
        if not dry_run:
            assert report["edits"][0]["after_hash"] == file_hash(slide)

    def test_error_exits_1(self, slide: Path) -> None:
        result = CliRunner().invoke(
            main, ["parent", "set", "s.svg", "builtin:nope", "--no-deck"]
        )
        assert result.exit_code == 1
        assert "no built-in layout named 'nope'" in result.output
        assert slide.read_text(encoding="utf-8") == _SLIDE_SVG


@dataclass(frozen=True)
class _Request:
    target: Path
    name: str
    count: int = 1
    label: str | None = field(default=None, metadata=described("A label.", "TEXT"))
    force_all: bool = False


class TestRequestParams:
    def test_mapping(self) -> None:
        params = {param.name: param for param in _request_params(_Request)}
        assert isinstance(params["target"], click.Argument)
        assert isinstance(params["name"], click.Argument)
        count = params["count"]
        assert isinstance(count, click.Option)
        assert count.opts == ["--count"]
        assert count.default == 1
        label = params["label"]
        assert isinstance(label, click.Option)
        assert label.help == "A label."
        assert label.metavar == "TEXT"
        force_all = params["force_all"]
        assert isinstance(force_all, click.Option)
        assert force_all.is_flag
        assert force_all.opts == ["--force-all"]

    def test_unmapped_type_is_refused(self) -> None:
        @dataclass(frozen=True)
        class Unmapped:
            values: list[str]

        with pytest.raises(TypeError, match="no CLI mapping"):
            _request_params(Unmapped)

    def test_reserved_name_is_refused(self) -> None:
        @dataclass(frozen=True)
        class Clashing:
            dry_run: bool = False

        with pytest.raises(TypeError, match="clashes"):
            _request_params(Clashing)
