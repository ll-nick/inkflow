"""A deck that looks the same everywhere: where its fonts come from
(``inkflow fonts``), bringing them into the deck (``fonts bundle``/``set``),
and packing the rest (``inkflow pack``): files from outside the deck, the
pinned project and lock, git rules, committed PDF pages, a zip, and the checks
``verify`` and a commit make from it."""

# fontTools ships no type stubs: its builder calls report unknown member types.
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import textwrap
import threading
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner
from websockets.asyncio.server import serve as ws_serve

from inkflow import fontreport, instances, lfs, pack, pdf, server
from inkflow.cli import main
from inkflow.edit import NO_EDIT_COMMANDS
from inkflow.editor.filerename import plan_copy_in
from inkflow.editor.session import EditError, EditorSession
from inkflow.fontreport import Face, Where, font_report, plan_bundle, token_value
from inkflow.logging import resolve_levels
from inkflow.manifest import Deck, Slide
from inkflow.pipeline import SlideData
from inkflow.server import load_deck
from inkflow.themes import Theme
from inkflow.tui import LiveUI

# ── Fonts on disk ─────────────────────────────────────────────────────────────


def make_font(
    path: Path,
    family: str,
    *,
    weight: int = 400,
    italic: bool = False,
    licence: str = "",
    fs_type: int = 0,
) -> Path:
    """A one-glyph TrueType font named ``family`` at ``weight``/``italic``."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 700))
    pen.lineTo((500, 700))
    pen.closePath()
    fb = FontBuilder(unitsPerEm=1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", "A"])
    fb.setupCharacterMap({0x41: "A"})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "A": pen.glyph()})
    fb.setupHorizontalMetrics({".notdef": (600, 0), "A": (600, 0)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    style = ("Bold " if weight >= 700 else "") + ("Italic" if italic else "")
    names: dict[str, str] = {
        "familyName": family,
        "styleName": style.strip() or "Regular",
    }
    if licence:
        names["licenseDescription"] = licence
    fb.setupNameTable(names)
    fb.setupOS2(
        usWeightClass=weight,
        fsSelection=0x01 if italic else 0x40,
        fsType=fs_type,
    )
    fb.setupPost()
    path.parent.mkdir(parents=True, exist_ok=True)
    fb.save(str(path))
    return path


class DirTheme(Theme):
    def __init__(self, asset_dir: Path) -> None:
        super().__init__()
        self._asset_dir: Path = asset_dir

    def asset_dir(self) -> Path:  # pyright: ignore[reportImplicitOverride]
        return self._asset_dir


@pytest.fixture
def machine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake font folder of "this computer" (the only one searched beside the
    deck's and the theme's)."""
    folder = tmp_path / "machine-fonts"
    folder.mkdir()

    def font_dirs(project_dir: Path, theme_fonts_dir: Path | None) -> list[Path]:
        dirs = [project_dir / "fonts", *([theme_fonts_dir] if theme_fonts_dir else [])]
        return [d for d in [*dirs, folder] if d.exists()]

    monkeypatch.setattr("inkflow.fonts._font_dirs", font_dirs)
    return folder


def _slide(body: str) -> SlideData:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + body
        + "</svg>"
    )
    return {"svg": svg, "title": "", "id": "one", "notes": "", "editableFiles": []}


def _styles(project: Path, **tokens: str) -> None:
    decls = "".join(
        f"    --inkflow-{role}-font: {value};\n" for role, value in tokens.items()
    )
    (project / "styles.css").write_text(f":root {{\n{decls}}}\n", encoding="utf-8")


# ── The report ────────────────────────────────────────────────────────────────


