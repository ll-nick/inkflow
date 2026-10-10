"""Renaming and moving project files with every reference following
(``editor/filerename.py``, the session's ``rename`` action, ``inkflow mv`` and
``inkflow slide rename-files``)."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner, Result
from websockets.sync.client import connect

from inkflow import instances
from inkflow.cli import main
from inkflow.editor.filerename import (
    RenameError,
    RenamePlan,
    plan_rename,
    plan_slide_rename,
    reference_counts,
    rewrite_markdown,
    scan_svg,
)
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import file_hash
from inkflow.manifest import Image
from inkflow.server import load_deck
from tests import test_slides_cli as slides_tests

# The deck served as `inkflow edit` would, from the `inkflow slide` tests.
served = slides_tests.served

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="800"/>
    </svg>
""")

# Built on the "plain" layout; its preview layers (as `inkflow sync` writes
# them) name each layer the way the file that declared it did.
CHILD_LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="plain" viewBox="0 0 1920 1080">
      <rect id="band" x="0" y="0" width="1920" height="40"/>
    </svg>
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
         xmlns:inkflow="urn:inkflow" inkflow:parent="banded"
         viewBox="0 0 1920 1080">
      <g inkflow:layout-src="plain" inkflow:layout-hash="1"><image href="logo.png"/></g>
      <g inkflow:layout-src="banded" inkflow:layout-hash="2"/>
      <style>.bg { background: url("../assets/photo.png"); }</style>
      <image id="pic" href="../assets/photo.png" width="10" height="10"/>
      <image id="old" xlink:href='../assets/photo.png' width="10" height="10"/>
      <image id="fig" href="../assets/plot.pdf#page=2" width="10" height="10"/>
      <image id="dia" href="../diagrams/diagram-1.drawio.svg"/>
      <rect id="box" style="fill: url(#grad); stroke: url('../assets/photo.png')"/>
      <a href="slide:intro"><rect id="go"/></a>
      <a href="https://example.com/assets/photo.png"><rect id="web"/></a>
    </svg>
""")

NESTED = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <image href="../../assets/photo.png"/>
      <image href="photo.png"/>
    </svg>
""")

INTRO_MD = textwrap.dedent("""\
    # Intro

    ![a photo](../assets/photo.png "Title")
    [the data](../data/sales.csv) and [the end](slide:end)
    <img src="../assets/photo.png" alt="again">

    ```chart
    data: ../data/sales.csv
    kind: line
    ```

    ```python
    path = "![x](../assets/photo.png)"
    ```

    Inline `![x](../assets/photo.png)` code stays.

    [ref]: ../assets/photo.png
""")

NOTES_MD = "Photo: ![x](photo.png)\n"
"""Names notes/photo.png, a different file from assets/photo.png."""

STYLES = 'body { background: url("assets/photo.png"); }\n'

DECK = textwrap.dedent("""\
    from inkflow import Chart, Deck, Image, Inline, Overlay, Slide, Video


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            overlays=[Overlay("footer")],
            slides=[
                # The drawn slide.
                Slide("drawn.svg", notes="notes/drawn.md"),
                Slide(
                    "plain",
                    md="intro.md",
                    zones={
                        "content": Image(
                            "assets/photo.png",  # the cover
                            alt_src="assets/photo.png",
                        )
                    },
                ),
                Slide(
                    "local:plain",
                    md=Inline("# Inline\\n\\n![p](assets/photo.png)"),
                    zones={"title": "![t](assets/photo.png)"},
                ),
                Slide(
                    "banded",
                    md="end.md",
                    zones={
                        "content": Chart("data/sales.csv"),
                        "title": Video("assets/clip.mp4", poster="assets/photo.png"),
                    },
                ),
                Slide("plain", md="shared.md"),
                Slide("plain", md="shared.md"),
            ],
        )
""")


