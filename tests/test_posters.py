"""Posters: the built-in poster layouts, the print type scale, scaffolding."""

from __future__ import annotations

import re
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

from inkflow.charts import FENCE_FONT, fence_font
from inkflow.cli import main
from inkflow.editor import projects
from inkflow.editor.model import build_model
from inkflow.editor.previews import layout_previews
from inkflow.export import find_chromium
from inkflow.init import poster_layout, scaffold_poster
from inkflow.layout import discover_layouts, layout_canvas, layouts_for
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.sizes import PageSize
from inkflow.svgio import parse_svg
from inkflow.themes import Builtin

POSTER_LAYOUTS = {
    "poster-2col": (3179, 4494, 2),
    "poster-3col": (3179, 4494, 3),
    "poster-landscape-3col": (4494, 3179, 3),
    "poster-landscape-4col": (4494, 3179, 4),
}


def _layouts() -> dict[str, Path]:
    return {p.stem: p for _, p in discover_layouts(None, Builtin())}


@pytest.mark.parametrize("name", sorted(POSTER_LAYOUTS))
def test_poster_layouts_are_a_shaped_with_their_zones(name: str) -> None:
    from inkflow.layout import layout_zones

    w, h, cols = POSTER_LAYOUTS[name]
    path = _layouts()[name]
    assert layout_canvas(path) == (w, h)
    zones = set(layout_zones(path, None, Builtin()).zones)
    assert {f"col-{i}" for i in range(1, cols + 1)} <= zones
    assert {"title", "authors", "affiliations", "logos", "references", "contact"} <= (
        zones
    )
    assert f"col-{cols + 1}" not in zones


def test_poster_decks_are_offered_poster_layouts(tmp_path: Path) -> None:
    found = discover_layouts(tmp_path, Builtin())
    screen = {p.stem for _, p in layouts_for(found, PageSize.WIDESCREEN)}
    assert "content" in screen
    assert not any(name.startswith("poster") for name in screen)
    portrait = {p.stem for _, p in layouts_for(found, PageSize.A1)}
    assert portrait == {"poster-base", "poster-2col", "poster-3col"}
    landscape = {p.stem for _, p in layouts_for(found, PageSize("a0-landscape"))}
    assert landscape == {
        "poster-landscape-base",
        "poster-landscape-3col",
        "poster-landscape-4col",
    }
    # A shape no built-in layout has: every layout is offered.
    assert len(layouts_for(found, PageSize.LETTER)) == len(found)


def test_project_layouts_are_offered_whatever_their_shape(tmp_path: Path) -> None:
    (tmp_path / "layouts").mkdir()
    (tmp_path / "layouts" / "mine.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 768"/>'
    )
    found = discover_layouts(tmp_path, Builtin())
    names = {p.stem for _, p in layouts_for(found, PageSize.A0)}
    assert "mine" in names


# ── The poster template ───────────────────────────────────────────────────────


@pytest.fixture
def poster(tmp_path: Path) -> Path:
    scaffold_poster(tmp_path / "poster")
    return tmp_path / "poster"


def test_scaffold_poster(poster: Path) -> None:
    deck = load_deck(poster / "deck.py")
    assert deck.size == "a0"
    assert deck.slides[0].src == "poster-3col"
    for rel in ("slides/poster.md", "figures/method.svg", "data/results.csv"):
        assert (poster / rel).is_file()
    slides = process_deck(deck, poster, poster / "deck.py")
    svg = slides[0]["svg"]
    root = parse_svg(svg)
    assert root.get("viewBox") == "0 0 3179 4494"
    for zone in ("title", "authors", "col-1", "col-2", "col-3", "references"):
        assert f'id="zone-{zone}"' in svg
    assert 'class="inkflow-chart"' in svg  # the Markdown chart was drawn
    assert "method.svg" in svg


def test_scaffold_poster_landscape_and_refusals(tmp_path: Path) -> None:
    sheet = scaffold_poster(tmp_path / "wide", "a1-landscape")
    assert sheet == "a1-landscape"
    assert load_deck(tmp_path / "wide" / "deck.py").slides[0].src == (
        "poster-landscape-3col"
    )
    assert poster_layout(PageSize.A2) == "poster-3col"
    with pytest.raises(ValueError, match="paper size"):
        scaffold_poster(tmp_path / "screen", "16:9")


def test_init_poster_cli(tmp_path: Path) -> None:
    target = tmp_path / "my-poster"
    result = CliRunner().invoke(main, ["init", str(target), "--size", "a1", "--no-git"])
    assert result.exit_code == 0, result.output
    assert "A1 portrait" in result.output
    assert 'size="a1"' in (target / "deck.py").read_text()
    bad = CliRunner().invoke(main, ["init", str(tmp_path / "x"), "--size", "4:3"])
    assert bad.exit_code != 0 and "paper size" in bad.output