def test_each_family_is_classified_by_where_it_comes_from(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    theme_dir = tmp_path / "theme"
    make_font(project / "fonts" / "Own.ttf", "Ownface")
    make_font(theme_dir / "fonts" / "Themed.ttf", "Themeface")
    make_font(machine / "here" / "Here.ttf", "Hereface")
    (machine / "here" / "OFL.txt").write_text(
        "SIL Open Font License 1.1\n", encoding="utf-8"
    )
    _styles(project, body="Hereface, sans-serif", heading="Themeface", mono="monospace")
    deck = Deck(slides=[Slide("x")], theme=DirTheme(theme_dir))
    slides = [
        _slide(
            '<text font-family="Ownface">a</text>'
            + '<text style="font-family: Gone Sans, serif; font-weight: bold">b</text>'
        )
    ]
    report = font_report(deck, project, slides)
    where = {f.family: f.where for f in report.families}
    assert where == {
        "Ownface": Where.PROJECT,
        "Themeface": Where.THEME,
        "Hereface": Where.MACHINE,
        "Gone Sans": Where.MISSING,
        "monospace": Where.GENERIC,
    }
    here = report.by_family("Hereface")
    assert here is not None and here.licence is not None
    assert here.licence.status == "open"
    assert here.files[0].path == machine / "here" / "Here.ttf"
    gone = report.by_family("Gone Sans")
    assert gone is not None and gone.faces == [Face(700)]
    assert "comes from this machine" in here.message()
    assert str(machine / "here" / "Here.ttf") in here.message()
    assert [f.family for f in report.problems] == [
        "monospace",
        "Gone Sans",
        "Hereface",
    ]


def test_a_project_override_replaces_the_themes_font(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "Here.ttf", "Hereface")
    css = ":root { --inkflow-body-font: Hereface, sans-serif; }\n"
    (project / "styles.css").write_text(css, encoding="utf-8")
    report = font_report(Deck(slides=[Slide("x")]), project, [_slide("")])
    assert report.tokens["body"] == "Hereface, sans-serif"
    assert report.by_family("Hereface") is not None
    # The built-in theme's own body font is no longer the deck's.
    assert all(
        f.used_by != ["body font"] or f.family == "Hereface" for f in report.families
    )


def test_body_faces_follow_the_text(tmp_path: Path, machine: Path) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "Here.ttf", "Hereface")
    _styles(project, body="Hereface")
    html = (
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">'
        + "<p>plain <strong>bold</strong> <em>slanted</em></p></div></foreignObject>"
    )
    report = font_report(Deck(slides=[Slide("x")]), project, [_slide(html)])
    family = report.by_family("Hereface")
    assert family is not None
    assert family.faces == [Face(400), Face(400, True), Face(700), Face(700, True)]
    plain = font_report(Deck(slides=[Slide("x")]), project, [_slide("")])
    assert cast("fontreport.FamilyReport", plain.by_family("Hereface")).faces == [
        Face(400)
    ]


# ── Bundling ──────────────────────────────────────────────────────────────────


def _machine_family(machine: Path, family: str = "Hereface") -> None:
    folder = machine / family.lower()
    make_font(folder / f"{family}-Regular.ttf", family)
    make_font(folder / f"{family}-Bold.ttf", family, weight=700)
    make_font(folder / f"{family}-Light.ttf", family, weight=300)
    make_font(folder / f"{family}-Italic.ttf", family, italic=True)
    (folder / "OFL.txt").write_text("SIL Open Font License 1.1\n", encoding="utf-8")