def _write(path: Path, text: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text, encoding="utf-8")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    _write(tmp_path / "layouts" / "plain.svg", LAYOUT)
    _write(tmp_path / "layouts" / "banded.svg", CHILD_LAYOUT)
    _write(tmp_path / "overlays" / "footer.svg", LAYOUT)
    _write(tmp_path / "slides" / "drawn.svg", DRAWN)
    _write(tmp_path / "slides" / "sub" / "nested.svg", NESTED)
    _write(tmp_path / "slides" / "intro.md", INTRO_MD)
    _write(tmp_path / "slides" / "end.md", "# End\n\nBack to [intro](slide:intro).\n")
    _write(tmp_path / "slides" / "shared.md", "# Shared\n")
    _write(tmp_path / "notes" / "drawn.md", NOTES_MD)
    _write(tmp_path / "assets" / "photo.png", b"\x89PNG photo")
    _write(tmp_path / "assets" / "clip.mp4", b"video")
    _write(tmp_path / "assets" / "plot.pdf", b"%PDF")
    _write(tmp_path / "diagrams" / "diagram-1.drawio.svg", LAYOUT)
    _write(tmp_path / "data" / "sales.csv", "month,revenue\nJan,1\n")
    _write(tmp_path / "ink" / "intro.svg", LAYOUT)
    _write(tmp_path / "styles.css", STYLES)
    _write(tmp_path / "deck.py", DECK)
    return tmp_path


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _plan(project: Path, old: str, new: str) -> RenamePlan:
    deck = load_deck(project / "deck.py")
    return plan_rename(project, project / "deck.py", deck, {old: new})


def _text(project: Path, rel: str) -> str:
    return (project / rel).read_text(encoding="utf-8")


def _session(project: Path) -> EditorSession:
    session = EditorSession(project / "deck.py")
    session.built_hash = file_hash((project / "deck.py").read_bytes())
    return session


def _apply(project: Path, msg: dict[str, object]) -> dict[str, object]:
    session = _session(project)
    return session.apply(msg, load_deck(project / "deck.py"))


