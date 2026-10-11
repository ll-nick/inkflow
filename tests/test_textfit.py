"""A text zone's size (``--inkflow-font-scale``) and shrink-to-fit
(``--inkflow-fit``): where each is written (the zone shape's style, a Markdown
marker's ``size=``/``fit=``, ``TextBox(size=, fit=)``), how the build emits
them, the editor's and the CLI's writes, the outline, and `inkflow render`
measuring a zone after the browser fitted it (src/ts/shared/fit.ts)."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow import instances
from inkflow.cli import main
from inkflow.content import substitute_content
from inkflow.editor.codegen import Code
from inkflow.editor.outline import build_outline, format_outline
from inkflow.editor.session import EditError, EditorSession
from inkflow.export import find_chromium
from inkflow.manifest import TextBox, format_text_scale, parse_text_scale
from inkflow.pipeline import process_deck
from inkflow.render import render_slides
from inkflow.server import load_deck
from inkflow.sizes import PRINT_MIN_TEXT, PageSize, print_body_pt
from inkflow.svgio import parse_svg
from inkflow.zones import (
    parse_markdown_zones,
    replace_zone_text,
    set_zone_params,
    zone_params,
)

XHTML = "http://www.w3.org/1999/xhtml"


def _wrapper_style(svg: str, zone: str) -> str:
    fo = parse_svg(svg).find(f'.//*[@id="zone-{zone}"]')
    assert fo is not None
    wrapper = fo.find(f"{{{XHTML}}}div")
    assert wrapper is not None
    return wrapper.get("style") or ""


# ── The value and its grammar ────────────────────────────────────────────────


class TestTextScale:
    @pytest.mark.parametrize(
        ("text", "scale"), [("80%", 0.8), ("0.8", 0.8), ("150 %", 1.5), ("25%", 0.25)]
    )
    def test_parse(self, text: str, scale: float) -> None:
        assert parse_text_scale(text) == pytest.approx(scale)

    @pytest.mark.parametrize("text", ["20%", "3.5", "big", "80"])
    def test_refused(self, text: str) -> None:
        with pytest.raises(ValueError):
            parse_text_scale(text)

    def test_format(self) -> None:
        assert format_text_scale(0.8) == "80%"
        assert format_text_scale(0.67) == "67%"
        assert format_text_scale(1.125) == "112.5%"

    def test_textbox_checks_its_size(self) -> None:
        assert TextBox("x", size=0.8).size == 0.8
        with pytest.raises(ValueError, match="between"):
            TextBox("x", size=5)

    def test_codegen_writes_the_new_fields(self) -> None:
        code = Code().call(TextBox("Hi", size=0.8, fit=False))
        assert code == 'TextBox(text="Hi", size=0.8, fit=False)'


class TestMarkers:
    def test_size_and_fit_reach_the_textbox(self) -> None:
        from inkflow.assets import AssetRoots, AssetSource
        from inkflow.zones import build_slide_content

        source = AssetSource.for_deck(AssetRoots(Path.cwd()))
        parsed = parse_markdown_zones(
            "::content size=80% fit=none::\nText\n\n::side size=0.5::\nMore\n"
        )
        content = build_slide_content(parsed, {}, source, source).content
        box = content["zone-content"]
        assert isinstance(box, TextBox)
        assert (box.size, box.fit) == (pytest.approx(0.8), False)
        side = content["zone-side"]
        assert isinstance(side, TextBox)
        assert (side.size, side.fit) == (pytest.approx(0.5), None)

    def test_a_bad_value_is_ignored(self, caplog: pytest.LogCaptureFixture) -> None:
        from inkflow.assets import AssetRoots, AssetSource
        from inkflow.zones import build_slide_content

        source = AssetSource.for_deck(AssetRoots(Path.cwd()))
        parsed = parse_markdown_zones("::content size=9000% fit=maybe::\nText\n")
        box = build_slide_content(parsed, {}, source, source).content["zone-content"]
        assert isinstance(box, TextBox)
        assert (box.size, box.fit) == (None, None)
        assert "size=9000%" in caplog.text and "fit=maybe" in caplog.text

    def test_set_params_on_a_marker_keeps_the_others(self) -> None:
        md = "# T\n\n::content align=center::\nBody\n"
        out = set_zone_params(md, "content", {"size": "80%", "fit": "none"})
        assert out == "# T\n\n::content align=center size=80% fit=none::\nBody\n"
        assert zone_params(out, "content") == {
            "align": "center",
            "size": "80%",
            "fit": "none",
        }
        back = set_zone_params(out, "content", {"size": None, "fit": None})
        assert back == md

    def test_auto_zones_get_markers(self) -> None:
        md = "# Title\n\nBody text\n"
        out = set_zone_params(md, "title", {"size": "80%"})
        assert out == "::title size=80%::\n# Title\n\n::content::\nBody text\n"
        parsed = parse_markdown_zones(out)
        assert parsed.params["title"] == {"size": "80%"}
        assert set(parsed.zones) == {"title", "content"}

    def test_a_zone_the_file_does_not_name_gets_an_empty_marker(self) -> None:
        out = set_zone_params("Just text\n", "body", {"fit": "none"})
        assert out == "Just text\n\n::body fit=none::\n"
        assert parse_markdown_zones(out).params["body"] == {"fit": "none"}
        assert set_zone_params("x\n", "body", {"size": None}) == "x\n"

    def test_writing_text_keeps_the_marker_params(self) -> None:
        md = "::content size=80%::\nOld\n"
        assert replace_zone_text(md, "content", "New") == "::content size=80%::\nNew\n"


# ── The build ────────────────────────────────────────────────────────────────

ZONE_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-a" x="0" y="0" width="400" height="100"
            style="--inkflow-font-scale:0.9;--inkflow-fit:none"/>
    </svg>
""")