def test_new_deck_poster_look(tmp_path: Path) -> None:
    info = projects.new_deck_info(None, None)
    assert any(t["id"] == "poster" for t in projects.THEMES)
    sizes = info["posterSizes"]
    assert (
        isinstance(sizes, list)
        and {"id": "a0", "label": "A0 portrait (841 x 1189 mm)"} in sizes
    )
    deck_py = projects.create_deck(
        tmp_path / "conf", title="Our poster", theme="poster", git=False, size="a1"
    )
    text = deck_py.read_text()
    assert 'size="a1"' in text and 'title="Our poster"' in text
    with pytest.raises(projects.ProjectError, match="paper size"):
        projects.create_deck(
            tmp_path / "bad", title="", theme="poster", git=False, size="9:16"
        )


def test_editor_model_and_gallery_for_a_poster(poster: Path) -> None:
    deck = load_deck(poster / "deck.py")
    slides = process_deck(deck, poster, poster / "deck.py", editor=True)
    model = build_model(deck, poster / "deck.py", slides)
    layouts = cast("list[dict[str, str]]", model["layouts"])
    names = [entry["name"] for entry in layouts]
    assert names == ["poster-2col", "poster-3col"]
    previews = layout_previews(deck, poster / "deck.py")
    assert [p["name"] for p in previews] == ["poster-3col", "poster-2col"]
    assert "Section" in str(previews[0]["svg"])


# ── Type scale ────────────────────────────────────────────────────────────────


def _font_sizes(svg: str, zone: str) -> list[float]:
    """The font-size of every text of one chart zone."""
    start = svg.index(f'id="zone-{zone}"')
    end = svg.index("</svg>", start)
    found = re.finditer(r'font-size="([\d.]+)"', svg[start:end])
    return [float(m.group(1)) for m in found]


def test_chart_text_follows_the_print_type_scale(tmp_path: Path) -> None:
    (tmp_path / "data.csv").write_text("x,y\na,1\nb,2\n")
    zone = '<rect id="zone-plot" x="100" y="100" width="1000" height="800"/>'
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {}">{}</svg>'
    (tmp_path / "chart.svg").write_text(svg.format("3179 4494", zone))
    (tmp_path / "wide.svg").write_text(svg.format("1920 1080", zone))

    def sizes(size: str | None, src: str) -> list[float]:
        arg = f"size={size!r}, " if size else ""
        (tmp_path / "deck.py").write_text(
            "from inkflow import Chart, Deck, Slide\n\n\n"
            + f"def main() -> Deck:\n    return Deck({arg}slides=[Slide("
            + f'"./{src}", zones={{"plot": Chart("data.csv")}})])\n'
        )
        deck = load_deck(tmp_path / "deck.py")
        return _font_sizes(
            process_deck(deck, tmp_path, tmp_path / "deck.py")[0]["svg"], "plot"
        )

    screen = sizes(None, "wide.svg")
    poster = sizes("a0", "chart.svg")
    # Axis labels are 0.8 of the chart text: 0.6 of the 36 px body on a 16:9
    # slide, on A0 the 40-unit body itself (24 pt).
    assert max(screen) == pytest.approx(36 * 0.6 * 0.8, abs=0.01)
    assert max(poster) == pytest.approx(40 * 1.0 * 0.8, abs=0.01)
    # A Markdown chart likewise.
    assert fence_font(36) == FENCE_FONT
    assert fence_font(40, 1.0) == pytest.approx(FENCE_FONT * 40 / 36 / 0.6)


# ── Rendered ──────────────────────────────────────────────────────────────────


@pytest.mark.skipif(find_chromium() is None, reason="chromium not available")
@pytest.mark.parametrize("layout", sorted(POSTER_LAYOUTS))
def test_poster_layouts_render_without_problems(poster: Path, layout: str) -> None:
    from inkflow.render import render_slides

    deck_py = poster / "deck.py"
    deck_py.write_text(deck_py.read_text().replace('"poster-3col"', f'"{layout}"'))
    if "landscape" in layout:
        deck_py.write_text(deck_py.read_text().replace('"a0"', '"a0-landscape"'))
    result = render_slides(deck_py, None, None, no_sandbox=True)
    problems = [f.message() for f in result.findings if f.is_problem]
    assert problems == []
    # The template's text is all large enough to read on paper, too.
    hints = [f.message() for f in result.findings]
    assert hints == []


# ── Print checks ──────────────────────────────────────────────────────────────