def _snapshot(project: Path) -> dict[str, bytes]:
    return {
        p.relative_to(project).as_posix(): p.read_bytes()
        for p in sorted(project.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts
    }


# ── Every kind of reference, resolved against its own file ─────────────────────


def test_a_picture_rename_rewrites_every_kind_of_reference(project: Path) -> None:
    plan = _plan(project, "assets/photo.png", "assets/pictures/cover.png")
    writes = {
        p.relative_to(project).as_posix(): d.decode() for p, d in plan.writes.items()
    }
    drawn = writes["slides/drawn.svg"]
    assert 'href="../assets/pictures/cover.png" width' in drawn
    assert "xlink:href='../assets/pictures/cover.png'" in drawn
    assert 'url("../assets/pictures/cover.png")' in drawn
    assert "stroke: url('../assets/pictures/cover.png')" in drawn
    assert "url(#grad)" in drawn
    assert "https://example.com/assets/photo.png" in drawn
    # A preview layer's content belongs to the layout it was copied from.
    assert '<image href="logo.png"/>' in drawn
    nested = writes["slides/sub/nested.svg"]
    assert '<image href="../../assets/pictures/cover.png"/>' in nested
    assert '<image href="photo.png"/>' in nested  # slides/sub/photo.png
    intro = writes["slides/intro.md"]
    assert '![a photo](../assets/pictures/cover.png "Title")' in intro
    assert '<img src="../assets/pictures/cover.png"' in intro
    assert "[ref]: ../assets/pictures/cover.png" in intro
    assert 'path = "![x](../assets/photo.png)"' in intro  # code, not a reference
    assert "`![x](../assets/photo.png)`" in intro
    assert (
        writes["styles.css"]
        == 'body { background: url("assets/pictures/cover.png"); }\n'
    )
    deck = writes["deck.py"]
    assert '"assets/pictures/cover.png",  # the cover' in deck
    assert 'alt_src="assets/pictures/cover.png"' in deck
    assert 'poster="assets/pictures/cover.png"' in deck
    assert "![p](assets/pictures/cover.png)" in deck
    assert '"title": "![t](assets/pictures/cover.png)"' in deck
    assert "notes/drawn.md" not in writes  # its photo.png is notes/photo.png
    summary = plan.summary(project)
    assert summary["references"] == len(plan.edits) == 14
    assert summary["files"] == 5
    assert summary["moves"] == [
        {"from": "assets/photo.png", "to": "assets/pictures/cover.png"}
    ]


def test_pdf_pages_drawio_pictures_and_chart_data(project: Path) -> None:
    pdf = _plan(project, "assets/plot.pdf", "figures/results.pdf")
    drawn = pdf.writes[project / "slides" / "drawn.svg"].decode()
    assert 'href="../figures/results.pdf#page=2"' in drawn
    dia = _plan(
        project, "diagrams/diagram-1.drawio.svg", "diagrams/pipeline.drawio.svg"
    )
    assert 'href="../diagrams/pipeline.drawio.svg"' in (
        dia.writes[project / "slides" / "drawn.svg"].decode()
    )
    data = _plan(project, "data/sales.csv", "data/revenue.csv")
    intro = data.writes[project / "slides" / "intro.md"].decode()
    assert "data: ../data/revenue.csv" in intro
    assert "[the data](../data/revenue.csv)" in intro
    assert 'Chart("data/revenue.csv")' in data.writes[project / "deck.py"].decode()


def test_a_moved_file_rewrites_its_own_relative_references(project: Path) -> None:
    plan = _plan(project, "slides/intro.md", "text/opening/intro.md")
    intro = plan.writes[project / "text" / "opening" / "intro.md"].decode()
    assert "![a photo](../../assets/photo.png" in intro
    assert "data: ../../data/sales.csv" in intro
    assert "slide:end" in intro
    assert 'md="text/opening/intro.md"' in plan.writes[project / "deck.py"].decode()
    assert plan.ids == {}  # still intro


def test_markdown_rewrite_leaves_urls_anchors_and_slide_links() -> None:
    text = "[a](https://x.org/a.png) [b](#top) [c](slide:x) ![d](a.png)\n"
    seen: list[str] = []

    def visit(raw: str, _kind: object, _label: str) -> str | None:
        seen.append(raw)
        return None

    assert rewrite_markdown(text, visit) == text
    assert seen == ["https://x.org/a.png", "#top", "slide:x", "a.png"]


def test_svg_scan_keeps_the_file_byte_for_byte_but_the_value() -> None:
    svg = (
        '<svg\n   xmlns="http://www.w3.org/2000/svg">\n'
        + '  <image\n     href="a.png" />\n</svg>\n'
    )
    out = scan_svg(svg, lambda raw, _k, _l: "b&c.png" if raw == "a.png" else None)
    assert out == svg.replace('href="a.png"', 'href="b&amp;c.png"')


# ── Layouts and overlays ───────────────────────────────────────────────────────


def test_renaming_a_layout_rewrites_parents_names_and_preview_layers(
    project: Path,
) -> None:
    plan = _plan(project, "layouts/plain.svg", "layouts/simple.svg")
    banded = plan.writes[project / "layouts" / "banded.svg"].decode()
    assert 'inkflow:parent="simple"' in banded
    drawn = plan.writes[project / "slides" / "drawn.svg"].decode()
    # The layer declared by banded.svg's parent, followed through the chain.
    assert 'inkflow:layout-src="simple"' in drawn
    assert 'inkflow:layout-src="banded"' in drawn
    deck = plan.writes[project / "deck.py"].decode()
    assert 'Slide(\n                "simple",' in deck
    assert 'Slide("simple", md="shared.md")' in deck
    assert '"local:simple"' in deck
    # Slides named after the layout take its new name as their id.
    assert plan.ids == {"local-plain": "local-simple"}


def test_a_layout_moved_into_a_folder_is_named_by_path(project: Path) -> None:
    plan = _plan(project, "layouts/plain.svg", "layouts/base/plain.svg")
    banded = plan.writes[project / "layouts" / "banded.svg"].decode()
    assert 'inkflow:parent="base/plain"' in banded
    deck = plan.writes[project / "deck.py"].decode()
    assert 'Slide("layouts/base/plain.svg", md="shared.md")' in deck


def test_a_bare_slide_name_is_pinned_when_a_slide_file_would_shadow_it(
    project: Path,
) -> None:
    _write(project / "slides" / "simple.svg", LAYOUT)
    plan = _plan(project, "layouts/plain.svg", "layouts/simple.svg")
    deck = plan.writes[project / "deck.py"].decode()
    assert 'Slide("local:simple", md="shared.md")' in deck


def test_renaming_an_overlay(project: Path) -> None:
    plan = _plan(project, "overlays/footer.svg", "overlays/brand.svg")
    assert 'Overlay("brand")' in plan.writes[project / "deck.py"].decode()


# ── Refusals ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("assets/photo.png", "assets/clip.mp4", "keep the extension"),
        ("assets/photo.png", "data/sales.png", None),
        ("assets/clip.mp4", "assets/photo.png", "keep the extension"),
        ("data/sales.csv", "data/sales.csv", "already has that name"),
        ("assets/photo.png", "../outside.png", "outside the project"),
        ("assets/photo.png", ".inkflow/photo.png", "hidden folders"),
        ("assets/photo.png", "_theme/photo.png", "reserved"),
        ("assets/photo.png", "assets/my photo.png", "cannot be part of a file name"),
        ("assets/photo.png", "assets/.png", "hidden"),
        ("styles.css", "theme.css", "found by its name"),
        ("deck.py", "slides.py", "found by its name"),
        ("assets/none.png", "assets/x.png", "does not exist"),
        ("diagrams/diagram-1.drawio.svg", "diagrams/d.svg", "keep the extension"),
    ],
)
def test_refusals(project: Path, old: str, new: str, message: str | None) -> None:
    if message is None:
        _plan(project, old, new)  # another folder is fine
        return
    _write(project / "assets" / "taken.png", b"x")
    with pytest.raises(RenameError, match=message):
        _plan(project, old, new)