class TestBuild:
    def test_textbox_fields_go_on_the_wrapper(self) -> None:
        root = parse_svg(ZONE_SVG)
        substitute_content(root, {"zone-a": TextBox("Hi", size=0.8, fit=True)})
        fo = root.find('.//*[@id="zone-a"]')
        assert fo is not None
        # The shape's own values on the box (inherited)...
        assert "--inkflow-font-scale:0.9" in (fo.get("style") or "")
        # ...the slide's text's values on the wrapper inside it, which win.
        wrapper = fo.find(f"{{{XHTML}}}div")
        assert wrapper is not None
        style = wrapper.get("style") or ""
        assert "--inkflow-font-scale:0.8" in style
        assert "--inkflow-fit:shrink" in style

    def test_unset_fields_write_nothing(self) -> None:
        root = parse_svg(ZONE_SVG)
        substitute_content(root, {"zone-a": TextBox("Hi")})
        fo = root.find('.//*[@id="zone-a"]')
        assert fo is not None
        wrapper = fo.find(f"{{{XHTML}}}div")
        assert wrapper is not None
        assert wrapper.get("style") is None

    def test_contract_css_multiplies_both_factors(self) -> None:
        css = (Path(__file__).parent.parent / "src/inkflow/contract.css").read_text()
        flat = " ".join(css.split())
        assert "var(--inkflow-font-scale, 1) * var(--inkflow-fit-scale, 1)" in flat

    def test_a_printed_slide_carries_its_readable_minimum(self, tmp_path: Path) -> None:
        (tmp_path / "deck.py").write_text(
            textwrap.dedent("""\
                from inkflow import Deck, Slide


                def main() -> Deck:
                    return Deck(
                        size="a0", embed_fonts=False, slides=[Slide("poster-base")]
                    )
            """)
        )
        deck = load_deck(tmp_path / "deck.py")
        svg = process_deck(deck, tmp_path, tmp_path / "deck.py")[0]["svg"]
        root = parse_svg(svg)
        size = PageSize("a0")
        w, h = size.page_pt
        cw, ch = size.canvas
        expected = print_body_pt(w, h) * PRINT_MIN_TEXT / min(w / cw, h / ch)
        assert float(root.get("data-inkflow-min-text", "0")) == pytest.approx(
            expected, rel=1e-3
        )

    def test_a_screen_slide_has_none(self, tmp_path: Path) -> None:
        (tmp_path / "deck.py").write_text(
            textwrap.dedent("""\
                from inkflow import Deck, Slide


                def main() -> Deck:
                    return Deck(embed_fonts=False, slides=[Slide("content")])
            """)
        )
        deck = load_deck(tmp_path / "deck.py")
        svg = process_deck(deck, tmp_path, tmp_path / "deck.py")[0]["svg"]
        assert "data-inkflow-min-text" not in svg