def test_print_check_thresholds_follow_the_sheet() -> None:
    from inkflow.export import PdfPage
    from inkflow.render import print_check

    a0 = PageSize.A0
    check = print_check(PdfPage(*a0.page_pt, a0.canvas))
    assert check["ptPerUnit"] == pytest.approx(0.75, abs=1e-3)
    assert check["minPt"] == pytest.approx(17.9, abs=0.05)  # about 18 pt
    assert check["bodyPt"] == pytest.approx(23.8, abs=0.05)  # about 24 pt
    a1 = PageSize.A1
    small = print_check(PdfPage(*a1.page_pt, a1.canvas))
    # The A0 canvas on an A1 sheet: everything scaled by 1/sqrt(2).
    assert small["ptPerUnit"] == pytest.approx(0.75 / 2**0.5, abs=1e-3)
    assert small["bodyPt"] == pytest.approx(23.8 / 2**0.5, abs=0.1)


def test_print_checks_apply_to_paper_only() -> None:
    from inkflow.manifest import Deck
    from inkflow.pipeline import SlideData
    from inkflow.render import print_checks

    def slide(attrs: str) -> SlideData:
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" {attrs}/>'
        return cast("SlideData", cast(object, {"svg": svg, "notes": "", "id": "s"}))

    screen = slide('viewBox="0 0 1920 1080"')
    paper = slide('viewBox="0 0 841 1189" width="841mm" height="1189mm"')
    assert print_checks(Deck(), [screen, paper])[0] is None
    raw = print_checks(Deck(), [paper])[0]
    assert raw is not None and raw["ptPerUnit"] == pytest.approx(72 / 25.4)
    assert all(c is not None for c in print_checks(Deck(size="a0"), [screen]))
    assert print_checks(Deck(size="16:9"), [screen]) == [None]


def test_print_findings_read_as_points_and_dpi() -> None:
    from inkflow.render import parse_findings

    raw = [
        {
            "kind": "small-text",
            "target": "#zone-col-1",
            "size": 20.5,
            "min": 23.8,
            "text": "Body",
            "unit": "pt",
            "body": True,
        },
        {
            "kind": "low-res",
            "target": "<image>",
            "dpi": 72,
            "min": 150,
            "problem": True,
            "text": "photo.png",
        },
        {
            "kind": "low-res",
            "target": "#pic",
            "dpi": 120,
            "min": 150,
            "problem": False,
            "text": "pic.jpg",
        },
    ]
    small, coarse, soft = parse_findings(1, "poster", raw)
    assert not small.is_problem
    assert "body text 20.5 pt is likely too small to read on paper" in (small.message())
    assert coarse.is_problem and not soft.is_problem
    assert "photo.png prints at 72 dpi, pixelated" in coarse.message()
    assert "120 dpi, soft" in soft.message()


@pytest.mark.skipif(find_chromium() is None, reason="chromium not available")
def test_render_check_finds_small_print_and_coarse_pictures(tmp_path: Path) -> None:
    from inkflow.render import render_slides
    from tests.test_print_export import _png  # pyright: ignore[reportPrivateUsage]

    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "small.png").write_bytes(_png(300, 200))
    (tmp_path / "slides" / "fine.png").write_bytes(_png(1600, 1200))
    (tmp_path / "slides" / "poster.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3179 4494">'
        + '<image id="coarse" href="small.png" x="100" y="100" width="1000"'
        + ' height="667"/>'
        + '<image id="sharp" href="fine.png" x="100" y="900" width="600"'
        + ' height="450"/>'
        + '<text id="tiny" x="100" y="2000" font-size="16">Footnote</text>'
        + '<text id="big" x="100" y="2200" font-size="40">Body</text>'
        + "</svg>"
    )
    (tmp_path / "deck.py").write_text(
        "from inkflow import Deck, Slide\n\n\ndef main() -> Deck:\n"
        + '    return Deck(size="a0", slides=[Slide("slides/poster.svg")])\n'
    )
    result = render_slides(tmp_path / "deck.py", None, None, no_sandbox=True)
    found = {(f.kind, f.target): f for f in result.findings}
    coarse = found[("low-res", "#coarse")]
    # 300 px across 1000 units = 750 pt = 10.4 in: 29 dpi.
    assert coarse.dpi == 29 and coarse.is_problem
    assert ("low-res", "#sharp") not in found  # 1600 px over 6.25 in: 256 dpi
    tiny = found[("small-text", "#tiny")]
    assert tiny.unit == "pt" and tiny.size == 12  # 16 units at 0.75 pt
    assert ("small-text", "#big") not in found
    # A screen deck keeps measuring in px, and never pictures.
    (tmp_path / "deck.py").write_text(
        (tmp_path / "deck.py").read_text().replace('size="a0", ', "")
    )
    screen = render_slides(tmp_path / "deck.py", None, None, no_sandbox=True)
    assert all(f.kind != "low-res" and f.unit == "px" for f in screen.findings)