def test_an_existing_target_is_refused(project: Path) -> None:
    _write(project / "assets" / "taken.png", b"x")
    with pytest.raises(RenameError, match="already exists"):
        _plan(project, "assets/photo.png", "assets/taken.png")


def test_a_file_nothing_names_can_be_renamed(project: Path) -> None:
    _write(project / "assets" / "spare.png", b"x")
    plan = _plan(project, "assets/spare.png", "assets/kept.png")
    assert plan.edits == [] and plan.writes == {}


def test_an_id_another_slide_has_is_refused(project: Path) -> None:
    with pytest.raises(RenameError, match="another slide is already called 'end'"):
        _plan(project, "slides/intro.md", "slides/sub/end.md")


# ── The session: one undoable step ────────────────────────────────────────────


def test_rename_is_one_step_and_undo_restores_everything(project: Path) -> None:
    before = _snapshot(project)
    session = _session(project)
    deck = load_deck(project / "deck.py")
    dry = session.apply(
        {
            "action": "rename",
            "from": "assets/photo.png",
            "to": "media/cover.png",
            "dryRun": True,
        },
        deck,
    )
    assert _snapshot(project) == before
    assert not session.history.done
    result = session.apply(
        {"action": "rename", "from": "assets/photo.png", "to": "media/cover.png"},
        deck,
    )
    assert result["rename"] == dry["rename"]
    assert result["label"] == "Rename photo.png to media/cover.png"
    preview = cast("dict[str, object]", dry["rename"])
    edited = {e["file"] for e in cast("list[dict[str, str]]", preview["edits"])}
    changes = cast("list[dict[str, str]]", result["changes"])
    assert {c["path"] for c in changes if c["change"] == "modified"} == edited
    assert {
        "path": "media/cover.png",
        "change": "renamed",
        "from": "assets/photo.png",
    } in changes
    assert (project / "media" / "cover.png").read_bytes() == b"\x89PNG photo"
    assert not (project / "assets" / "photo.png").exists()
    assert len(session.history.done) == 1
    # The rebuilt deck finds its picture under the new name.
    rebuilt = load_deck(project / "deck.py")
    picture = rebuilt.slides[1].zones["content"]
    assert isinstance(picture, Image) and picture.src == "media/cover.png"

    session.apply({"action": "undo"}, rebuilt)
    assert _snapshot(project) == before
    assert not (project / "media").exists()  # the folder it made is gone again
    session.apply({"action": "redo"}, rebuilt)
    assert (project / "media" / "cover.png").exists()


