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
from inkflow.ops import ChangeSet, ConflictError, DeckUse, OpContext, OpError, parent
from inkflow.ops.changeset import file_hash
from inkflow.ops.parent import (
    FileParent,
    ParentGetRequest,
    ParentSetRequest,
    ParentStripRequest,
)
from inkflow.ops.registry import (
    described,
    register,
    register_group,
    registered_ops,
)
from inkflow.svgio import parse_svg_file

_SLIDE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="0" y="0" width="10" height="10"/>
    </svg>
""")

_INKSCAPE_PROLOG = (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    "<!-- Created with Inkscape (http://www.inkscape.org/) -->\n\n"
)
# _SLIDE_SVG as Inkscape saves it: declaration, comment, its own attribute layout.
_INKSCAPE_SLIDE_SVG = _INKSCAPE_PROLOG + textwrap.dedent("""\
    <svg
       xmlns="http://www.w3.org/2000/svg"
       viewBox='0 0 1920 1080'>
      <rect
         id="box"
         x="0"
         y="0"
         width="10"
         height="10" />
    </svg>
""")

_NO_DECK = OpContext(None, None)


def _write_inkscape(path: Path, newline: str = "\n") -> Path:
    path.write_bytes(_INKSCAPE_SLIDE_SVG.replace("\n", newline).encode())
    return path


class _EditJson(TypedDict):
    path: str
    before_hash: str | None
    after_hash: str
    detail: str


class _ResultJson(TypedDict):
    api: str
    op: str
    applied: bool
    summary: str
    edits: list[_EditJson]


class _FileParentJson(TypedDict):
    path: str
    parent: str | None


class _ParentGetJson(TypedDict):
    api: str
    op: str
    files: list[_FileParentJson]


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

    @pytest.mark.parametrize("newline", ["\n", "\r\n"])
    def test_same_parent_again_on_inkscape_file_is_a_no_op(
        self, tmp_path: Path, newline: str
    ) -> None:
        slide = _write(tmp_path / "s.svg")
        parent.set(ParentSetRequest(slide, "builtin:content"), _NO_DECK).apply()
        # Saved again by Inkscape: same document, its own markup.
        text = slide.read_text(encoding="utf-8")
        resaved = _INKSCAPE_PROLOG + text.replace("/>", " />").replace(
            " id=", "\n   id="
        )
        slide.write_bytes(resaved.replace("\n", newline).encode())
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
        with pytest.raises(OpError, match="Circular"):
            parent.set(ParentSetRequest(slide, "./layout.svg"), _NO_DECK)

    def test_missing_file(self, tmp_path: Path) -> None:
        request = ParentSetRequest(tmp_path / "ghost.svg", "builtin:base")
        with pytest.raises(OpError, match="file not found"):
            parent.set(request, _NO_DECK)


_OVERLAY_DECK = textwrap.dedent("""\
    from inkflow import Deck, Overlay, Slide

    def main():
        return Deck(slides=[Slide("slides/01.svg")], overlays=[Overlay("footer")])
""")

_FOOTER_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <text id="footer" x="80" y="1050">chrome</text>
    </svg>
""")