def test_bundle_copies_only_the_used_weights_with_licence_and_readme(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    _machine_family(machine)
    _styles(project, body="Hereface, sans-serif")
    report = font_report(Deck(slides=[Slide("x")]), project, [_slide("")])
    plan = plan_bundle(report, project)
    assert sorted(c.dst.relative_to(project).as_posix() for c in plan.copies) == [
        "fonts/hereface/Hereface-Regular.ttf",
        "fonts/hereface/OFL.txt",
    ]
    assert plan.warnings == []
    assert plan.readme is not None
    assert "| Hereface | `hereface/` |" in plan.readme
    assert "SIL Open Font License" in plan.readme
    every = plan_bundle(report, project, all_weights=True)
    assert len([c for c in every.copies if c.dst.suffix == ".ttf"]) == 4


def test_a_system_font_or_one_without_a_licence_is_bundled_with_a_warning(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "arial" / "arial.ttf", "Arial")
    make_font(machine / "odd" / "Odd.ttf", "Oddface")
    make_font(machine / "shut" / "Shut.ttf", "Shutface")
    (machine / "shut" / "LICENSE.txt").write_text(
        "This font may not be redistributed.\n", encoding="utf-8"
    )
    slides = [
        _slide(
            '<text font-family="Arial">a</text><text font-family="Oddface">b</text>'
            + '<text font-family="Shutface">c</text>'
        )
    ]
    report = font_report(Deck(slides=[Slide("x")]), project, slides)
    plan = plan_bundle(report, project)
    assert sorted(plan.families) == ["Arial", "Oddface", "Shutface"]
    text = "\n".join(plan.warnings)
    assert '"Arial" is a Microsoft/Monotype system font' in text
    assert "Arimo" in text
    assert '"Oddface": no licence found' in text
    assert '"Shutface" has a proprietary licence' in text
    arial = report.by_family("Arial")
    assert arial is not None and "pick an open font such as Arimo" in arial.message()


def test_a_licence_only_in_the_font_is_written_beside_it(
    tmp_path: Path, machine: Path
) -> None:
    project = tmp_path / "deck"
    project.mkdir()
    make_font(
        machine / "Named.ttf",
        "Namedface",
        licence="This Font Software is licensed under the SIL Open Font License",
    )
    report = font_report(
        Deck(slides=[Slide("x")]),
        project,
        [_slide('<text font-family="Namedface">a</text>')],
    )
    plan = plan_bundle(report, project)
    assert plan.warnings == []
    [(path, text)] = plan.texts.items()
    assert path == project / "fonts" / "namedface" / "LICENSE-from-font.txt"
    assert "SIL Open Font License" in text


def test_a_generic_first_family_is_refused() -> None:
    assert token_value("body", "Inter") == "Inter, sans-serif"
    assert token_value("mono", "JetBrains Mono") == "JetBrains Mono, monospace"
    assert token_value("heading", "Fira 3D") == '"Fira 3D", sans-serif'
    assert token_value("body", "Inter, Arial, sans-serif") == "Inter, Arial, sans-serif"
    with pytest.raises(fontreport.FontSetError, match="generic family"):
        token_value("body", "sans-serif, Inter")
    with pytest.raises(fontreport.FontSetError, match="no font role"):
        token_value("title", "Inter")


# ── Through the editor session and the CLI ────────────────────────────────────

DECK_PY = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(slides=[Slide("one")])
""")

SLIDE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
    + '<text x="10" y="50">Hello</text></svg>'
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    deck = tmp_path / "deck"
    (deck / "slides").mkdir(parents=True)
    (deck / "slides" / "one.svg").write_text(SLIDE, encoding="utf-8")
    (deck / "deck.py").write_text(DECK_PY, encoding="utf-8")
    return deck


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _session(project: Path) -> tuple[EditorSession, Deck]:
    return EditorSession(project / "deck.py"), load_deck(project / "deck.py")


def test_fonts_set_writes_the_theme_block_and_bundles_the_family(
    project: Path, machine: Path
) -> None:
    _machine_family(machine)
    session, deck = _session(project)
    result = session.apply(
        {
            "action": "fonts",
            "op": "set",
            "role": "body",
            "family": "Hereface",
            "_local": True,
        },
        deck,
    )
    css = (project / "styles.css").read_text(encoding="utf-8")
    assert "/* inkflow:theme" in css
    assert "--inkflow-body-font: Hereface, sans-serif;" in css
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    assert (project / "fonts" / "hereface" / "OFL.txt").is_file()
    assert result["label"] == "Font: body = Hereface, sans-serif"
    created = {c["path"] for c in cast("list[dict[str, str]]", result["changes"])}
    assert "fonts/hereface/Hereface-Regular.ttf" in created
    # One step: undo takes the token and the copied fonts back.
    session.apply({"action": "undo"}, deck)
    assert not (project / "styles.css").exists()
    assert not (project / "fonts" / "hereface" / "Hereface-Regular.ttf").exists()
    session.apply({"action": "redo"}, deck)
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    with pytest.raises(EditError, match="generic family"):
        session.apply(
            {"action": "fonts", "op": "set", "role": "body", "family": "serif"}, deck
        )


def test_a_remote_editor_sets_the_font_but_does_not_copy_this_machines_files(
    project: Path, machine: Path
) -> None:
    _machine_family(machine)
    session, deck = _session(project)
    result = session.apply(
        {"action": "fonts", "op": "set", "role": "body", "family": "Hereface"}, deck
    )
    assert "server's computer" in str(result["note"])
    assert not (project / "fonts").exists()
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply(
            {"action": "fonts", "op": "bundle"}, load_deck(project / "deck.py")
        )


def _cli(project: Path, *args: str) -> str:
    result = CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])
    assert result.exit_code == 0, result.output
    return result.output


def _families(out: str) -> dict[str, dict[str, object]]:
    report = cast("dict[str, list[dict[str, object]]]", json.loads(out))
    return {str(f["family"]): f for f in report["families"]}


def test_cli_report_bundle_and_set_offline(project: Path, machine: Path) -> None:
    _machine_family(machine)
    _machine_family(machine, "Codeface")
    _styles(project, body="Hereface, sans-serif")
    by_family = _families(_cli(project, "fonts", "--json"))
    assert by_family["Hereface"]["where"] == "machine"
    licence = cast("dict[str, str]", by_family["Hereface"]["licence"])
    assert licence["status"] == "open"
    out = _cli(project, "fonts")
    assert "machine" in out and "Hereface" in out
    dry = _cli(project, "fonts", "bundle", "--dry-run")
    assert "Would copy" in dry and not (project / "fonts").exists()
    out = _cli(project, "fonts", "bundle")
    assert "Created" in out
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    assert _families(_cli(project, "fonts", "--json"))["Hereface"]["where"] == (
        "project"
    )
    out = _cli(project, "fonts", "set", "mono", "Codeface")
    assert "Bundled" in out
    assert (project / "fonts" / "codeface" / "Codeface-Regular.ttf").is_file()
    refused = CliRunner().invoke(
        main, ["fonts", "set", "body", "monospace", "--deck", str(project / "deck.py")]
    )
    assert refused.exit_code == 1
    assert "generic family" in refused.output


# ── Packing ───────────────────────────────────────────────────────────────────

MEDIA_DECK = textwrap.dedent("""\
    from inkflow import Deck, Image, Slide


    def main() -> Deck:
        return Deck(
            slides=[
                Slide(
                    "content", md="text", zones={"media": Image("../outside/pic.png")}
                ),
                Slide("one"),
            ]
        )
""")


@pytest.fixture
def scattered(project: Path) -> Path:
    """A deck naming a picture outside its folder (deck.py), another from its
    Markdown, and a third through a symlinked folder (its SVG)."""
    outside = project.parent / "outside"
    shared = project.parent / "shared"
    outside.mkdir()
    shared.mkdir()
    (outside / "pic.png").write_bytes(b"PNG-pic")
    (outside / "b.png").write_bytes(b"PNG-b")
    (shared / "logo.png").write_bytes(b"PNG-logo")
    (project / "linked").symlink_to(shared, target_is_directory=True)
    (project / "deck.py").write_text(MEDIA_DECK, encoding="utf-8")
    (project / "slides" / "text.md").write_text(
        "::content::\n\n![b](../../outside/b.png)\n", encoding="utf-8"
    )
    (project / "slides" / "one.svg").write_text(
        SLIDE.replace(
            "<text",
            '<image href="../linked/logo.png" width="9" height="9"/>'
            + '<image href="https://example.com/x.png" width="9" height="9"/><text',
        ),
        encoding="utf-8",
    )
    return project


def test_copy_in_rewrites_each_reference_where_it_is_written(scattered: Path) -> None:
    deck = load_deck(scattered / "deck.py")
    plan = plan_copy_in(scattered, scattered / "deck.py", deck)
    targets = sorted(dst.relative_to(scattered).as_posix() for _, dst in plan.copies)
    assert targets == ["assets/b.png", "assets/logo.png", "assets/pic.png"]
    edits = {(e.file, e.old, e.new) for e in plan.edits}
    assert edits == {
        ("deck.py", "../outside/pic.png", "assets/pic.png"),
        ("slides/text.md", "../../outside/b.png", "../assets/b.png"),
        ("slides/one.svg", "../linked/logo.png", "../assets/logo.png"),
    }
    assert [r.raw for r in plan.remote] == ["https://example.com/x.png"]


def test_pack_through_the_session_is_one_undoable_step(
    scattered: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def lock(project_dir: Path, timeout: float = 0) -> tuple[bool, str]:
        del timeout
        (project_dir / "uv.lock").write_text("version = 1\n", encoding="utf-8")
        return True, "uv.lock written"

    monkeypatch.setattr("inkflow.pack.run_uv_lock", lock)
    session, deck = _session(scattered)
    check = session.apply({"action": "pack", "op": "check"}, deck)
    summary = cast("dict[str, object]", check["pack"])
    assert summary["needed"] is True
    keys = {
        cast("dict[str, str]", i)["key"] for i in cast("list[object]", summary["items"])
    }
    assert {"asset", "pyproject", "lock", "eol", "lfs", "remote"} <= keys
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply({"action": "pack", "op": "apply"}, deck)
    result = session.apply({"action": "pack", "op": "apply", "_local": True}, deck)
    assert (scattered / "assets" / "pic.png").read_bytes() == b"PNG-pic"
    assert 'Image("assets/pic.png")' in (scattered / "deck.py").read_text()
    assert "../assets/b.png" in (scattered / "slides" / "text.md").read_text()
    assert (scattered / "uv.lock").is_file()
    assert "inkflow" in (scattered / "pyproject.toml").read_text()
    attributes = (scattered / ".gitattributes").read_text()
    assert "*.svg text eol=lf" in attributes
    assert "*.ttf filter=lfs" in attributes
    assert result["lock"] == "uv.lock written"
    remaining = cast("list[dict[str, str]]", result["remaining"])
    assert "remote" in [r["key"] for r in remaining]
    assert "asset" not in [r["key"] for r in remaining]
    assert len(session.history.done) == 1
    # Packed: nothing left that packing would change.
    again = session.apply(
        {"action": "pack", "op": "check"}, load_deck(scattered / "deck.py")
    )
    assert cast("dict[str, object]", again["pack"])["needed"] is False
    # One step: undo takes all of it back, the lock file included.
    session.apply({"action": "undo"}, load_deck(scattered / "deck.py"))
    assert not (scattered / "assets").exists()
    assert not (scattered / "uv.lock").exists()
    assert not (scattered / ".gitattributes").exists()
    assert (scattered / "deck.py").read_text() == MEDIA_DECK


def test_gitattributes_are_merged_once_and_respect_the_lfs_opt_out(
    project: Path,
) -> None:
    attrs = project / ".gitattributes"
    attrs.write_text("*.psd binary\n", encoding="utf-8")
    plan = pack.plan_attributes(project)
    assert plan.text is not None
    assert plan.text.startswith("*.psd binary\n")
    assert pack.EOL_MARKER in plan.text and pack.DIFF_LINE in plan.text
    assert lfs.ON_MARKER in plan.text
    attrs.write_text(plan.text, encoding="utf-8")
    assert pack.plan_attributes(project).text is None
    # A deck that chose git only keeps that choice.
    attrs.write_text(lfs.block(False), encoding="utf-8")
    plan = pack.plan_attributes(project)
    assert plan.text is not None and "filter=lfs" not in plan.text
    assert plan.lfs == []
    # LFS on but from before fonts were in it: only the font rules come.
    attrs.write_text(lfs.ON_MARKER + "\n" + lfs.rule("*.png") + "\n", encoding="utf-8")
    plan = pack.plan_attributes(project)
    assert plan.lfs == ["*.ttf", "*.otf", "*.woff", "*.woff2"]
    # A repository-wide `* text=auto eol=lf` covers the line endings.
    attrs.write_text("* text=auto eol=lf\n*.svg diff=inkscape-svg\n", encoding="utf-8")
    assert pack.plan_attributes(project).eol == []


def test_an_existing_pyproject_gets_the_pin_added(project: Path) -> None:
    (project / "pyproject.toml").write_text(
        '[project]\nname = "talk"\ndependencies = [\n    "rich",\n]\n',
        encoding="utf-8",
    )
    plan = pack.plan_pyproject(load_deck(project / "deck.py"), project)
    assert plan.text is not None
    assert plan.added and plan.added[0].startswith("inkflow")
    assert '"rich",' in plan.text and f'"{plan.added[0]}",' in plan.text
    (project / "pyproject.toml").write_text(plan.text, encoding="utf-8")
    assert pack.plan_pyproject(load_deck(project / "deck.py"), project).text is None


def test_the_zip_holds_the_source_tree_without_ignored_files(project: Path) -> None:
    (project / ".gitignore").write_text("/notes-private/\n*.log\n", encoding="utf-8")
    (project / "notes-private").mkdir()
    (project / "notes-private" / "x.md").write_text("x", encoding="utf-8")
    (project / "debug.log").write_text("x", encoding="utf-8")
    (project / ".inkflow").mkdir()
    (project / ".inkflow" / "context.json").write_text("{}", encoding="utf-8")
    (project / "build").mkdir()
    (project / "build" / "index.html").write_text("x", encoding="utf-8")
    out = project.parent / "deck.zip"
    names = pack.make_zip(project, out)
    assert sorted(names) == [
        "deck/.gitignore",
        "deck/deck.py",
        "deck/slides/one.svg",
    ]
    with zipfile.ZipFile(out) as archive:
        assert archive.read("deck/deck.py").decode() == DECK_PY


def test_the_zip_follows_git_in_a_repository(project: Path) -> None:
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "init", "-q"], cwd=project, check=True, env=env)
    (project / ".gitignore").write_text("secret.txt\n", encoding="utf-8")
    (project / "secret.txt").write_text("x", encoding="utf-8")
    names = pack.make_zip(project, project / "deck.zip")
    assert "deck/secret.txt" not in names
    assert "deck/deck.zip" not in names
    assert "deck/slides/one.svg" in names


def test_cli_pack_dry_run_then_pack_and_zip(scattered: Path) -> None:
    dry = _cli(scattered, "pack", "--dry-run")
    assert "Would" in dry and "assets/pic.png" in dry
    assert not (scattered / "assets").exists()
    out = CliRunner().invoke(
        main,
        [
            "pack",
            "--deck",
            str(scattered / "deck.py"),
            "--zip",
            str(scattered.parent / "out.zip"),
        ],
    )
    assert out.exit_code == 0, out.output
    assert "Still machine-dependent" in out.output
    assert "https://example.com/x.png" in out.output
    assert "uv lock skipped in tests" in out.output
    with zipfile.ZipFile(scattered.parent / "out.zip") as archive:
        assert "deck/assets/pic.png" in archive.namelist()


def test_verify_names_what_ties_the_deck_to_this_machine(
    scattered: Path, machine: Path
) -> None:
    _machine_family(machine)
    _styles(scattered, body="Hereface, sans-serif")
    out = CliRunner().invoke(main, ["verify", "--deck", str(scattered / "deck.py")])
    text = " ".join(out.output.split())
    assert 'font "Hereface" comes from this machine' in text
    assert "inkflow fonts bundle" in text
    assert "3 file(s) outside the deck or behind a symlink" in text
    assert "picture(s) read from the web" in text
    assert "no uv.lock" in text
    assert "no line-ending rules" in text
    quiet = CliRunner().invoke(
        main, ["verify", "--no-portable", "--deck", str(scattered / "deck.py")]
    )
    assert "comes from this machine" not in quiet.output


def test_a_committed_pdf_page_stands_in_while_the_pdf_is_unchanged(
    tmp_path: Path,
) -> None:
    figure = tmp_path / "figure.pdf"
    figure.write_bytes(b"%PDF-1.4 fake")
    page = pdf.committed_path(figure, 1)
    assert page.name == "figure.pdf.p1.svg"
    page.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" '
        + f'{pdf.DIGEST_ATTR}="{pdf.digest(figure)}"/>',
        encoding="utf-8",
    )
    assert pdf.committed_page(figure, 1) == page
    assert pdf.committed_page(figure, 2) is None
    from inkflow.assets import AssetRoots

    pages = pdf.PdfPages(AssetRoots(tmp_path), tool=None)
    assert pages.page("figure.pdf#page=1") == ("figure.pdf.p1.svg", "")
    figure.write_bytes(b"%PDF-1.4 changed")
    assert pdf.committed_page(figure, 1) is None


# ── New decks ─────────────────────────────────────────────────────────────────


def test_init_writes_line_endings_and_tries_the_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[Path] = []

    def lock(project_dir: Path, timeout: float = 0) -> tuple[bool, str]:
        del timeout
        calls.append(project_dir)
        return False, "uv lock failed (offline? run it again with a network)"

    monkeypatch.setattr("inkflow.pack.run_uv_lock", lock)
    monkeypatch.setattr("inkflow.pack.uv_available", lambda: True)
    target = tmp_path / "talk"
    out = CliRunner().invoke(main, ["init", str(target), "--no-git"])
    assert out.exit_code == 0, out.output
    attrs = (target / ".gitattributes").read_text(encoding="utf-8")
    assert "*.md text eol=lf" in attrs and pack.DIFF_LINE in attrs
    assert calls == [target.resolve()]
    assert "offline?" in " ".join(out.output.split())


def test_a_new_deck_in_the_current_look_brings_its_machine_fonts(
    project: Path, machine: Path, tmp_path: Path
) -> None:
    from inkflow.editor import projects

    _machine_family(machine)
    _styles(project, body="Hereface, sans-serif")
    created = projects.create_deck(
        tmp_path / "new-talk",
        title="New",
        theme="current",
        git=False,
        current=project / "deck.py",
    )
    folder = created.parent
    assert (folder / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    assert "*.svg text eol=lf" in (folder / ".gitattributes").read_text()


# ── Through the server that has the deck open ─────────────────────────────────


class _UI:
    def refresh(self) -> None:
        pass

    def set_building(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, _trace: str) -> None:
        pass


@pytest.fixture
def served(project: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[EditorSession]:
    deck_path = project / "deck.py"
    session = EditorSession(deck_path)
    ui = cast("LiveUI", cast("object", _UI()))
    levels = resolve_levels()
    started = threading.Event()
    port: list[int] = []
    loop = asyncio.new_event_loop()
    stop = asyncio.Event()

    async def run() -> None:
        server._editor["session"] = session  # pyright: ignore[reportPrivateUsage]
        await server.rebuild(deck_path, ui, levels)
        handler = server.make_ws_handler(ui, NO_EDIT_COMMANDS, session)
        async with ws_serve(handler, "127.0.0.1", 0) as ws:
            port.append(
                cast("tuple[str, int]", next(iter(ws.sockets)).getsockname())[1]
            )
            watch = asyncio.create_task(
                server._watch(deck_path, ui, asyncio.Lock(), levels)  # pyright: ignore[reportPrivateUsage]
            )
            await asyncio.sleep(0.3)
            started.set()
            await stop.wait()
            watch.cancel()

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    record = instances.Instance(os.getpid(), "127.0.0.1", 0, port[0], str(deck_path))

    def serving(_deck: Path, _exclude_pid: int | None = None) -> instances.Instance:
        return record

    monkeypatch.setattr(instances, "serving", serving)
    try:
        yield session
    finally:
        loop.call_soon_threadsafe(stop.set)
        thread.join(10)
        loop.close()
        server._editor.update(  # pyright: ignore[reportPrivateUsage]
            {"session": None, "deck": None, "model": None, "failed_hash": None}
        )
        server._editor["clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["ws_clients"].clear()  # pyright: ignore[reportPrivateUsage]
        server._state["error"] = None  # pyright: ignore[reportPrivateUsage]


def test_bundle_and_pack_through_the_server_are_agent_steps(
    project: Path, machine: Path, served: EditorSession
) -> None:
    _machine_family(machine)
    _styles(project, body="Hereface, sans-serif")
    out = _cli(project, "fonts", "bundle")
    assert "Ctrl+Z in the editor" in out
    assert (project / "fonts" / "hereface" / "Hereface-Regular.ttf").is_file()
    out = _cli(project, "pack")
    assert "Ctrl+Z in the editor" in out
    assert [s.label for s in served.history.done] == [
        "Agent: Bundle fonts into the deck",
        "Agent: Pack the deck",
    ]
    served.apply({"action": "undo"}, load_deck(project / "deck.py"))
    served.apply({"action": "undo"}, load_deck(project / "deck.py"))
    assert not (project / "fonts" / "hereface").exists()


def test_the_report_resolves_fonts_as_the_build_does(
    tmp_path: Path, machine: Path
) -> None:
    """The shipped variable Inter covers every weight, so a static Inter Bold
    on this machine is not what the build embeds; a generic attribute is mapped
    to the deck's own font, and a family a slide defines itself travels inside
    it: none of these is machine-dependent."""
    project = tmp_path / "deck"
    project.mkdir()
    make_font(machine / "Inter-Bold.ttf", "Inter", weight=700)
    deck = Deck(slides=[Slide("x")])  # the built-in theme: the shipped fonts
    slides = [
        _slide(
            "<style>@font-face { font-family: 'Logo Sans'; src: url(data:,x) }</style>"
            + '<text font-family="sans-serif">a</text>'
            + '<text font-family="Logo Sans">b</text>'
            + "<foreignObject><div xmlns='http://www.w3.org/1999/xhtml'>"
            + "<strong>bold</strong></div></foreignObject>"
        )
    ]
    report = font_report(deck, project, slides)
    inter = report.by_family("Inter")
    assert inter is not None and inter.where is Where.THEME
    assert {f.path.name for f in inter.files} == {"InterVariable.woff2"}
    assert report.by_family("sans-serif") is None
    assert report.by_family("Logo Sans") is None
    assert report.problems == []