def test_an_emptied_folder_is_removed_and_comes_back_on_undo(project: Path) -> None:
    session = _session(project)
    deck = load_deck(project / "deck.py")
    session.apply(
        {"action": "rename", "from": "data/sales.csv", "to": "tables/sales.csv"}, deck
    )
    assert not (project / "data").exists()
    session.apply({"action": "undo"}, deck)
    assert (project / "data" / "sales.csv").exists()
    assert not (project / "tables").exists()


def test_undo_refuses_when_the_file_moved_again_outside(project: Path) -> None:
    session = _session(project)
    deck = load_deck(project / "deck.py")
    session.apply(
        {"action": "rename", "from": "assets/clip.mp4", "to": "assets/intro.mp4"}, deck
    )
    (project / "assets" / "intro.mp4").rename(project / "assets" / "elsewhere.mp4")
    with pytest.raises(EditError, match="outside the editor"):
        session.apply({"action": "undo"}, deck)


def test_a_refused_rename_is_an_edit_error(project: Path) -> None:
    _write(project / "assets" / "clip.png", b"x")
    with pytest.raises(EditError, match="already exists"):
        _apply(
            project,
            {"action": "rename", "from": "assets/photo.png", "to": "assets/clip.png"},
        )


# ── Slides: ids, ink and links follow ─────────────────────────────────────────


def test_a_renamed_markdown_file_takes_the_ink_and_links_along(project: Path) -> None:
    plan = _plan(project, "slides/intro.md", "slides/opening.md")
    assert plan.ids == {"intro": "opening"}
    assert (
        project / "ink" / "intro.svg",
        project / "ink" / "opening.svg",
    ) in plan.moves
    assert "slide:opening" in plan.writes[project / "slides" / "end.md"].decode()
    assert (
        'href="slide:opening"' in plan.writes[project / "slides" / "drawn.svg"].decode()
    )
    assert plan.links == 2