class TestParentSetKeepsSync:
    """`parent set` leaves a file as `sync` would, overlays and styles included."""

    @pytest.fixture
    def runner(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> CliRunner:
        monkeypatch.chdir(tmp_path)
        _write(tmp_path / "deck.py", _OVERLAY_DECK)
        _write(tmp_path / "overlays" / "footer.svg", _FOOTER_SVG)
        _write(tmp_path / "slides" / "01.svg")
        runner = CliRunner()
        set_parent = ["parent", "set", "slides/01.svg", "builtin:content"]
        assert runner.invoke(main, set_parent).exit_code == 0
        assert runner.invoke(main, ["sync"]).exit_code == 0
        return runner

    def test_same_parent_writes_nothing(self, runner: CliRunner) -> None:
        before = Path("slides/01.svg").read_bytes()
        result = runner.invoke(
            main, ["parent", "set", "slides/01.svg", "builtin:content"]
        )
        assert result.exit_code == 0, result.output
        assert "Unchanged" in result.output
        assert Path("slides/01.svg").read_bytes() == before

    def test_new_parent_stays_in_sync(self, runner: CliRunner) -> None:
        result = runner.invoke(
            main, ["parent", "set", "slides/01.svg", "builtin:title"]
        )
        assert result.exit_code == 0, result.output
        assert 'inkflow:overlay-src="footer"' in Path("slides/01.svg").read_text(
            encoding="utf-8"
        )
        assert runner.invoke(main, ["sync", "--check"]).exit_code == 0


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


def _parented(path: Path, value: str = "builtin:content") -> Path:
    _write(path)
    parent.set(ParentSetRequest(path, value), _NO_DECK).apply()
    return path


class TestParentStrip:
    def test_removes_parent_and_layers(self, tmp_path: Path) -> None:
        slide = _parented(tmp_path / "s.svg")
        changes = parent.strip(ParentStripRequest((slide,)), _NO_DECK)
        (edit,) = changes.edits
        assert edit.detail == "parent 'builtin:content' removed"
        changes.apply()
        text = slide.read_text(encoding="utf-8")
        assert "inkflow:parent" not in text
        assert "inkflow:layout-src" not in text
        assert text.endswith("\n")

    def test_plain_file_is_left_alone(self, tmp_path: Path) -> None:
        slide = _write(tmp_path / "s.svg")
        changes = parent.strip(ParentStripRequest((slide,)), _NO_DECK)
        assert not changes.changed
        assert changes.summary == "nothing to strip in 1 file(s)"

    @pytest.mark.parametrize("newline", ["\n", "\r\n"])
    def test_inkscape_file_without_parent_is_left_alone(
        self, tmp_path: Path, newline: str
    ) -> None:
        slide = _write_inkscape(tmp_path / "s.svg", newline)
        assert not parent.strip(ParentStripRequest((slide,)), _NO_DECK).changed

    def test_reports_only_files_that_change(self, tmp_path: Path) -> None:
        plain = _write(tmp_path / "plain.svg")
        slide = _parented(tmp_path / "s.svg")
        changes = parent.strip(ParentStripRequest((plain, slide)), _NO_DECK)
        assert [edit.path for edit in changes.edits] == [slide]
        assert changes.summary == "stripped 1 of 2 file(s)"

    def test_missing_file_aborts_everything(self, tmp_path: Path) -> None:
        slide = _parented(tmp_path / "s.svg")
        request = ParentStripRequest((slide, tmp_path / "ghost.svg"))
        with pytest.raises(OpError, match="file not found"):
            parent.strip(request, _NO_DECK)

    def test_no_files_without_a_deck(self) -> None:
        with pytest.raises(OpError, match="no deck to sweep"):
            parent.strip(ParentStripRequest(), _NO_DECK)


class TestParentGet:
    def test_reports_each_file(self, tmp_path: Path) -> None:
        plain = _write(tmp_path / "plain.svg")
        slide = _parented(tmp_path / "s.svg")
        result = parent.get(ParentGetRequest((plain, slide)), _NO_DECK)
        assert result.files == [
            FileParent(plain.as_posix(), None),
            FileParent(slide.as_posix(), "builtin:content"),
        ]

    def test_renders_one_line_per_file(self, tmp_path: Path) -> None:
        plain = _write(tmp_path / "plain.svg")
        slide = _parented(tmp_path / "s.svg")
        result = parent.get(ParentGetRequest((plain, slide)), _NO_DECK)
        assert result.render().plain.splitlines() == [
            f"{plain.as_posix()}: (no parent)",
            f"{slide.as_posix()}: builtin:content",
        ]

    def test_same_file_twice_is_reported_once(self, tmp_path: Path) -> None:
        slide = _write(tmp_path / "s.svg")
        result = parent.get(ParentGetRequest((slide, slide)), _NO_DECK)
        assert len(result.files) == 1


_TWO_SLIDE_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide

    def main():
        return Deck(slides=[Slide("slides/01.svg"), Slide("slides/02.svg")])
""")


class TestFileOpsCli:
    @pytest.fixture
    def project(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        monkeypatch.chdir(tmp_path)
        _write(tmp_path / "deck.py", _TWO_SLIDE_DECK)
        _parented(tmp_path / "slides" / "01.svg")
        _write(tmp_path / "slides" / "02.svg")
        return tmp_path

    def test_strip_sweeps_the_deck(self, project: Path) -> None:
        result = CliRunner().invoke(main, ["parent", "strip"])
        assert result.exit_code == 0, result.output
        assert "slides/01.svg: parent 'builtin:content' removed" in result.output
        assert "slides/02.svg" not in result.output
        text = (project / "slides" / "01.svg").read_text(encoding="utf-8")
        assert "inkflow:parent" not in text

    def test_strip_named_files_needs_no_deck(self, project: Path) -> None:
        (project / "deck.py").unlink()
        result = CliRunner().invoke(main, ["parent", "strip", "slides/01.svg"])
        assert result.exit_code == 0, result.output

    def test_check_reports_without_writing(self, project: Path) -> None:
        before = (project / "slides" / "01.svg").read_bytes()
        result = CliRunner().invoke(main, ["parent", "strip", "--check"])
        assert result.exit_code == 1
        assert "Would write" in result.output
        assert (project / "slides" / "01.svg").read_bytes() == before

    @pytest.mark.usefixtures("project")
    def test_check_passes_when_nothing_would_change(self) -> None:
        result = CliRunner().invoke(
            main, ["parent", "strip", "--check", "slides/02.svg"]
        )
        assert result.exit_code == 0, result.output

    @pytest.mark.usefixtures("project")
    def test_get_sweeps_the_deck(self) -> None:
        result = CliRunner().invoke(main, ["parent", "get"])
        assert result.exit_code == 0, result.output
        assert "slides/01.svg: builtin:content" in result.output
        assert "slides/02.svg: (no parent)" in result.output

    @pytest.mark.usefixtures("project")
    def test_get_json(self) -> None:
        result = CliRunner().invoke(main, ["parent", "get", "--json"])
        assert result.exit_code == 0, result.output
        report = cast(_ParentGetJson, json.loads(result.stdout))
        assert report["api"] == "v0"
        assert report["op"] == "parent.get"
        assert report["files"] == [
            {"path": "slides/01.svg", "parent": "builtin:content"},
            {"path": "slides/02.svg", "parent": None},
        ]


class TestRegister:
    def test_kind_follows_the_output_type(self) -> None:
        kinds = {op.name: op.writes for op in registered_ops()}
        assert kinds["parent.set"] is True
        assert kinds["parent.get"] is False

    def test_output_without_to_json_is_refused(self) -> None:
        group = register_group("test-bad-output", "")
        with pytest.raises(TypeError, match="has no to_json"):
            register(group, "run", ParentGetRequest, str, deck=DeckUse.OPTIONAL)  # pyright: ignore[reportArgumentType]

    def test_read_output_needs_render(self) -> None:
        class JsonOnly:
            def to_json(self) -> dict[str, object]:
                return {}

        group = register_group("test-no-render", "")
        with pytest.raises(TypeError, match="has no render"):
            register(group, "run", ParentGetRequest, JsonOnly, deck=DeckUse.OPTIONAL)  # pyright: ignore[reportArgumentType]


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

    def test_tuple_is_variadic(self) -> None:
        @dataclass(frozen=True)
        class Variadic:
            required: tuple[Path, ...]

        @dataclass(frozen=True)
        class Optional:
            files: tuple[str, ...] = ()

        (required,) = _request_params(Variadic)
        assert isinstance(required, click.Argument)
        assert (required.nargs, required.required) == (-1, True)
        (optional,) = _request_params(Optional)
        assert isinstance(optional, click.Argument)
        assert (optional.nargs, optional.required) == (-1, False)

    def test_two_variadics_are_refused(self) -> None:
        @dataclass(frozen=True)
        class Two:
            first: tuple[Path, ...]
            second: tuple[Path, ...]

        with pytest.raises(TypeError, match="more than one variadic"):
            _request_params(Two)

    def test_reserved_name_is_refused(self) -> None:
        @dataclass(frozen=True)
        class Clashing:
            dry_run: bool = False

        with pytest.raises(TypeError, match="clashes"):
            _request_params(Clashing)