# ── The editor's writes ──────────────────────────────────────────────────────

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

DRAWN = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow"
         inkflow:parent="two" viewBox="0 0 1920 1080">
      <rect id="zone-note" x="100" y="700" width="600" height="200"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Inline, Slide, TextBox


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide("two", md="text.md"),
                Slide("two", zones={"title": "Hello", "content": TextBox("Boxed")}),
                Slide("two", md=Inline("# Inline\\n\\nBody")),
                Slide("drawn.svg", md="drawn.md"),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    for sub in ("slides", "layouts"):
        (tmp_path / sub).mkdir()
    (tmp_path / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "drawn.svg").write_text(DRAWN, encoding="utf-8")
    (tmp_path / "slides" / "text.md").write_text("# Title\n\nBody\n", encoding="utf-8")
    (tmp_path / "slides" / "drawn.md").write_text("::note::\nNote\n", encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _deck(project: Path):
    return load_deck(project / "deck.py")


def _format(project: Path, **msg: object) -> dict[str, object]:
    session = EditorSession(project / "deck.py")
    return session.apply({"action": "zone-format", **msg}, _deck(project))


class TestZoneFormat:
    def test_markdown_zone_gets_a_marker_param(self, project: Path) -> None:
        _format(project, slide=0, zone="content", size=0.8)
        md = (project / "slides" / "text.md").read_text()
        assert md == "# Title\n\n::content size=80%::\nBody\n"
        svg = process_deck(_deck(project), project, project / "deck.py")[0]["svg"]
        assert "--inkflow-font-scale:0.8" in _wrapper_style(svg, "content")
        # Fit off, then back to the default: the marker loses it again.
        _format(project, slide=0, zone="content", fit="none")
        assert (
            "::content size=80% fit=none::" in (project / "slides/text.md").read_text()
        )
        _format(project, slide=0, zone="content", fit=None, size=None)
        assert "::content::" in (project / "slides" / "text.md").read_text()

    def test_one_undo_step(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        before = (project / "slides" / "text.md").read_text()
        session.apply(
            {"action": "zone-format", "slide": 0, "zone": "title", "size": "150%"},
            _deck(project),
        )
        assert "::title size=150%::" in (project / "slides" / "text.md").read_text()
        session.apply({"action": "undo"}, _deck(project))
        assert (project / "slides" / "text.md").read_text() == before

    def test_textbox_gets_its_fields(self, project: Path) -> None:
        _format(project, slide=1, zone="content", size=0.67, fit="none")
        box = _deck(project).slides[1].zones["content"]
        assert box == TextBox("Boxed", size=0.67, fit=False)
        _format(project, slide=1, zone="content", fit="shrink")
        box = _deck(project).slides[1].zones["content"]
        assert isinstance(box, TextBox) and box.fit is True and box.size == 0.67

    def test_deck_string_moves_to_markdown(self, project: Path) -> None:
        _format(project, slide=1, zone="title", size=1.15)
        slide = _deck(project).slides[1]
        assert "title" not in slide.zones
        md = (project / "slides" / f"{slide.md}").read_text()
        assert "size=115%" in md and "Hello" in md

    def test_inline_markdown(self, project: Path) -> None:
        _format(project, slide=2, zone="content", fit="none")
        inline = str(_deck(project).slides[2].md)
        assert "::content fit=none::" in inline and "Body" in inline

    def test_refusals(self, project: Path) -> None:
        with pytest.raises(EditError, match="between"):
            _format(project, slide=0, zone="content", size=9)
        with pytest.raises(EditError, match="shrink or none"):
            _format(project, slide=0, zone="content", fit="sometimes")


# ── The command line ─────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _no_server(monkeypatch: pytest.MonkeyPatch) -> None:
    def serving(_deck: Path, _exclude_pid: int | None = None) -> None:
        return None

    monkeypatch.setattr(instances, "serving", serving)


def _shape(project: Path, *args: str) -> str:
    result = CliRunner().invoke(
        main, ["shape", *args, "--deck", str(project / "deck.py")]
    )
    assert result.exit_code == 0, result.output
    return result.output


class TestShapeStyle:
    def test_own_text_box_gets_its_style(self, project: Path) -> None:
        _shape(project, "style", "-s", "4", "note", "--font-scale", "80%")
        _shape(project, "style", "-s", "4", "note", "--fit", "none")
        svg = (project / "slides" / "drawn.svg").read_text()
        assert 'style="--inkflow-font-scale:0.8;--inkflow-fit:none"' in svg
        _shape(
            project, "style", "-s", "4", "note", "--font-scale", "1", "--fit", "shrink"
        )
        assert "--inkflow" not in (project / "slides" / "drawn.svg").read_text()

    def test_layout_zone_is_set_on_the_slide(self, project: Path) -> None:
        _shape(project, "style", "-s", "1", "content", "--font-scale", "0.5")
        assert "::content size=50%::" in (project / "slides" / "text.md").read_text()
        # The layout is left alone.
        assert "inkflow" not in (project / "layouts" / "two.svg").read_text()

    def test_bad_values(self, project: Path) -> None:
        result = CliRunner().invoke(
            main,
            [
                "shape",
                "style",
                "-s",
                "4",
                "note",
                "--font-scale",
                "9",
                "--deck",
                str(project / "deck.py"),
            ],
        )
        assert result.exit_code != 0


def test_outline_shows_size_and_fit(project: Path) -> None:
    (project / "slides" / "text.md").write_text(
        "# Title\n\n::content size=80% fit=none::\nBody\n"
    )
    (project / "slides" / "drawn.svg").write_text(
        DRAWN.replace(
            'height="200"/>', 'height="200" style="--inkflow-font-scale:1.5"/>'
        )
    )
    deck = _deck(project)
    deck_path = project / "deck.py"
    outline = build_outline(
        deck, deck_path, process_deck(deck, project, deck_path, editor=True)
    )
    one = format_outline(outline, 1)
    assert "size 80%" in one and "fit off" in one
    assert "size 150%" in format_outline(outline, 4)


# ── In Chromium ──────────────────────────────────────────────────────────────

needs_chromium = pytest.mark.skipif(
    find_chromium() is None, reason="no Chromium available"
)

FIT_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" fill="#fff"/>
      <rect id="zone-shrinks" x="100" y="100" width="800" height="300"/>
      <rect id="zone-floor" x="1000" y="100" width="800" height="120"/>
      <rect id="zone-off" x="100" y="600" width="800" height="120"
            style="--inkflow-fit:none"/>
    </svg>
""")

FIT_DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                Slide(
                    "slide.svg",
                    zones={
                        "shrinks": "\\n\\n".join(["A paragraph of text."] * 8),
                        "floor": "\\n\\n".join(["A paragraph of text."] * 30),
                        "off": "\\n\\n".join(["A paragraph of text."] * 4),
                    },
                ),
            ],
        )
""")


@needs_chromium
def test_render_measures_text_after_fitting(tmp_path: Path) -> None:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "slide.svg").write_text(FIT_SVG)
    (tmp_path / "deck.py").write_text(FIT_DECK)
    result = render_slides(
        tmp_path / "deck.py", None, None, no_sandbox=True, contrast=False
    )
    overflow = {f.target: f for f in result.findings if f.kind == "overflow"}
    # Shrunk until it fits: nothing to report.
    assert "#zone-shrinks" not in overflow
    # At the floor and still too much: a problem saying how far it shrank,
    # the readable minimum (1080/80 = 13.5 of 36: 37.5 %) above the 33 % floor.
    floor = overflow["#zone-floor"]
    assert floor.is_problem
    assert floor.size == pytest.approx(0.375, abs=0.001)
    assert "even shrunk to 38%" in floor.message()
    # Shrinking off: overflows at its own size.
    assert overflow["#zone-off"].size == 0
    assert not any(f.kind == "small-text" for f in result.findings)