def test_slide_rename_files_moves_its_own_files(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    plan = plan_slide_rename(project, project / "deck.py", deck, 0, "diagram")
    moved = {
        (a.relative_to(project).as_posix(), b.relative_to(project).as_posix())
        for a, b in plan.moves
    }
    assert moved == {
        ("slides/drawn.svg", "slides/diagram.svg"),
        ("notes/drawn.md", "notes/diagram.md"),
    }
    deck_text = plan.writes[project / "deck.py"].decode()
    assert 'Slide("diagram.svg", notes="notes/diagram.md")' in deck_text
    assert plan.ids == {"drawn": "diagram"}
    # Its own picture references, rewritten in the moved drawing itself? Same
    # folder: unchanged.
    assert project / "slides" / "diagram.svg" not in plan.writes


def test_shared_files_stay_and_are_listed(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    with pytest.raises(RenameError, match="no files of its own"):
        plan_slide_rename(project, project / "deck.py", deck, 4, "x")
    plan = plan_slide_rename(project, project / "deck.py", deck, 1, "opening")
    assert plan.shared == ["layouts/plain.svg (a layout)"]
    assert plan.ids == {"intro": "opening"}


def test_an_explicit_id_stays_and_is_dropped_once_it_is_the_name(
    project: Path,
) -> None:
    _write(
        project / "deck.py",
        DECK.replace(
            'Slide("drawn.svg", notes="notes/drawn.md")',
            'Slide("drawn.svg", id="diagram", notes="notes/drawn.md")',
        ),
    )
    deck = load_deck(project / "deck.py")
    plan = plan_slide_rename(project, project / "deck.py", deck, 0, "other")
    assert plan.ids == {}
    assert 'id="diagram"' in plan.writes[project / "deck.py"].decode()
    plan = plan_slide_rename(project, project / "deck.py", deck, 0, "diagram")
    assert plan.ids == {}
    assert 'Slide("diagram.svg", notes="notes/diagram.md")' in (
        plan.writes[project / "deck.py"].decode()
    )


def test_keep_id_pins_the_old_id(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    plan = plan_slide_rename(
        project, project / "deck.py", deck, 1, "opening", keep_id=True
    )
    assert plan.ids == {}
    assert 'id="intro"' in plan.writes[project / "deck.py"].decode()
    assert not any(a.parent.name == "ink" for a, _ in plan.moves)


def test_renaming_a_default_ink_file_names_it_on_the_slide(project: Path) -> None:
    plan = _plan(project, "ink/intro.svg", "ink/intro-sketch.svg")
    assert 'ink="ink/intro-sketch.svg"' in plan.writes[project / "deck.py"].decode()


# ── The Files view ─────────────────────────────────────────────────────────────


def test_reference_counts_and_deleting_unused_files(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    counts = reference_counts(project, project / "deck.py", deck)
    assert counts["assets/photo.png"] == 14
    assert counts["data/sales.csv"] == 3
    assert counts["ink/intro.svg"] == 1
    _write(project / "assets" / "spare.png", b"x")
    session = _session(project)
    files = cast(
        "list[dict[str, object]]", session.apply({"action": "files"}, deck)["files"]
    )
    uses = {f["path"]: f["uses"] for f in files}
    assert uses["assets/spare.png"] == 0
    assert "styles.css" not in uses and "deck.py" not in uses
    with pytest.raises(EditError, match="in use"):
        session.apply({"action": "delete-files", "paths": ["assets/photo.png"]}, deck)
    session.apply({"action": "delete-files", "paths": ["assets/spare.png"]}, deck)
    assert not (project / "assets" / "spare.png").exists()
    session.apply({"action": "undo"}, deck)
    assert (project / "assets" / "spare.png").exists()


# ── The command line ───────────────────────────────────────────────────────────


def _cli(project: Path, *args: str) -> Result:
    return CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])


def test_mv_dry_run_changes_nothing(project: Path) -> None:
    before = _snapshot(project)
    result = _cli(project, "mv", str(project / "data/sales.csv"), "data/revenue", "-n")
    assert result.exit_code == 0, result.output
    assert "Would move" in result.output and "data/revenue.csv" in result.output
    assert "3 in 2 files would be updated" in result.output
    assert _snapshot(project) == before


def test_mv_offline(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(project)
    result = _cli(project, "mv", "assets/clip.mp4", "videos/")
    assert result.exit_code == 0, result.output
    assert "assets/clip.mp4 -> videos/clip.mp4" in result.output
    assert (project / "videos" / "clip.mp4").exists()
    assert 'Video("videos/clip.mp4"' in _text(project, "deck.py")
    refused = _cli(project, "mv", "videos/clip.mp4", "videos/clip.webm")
    assert refused.exit_code != 0 and "keep the extension" in refused.output


def test_slide_rename_files_offline(project: Path) -> None:
    result = _cli(project, "slide", "rename-files", "intro", "opening")
    assert result.exit_code == 0, result.output
    assert "Slide id  intro -> opening" in result.output
    assert (project / "slides" / "opening.md").exists()
    assert (project / "ink" / "opening.svg").exists()
    assert "slide:opening" in _text(project, "slides/end.md")


def test_mv_through_the_server_is_an_undoable_agent_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, port = served
    with connect(f"ws://127.0.0.1:{port}", proxy=None, max_size=None) as editor:
        editor.send(json.dumps({"type": "hello", "role": "editor"}))
        result = _cli(
            project, "mv", str(project / "data/sales.csv"), "data/revenue.csv"
        )
        assert result.exit_code == 0, result.output
        assert "Ctrl+Z in the editor" in result.output
        assert [s.label for s in session.history.done] == [
            "Agent: Rename data/sales.csv to data/revenue.csv"
        ]
    deck = load_deck(project / "deck.py")
    session.apply({"action": "undo"}, deck)
    assert (project / "data" / "sales.csv").exists()
    assert _text(project, "deck.py") == DECK
