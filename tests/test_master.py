"""The slide master: the deck's own copies of theme layouts (copy-on-write and
how they resolve), reverting them, templates saved from slides, new overlays,
and the ``inkflow layout`` / ``inkflow overlay`` commands."""

from __future__ import annotations

import asyncio
import json
import os
import textwrap
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import ClassVar, cast

import pytest
from click.testing import CliRunner
from lxml import etree
from typing_extensions import override
from websockets.sync.client import connect

from inkflow import instances, ns, server
from inkflow.builtin_themes import Paper
from inkflow.cli import main
from inkflow.editor.master import (
    hint_of,
    layout_entries,
    master_tree,
    slug_name,
)
from inkflow.editor.model import build_model
from inkflow.editor.previews import layout_previews
from inkflow.editor.provenance import INK, stamper
from inkflow.editor.session import EditError, EditorSession
from inkflow.layout import (
    AssetKind,
    builtin_theme_dir,
    deck_copy,
    resolve_chain,
    resolve_parent_path,
)
from inkflow.logging import console, resolve_levels
from inkflow.pipeline import process_deck, resolve_slide_src
from inkflow.server import load_deck
from inkflow.svgio import parse_svg_file
from inkflow.themes import Theme
from inkflow.tui import LiveUI

BUILTIN = builtin_theme_dir() / "layouts"

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="title" viewBox="0 0 1920 1080">
      <rect id="code-box" x="100" y="300" width="900" height="500"/>
      <rect id="zone-code" x="1100" y="300" width="700" height="500"/>
      <image id="shot" x="100" y="850" width="300" height="150"
             href="../assets/shot.png"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("content", md="intro.md"),
                Slide("drawn.svg", md="drawn.md"),
                Slide("agenda", md="plan.md"),
                Slide("agenda", md="plan2.md"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "assets"):
        (tmp_path / sub).mkdir()
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    (tmp_path / "assets" / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    texts = {
        "intro": "# Intro\n\n- One\n",
        "drawn": "# Code examples\n\n::code::\n\n```py\nprint(1)\n```\n",
        "plan": "# Plan\n\n1. First\n",
        "plan2": "# Plan B\n",
    }
    for name, text in texts.items():
        (tmp_path / "slides" / f"{name}.md").write_text(text, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _apply(project: Path, msg: dict[str, object]) -> dict[str, object]:
    deck = load_deck(project / "deck.py")
    return EditorSession(project / "deck.py").apply({**msg, "_local": True}, deck)


def _chain(project: Path, index: int) -> list[Path]:
    deck = load_deck(project / "deck.py")
    src = resolve_slide_src(deck.slides[index].src, project, deck.theme)
    return [*resolve_chain(src, project, deck.theme), src]


def _names(paths: list[Path], project: Path) -> list[str]:
    return [
        p.relative_to(project).as_posix() if p.is_relative_to(project) else p.stem
        for p in paths
    ]


def _copy(project: Path, name: str, kind: str = "layouts") -> None:
    """The deck's copy of a built-in layout, as the editor writes it."""
    (project / kind).mkdir(exist_ok=True)
    text = (BUILTIN / f"{name}.svg").read_text(encoding="utf-8")
    root = etree.fromstring(text.encode())
    parent = root.get(ns.INKFLOW_PARENT)
    if parent:
        root.set(ns.INKFLOW_PARENT, "builtin:" + parent.removeprefix("./"))
    root.set(ns.INKFLOW_COPY_OF, f"builtin:{name}")
    (project / kind / f"{name}.svg").write_bytes(etree.tostring(root))


# ── Resolution ─────────────────────────────────────────────────────────────────


def test_a_copy_of_a_theme_layout_shadows_it_for_its_slides(project: Path) -> None:
    _copy(project, "agenda")
    assert _names(_chain(project, 2), project) == [
        "base",
        "numbered",
        "title",
        "layouts/agenda.svg",
    ]
    # Other layouts stay the theme's.
    assert _names(_chain(project, 0), project) == [
        "base",
        "numbered",
        "title",
        "content",
    ]


def test_a_copy_of_base_is_the_background_of_every_layout(project: Path) -> None:
    _copy(project, "base")
    for index in range(4):
        chain = _names(_chain(project, index), project)
        assert chain[0] == "layouts/base.svg", chain
    # Also a reference that names the theme's explicitly.
    resolved = resolve_parent_path("builtin:base", project, project, None)
    assert resolved == project / "layouts" / "base.svg"
    assert (
        resolve_parent_path("builtin:base", project, project, None, follow_copies=False)
        == BUILTIN / "base.svg"
    )


def test_a_copy_of_the_parent_stands_in_for_the_copys_parent(project: Path) -> None:
    _copy(project, "agenda")
    _copy(project, "title")
    assert _names(_chain(project, 2), project) == [
        "base",
        "numbered",
        "layouts/title.svg",
        "layouts/agenda.svg",
    ]


def test_a_layout_merely_named_like_a_theme_one_stays_out_of_its_chains(
    project: Path,
) -> None:
    (project / "layouts").mkdir()
    (project / "layouts" / "title.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"/>'
    )
    # agenda is built on the theme's title, not on the deck's title slide.
    assert _names(_chain(project, 2), project) == [
        "base",
        "numbered",
        "title",
        "agenda",
    ]
    assert deck_copy(BUILTIN / "title.svg", project, None) is None


def test_a_copy_built_on_its_own_original_is_no_loop(project: Path) -> None:
    (project / "layouts").mkdir()
    (project / "layouts" / "content.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow" '
        + 'inkflow:parent="builtin:content" inkflow:copy-of="builtin:content" '
        + 'viewBox="0 0 1920 1080"/>'
    )
    assert _names(_chain(project, 0), project) == [
        "base",
        "numbered",
        "title",
        "content",
        "layouts/content.svg",
    ]


class _Mine(Paper):
    """A deck's own subclass of a shipped theme (its assets stay Paper's)."""


class _Packaged(Theme):
    """A theme with layouts of its own, as a pip-installed one has."""

    folder: ClassVar[Path] = Path()

    @override
    def asset_dir(self) -> Path:
        return self.folder


def test_copies_resolve_under_a_theme_subclass(project: Path) -> None:
    _copy(project, "base")
    theme = _Mine()
    src = resolve_slide_src("agenda", project, theme)
    chain = resolve_chain(src, project, theme)
    assert chain[0] == project / "layouts" / "base.svg"


def test_a_packaged_themes_layout_is_copied_as_theme_ref(
    project: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    folder = tmp_path_factory.mktemp("theme")
    (folder / "layouts").mkdir()
    (folder / "layouts" / "agenda.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow" '
        + 'inkflow:parent="./title" viewBox="0 0 1920 1080"><rect id="mark"/></svg>'
    )
    (folder / "layouts" / "title.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + '<rect id="zone-title"/></svg>'
    )
    _Packaged.folder = folder
    theme = _Packaged()
    deck = load_deck(project / "deck.py")
    deck.theme = theme
    session = EditorSession(project / "deck.py")
    result = session.apply(
        {"action": "master", "op": "copy", "name": "agenda", "_local": True}, deck
    )
    assert result["ok"]
    root = parse_svg_file(project / "layouts" / "agenda.svg")
    assert root.get(ns.INKFLOW_COPY_OF) == "theme:agenda"
    assert root.get(ns.INKFLOW_PARENT) == "theme:title"
    src = resolve_slide_src("agenda", project, theme)
    assert src == project / "layouts" / "agenda.svg"
    assert resolve_chain(src, project, theme) == [folder / "layouts" / "title.svg"]


# ── Copy, edit, revert ─────────────────────────────────────────────────────────


def test_copy_then_revert(project: Path) -> None:
    result = _apply(project, {"action": "master", "op": "copy", "name": "agenda"})
    assert result["label"] == "Copy layout 'agenda' into the deck"
    copied = cast("dict[str, str]", result["copied"])
    assert "own copy of 'agenda'" in copied["note"]
    root = parse_svg_file(project / "layouts" / "agenda.svg")
    assert root.get(ns.INKFLOW_PARENT) == "builtin:title"
    assert root.get(ns.INKFLOW_COPY_OF) == "builtin:agenda"
    with pytest.raises(EditError, match="already has its own"):
        _apply(project, {"action": "master", "op": "copy", "name": "agenda"})
    _apply(project, {"action": "master", "op": "revert", "name": "agenda"})
    assert not (project / "layouts" / "agenda.svg").exists()
    assert _names(_chain(project, 2), project)[-1] == "agenda"


def test_revert_refuses_a_layout_of_the_decks_own(project: Path) -> None:
    (project / "layouts").mkdir()
    (project / "layouts" / "mine.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"/>'
    )
    with pytest.raises(EditError, match="not a copy"):
        _apply(project, {"action": "master", "op": "revert", "name": "mine"})


def _locator(path: Path, element_id: str | None = None, tag: str = "rect") -> str:
    root = parse_svg_file(path)
    stamper(0)(root)
    for el in root.iter(f"{{{ns.SVG}}}{tag}"):
        if el.get("data-ink-layer") is None and (
            element_id is None or el.get("id") == element_id
        ):
            if any(
                a.get(ns.INKFLOW_LAYOUT_SRC) is not None for a in el.iterancestors()
            ):
                continue
            return el.get(INK, "")
    raise AssertionError("no such element")


def test_editing_a_theme_layout_copies_it_in_the_same_step(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    theme_file = BUILTIN / "base.svg"
    loc = _locator(theme_file)
    result = session.apply(
        {
            "action": "svg",
            "file": str(theme_file),
            "copyLayout": True,
            "ops": [{"kind": "attrs", "loc": loc, "set": {"fill": "#ff0000"}}],
            "_local": True,
        },
        deck,
    )
    assert cast("dict[str, str]", result["copied"])["name"] == "base"
    copy = project / "layouts" / "base.svg"
    assert 'fill="#ff0000"' in copy.read_text(encoding="utf-8")
    assert theme_file.read_text(encoding="utf-8").count("#ff0000") == 0
    # Every slide's background is the copy now.
    built = process_deck(load_deck(project / "deck.py"), project, project / "deck.py")
    assert all("#ff0000" in s["svg"] for s in built)
    # One step: undo takes the copy away again.
    session.apply({"action": "undo"}, deck)
    assert not copy.exists()


def test_a_second_edit_before_the_reload_goes_into_the_copy(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    theme_file = BUILTIN / "base.svg"
    loc = _locator(theme_file)
    for colour in ("#ff0000", "#00ff00"):
        session.apply(
            {
                "action": "svg",
                "file": str(theme_file),
                "copyLayout": True,
                "ops": [{"kind": "attrs", "loc": loc, "set": {"fill": colour}}],
                "_local": True,
            },
            deck,
        )
    assert 'fill="#00ff00"' in (project / "layouts" / "base.svg").read_text()


def test_without_copy_on_write_a_theme_file_is_refused(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    with pytest.raises(EditError, match="outside the project"):
        EditorSession(project / "deck.py").apply(
            {"action": "svg", "file": str(BUILTIN / "base.svg"), "ops": []}, deck
        )


def test_only_agenda_slides_follow_an_agenda_copy(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    theme_file = BUILTIN / "agenda.svg"
    loc = _locator(theme_file, tag="rect")
    session.apply(
        {
            "action": "svg",
            "file": str(theme_file),
            "copyLayout": True,
            "ops": [{"kind": "attrs", "loc": loc, "set": {"fill": "#abcdef"}}],
            "_local": True,
        },
        deck,
    )
    built = process_deck(load_deck(project / "deck.py"), project, project / "deck.py")
    assert ["#abcdef" in s["svg"] for s in built] == [False, False, True, True]


# ── The master's contents ──────────────────────────────────────────────────────


def test_master_tree_lists_background_layouts_and_usage(project: Path) -> None:
    _copy(project, "agenda")
    deck = load_deck(project / "deck.py")
    tree = master_tree(deck, project / "deck.py")
    assert tree["background"] == "base"
    layouts = {
        cast("str", e["name"]): e
        for e in cast("list[dict[str, object]]", tree["layouts"])
    }
    assert layouts["agenda"]["source"] == "local"
    assert layouts["agenda"]["copyOf"] == "builtin:agenda"
    assert layouts["agenda"]["slides"] == [2, 3]
    assert layouts["title"]["slides"] == [1]  # the drawn slide is built on it
    assert layouts["base"]["reach"] == [0, 1, 2, 3]
    assert layouts["content"]["parent"] == "title"
    assert tree["overlays"] == []
    assert "poster-base" not in layouts  # not in a 16:9 deck's shape


def test_master_render_shows_a_layout_with_its_zones(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    result = EditorSession(project / "deck.py").apply(
        {
            "action": "master-render",
            "kind": "layout",
            "path": str(BUILTIN / "media-left.svg"),
        },
        deck,
    )
    entry = cast("dict[str, object]", result["entry"])
    svg = cast("dict[str, str]", result["slide"])["svg"]
    # Text zones show sample text, the media zone stays as a dashed box.
    assert "Slide title" in svg
    assert 'id="zone-media"' in svg
    sources = cast("list[dict[str, object]]", entry["sources"])
    assert sources[0]["path"] == str(BUILTIN / "media-left.svg")
    assert sources[0]["role"] == "layout"
    assert not sources[0]["writable"]
    with pytest.raises(EditError, match="not one of the deck's"):
        EditorSession(project / "deck.py").apply(
            {
                "action": "master-render",
                "kind": "layout",
                "path": str(project / "deck.py"),
            },
            deck,
        )


# ── New overlays ───────────────────────────────────────────────────────────────


def test_new_overlay_on_every_slide(project: Path) -> None:
    result = _apply(project, {"action": "master", "op": "new-overlay", "name": "Logo"})
    assert result["label"] == "New overlay 'logo'"
    path = project / "overlays" / "logo.svg"
    root = parse_svg_file(path)
    assert root.get("viewBox") == "0 0 1920 1080"
    assert root.get(ns.INKFLOW_PREVIEW) == "base"
    code = (project / "deck.py").read_text(encoding="utf-8")
    assert 'overlays=[Overlay("logo")]' in code
    assert "from inkflow import Deck, Overlay, Slide" in code
    deck = load_deck(project / "deck.py")
    assert [o.src for o in deck.effective_overlays] == ["logo"]
    # Drawing into it reaches every slide.
    path.write_text(
        path.read_text().replace("</svg>", '<text id="footer">ACME</text></svg>')
    )
    built = process_deck(deck, project, project / "deck.py")
    assert all("ACME" in s["svg"] for s in built)
    with pytest.raises(EditError, match="exists already"):
        _apply(project, {"action": "master", "op": "new-overlay", "name": "logo"})


def test_new_overlay_keeps_the_ones_before_and_can_be_one_slides(
    project: Path,
) -> None:
    _apply(project, {"action": "master", "op": "new-overlay", "name": "footer"})
    _apply(
        project,
        {"action": "master", "op": "new-overlay", "name": "badge", "slide": 2},
    )
    deck = load_deck(project / "deck.py")
    assert [o.src for o in deck.effective_overlays] == ["footer"]
    assert [o.src for o in deck.slides[2].overlays or []] == ["footer", "badge"]
    assert deck.slides[1].overlays is None


def test_a_poster_decks_overlay_has_the_poster_canvas(project: Path) -> None:
    code = (
        (project / "deck.py")
        .read_text()
        .replace("embed_fonts=False,", 'embed_fonts=False,\n        size="a0",')
    )
    (project / "deck.py").write_text(code)
    _apply(project, {"action": "master", "op": "new-overlay", "name": "logos"})
    root = parse_svg_file(project / "overlays" / "logos.svg")
    assert root.get("viewBox") == "0 0 3179 4494"


# ── Templates ──────────────────────────────────────────────────────────────────


def test_slug_and_hint() -> None:
    assert slug_name("customCodeExamples") == "custom-code-examples"
    assert slug_name("Code examples") == "code-examples"
    assert slug_name("HTMLSlides") == "html-slides"
    assert hint_of("# Code examples\n\nmore") == "Code examples"
    assert hint_of("- **One** point") == "One point"
    assert hint_of("```py\nprint(1)\n```") == "print(1)"


def test_save_a_drawn_slide_as_a_template(project: Path) -> None:
    result = _apply(
        project,
        {
            "action": "master",
            "op": "save",
            "slide": 1,
            "name": "customCodeExamples",
            "hints": True,
        },
    )
    assert result["layout"] == "custom-code-examples"
    path = project / "layouts" / "custom-code-examples.svg"
    root = parse_svg_file(path)
    assert root.get(ns.INKFLOW_LABEL) == "customCodeExamples"
    assert root.get(ns.INKFLOW_PARENT) == "title"
    ids = {el.get("id") for el in root.iter() if el.get("id")}
    assert {"code-box", "zone-code", "shot"} <= ids
    # The picture's reference still names the file from layouts/.
    image = next(root.iter(f"{{{ns.SVG}}}image"))
    assert image.get("href") == "../assets/shot.png"
    hints = {el.get("zone"): el.text for el in root.iter(ns.INKFLOW_HINT)}
    assert hints == {"title": "Code examples", "code": "print(1)"}
    # It is a layout like any: listed, offered, and a new slide goes on it.
    deck = load_deck(project / "deck.py")
    names = [p["name"] for p in layout_previews(deck, project / "deck.py")]
    assert names[0] == "custom-code-examples"
    previews = {p["name"]: p for p in layout_previews(deck, project / "deck.py")}
    assert previews["custom-code-examples"]["label"] == "customCodeExamples"
    _apply(
        project,
        {"action": "slide", "op": "new", "layout": "custom-code-examples", "after": 3},
    )
    deck = load_deck(project / "deck.py")
    built = process_deck(deck, project, project / "deck.py", editor=True)
    edit = built[-1].get("edit")
    assert edit is not None
    empty = {z["zone"]: z.get("hint") for z in edit["emptyZones"]}
    assert empty["code"] == "print(1)"
    assert empty["title"] == "Code examples"
    assert "inkflow:hint" not in built[-1]["svg"]
    model = build_model(deck, project / "deck.py", built)
    layouts = {e["name"]: e for e in cast("list[dict[str, str]]", model["layouts"])}
    assert layouts["custom-code-examples"]["label"] == "customCodeExamples"


def test_save_turns_pictures_into_placeholders(project: Path) -> None:
    _apply(
        project,
        {
            "action": "master",
            "op": "save",
            "slide": 1,
            "name": "shots",
            "pictures": True,
        },
    )
    root = parse_svg_file(project / "layouts" / "shots.svg")
    assert not list(root.iter(f"{{{ns.SVG}}}image"))
    rects = {el.get("id"): el for el in root.iter(f"{{{ns.SVG}}}rect")}
    assert rects["zone-picture"].get("width") == "300"


def test_save_a_slide_drawn_straight_from_a_layout(project: Path) -> None:
    _apply(project, {"action": "master", "op": "save", "slide": 2, "name": "Plans"})
    root = parse_svg_file(project / "layouts" / "plans.svg")
    assert root.get(ns.INKFLOW_PARENT) == "agenda"
    assert root.get(ns.INKFLOW_LABEL) == "Plans"
    with pytest.raises(EditError, match="exists already"):
        _apply(project, {"action": "master", "op": "save", "slide": 2, "name": "plans"})
    with pytest.raises(EditError, match="exists already"):
        _apply(
            project, {"action": "master", "op": "save", "slide": 2, "name": "Agenda"}
        )


def test_rename_and_delete_a_template(project: Path) -> None:
    _apply(project, {"action": "master", "op": "save", "slide": 2, "name": "Plans"})
    _apply(
        project,
        {"action": "slide", "op": "new", "layout": "plans", "after": 3},
    )
    # The label alone.
    _apply(
        project, {"action": "master", "op": "rename", "name": "plans", "to": "PLANS"}
    )
    assert (
        parse_svg_file(project / "layouts" / "plans.svg").get(ns.INKFLOW_LABEL)
        == "PLANS"
    )
    # A new file name: the new slide's drawing follows.
    _apply(
        project,
        {"action": "master", "op": "rename", "name": "plans", "to": "Road maps"},
    )
    assert not (project / "layouts" / "plans.svg").exists()
    renamed = project / "layouts" / "road-maps.svg"
    assert parse_svg_file(renamed).get(ns.INKFLOW_LABEL) == "Road maps"
    deck = load_deck(project / "deck.py")
    new_slide = resolve_slide_src(deck.slides[4].src, project, deck.theme)
    assert parse_svg_file(new_slide).get(ns.INKFLOW_PARENT) == "road-maps"
    # Deleting it is refused while a slide is built on it.
    with pytest.raises(EditError, match="1 slide use 'road-maps'"):
        _apply(project, {"action": "master", "op": "delete", "name": "road-maps"})
    _apply(
        project,
        {
            "action": "master",
            "op": "delete",
            "name": "road-maps",
            "moveTo": "agenda",
        },
    )
    assert not renamed.exists()
    assert parse_svg_file(new_slide).get(ns.INKFLOW_PARENT) == "agenda"


def test_copies_keep_the_themes_name(project: Path) -> None:
    _apply(project, {"action": "master", "op": "copy", "name": "agenda"})
    with pytest.raises(EditError, match="keeps its name"):
        _apply(
            project, {"action": "master", "op": "rename", "name": "agenda", "to": "x"}
        )
    with pytest.raises(EditError, match="keeps its name"):
        _apply(project, {"action": "master", "op": "delete", "name": "agenda"})


def test_add_a_placeholder_to_a_layout(project: Path) -> None:
    _apply(project, {"action": "master", "op": "save", "slide": 2, "name": "Plans"})
    path = project / "layouts" / "plans.svg"
    result = _apply(
        project,
        {
            "action": "master",
            "op": "add-zone",
            "file": str(path),
            "zoneKind": "picture",
            "x": 10,
            "y": 20,
            "width": 300,
            "height": 200,
        },
    )
    assert result["zone"] == "picture"
    result = _apply(
        project,
        {
            "action": "master",
            "op": "add-zone",
            "file": str(path),
            "name": "Caption",
            "x": 10,
            "y": 20,
            "width": 300,
            "height": 200,
        },
    )
    assert result["zone"] == "caption"
    entries = layout_entries(load_deck(project / "deck.py"), project)
    assert entries["plans"].name == "plans"
    # The title zone is the agenda layout's: a new "title" is numbered on.
    result = _apply(
        project,
        {
            "action": "master",
            "op": "add-zone",
            "file": str(path),
            "name": "title",
            "x": 0,
            "y": 0,
            "width": 10,
            "height": 10,
        },
    )
    assert result["zone"] != "title"


def test_refreshing_previews_joins_the_last_step(project: Path) -> None:
    """Leaving the slide master refreshes the Inkscape previews as part of
    the last edit, so Undo takes back what the user saw change."""
    CliRunner().invoke(main, ["sync", "--deck", str(project / "deck.py")])
    deck = load_deck(project / "deck.py")
    session = EditorSession(project / "deck.py")
    theme_file = BUILTIN / "base.svg"
    session.apply(
        {
            "action": "svg",
            "file": str(theme_file),
            "copyLayout": True,
            "ops": [
                {"kind": "attrs", "loc": _locator(theme_file), "set": {"fill": "#123"}}
            ],
        },
        deck,
    )
    drawn = project / "slides" / "drawn.svg"
    before = drawn.read_text()
    result = session.apply(
        {"action": "master", "op": "previews", "attach": True},
        load_deck(project / "deck.py"),
    )
    assert drawn.read_text() != before  # its preview shows the new background
    assert len(session.history.done) == 1
    assert result["undoLabel"] == "Edit shape"
    session.apply({"action": "undo"}, deck)
    assert drawn.read_text() == before
    assert not (project / "layouts" / "base.svg").exists()


def test_layout_previews_show_template_hints_and_roots(project: Path) -> None:
    _apply(
        project,
        {
            "action": "master",
            "op": "save",
            "slide": 1,
            "name": "Code",
            "hints": True,
        },
    )
    deck = load_deck(project / "deck.py")
    previews = {p["name"]: p for p in layout_previews(deck, project / "deck.py")}
    assert "Code examples" in cast("str", previews["code"]["svg"])
    assert "base" not in previews
    roots = layout_previews(deck, project / "deck.py", roots=True)
    assert "base" in {p["name"] for p in roots}


def test_previews_follow_the_master(project: Path) -> None:
    """A copy, a revert or a new overlay updates the Inkscape previews of the
    deck's files in the same step: `verify` stays clean."""
    (project / "slides" / "drawn.svg").write_text(DRAWN)
    CliRunner().invoke(main, ["sync", "--deck", str(project / "deck.py")])
    _apply(project, {"action": "master", "op": "copy", "name": "base"})
    _apply(project, {"action": "master", "op": "new-overlay", "name": "logo"})
    drawn = (project / "slides" / "drawn.svg").read_text()
    assert (
        'inkflow:layout-src="builtin:base"' in drawn
        or "layouts/base" in drawn
        or ("__inkflow:layout:base__" in drawn)
    )
    assert 'inkflow:overlay-src="logo"' in drawn
    result = CliRunner().invoke(main, ["verify", "--deck", str(project / "deck.py")])
    assert "stale" not in result.output, result.output


# ── The command line ───────────────────────────────────────────────────────────


def _cli(project: Path, *args: str) -> str:
    result = CliRunner().invoke(main, [*args, "--deck", str(project / "deck.py")])
    assert result.exit_code == 0, result.output
    return result.output


def test_cli_offline(project: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(console, "width", 220)
    out = _cli(project, "layout", "copy", "base")
    assert "Copy layout base into the deck" in out
    assert "own copy of 'base'" in out
    out = _cli(project, "layouts")
    assert "copy of builtin:base" in out
    assert "replaced by the deck's copy" in out
    out = _cli(project, "layout", "save", "2", "customCodeExamples", "--hints")
    assert "inkflow slide add --layout custom-code-examples" in out
    _cli(project, "slide", "add", "--layout", "custom-code-examples")
    deck = load_deck(project / "deck.py")
    src = resolve_slide_src(deck.slides[-1].src, project, deck.theme)
    assert parse_svg_file(src).get(ns.INKFLOW_PARENT) == "custom-code-examples"
    out = _cli(project, "overlay", "new", "brand")
    assert "brand is drawn on every slide" in out
    out = _cli(project, "overlay", "new", "badge", "--slide", "3")
    assert "slide 3" in out
    _cli(project, "layout", "rename", "custom-code-examples", "Code samples")
    assert (project / "layouts" / "code-samples.svg").exists()
    _cli(project, "layout", "revert", "base")
    assert not (project / "layouts" / "base.svg").exists()
    result = CliRunner().invoke(
        main, ["layout", "delete", "code-samples", "--deck", str(project / "deck.py")]
    )
    assert result.exit_code != 0
    assert "use 'code-samples'" in result.output
    _cli(project, "layout", "delete", "code-samples", "--move-to", "content")
    assert not (project / "layouts" / "code-samples.svg").exists()


class _UI:
    def set_building(self) -> None:
        pass

    def refresh(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, _trace: str) -> None:
        pass


@pytest.fixture
def served(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[EditorSession, int]]:
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
        async with server.listening(ui, session) as bound:
            port.append(bound)
            watch = asyncio.create_task(
                server._watch(deck_path, ui, asyncio.Lock(), levels)  # pyright: ignore[reportPrivateUsage]
            )
            await asyncio.sleep(0.3)
            started.set()
            await stop.wait()
            watch.cancel()
            # A rebuild still running would be destroyed pending, and its
            # complaint logged into some later test's output.
            rest = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            for task in rest:
                _ = task.cancel()
            _ = await asyncio.gather(*rest, return_exceptions=True)

    thread = threading.Thread(target=lambda: loop.run_until_complete(run()))
    thread.start()
    assert started.wait(20)
    record = instances.Instance(
        os.getpid(), "127.0.0.1", port[0], port[0], str(deck_path)
    )

    def serving(_deck: Path, _exclude_pid: int | None = None) -> instances.Instance:
        return record

    monkeypatch.setattr(instances, "serving", serving)
    try:
        yield session, port[0]
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


def test_cli_through_the_server_is_an_undoable_step(
    project: Path, served: tuple[EditorSession, int]
) -> None:
    session, port = served
    with connect(
        f"ws://127.0.0.1:{port}/_inkflow/ws", proxy=None, max_size=None
    ) as editor:
        editor.send(json.dumps({"type": "hello", "role": "editor"}))
        out = _cli(project, "overlay", "new", "logo")
        assert "Ctrl+Z in the editor" in out
        out = _cli(project, "layout", "copy", "agenda")
        assert "Ctrl+Z in the editor" in out
        # The editor's master view reads the same tree.
        editor.send(json.dumps({"type": "edit-op", "id": "t", "action": "master-tree"}))
        while True:
            msg = cast("dict[str, object]", json.loads(editor.recv(timeout=10)))
            if msg.get("type") == "edit-result" and msg.get("id") == "t":
                break
        master = cast("dict[str, object]", msg["master"])
        overlays = cast("list[dict[str, object]]", master["overlays"])
        assert [o["name"] for o in overlays] == ["logo"]
    assert [s.label for s in session.history.done] == [
        "Agent: New overlay logo",
        "Agent: Copy layout agenda into the deck",
    ]
    deck = load_deck(project / "deck.py")
    session.apply({"action": "undo"}, deck)
    assert not (project / "layouts" / "agenda.svg").exists()
    assert AssetKind.LAYOUT.value == "layouts"
