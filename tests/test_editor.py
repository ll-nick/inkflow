"""The visual editor's backend: provenance, write-back operations and the model."""

from __future__ import annotations

import base64
import io
import json
import textwrap
from pathlib import Path
from typing import cast

import pytest

from inkflow.animations import FadeIn, SlideIn
from inkflow.editor.codegen import Code, coerce_fields, field_schema
from inkflow.editor.context import format_context, read_context, write_context
from inkflow.editor.deckedit import DeckEditError, DeckSource
from inkflow.editor.model import build_model
from inkflow.editor.provenance import INK, INK_TOP, is_element, locate, parse_locator
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import SvgFile, SvgOpError, apply_ops, group, ungroup
from inkflow.enums import ColorMode, Direction, Easing, MediaFit, Muted, Trigger
from inkflow.manifest import Deck, Image, TextBox, Video
from inkflow.pipeline import process_deck
from inkflow.server import load_deck
from inkflow.svgio import parse_svg, parse_svg_file
from inkflow.transitions import Push
from inkflow.zones import replace_zone_text, zone_spans

SVG_NS = "http://www.w3.org/2000/svg"

DRAWING = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg"
         xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
         viewBox="0 0 1920 1080">
      <!-- a comment before the shapes -->
      <rect id="box" x="100" y="100" width="200" height="100"/>
      <text id="label" x="120" y="160">Hello</text>
      <g id="grp" transform="rotate(10)">
        <circle id="dot" cx="10" cy="10" r="5"/>
      </g>
      <g inkscape:groupmode="layer" id="layer1">
        <rect id="inlayer" x="0" y="0" width="10" height="10"/>
      </g>
    </svg>
""")

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect width="1920" height="1080" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Deck, Slide, animations


    def main() -> Deck:
        return Deck(
            slides=[
                # The drawn slide.
                Slide(
                    "drawing.svg",
                    notes="notes/drawing.md",
                    animations=[animations.FadeIn("box")],
                ),
                Slide("two", md="text.md"),
                Slide("two", zones={"title": "Hello"}),
            ],
        )
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "layouts").mkdir()
    (tmp_path / "notes").mkdir()
    (tmp_path / "slides" / "drawing.svg").write_text(DRAWING, encoding="utf-8")
    (tmp_path / "layouts" / "two.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "slides" / "text.md").write_text("# Title\n\nBody\n", encoding="utf-8")
    (tmp_path / "notes" / "drawing.md").write_text("Speak.\n", encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _deck(project: Path) -> Deck:
    return load_deck(project / "deck.py")


# ── Provenance ────────────────────────────────────────────────────────────────


class TestProvenance:
    def test_editor_build_stamps_locators_that_resolve(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        edit = slides[0].get("edit")
        assert edit is not None
        root = parse_svg(slides[0]["svg"])
        box = root.find(f".//{{{SVG_NS}}}rect[@id='box']")
        assert box is not None and box.get(INK_TOP) == ""
        key, path = parse_locator(box.get(INK, ""))
        source = parse_svg_file(Path(edit["sources"][key]))
        assert locate(source, path).get("id") == "box"

    def test_layer_children_are_objects_layers_are_not(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        root = parse_svg(slides[0]["svg"])
        layer = root.find(".//*[@id='layer1']")
        inner = root.find(".//*[@id='inlayer']")
        dot = root.find(".//*[@id='dot']")
        assert layer is not None and inner is not None and dot is not None
        assert layer.get(INK_TOP) is None
        assert inner.get(INK_TOP) == ""
        assert dot.get(INK_TOP) is None  # inside a group, not top level

    def test_filled_zone_keeps_its_rect_locator(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        root = parse_svg(slides[2]["svg"])
        title = root.find(".//*[@id='zone-title']")
        assert title is not None
        assert title.tag == f"{{{SVG_NS}}}foreignObject"
        assert title.get("data-ink-tag") == "rect"
        assert title.get(INK, "").startswith("0:")

    def test_empty_zones_and_origins_are_reported(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py", editor=True)
        md_slide = slides[1].get("edit")
        deck_slide = slides[2].get("edit")
        assert md_slide is not None and deck_slide is not None
        assert md_slide["zoneOrigins"] == {"title": "md", "content": "md"}
        assert deck_slide["zoneOrigins"] == {"title": "deck"}
        assert [z["zone"] for z in deck_slide["emptyZones"]] == ["content"]

    def test_plain_build_has_no_provenance(self, project: Path) -> None:
        deck = _deck(project)
        slides = process_deck(deck, project, project / "deck.py")
        assert "data-ink" not in slides[0]["svg"]
        assert "edit" not in slides[0]


# ── SVG operations ────────────────────────────────────────────────────────────


def _svg(text: str = DRAWING) -> SvgFile:
    return SvgFile.from_bytes(Path("x.svg"), text.encode())


def _loc(svg: SvgFile, element_id: str) -> str:
    from inkflow.editor.provenance import child_path

    el = svg.root.find(f".//*[@id='{element_id}']")
    assert el is not None
    return f"0:{child_path(el)}"


class TestSvgOps:
    def test_attrs_change_only_that_element(self) -> None:
        svg = _svg()
        apply_ops(svg, [{"kind": "attrs", "loc": _loc(svg, "box"), "set": {"x": "5"}}])
        out = svg.to_bytes().decode()
        assert '<rect id="box" x="5" y="100"' in out
        assert "<!-- a comment before the shapes -->" in out

    def test_attrs_cannot_set_event_handlers(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(
                svg,
                [{"kind": "attrs", "loc": _loc(svg, "box"), "set": {"onclick": "x"}}],
            )

    def test_paint_with_a_theme_token_replaces_inline_colour(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<rect style="fill:#f00;stroke:#00f"/></svg>'
        )
        apply_ops(
            svg, [{"kind": "paint", "loc": "0:0", "prop": "fill", "token": "accent"}]
        )
        rect = svg.root[0]
        assert rect.get("class") == "inkflow-fill-accent"
        assert rect.get("style") == "stroke:#00f"
        apply_ops(
            svg, [{"kind": "paint", "loc": "0:0", "prop": "fill", "color": "#123456"}]
        )
        assert rect.get("class") is None
        assert "fill:#123456" in (rect.get("style") or "")

    def test_paint_rejects_unknown_tokens_and_bad_colours(self) -> None:
        svg = _svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
        with pytest.raises(SvgOpError):
            apply_ops(
                svg, [{"kind": "paint", "loc": "0:0", "prop": "fill", "token": "nope"}]
            )
        with pytest.raises(SvgOpError):
            apply_ops(
                svg,
                [{"kind": "paint", "loc": "0:0", "prop": "fill", "color": "url(evil)"}],
            )

    def test_text_single_and_multi_line(self) -> None:
        svg = _svg()
        loc = _loc(svg, "label")
        apply_ops(svg, [{"kind": "text", "loc": loc, "lines": ["Hi"]}])
        label = svg.root.find(".//*[@id='label']")
        assert label is not None and label.text == "Hi"
        apply_ops(svg, [{"kind": "text", "loc": loc, "lines": ["One", "Two"]}])
        spans = list(label)
        assert [s.text for s in spans] == ["One", "Two"]
        assert spans[1].get("dy") == "1.2em"

    def test_text_keeps_inkscape_line_spacing(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg"><text>'
            + '<tspan x="5" y="10" style="font-weight:bold">a</tspan>'
            + '<tspan x="5" y="40">b</tspan></text></svg>'
        )
        apply_ops(svg, [{"kind": "text", "loc": "0:0", "lines": ["1", "2", "3"]}])
        spans = list(svg.root[0])
        assert [s.get("y") for s in spans] == ["10", "40", "70"]
        assert all(s.get("style") == "font-weight:bold" for s in spans)

    def test_batch_resolves_targets_before_deleting(self) -> None:
        svg = _svg()
        box, label = _loc(svg, "box"), _loc(svg, "label")
        apply_ops(
            svg,
            [
                {"kind": "delete", "loc": box},
                {"kind": "attrs", "loc": label, "set": {"x": "1"}},
            ],
        )
        assert svg.root.find(".//*[@id='box']") is None
        el = svg.root.find(".//*[@id='label']")
        assert el is not None and el.get("x") == "1"

    def test_duplicate_gets_fresh_ids_and_offset(self) -> None:
        svg = _svg()
        result = apply_ops(
            svg,
            [
                {
                    "kind": "duplicate",
                    "loc": _loc(svg, "grp"),
                    "offset": [10, 5],
                    "key": "d",
                }
            ],
        )
        new_id = result.ids["d"]
        assert new_id == "grp-2"
        clone = svg.root.find(f".//*[@id='{new_id}']")
        assert clone is not None
        assert clone.get("transform") == "translate(10,5) rotate(10)"
        assert svg.root.find(".//*[@id='dot-2']") is not None
        assert result.structural

    def test_a_copy_dragged_off_lands_where_it_was_dropped(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg"'
            + ' xmlns:inkflow="urn:inkflow">'
            + '<rect id="a" x="0" y="0" width="10" height="10"/>'
            + '<rect id="b" x="50" y="0" width="10" height="10"/>'
            + '<path id="arrow" d="M10 5L50 5" inkflow:connector="straight"'
            + ' inkflow:connect-start="a:right" inkflow:connect-end="b:left"/>'
            + '<text id="t" x="0" y="40"><tspan x="0" y="40">hi</tspan></text>'
            + "</svg>"
        )
        a, arrow, t = _loc(svg, "a"), _loc(svg, "arrow"), _loc(svg, "t")
        span = t + ".0"
        result = apply_ops(
            svg,
            [
                {"kind": "duplicate", "loc": a, "key": "c0", "set": {"y": "100"}},
                {
                    "kind": "duplicate",
                    "loc": arrow,
                    "key": "c1",
                    "set": {"d": "M10 105L50 105", "inkflow:connect-end": None},
                },
                {
                    "kind": "duplicate",
                    "loc": t,
                    "key": "c2",
                    "set": {"y": "140"},
                    "kids": [{"loc": span, "set": {"y": "140"}}],
                },
            ],
        )
        root = svg.root
        orig = root.find(".//*[@id='a']")
        copy_a = root.find(f".//*[@id='{result.ids['c0']}']")
        assert orig is not None and orig.get("y") == "0"
        assert copy_a is not None and copy_a.get("y") == "100"
        out = svg.to_bytes().decode()
        # The copied arrow follows the copied box, and lets go of the other.
        new_arrow = root.find(f".//*[@id='{result.ids['c1']}']")
        assert new_arrow is not None
        ink = "{urn:inkflow}"
        assert new_arrow.get(f"{ink}connect-start") == f"{result.ids['c0']}:right"
        assert new_arrow.get(f"{ink}connect-end") is None
        assert 'inkflow:connect-start="a:right"' in out  # the original keeps it
        copy_t = root.find(f".//*[@id='{result.ids['c2']}']")
        assert copy_t is not None and copy_t[0].get("y") == "140"
        t_el = root.find(".//*[@id='t']")
        assert t_el is not None and t_el[0].get("y") == "40"

    def test_insert_assigns_a_unique_id_and_sanitises(self) -> None:
        svg = _svg()
        result = apply_ops(
            svg,
            [
                {
                    "kind": "insert",
                    "parent": "0:",
                    "xml": '<rect id="box" onclick="x()" width="1"/>',
                    "key": "n",
                }
            ],
        )
        assert result.ids["n"] == "box-2"
        new = svg.root.find(".//*[@id='box-2']")
        assert new is not None and new.get("onclick") is None

    def test_insert_renames_nested_ids(self) -> None:
        svg = _svg()
        apply_ops(
            svg,
            [
                {
                    "kind": "insert",
                    "parent": "0:",
                    "xml": '<g id="grp"><circle id="dot" r="1"/></g>',
                }
            ],
        )
        assert svg.root.find(".//*[@id='grp-2']") is not None
        assert svg.root.find(".//*[@id='dot-2']") is not None

    def test_insert_refuses_scripts(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(
                svg,
                [
                    {
                        "kind": "insert",
                        "parent": "0:",
                        "xml": "<script>alert(1)</script>",
                    }
                ],
            )

    def test_insert_into_layer(self) -> None:
        svg = _svg()
        apply_ops(
            svg,
            [
                {
                    "kind": "insert",
                    "parent": _loc(svg, "layer1"),
                    "xml": '<circle id="c" r="2"/>',
                }
            ],
        )
        layer = svg.root.find(".//*[@id='layer1']")
        assert layer is not None and layer[-1].get("id") == "c"

    def test_order_front_and_back(self) -> None:
        svg = _svg()
        apply_ops(svg, [{"kind": "order", "loc": _loc(svg, "box"), "to": "front"}])
        painted = [el.get("id") for el in svg.root if is_element(el)]
        assert painted[-1] == "box"
        apply_ops(svg, [{"kind": "order", "loc": _loc(svg, "box"), "to": "back"}])
        painted = [el.get("id") for el in svg.root if is_element(el)]
        assert painted[0] == "box"

    def test_rename_refuses_a_taken_id(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(svg, [{"kind": "id", "loc": _loc(svg, "box"), "id": "label"}])

    def test_ensure_id_and_marker(self) -> None:
        svg = _svg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')
        result = apply_ops(
            svg,
            [
                {"kind": "ensure-id", "loc": "0:0", "key": "t", "base": "rect"},
                {"kind": "ensure-marker"},
                {"kind": "ensure-marker"},
            ],
        )
        assert result.ids["t"] == "rect"
        markers = svg.root.findall(f".//{{{SVG_NS}}}marker")
        assert len(markers) == 1

    def test_group_and_ungroup(self) -> None:
        svg = _svg()
        group_id = group(svg, [_loc(svg, "box"), _loc(svg, "label")])
        g = svg.root.find(f".//*[@id='{group_id}']")
        assert g is not None and [c.get("id") for c in g] == ["box", "label"]
        ungroup(svg, _loc(svg, "grp"))
        dot = svg.root.find(".//*[@id='dot']")
        assert dot is not None and dot.getparent() is svg.root
        assert dot.get("transform") == "rotate(10)"

    def test_ungroup_keeps_the_group_style(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<g style="fill:#f00;opacity:.5" class="inkflow-stroke-accent" '
            + 'transform="translate(10,0)">'
            + '<rect width="1"/><rect width="2" style="fill:#00f"/></g></svg>'
        )
        ungroup(svg, "0:0")
        first, second = list(svg.root)
        assert first.get("style") == "fill:#f00;opacity:0.5"
        assert first.get("class") == "inkflow-stroke-accent"
        assert first.get("transform") == "translate(10,0)"
        assert second.get("style") == "fill:#00f;opacity:0.5"

    def test_ungroup_refuses_group_effects(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<g clip-path="url(#c)"><rect/></g></svg>'
        )
        with pytest.raises(SvgOpError, match="clip-path"):
            ungroup(svg, "0:0")

    def test_text_with_inline_spans_keeps_all_its_words(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg"><text x="5" y="9">Hello '
            + '<tspan font-weight="bold">world</tspan></text></svg>'
        )
        apply_ops(svg, [{"kind": "text", "loc": "0:0", "lines": ["Hello world!"]}])
        text = svg.root[0]
        assert text.text == "Hello world!" and len(text) == 0

    def test_new_lines_start_under_the_first(self) -> None:
        svg = _svg(
            '<svg xmlns="http://www.w3.org/2000/svg">'
            + '<text x="100" y="200"><tspan>One</tspan></text></svg>'
        )
        apply_ops(svg, [{"kind": "text", "loc": "0:0", "lines": ["One", "Two"]}])
        assert list(svg.root[0])[1].get("x") == "100"

    def test_insert_with_offset(self) -> None:
        svg = _svg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
        apply_ops(
            svg,
            [
                {
                    "kind": "insert",
                    "parent": "0:",
                    "xml": '<rect x="1" y="2"/>',
                    "offset": [24, 24],
                }
            ],
        )
        assert svg.root[0].get("transform") == "translate(24,24)"

    def test_stale_locator_raises(self) -> None:
        svg = _svg()
        with pytest.raises(SvgOpError):
            apply_ops(svg, [{"kind": "attrs", "loc": "0:99", "set": {"x": "1"}}])


# ── Markdown zone spans ──────────────────────────────────────────────────────


class TestZoneSpans:
    def test_auto_extracted_heading_and_body(self) -> None:
        text = "# Title\n\n## Sub\n\nbody\nmore\n"
        spans = zone_spans(text)
        assert {k: text[a:b] for k, (a, b) in spans.items()} == {
            "title": "# Title",
            "subtitle": "## Sub",
            "content": "body\nmore",
        }

    def test_markers_override_auto_content(self) -> None:
        text = "intro\n::title::\nHello\n\n::content align=center::\n- a\n"
        spans = zone_spans(text)
        assert text[slice(*spans["content"])] == "- a"
        assert text[slice(*spans["title"])] == "Hello"

    def test_replace_keeps_other_sections(self) -> None:
        text = "# T\n\nBody\n\n::aside::\nSide\n"
        out = replace_zone_text(text, "aside", "New side")
        assert out == "# T\n\nBody\n\n::aside::\nNew side\n"

    def test_replace_title_keeps_it_a_heading(self) -> None:
        assert (
            replace_zone_text("# T\n\nBody\n", "title", "Fresh") == "# Fresh\n\nBody\n"
        )

    def test_new_zones_are_appended_or_prepended(self) -> None:
        assert replace_zone_text("Body\n", "title", "T") == "# T\n\nBody\n"
        assert replace_zone_text("# T\n", "media", "x") == "# T\n\n::media::\nx\n"
        assert replace_zone_text("", "content", "x") == "x\n"


# ── deck.py edits ─────────────────────────────────────────────────────────────


class TestDeckSource:
    def test_slide_calls_found(self) -> None:
        calls = DeckSource(DECK).slide_calls(expected=3)
        assert calls is not None and len(calls) == 3

    def test_non_literal_slides_are_not_editable(self) -> None:
        code = "def main():\n    return Deck(slides=[Slide(x) for x in 'ab'])\n"
        assert DeckSource(code).slide_calls() is None
        with pytest.raises(DeckEditError):
            DeckSource(code).move_slide(0, 1)

    def test_slides_bound_to_a_name_are_followed(self) -> None:
        code = (
            "SLIDES = [Slide('a'), Slide('b')]\n"
            + "def main():\n    return Deck(slides=SLIDES)\n"
        )
        source = DeckSource(code)
        source.move_slide(1, 0)
        assert "SLIDES = [Slide('b'), Slide('a')]" in source.code

    def test_move_carries_the_comment_above_a_slide(self) -> None:
        source = DeckSource(DECK)
        source.move_slide(0, 2)
        code = source.code
        assert code.index('Slide("two", zones') < code.index("# The drawn slide.")
        assert code.index("# The drawn slide.") < code.index('"drawing.svg"')
        compile(code, "deck.py", "exec")

    def test_insert_remove_and_duplicate(self) -> None:
        source = DeckSource(DECK)
        source.insert_slide(1, 'Slide("new.svg")')
        source.duplicate_slide(2, {"id": '"copy"'})
        source.remove_slide(0)
        calls = source.slide_calls()
        assert calls is not None
        code = source.code
        assert code.count("Slide(") == 4
        assert 'Slide("new.svg"),' in code
        assert 'id="copy"' in code
        compile(code, "deck.py", "exec")

    def test_last_slide_cannot_be_removed(self) -> None:
        source = DeckSource("Deck(slides=[Slide('a')])\n")
        with pytest.raises(DeckEditError):
            source.remove_slide(0)

    def test_set_and_remove_keyword_arguments(self) -> None:
        source = DeckSource(DECK)
        source.set_slide_arg(1, "transition", "transitions.Fade()")
        source.set_slide_arg(0, "notes", None)
        source.set_slide_arg(2, "src", '"other"')
        code = source.code
        assert 'Slide("two", md="text.md", transition=transitions.Fade())' in code
        assert "notes=" not in code
        assert 'Slide("other", zones' in code

    def test_multiline_call_gains_an_argument_on_its_own_line(self) -> None:
        source = DeckSource(DECK)
        source.set_slide_arg(0, "title", '"Drawn"')
        assert '\n                title="Drawn",\n            ),' in source.code

    def test_animation_list_edits(self) -> None:
        source = DeckSource(DECK)
        source.edit_animations(0, insert=(1, 'animations.FadeOut("box")'))
        source.edit_animations(0, move=(1, 0))
        source.edit_animations(0, replace=(1, 'animations.FadeIn("label")'))
        code = source.code
        assert code.index('FadeOut("box")') < code.index('FadeIn("label")')
        source.edit_animations(0, remove=0)
        source.edit_animations(0, remove=0)
        assert "animations=" not in source.code
        source.edit_animations(1, insert=(0, 'animations.FadeIn("x")'))
        assert 'animations=[animations.FadeIn("x")]' in source.code

    def test_zone_edits(self) -> None:
        source = DeckSource(DECK)
        source.set_zone(2, "title", '"Bye"')
        source.set_zone(2, "content", '"More"')
        assert 'zones={"title": "Bye", "content": "More"}' in source.code
        source.set_zone(2, "title", None)
        source.set_zone(2, "content", None)
        assert "zones=" not in source.code
        source.set_zone(1, "media", 'Image("a.png")')
        assert 'zones={"media": Image("a.png")}' in source.code

    def test_ensure_imports_extends_the_inkflow_import(self) -> None:
        source = DeckSource(DECK)
        source.ensure_imports({"Trigger", "transitions", "Deck"})
        first = source.code.splitlines()[0]
        assert (
            first == "from inkflow import Deck, Slide, Trigger, animations, transitions"
        )

    def test_ensure_imports_skips_classes_defined_in_the_deck(self) -> None:
        source = DeckSource("from inkflow import Deck\nclass Flicker:\n    pass\n")
        source.ensure_imports({"Flicker"})
        assert source.code.splitlines()[0] == "from inkflow import Deck"


# ── Code generation ───────────────────────────────────────────────────────────


class TestCodegen:
    def test_defaults_are_left_out(self) -> None:
        code = Code()
        assert code.call(FadeIn("box")) == 'animations.FadeIn("box")'
        assert code.imports == {"animations"}

    def test_values_are_spelled_like_an_author_would(self) -> None:
        code = Code()
        anim = SlideIn(
            "box",
            Trigger.WITH_PREVIOUS,
            direction=Direction.DOWN,
            distance=300,
            easing=Easing.cubic_bezier(0.2, 0, 0.3, 1),
        )
        assert code.call(anim) == (
            'animations.SlideIn("box", Trigger.WITH_PREVIOUS, '
            + "easing=Easing.cubic_bezier(0.2, 0, 0.3, 1), "
            + "direction=Direction.DOWN, distance=300)"
        )
        assert code.imports == {"animations", "Trigger", "Easing", "Direction"}

    def test_pinned_trigger_and_transitions(self) -> None:
        code = Code()
        assert (
            code.call(FadeIn("a", Trigger.at(3)))
            == 'animations.FadeIn("a", Trigger.at(3))'
        )
        assert code.call(Push(direction=Direction.LEFT)) == "transitions.Push()"

    def test_coerce_fields_converts_and_validates(self) -> None:
        fields = coerce_fields(
            SlideIn,
            {
                "direction": "up",
                "distance": "12",
                "trigger": "with-previous",
                "bogus": 1,
            },
        )
        assert fields == {
            "direction": Direction.UP,
            "distance": 12.0,
            "trigger": Trigger.WITH_PREVIOUS,
        }
        with pytest.raises(ValueError):
            coerce_fields(SlideIn, {"trigger": "whenever"})

    def test_field_schema_lists_choices(self) -> None:
        schema = {f["name"]: f for f in field_schema(SlideIn)}
        assert schema["direction"]["kind"] == "enum"
        assert "left" in cast("list[str]", schema["direction"]["choices"])
        assert schema["trigger"]["kind"] == "trigger"
        assert "element" not in schema


# ── Session (end to end on files) ─────────────────────────────────────────────


def build_model_ids(project: Path) -> list[dict[str, object]]:
    return cast(
        "list[dict[str, object]]",
        process_deck(_deck(project), project, project / "deck.py"),
    )


def _hash(path: Path) -> str:
    from inkflow.editor.svgops import file_hash

    return file_hash(path.read_bytes())


class TestSession:
    def test_svg_edit_and_undo_redo(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        svg_path = project / "slides" / "drawing.svg"
        before = svg_path.read_text()
        svg = _svg(before)
        result = session.apply(
            {
                "action": "svg",
                "file": str(svg_path),
                "hash": _hash(svg_path),
                "ops": [{"kind": "attrs", "loc": _loc(svg, "box"), "set": {"x": "7"}}],
            },
            _deck(project),
        )
        assert result["ok"] and result["canUndo"]
        assert 'id="box" x="7"' in svg_path.read_text()
        session.apply({"action": "undo"}, None)
        assert svg_path.read_text() == before
        session.apply({"action": "redo"}, None)
        assert 'id="box" x="7"' in svg_path.read_text()

    def test_stale_hash_is_refused(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        svg_path = project / "slides" / "drawing.svg"
        with pytest.raises(EditError, match="changed on disk"):
            session.apply(
                {"action": "svg", "file": str(svg_path), "hash": "stale", "ops": []},
                _deck(project),
            )

    def test_deck_edits_wait_for_the_rebuild(self, project: Path) -> None:
        from inkflow.editor.svgops import file_hash

        session = EditorSession(project / "deck.py")
        session.built_hash = file_hash((project / "deck.py").read_bytes())
        deck = _deck(project)
        session.apply({"action": "slide", "op": "move", "from": 0, "to": 1}, deck)
        with pytest.raises(EditError, match="since the last build"):
            session.apply({"action": "slide", "op": "move", "from": 0, "to": 1}, deck)

    def test_files_outside_the_project_are_refused(
        self, project: Path, tmp_path_factory: pytest.TempPathFactory
    ) -> None:
        outside = tmp_path_factory.mktemp("out") / "x.svg"
        outside.write_text(DRAWING)
        session = EditorSession(project / "deck.py")
        with pytest.raises(EditError, match="outside the project"):
            session.apply(
                {"action": "svg", "file": str(outside), "ops": []}, _deck(project)
            )

    def test_undo_refuses_after_an_outside_edit(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "notes", "slide": 0, "text": "New notes"}, _deck(project)
        )
        (project / "notes" / "drawing.md").write_text("Edited elsewhere")
        with pytest.raises(EditError, match="changed outside the editor"):
            session.apply({"action": "undo"}, None)

    def test_coalesced_steps_undo_together(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        notes = project / "notes" / "drawing.md"
        for text in ("a", "ab", "abc"):
            session.apply(
                {"action": "notes", "slide": 0, "text": text, "coalesce": "typing"},
                _deck(project),
            )
        assert len(session.history.done) == 1
        session.apply({"action": "undo"}, None)
        assert notes.read_text() == "Speak.\n"

    def test_zone_text_in_markdown(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "zone-text", "slide": 1, "zone": "content", "text": "New body"},
            _deck(project),
        )
        assert (project / "slides" / "text.md").read_text() == "# Title\n\nNew body\n"

    def test_zone_text_moves_into_a_new_markdown_file(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "zone-text", "slide": 2, "zone": "title", "text": "Bye"},
            _deck(project),
        )
        # Named after the slide's id, so slide:<id> links keep working.
        assert (project / "slides" / "two.md").read_text() == "# Bye\n"
        assert 'Slide("two", md="two.md")' in (project / "deck.py").read_text()
        assert [s["id"] for s in build_model_ids(project)] == ["drawing", "text", "two"]

    def test_move_text_to_markdown(self, project: Path) -> None:
        deck_py = project / "deck.py"
        deck_py.write_text(
            deck_py.read_text()
            .replace('md="text.md"', 'md=Inline("Body"), zones={"title": "Hi"}')
            .replace("import Deck, Slide,", "import Deck, Inline, Slide,"),
            encoding="utf-8",
        )
        session = EditorSession(deck_py)
        session.apply({"action": "to-markdown", "slide": 1}, _deck(project))
        code = deck_py.read_text()
        assert 'Slide("two", md="two.md")' in code
        assert (project / "slides" / "two.md").read_text() == "# Hi\n\nBody"
        session.apply({"action": "to-markdown", "slide": 2}, _deck(project))
        assert (project / "slides" / "two-2.md").read_text() == "# Hello\n"
        assert 'Slide("two", md="two-2.md")' in deck_py.read_text()
        ids = [s["id"] for s in build_model_ids(project)]
        assert ids == ["drawing", "two", "two-2"]
        with pytest.raises(EditError, match="no text"):
            session.apply({"action": "to-markdown", "slide": 2}, _deck(project))

    def test_text_box_settings_stay_in_deck(self, project: Path) -> None:
        deck_py = project / "deck.py"
        deck_py.write_text(
            deck_py.read_text()
            .replace(
                'zones={"title": "Hello"}',
                'zones={"title": TextBox("Hello", padding=4)}',
            )
            .replace("import Deck, Slide,", "import Deck, Slide, TextBox,"),
            encoding="utf-8",
        )
        session = EditorSession(deck_py)
        session.apply(
            {"action": "zone-text", "slide": 2, "zone": "title", "text": "Bye"},
            _deck(project),
        )
        assert 'TextBox(text="Bye", padding=4)' in deck_py.read_text()
        assert not (project / "slides" / "two.md").exists()

    def test_a_taken_name_keeps_the_slide_id(self, project: Path) -> None:
        (project / "slides" / "two.md").write_text("Other\n", encoding="utf-8")
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "zone-text", "slide": 2, "zone": "content", "text": "Body"},
            _deck(project),
        )
        code = (project / "deck.py").read_text()
        assert 'md="two-2.md"' in code and 'id="two"' in code
        assert (project / "slides" / "two-2.md").read_text() == "# Hello\n\nBody\n"

    def test_new_notes_file(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "notes", "slide": 1, "text": "Hi", "name": "text"},
            _deck(project),
        )
        assert (project / "notes" / "text.md").read_text() == "Hi"
        assert 'notes="notes/text.md"' in (project / "deck.py").read_text()

    def test_new_slide_like_another_takes_its_layout(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "slide", "op": "new", "after": 0, "layout": "two"},
            _deck(project),
        )
        # Like the slide just made (its own drawing, built on "two").
        session.apply(
            {"action": "slide", "op": "new", "after": 1, "like": 1, "name": "next"},
            _deck(project),
        )
        deck = _deck(project)
        assert deck.slides[2].src == "next.svg"
        assert 'inkflow:parent="two"' in (project / "slides" / "next.svg").read_text()

    def test_slide_lifecycle(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "slide", "op": "new", "after": 0, "layout": "two"},
            _deck(project),
        )
        deck = _deck(project)
        assert len(deck.slides) == 4
        assert deck.slides[1].src == "slide.svg"
        new_svg = project / "slides" / "slide.svg"
        assert 'inkflow:parent="two"' in new_svg.read_text()
        session.apply(
            {"action": "slide", "op": "duplicate", "slide": 0}, _deck(project)
        )
        deck = _deck(project)
        assert deck.slides[1].src == "drawing-copy.svg"
        assert (project / "slides" / "drawing-copy.svg").exists()
        session.apply(
            {"action": "slide", "op": "move", "from": 0, "to": 4}, _deck(project)
        )
        assert _deck(project).slides[4].src == "drawing.svg"
        session.apply(
            {"action": "slide", "op": "hide", "slide": 0, "hidden": True},
            _deck(project),
        )
        assert _deck(project).slides[0].visible is False
        session.apply({"action": "slide", "op": "delete", "slide": 0}, _deck(project))
        assert len(_deck(project).slides) == 4

    def test_detach_rewrites_a_path_src_for_slides(self, project: Path) -> None:
        deck_py = project / "deck.py"
        deck_py.write_text(
            deck_py.read_text().replace(
                'Slide("two", md', 'Slide("layouts/two.svg", md'
            )
        )
        session = EditorSession(deck_py)
        session.apply(
            {"action": "slide", "op": "detach", "slide": 1, "name": "text"},
            _deck(project),
        )
        new = project / "slides" / "text.svg"
        assert 'inkflow:parent="../layouts/two.svg"' in new.read_text()
        # Inkscape shows the layout behind it and the theme's colours.
        assert 'inkflow:layout-src="../layouts/two.svg"' in new.read_text()
        assert '<style id="inkflow-preview">' in new.read_text()
        assert _deck(project).slides[1].src == "text.svg"
        assert sorted(p.name for p in (project / "slides").glob("*.svg")) == [
            "drawing.svg",
            "text.svg",
        ]

    def test_clearing_a_whole_file_zone_is_refused(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        with pytest.raises(EditError, match="whole Markdown file"):
            session.apply(
                {
                    "action": "zone-text",
                    "slide": 1,
                    "zone": "content",
                    "text": "",
                    "origin": "md-file",
                },
                _deck(project),
            )
        assert (project / "slides" / "text.md").read_text() == "# Title\n\nBody\n"

    def test_a_no_op_reorder_is_not_structural(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        svg_path = project / "slides" / "drawing.svg"
        svg = _svg(svg_path.read_text())
        result = session.apply(
            {
                "action": "svg",
                "file": str(svg_path),
                "ops": [{"kind": "order", "loc": _loc(svg, "layer1"), "to": "front"}],
            },
            _deck(project),
        )
        assert result["structural"] is False

    def test_detach_never_shadows_a_layout(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {"action": "slide", "op": "detach", "slide": 2, "name": "two"},
            _deck(project),
        )
        deck = _deck(project)
        assert deck.slides[2].src == "two-slide.svg"
        assert deck.slides[1].src == "two"

    def test_transition_and_animation(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        session.apply(
            {
                "action": "slide",
                "op": "transition",
                "slide": 0,
                "spec": {"type": "Push", "fields": {"direction": "up"}},
            },
            _deck(project),
        )
        code = (project / "deck.py").read_text()
        assert "transition=transitions.Push(direction=Direction.UP)" in code
        assert "Direction" in code.splitlines()[0]
        svg_path = project / "slides" / "drawing.svg"
        svg_path.write_text(svg_path.read_text().replace(' id="dot"', ""))
        svg = _svg(svg_path.read_text())
        grp = svg.root.find(".//*[@id='grp']")
        assert grp is not None
        from inkflow.editor.provenance import child_path

        # The target has no id yet: it gets one in the same step.
        session.apply(
            {
                "action": "anim",
                "slide": 0,
                "op": "insert",
                "index": 1,
                "spec": {
                    "type": "SlideIn",
                    "element": "",
                    "fields": {"trigger": "with-previous"},
                },
                "target": {
                    "file": str(svg_path),
                    "loc": f"0:{child_path(grp[0])}",
                    "base": "circle",
                },
            },
            _deck(project),
        )
        deck = _deck(project)
        assert [type(c).__name__ for c in deck.slides[0].animations] == [
            "FadeIn",
            "SlideIn",
        ]
        assert deck.slides[0].animations[1].element == "circle"
        assert 'id="circle"' in svg_path.read_text()

    def test_rename_updates_animations(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        svg_path = project / "slides" / "drawing.svg"
        svg = _svg(svg_path.read_text())
        session.apply(
            {
                "action": "svg",
                "file": str(svg_path),
                "ops": [
                    {"kind": "id", "loc": _loc(svg, "box"), "id": "hero", "from": "box"}
                ],
            },
            _deck(project),
        )
        assert _deck(project).slides[0].animations[0].element == "hero"

    def test_upload_reuses_identical_files(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        data = base64.b64encode(b"\x89PNG fake").decode()
        first = session.apply(
            {"action": "upload", "name": "My Pic.png", "data": data}, None
        )
        second = session.apply(
            {"action": "upload", "name": "My Pic.png", "data": data}, None
        )
        assert first["rel"] == second["rel"] == "assets/my-pic.png"
        with pytest.raises(EditError):
            session.apply({"action": "upload", "name": "x.exe", "data": data}, None)

    def test_insert_video_adds_zone_and_deck_value(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        (project / "assets").mkdir()
        clip = project / "assets" / "clip.mp4"
        clip.write_bytes(b"fake mp4")
        drawing = project / "slides" / "drawing.svg"
        result = session.apply(
            {
                "action": "insert-video",
                "slide": 0,
                "file": str(drawing),
                "hash": _hash(drawing),
                "src": str(clip),
                "x": 100,
                "y": 120,
                "width": 640,
                "height": 360,
            },
            _deck(project),
        )
        assert result["ids"] == {"new": "zone-video"}
        assert 'id="zone-video" x="100" y="120"' in drawing.read_text()
        slide = _deck(project).slides[0]
        assert slide.zones["video"] == Video("assets/clip.mp4")
        # One step undoes both files.
        session.apply({"action": "undo"}, _deck(project))
        assert "zone-video" not in drawing.read_text()
        assert _deck(project).slides[0].zones == {}

        # A second video gets a fresh zone name, and the build fills it.
        for _ in range(2):
            session.apply(
                {
                    "action": "insert-video",
                    "slide": 0,
                    "file": str(drawing),
                    "hash": _hash(drawing),
                    "src": str(clip),
                    "x": 0,
                    "y": 0,
                    "width": 320,
                    "height": 180,
                },
                _deck(project),
            )
        deck = _deck(project)
        assert set(deck.slides[0].zones) == {"video", "video-2"}
        html = process_deck(deck, project, project / "deck.py")[0]["svg"]
        assert html.count("<video") == 2

    def test_text_box_content_follows_its_zone(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        drawing = project / "slides" / "drawing.svg"

        def box(text: str) -> dict[str, object]:
            return {
                "action": "insert-textbox",
                "slide": 0,
                "file": str(drawing),
                "hash": _hash(drawing),
                "text": text,
                "x": 100,
                "y": 600,
                "width": 800,
                "height": 120,
            }

        result = session.apply(box("Hello **world**"), _deck(project))
        assert result["ids"] == {"new": "zone-text"}
        md = project / "slides" / "drawing.md"
        assert _deck(project).slides[0].zones == {}
        assert md.read_text() == "::text::\nHello **world**\n"
        html = process_deck(_deck(project), project, project / "deck.py")[0]["svg"]
        assert "<strong>world</strong>" in html

        # Duplicating the shape duplicates the text; deleting removes it.
        svg = SvgFile.from_bytes(drawing, drawing.read_bytes())
        loc = _loc(svg, "zone-text")
        session.apply(
            {
                "action": "svg",
                "file": str(drawing),
                "hash": _hash(drawing),
                "zoneSlide": 0,
                "ops": [{"kind": "duplicate", "loc": loc, "key": "d"}],
            },
            _deck(project),
        )
        assert md.read_text() == (
            "::text::\nHello **world**\n\n::text-2::\nHello **world**\n"
        )
        session.apply(
            {
                "action": "svg",
                "file": str(drawing),
                "hash": _hash(drawing),
                "zoneSlide": 0,
                "ops": [{"kind": "delete", "loc": loc}],
            },
            _deck(project),
        )
        assert md.read_text() == "::text-2::\nHello **world**\n"
        assert 'id="zone-text"' not in drawing.read_text()

    def test_text_box_on_a_markdown_slide_writes_the_md_file(
        self, project: Path
    ) -> None:
        deck_py = project / "deck.py"
        deck_py.write_text(
            deck_py.read_text().replace(
                '"drawing.svg",', '"drawing.svg",\n                    md="text.md",'
            )
        )
        session = EditorSession(deck_py)
        drawing = project / "slides" / "drawing.svg"
        md = project / "slides" / "text.md"
        session.apply(
            {
                "action": "insert-textbox",
                "slide": 0,
                "file": str(drawing),
                "hash": _hash(drawing),
                "x": 0,
                "y": 0,
                "width": 400,
                "height": 100,
            },
            _deck(project),
        )
        assert md.read_text() == "# Title\n\nBody\n\n::text::\nText\n"
        # Typing past the frame grows it in the same step.
        svg = SvgFile.from_bytes(drawing, drawing.read_bytes())
        session.apply(
            {
                "action": "zone-text",
                "slide": 0,
                "zone": "text",
                "text": "Line one\n\nLine two",
                "svg": {
                    "file": str(drawing),
                    "hash": _hash(drawing),
                    "ops": [
                        {
                            "kind": "attrs",
                            "loc": _loc(svg, "zone-text"),
                            "set": {"height": "260"},
                        }
                    ],
                },
            },
            _deck(project),
        )
        assert "::text::\nLine one\n\nLine two\n" in md.read_text()
        assert 'height="260"' in drawing.read_text()
        session.apply({"action": "undo"}, _deck(project))
        assert 'height="100"' in drawing.read_text()
        assert md.read_text().endswith("::text::\nText\n")
        svg = SvgFile.from_bytes(drawing, drawing.read_bytes())
        session.apply(
            {
                "action": "svg",
                "file": str(drawing),
                "hash": _hash(drawing),
                "zoneSlide": 0,
                "ops": [{"kind": "delete", "loc": _loc(svg, "zone-text")}],
            },
            _deck(project),
        )
        assert md.read_text() == "# Title\n\nBody\n"

    def test_insert_video_refuses_shared_svg_and_non_video(self, project: Path) -> None:
        session = EditorSession(project / "deck.py")
        layout = project / "layouts" / "two.svg"
        msg: dict[str, object] = {
            "action": "insert-video",
            "slide": 1,
            "file": str(layout),
            "hash": _hash(layout),
            "src": str(project / "clip.mp4"),
            "x": 0,
            "y": 0,
            "width": 10,
            "height": 10,
        }
        with pytest.raises(EditError, match="own SVG"):
            session.apply(msg, _deck(project))
        with pytest.raises(EditError, match="not a video"):
            session.apply({**msg, "src": str(project / "x.png")}, _deck(project))

    def test_zone_media_replace_keeps_the_zone_settings(self, project: Path) -> None:
        deck_py = project / "deck.py"
        deck_py.write_text(
            deck_py.read_text()
            .replace(
                'zones={"title": "Hello"}',
                'zones={"title": "Hello", "content": Video("a.mp4", loop=True,'
                + ' poster="a.png", start=2.0)}',
            )
            .replace("import Deck,", "import Deck, Video,"),
        )
        session = EditorSession(deck_py)
        msg: dict[str, object] = {"action": "zone-media", "slide": 2, "zone": "content"}
        session.apply(
            {**msg, "src": str(project / "b.webm"), "fit": "cover"}, _deck(project)
        )
        assert _deck(project).slides[2].zones["content"] == Video("b.webm", loop=True)
        # Another kind of file starts from that kind's defaults.
        session.apply(
            {**msg, "src": str(project / "c.png"), "fit": "cover"}, _deck(project)
        )
        assert _deck(project).slides[2].zones["content"] == Image(
            "c.png", fit=MediaFit.COVER
        )
        session.apply({**msg, "src": None}, _deck(project))
        assert "content" not in _deck(project).slides[2].zones

    def test_media_props_rewrites_the_zone_value(self, project: Path) -> None:
        deck_py = project / "deck.py"
        deck_py.write_text(
            deck_py.read_text()
            .replace(
                'zones={"title": "Hello"}',
                'zones={"title": "Hello", "content": Video("clip.mp4")}',
            )
            .replace("import Deck,", "import Deck, Video,"),
        )
        session = EditorSession(deck_py)
        session.apply(
            {
                "action": "media-props",
                "slide": 2,
                "zone": "content",
                "fields": {
                    "autoplay": True,
                    "loop": True,
                    "muted": "on",
                    "fit": "cover",
                    "start": 1.5,
                    "end": "",
                    "src": "evil.mp4",
                },
            },
            _deck(project),
        )
        value = _deck(project).slides[2].zones["content"]
        assert value == Video(
            "clip.mp4",
            fit=MediaFit.COVER,
            autoplay=True,
            loop=True,
            muted=Muted.ON,
            start=1.5,
        )
        assert (
            'Video("clip.mp4", fit=MediaFit.COVER, autoplay=True, muted=Muted.ON'
            in (deck_py.read_text())
        )
        schema = {f["name"]: f for f in field_schema(Video)}
        assert schema["muted"]["choices"] == ["auto", "on", "off"]
        assert schema["start"]["optional"] is True
        assert schema["loop"]["optional"] is False
        with pytest.raises(EditError):
            session.apply(
                {"action": "media-props", "slide": 2, "zone": "title", "fields": {}},
                _deck(project),
            )
        with pytest.raises(EditError):
            session.apply(
                {
                    "action": "media-props",
                    "slide": 2,
                    "zone": "content",
                    "fields": {"muted": "loud"},
                },
                _deck(project),
            )


def test_crop_frame_and_uncrop_round_trip() -> None:
    svg = _svg(
        DRAWING.replace(
            '<rect id="box"',
            '<image id="pic" href="a.png" x="10" y="20" width="400" height="200"'
            + ' class="c" transform="translate(5,5)"/>\n  <rect id="box"',
        )
    )
    loc = _loc(svg, "pic")
    result = apply_ops(svg, [{"kind": "crop-frame", "loc": loc}])
    assert result.structural
    frame = svg.root.find(f".//{{{SVG_NS}}}svg[@id='pic']")
    assert frame is not None
    assert dict(frame.attrib) == {
        "id": "pic",
        "x": "15",
        "y": "25",
        "width": "400",
        "height": "200",
        "viewBox": "15 25 400 200",
        "preserveAspectRatio": "none",
        "class": "c",
    }
    image = frame[0]
    assert image.get("x") == "15" and image.get("id") is None
    # Framing twice is a no-op; cropping is attrs on the frame.
    assert not apply_ops(svg, [{"kind": "crop-frame", "loc": loc}]).structural
    apply_ops(
        svg,
        [
            {
                "kind": "attrs",
                "loc": loc,
                "set": {"x": "115", "width": "300", "viewBox": "115 25 300 200"},
            }
        ],
    )
    apply_ops(svg, [{"kind": "title", "loc": loc, "text": "Alt"}])
    apply_ops(svg, [{"kind": "uncrop", "loc": loc}])
    image = svg.root.find(f".//{{{SVG_NS}}}image[@id='pic']")
    assert image is not None
    assert image[0].text == "Alt"
    assert (image.get("x"), image.get("width")) == ("15", "400")
    assert image.get("class") == "c"
    with pytest.raises(SvgOpError):
        apply_ops(svg, [{"kind": "crop-frame", "loc": _loc(svg, "box")}])


def test_title_op_sets_and_clears_alt_text() -> None:
    svg = _svg()
    loc = _loc(svg, "box")
    apply_ops(svg, [{"kind": "title", "loc": loc, "text": "A blue box"}])
    box = svg.root.find(f".//{{{SVG_NS}}}rect[@id='box']")
    assert box is not None and box[0].text == "A blue box"
    apply_ops(svg, [{"kind": "title", "loc": loc, "text": " "}])
    assert len(box) == 0
    with pytest.raises(SvgOpError):
        apply_ops(
            svg,
            [{"kind": "attrs", "loc": loc, "set": {"href": "javascript:alert(1)"}}],
        )


def test_lock_op_writes_inkflow_locked_and_stamps_it() -> None:
    from inkflow.editor.provenance import INK_LOCKED, INK_TOP, stamper

    svg = _svg()
    loc = _loc(svg, "box")
    apply_ops(svg, [{"kind": "lock", "loc": loc, "locked": True}])
    data = svg.to_bytes().decode()
    assert 'xmlns:inkflow="urn:inkflow"' in data
    assert (
        '<rect id="box" x="100" y="100" width="200" height="100" '
        + 'inkflow:locked="true"/>'
        in data
    )
    root = parse_svg(data)
    stamper(0)(root)
    box = root.find(f".//{{{SVG_NS}}}rect[@id='box']")
    assert box is not None and box.get(INK_LOCKED) == "" and box.get(INK_TOP) == ""
    apply_ops(svg, [{"kind": "lock", "loc": loc, "locked": False}])
    assert "locked" not in svg.to_bytes().decode()


def test_theme_panel_writes_a_styles_block_and_deck_args(project: Path) -> None:
    styles = project / "styles.css"
    styles.write_text("/* mine */\n.x { color: red; }\n", encoding="utf-8")
    session = EditorSession(project / "deck.py")
    info = cast(
        "dict[str, object]",
        session.apply({"action": "theme-get"}, _deck(project))["theme"],
    )
    assert info["name"] == "inkflow" and info["mode"] == "dark"
    values = cast("dict[str, dict[str, str]]", info["values"])
    assert values["dark"]["accent"].startswith("#")
    session.apply(
        {
            "action": "theme-set",
            "changes": {
                "dark": {"accent": "#ff8800"},
                "light": {"accent": "#cc5500"},
                "typography": {"body_font": "Inter, sans-serif"},
            },
            "mode": "light",
            "fontSize": 40,
        },
        _deck(project),
    )
    css = styles.read_text()
    assert css.startswith("/* mine */\n.x { color: red; }\n\n/* inkflow:theme")
    assert "--inkflow-accent: #ff8800;" in css
    assert ':root[data-theme="light"] {\n    --inkflow-accent: #cc5500;' in css
    assert "--inkflow-body-font: Inter, sans-serif;" in css
    deck = _deck(project)
    assert deck.mode == ColorMode.LIGHT and deck.font_size == 40
    info = cast(
        "dict[str, object]", session.apply({"action": "theme-get"}, deck)["theme"]
    )
    assert info["overrides"] == {
        "dark": {"accent": "#ff8800"},
        "light": {"accent": "#cc5500"},
        "typography": {"body_font": "Inter, sans-serif"},
    }
    # Resetting every token removes the block; invalid values are refused.
    session.apply(
        {
            "action": "theme-set",
            "changes": {
                "dark": {"accent": None},
                "light": {"accent": None},
                "typography": {"body_font": None},
            },
            "mode": None,
            "fontSize": None,
        },
        deck,
    )
    assert styles.read_text() == "/* mine */\n.x { color: red; }\n\n"
    assert _deck(project).mode is None
    with pytest.raises(EditError, match="not a valid value"):
        session.apply(
            {"action": "theme-set", "changes": {"dark": {"accent": "red; } body {"}}},
            _deck(project),
        )


def test_link_op_wraps_unwraps_and_stays_transparent(project: Path) -> None:
    from inkflow.editor.provenance import INK_TOP, stamper

    svg = _svg()
    loc = _loc(svg, "box")
    apply_ops(svg, [{"kind": "link", "loc": loc, "href": "https://example.com"}])
    a = svg.root.find(f"{{{SVG_NS}}}a")
    assert a is not None and a.get("href") == "https://example.com"
    assert a[0].get("id") == "box"
    # The object inside is the selectable one, and keeps its link when moved
    # in the stacking order or deleted.
    root = parse_svg(svg.to_bytes().decode())
    stamper(0)(root)
    stamped = root.find(f"{{{SVG_NS}}}a")
    assert stamped is not None
    assert stamped.get(INK_TOP) is None and stamped[0].get(INK_TOP) == ""
    inner = _loc(svg, "box")
    apply_ops(svg, [{"kind": "link", "loc": inner, "href": "slide:intro"}])
    assert svg.root.find(f"{{{SVG_NS}}}a[@href='slide:intro']") is not None
    with pytest.raises(SvgOpError):
        apply_ops(svg, [{"kind": "link", "loc": inner, "href": "javascript:x"}])
    apply_ops(svg, [{"kind": "link", "loc": inner, "href": None}])
    assert svg.root.find(f"{{{SVG_NS}}}a") is None
    assert svg.root.find(f"{{{SVG_NS}}}rect[@id='box']") is not None
    apply_ops(svg, [{"kind": "link", "loc": _loc(svg, "box"), "href": "#x"}])
    apply_ops(svg, [{"kind": "delete", "loc": _loc(svg, "box")}])
    assert svg.root.find(f"{{{SVG_NS}}}a") is None

    # In the presentation: slide: links jump, web links open a new tab.
    drawing = project / "slides" / "drawing.svg"
    drawing.write_text(
        drawing.read_text()
        .replace('<rect id="box"', '<a href="slide:two"><rect id="box"')
        .replace('height="100"/>', 'height="100"/></a>', 1)
        .replace('<text id="label"', '<a href="https://x.y"><text id="label"')
        .replace("Hello</text>", "Hello</text></a>"),
        encoding="utf-8",
    )
    html = process_deck(_deck(project), project, project / "deck.py")[0]["svg"]
    assert 'data-inkflow-slide="two"' in html and "slide:two" not in html
    assert 'href="https://x.y" target="_blank"' in html


def test_find_and_replace_across_svg_markdown_and_deck(project: Path) -> None:
    deck_py = project / "deck.py"
    deck_py.write_text(
        deck_py.read_text()
        .replace(
            'zones={"title": "Hello"}',
            'title="Hello deck", '
            + 'zones={"title": "Hello", "content": TextBox("hello there")}',
        )
        .replace("import Deck,", "import Deck, TextBox,")
    )
    session = EditorSession(deck_py)
    drawing = project / "slides" / "drawing.svg"
    md = project / "slides" / "text.md"
    md.write_text("# Hello\n\nSay hello.\n", encoding="utf-8")
    files = [str(drawing), str(md), "/etc/passwd"]
    found = cast(
        "list[dict[str, object]]",
        session.apply({"action": "find", "query": "hello", "files": files}, None)[
            "hits"
        ],
    )
    kinds = [(h["kind"], h["match"]) for h in found]
    assert kinds == [
        ("svg", "Hello"),
        ("md", "Hello"),
        ("md", "hello"),
        ("deck", "Hello"),
        ("deck", "Hello"),
        ("deck", "hello"),
    ]
    assert found[0]["id"] == "label" and found[0]["loc"]
    whole = session.apply(
        {"action": "find", "query": "hello", "files": files, "matchCase": True}, None
    )["hits"]
    assert len(cast("list[object]", whole)) == 2
    # Replace one hit, then the rest: each is one undo step.
    session.apply(
        {
            "action": "replace",
            "query": "hello",
            "replacement": "Hi",
            "files": files,
            "only": {"file": str(md), "index": 1},
        },
        _deck(project),
    )
    assert md.read_text() == "# Hello\n\nSay Hi.\n"
    result = session.apply(
        {"action": "replace", "query": "hello", "replacement": "Hi", "files": files},
        _deck(project),
    )
    assert result["replaced"] == 5
    assert "Hi</text>" in drawing.read_text()
    deck = _deck(project)
    assert deck.slides[2].title == "Hi deck"
    assert deck.slides[2].zones["content"] == TextBox("Hi there")
    assert md.read_text() == "# Hi\n\nSay Hi.\n"
    session.apply({"action": "undo"}, deck)
    assert md.read_text() == "# Hello\n\nSay Hi.\n"
    with pytest.raises(EditError):
        session.apply(
            {"action": "find", "query": "(", "regex": True, "files": []}, None
        )


def test_export_builds_and_offers_downloads(project: Path) -> None:
    import zipfile

    from inkflow import server
    from inkflow.cli.present import EXPORTERS

    with pytest.raises(EditError, match="not available"):
        EditorSession(project / "deck.py").apply(
            {"action": "export", "format": "html"}, None
        )
    session = EditorSession(project / "deck.py", EXPORTERS)
    web = session.apply({"action": "export", "format": "html"}, None)
    assert web["rel"] == "build" and (project / "build" / "index.html").is_file()
    single = session.apply(
        {"action": "export", "format": "single", "output": "out/talk"}, None
    )
    assert single["rel"] == "out/talk.html"
    assert "<svg" in (project / "out" / "talk.html").read_text()
    with pytest.raises(EditError):
        session.apply({"action": "export", "format": "html", "output": ".."}, None)

    server._editor["session"] = session  # pyright: ignore[reportPrivateUsage]
    try:
        found = server._export_download(str(web["download"]))  # pyright: ignore[reportPrivateUsage]
        assert found is not None
        name, mime, body = found[0](found[1])
        assert name == "build.zip" and mime == "application/zip"
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            assert "build/index.html" in zf.namelist()
        assert server._export_download("/_export/nope/x.pdf") is None  # pyright: ignore[reportPrivateUsage]
    finally:
        server._editor["session"] = None  # pyright: ignore[reportPrivateUsage]


def test_connector_attrs_and_renames() -> None:
    svg = _svg(
        DRAWING.replace(
            '<rect id="box"',
            '<path id="arrow" d="M0,0 L10,10" inkflow:connector="straight"'
            + ' inkflow:connect-end="box:left" xmlns:inkflow="urn:inkflow"/>'
            + '\n  <rect id="box"',
        )
    )
    arrow = _loc(svg, "arrow")
    apply_ops(
        svg,
        [
            {
                "kind": "attrs",
                "loc": arrow,
                "set": {"inkflow:connect-start": "label:right", "d": "M5,5 L9,9"},
            }
        ],
    )
    apply_ops(
        svg, [{"kind": "id", "loc": _loc(svg, "box"), "id": "card", "from": "box"}]
    )
    data = svg.to_bytes().decode()
    assert 'inkflow:connect-start="label:right"' in data
    assert 'inkflow:connect-end="card:left"' in data
    apply_ops(
        svg, [{"kind": "attrs", "loc": arrow, "set": {"inkflow:connect-end": None}}]
    )
    assert "connect-end" not in svg.to_bytes().decode()


def test_shape_text_turns_a_rectangle_into_a_styled_text_box(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    drawing = project / "slides" / "drawing.svg"
    drawing.write_text(
        drawing.read_text().replace(
            '<rect id="box" x="100" y="100" width="200" height="100"/>',
            '<rect id="box" x="100" y="100" width="200" height="100" rx="10"'
            + ' class="inkflow-fill-surface"/>',
        )
    )
    svg = SvgFile.from_bytes(drawing, drawing.read_bytes())
    result = session.apply(
        {
            "action": "shape-text",
            "slide": 0,
            "file": str(drawing),
            "hash": _hash(drawing),
            "loc": _loc(svg, "box"),
            "text": "Inside **the** box",
        },
        _deck(project),
    )
    assert result["ids"] == {"new": "zone-text"}
    text = drawing.read_text()
    assert 'id="zone-text"' in text and 'inkflow:show-shape="true"' in text
    # A label in a shape: centred both ways.
    assert 'style="--inkflow-align:center;--inkflow-valign:center"' in text
    deck = _deck(project)
    # The animation that targeted the rectangle follows it.
    assert deck.slides[0].animations[0].element == "zone-text"
    assert (project / "slides" / "drawing.md").read_text() == (
        "::text::\nInside **the** box\n"
    )
    html = process_deck(deck, project, project / "deck.py")[0]["svg"]
    assert "background:var(--inkflow-surface)" in html
    assert "<strong>the</strong>" in html
    assert "--inkflow-valign:center" in html  # carried onto the text box
    with pytest.raises(EditError, match="rectangles and ellipses"):
        svg = SvgFile.from_bytes(drawing, drawing.read_bytes())
        session.apply(
            {
                "action": "shape-text",
                "slide": 0,
                "file": str(drawing),
                "hash": _hash(drawing),
                "loc": _loc(svg, "label"),
            },
            _deck(project),
        )


def test_math_preview(project: Path) -> None:
    session = EditorSession(project / "deck.py")
    out = session.apply({"action": "math", "latex": "\\frac{a}{b}"}, None)
    assert str(out["mathml"]).startswith("<math") and "mfrac" in str(out["mathml"])
    assert 'data-latex="\\frac{a}{b}"' in str(out["mathml"])
    with pytest.raises(EditError):
        session.apply({"action": "math", "latex": " "}, None)


def test_open_file_lists_programs_and_launches_only_locally(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from inkflow.edit import App

    def which(binary: str) -> str:
        return f"/usr/bin/{binary}"

    monkeypatch.setattr("inkflow.edit.shutil.which", which)
    launched: list[tuple[Path, App]] = []

    def fake_open(path: Path, app: App) -> str | None:
        launched.append((path, app))
        return None

    monkeypatch.setattr("inkflow.editor.session.open_with", fake_open)
    session = EditorSession(project / "deck.py")
    out = session.apply({"action": "open-apps", "path": "deck.py"}, None)
    apps = cast("list[dict[str, str]]", out["apps"])
    assert apps[0]["id"] == "code" and apps[-1]["id"] == "system"
    svg: dict[str, object] = {"action": "open-apps", "path": "slides/drawing.svg"}
    svg_apps = cast("list[dict[str, str]]", session.apply(svg, None)["apps"])
    assert svg_apps[0]["label"] == "Inkscape"

    request = {"action": "open-file", "path": "slides/drawing.svg", "app": "inkscape"}
    with pytest.raises(EditError, match="this machine"):
        session.apply({**request, "_local": "true"}, None)
    out = session.apply({**request, "_local": True}, None)
    assert out["opened"] == "slides/drawing.svg"
    assert launched[0][0] == (project / "slides" / "drawing.svg").resolve()
    assert launched[0][1].id == "inkscape"
    for path in ("../outside.svg", "slides/missing.svg", "slides/drawing.exe"):
        with pytest.raises(EditError):
            session.apply({**request, "path": path, "_local": True}, None)
    with pytest.raises(EditError, match="no such program"):
        session.apply({**request, "app": "rm", "_local": True}, None)
    assert len(launched) == 1

    # With the deck built, an SVG gets its Inkscape preview refreshed first.
    drawing = project / "slides" / "drawing.svg"
    assert "inkflow-preview" not in drawing.read_text()
    out = session.apply({**request, "_local": True}, _deck(project))
    assert '<style id="inkflow-preview">' in drawing.read_text()
    assert out["label"] == "Refresh Inkscape preview" and len(launched) == 2
    again = session.apply({**request, "_local": True}, _deck(project))
    assert "label" not in again  # already current: nothing written


# ── Model ────────────────────────────────────────────────────────────────────


def test_model_describes_slides_and_types(project: Path) -> None:
    deck = _deck(project)
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    model = build_model(deck, project / "deck.py", slides)
    assert model["deckEditable"] is True
    entries = cast("list[dict[str, object]]", model["slides"])
    assert entries[0]["srcShared"] is False
    assert entries[1]["srcShared"] is True  # a layout used by two slides
    assert entries[1]["zoneText"] == {"title": "# Title", "content": "Body"}
    assert entries[2]["zoneText"] == {"title": "Hello"}
    sources = cast("list[dict[str, object]]", entries[0]["sources"])
    assert sources[0]["role"] == "slide" and sources[0]["writable"] is True
    types = [
        t["type"] for t in cast("list[dict[str, object]]", model["animationTypes"])
    ]
    assert "FadeIn" in types and "PlayVideo" in types
    assert "two" in [
        layout["name"] for layout in cast("list[dict[str, str]]", model["layouts"])
    ]


# ── Context for agents ───────────────────────────────────────────────────────


def test_context_round_trip_and_format(tmp_path: Path) -> None:
    write_context(
        tmp_path,
        {
            "slide": {
                "number": 2,
                "total": 5,
                "id": "intro",
                "title": "Intro",
                "svg": "slides/intro.svg",
                "deckIndex": 1,
            },
            "selection": [
                {
                    "id": "box",
                    "tag": "rect",
                    "file": "slides/intro.svg",
                    "box": {"x": 1, "y": 2, "width": 3, "height": 4},
                },
                {
                    "zone": "title",
                    "id": "zone-title",
                    "tag": "foreignObject",
                    "text": "Hello",
                },
            ],
        },
    )
    assert (tmp_path / ".inkflow" / ".gitignore").read_text() == "*\n"
    data = read_context(tmp_path)
    assert data is not None
    text = format_context(data)
    assert 'slide 2/5 "Intro" (id intro, deck.py slides[1])' in text
    assert "\n  svg slides/intro.svg\nselected:\n" in text
    assert "<rect> #box in slides/intro.svg at (1, 2) size 3x4" in text
    assert "zone 'title' #zone-title" in text
    assert format_context(data, max_age=-1) == ""


def test_context_ignores_malformed_input(tmp_path: Path) -> None:
    write_context(tmp_path, "nope")
    assert read_context(tmp_path) is None
    (tmp_path / ".inkflow").mkdir(exist_ok=True)
    (tmp_path / ".inkflow" / "context.json").write_text("{not json")
    assert read_context(tmp_path) is None
    assert json.loads('{"a": 1}') == {"a": 1}


# ── Agent commands ───────────────────────────────────────────────────────────


class TestAgentCommands:
    def test_context_without_an_editor(self, project: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        result = CliRunner().invoke(main, ["context", "-d", str(project / "deck.py")])
        assert result.exit_code == 1
        assert "inkflow edit" in result.output

    def test_context_prints_the_selection(self, project: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        write_context(project, {"slide": {"number": 1, "total": 3, "id": "drawing"}})
        result = CliRunner().invoke(main, ["context", "-d", str(project / "deck.py")])
        assert result.exit_code == 0
        assert "slide 1/3" in result.output
        raw = CliRunner().invoke(
            main, ["context", "--json", "-d", str(project / "deck.py")]
        )
        assert json.loads(raw.output)["slide"]["id"] == "drawing"

    def test_hook_mode_never_fails(self, tmp_path: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        result = CliRunner().invoke(
            main,
            ["context", "--hook", "-d", str(tmp_path / "missing.py")],
            input='{"prompt": "hi"}',
        )
        assert result.exit_code == 0
        assert result.output == ""

    def test_setup_claude_merges_and_is_idempotent(self, project: Path) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        settings = project / ".claude" / "settings.json"
        settings.parent.mkdir()
        settings.write_text(json.dumps({"permissions": {"allow": ["Bash(ls)"]}}))
        for _ in range(2):
            result = CliRunner().invoke(
                main, ["setup-claude", "-d", str(project / "deck.py")]
            )
            assert result.exit_code == 0, result.output
        data = cast("dict[str, object]", json.loads(settings.read_text()))
        assert data["permissions"] == {"allow": ["Bash(ls)"]}
        text = json.dumps(data["hooks"])
        assert text.count("inkflow context --hook") == 1
        skill = project / ".claude" / "skills" / "inkflow" / "SKILL.md"
        assert skill.read_text().startswith("---\nname: inkflow")

    def test_goto_without_a_server(self) -> None:
        from click.testing import CliRunner

        from inkflow.cli import main

        result = CliRunner().invoke(main, ["goto", "2", "--ws-port", "1"])
        assert result.exit_code == 1
        assert "inkflow edit" in result.output


# ── Copy and paste between decks ──────────────────────────────────────────────


def _second_project(root: Path) -> Path:
    for d in ("slides", "layouts", "notes"):
        (root / d).mkdir(parents=True)
    (root / "slides" / "drawing.svg").write_text(
        "<svg xmlns='http://www.w3.org/2000/svg'/>"
    )
    (root / "deck.py").write_text(
        "from inkflow import Deck, Slide\n\n\ndef main() -> Deck:\n"
        + '    return Deck(slides=[Slide("drawing.svg")])\n'
    )
    return root


class TestTransfer:
    def test_slides_travel_with_their_files(
        self, project: Path, tmp_path_factory: pytest.TempPathFactory
    ) -> None:
        from inkflow.editor.transfer import export_slides

        (project / "assets").mkdir()
        (project / "assets" / "pic.png").write_bytes(b"png")
        md = project / "slides" / "text.md"
        md.write_text("# Title\n\n![pic](../assets/pic.png)\n")
        bundle = export_slides(_deck(project), project / "deck.py", [0, 1])
        files = cast("dict[str, dict[str, str]]", bundle["files"])
        assert {k: v["role"] for k, v in files.items()} == {
            "slides/drawing.svg": "slide",
            "notes/drawing.md": "notes",
            "layouts/two.svg": "layout",
            "slides/text.md": "md",
            "assets/pic.png": "asset",
        }

        target = _second_project(tmp_path_factory.mktemp("b"))
        session = EditorSession(target / "deck.py")
        result = session.apply(
            {
                "action": "paste-slides",
                "after": 0,
                "bundle": json.loads(json.dumps(bundle)),
            },
            _deck(target),
        )
        assert result["pasted"] == 2
        deck = _deck(target)
        # The target's own drawing.svg is kept; the pasted one gets a new name.
        assert [s.src for s in deck.slides] == ["drawing.svg", "drawing-2.svg", "two"]
        assert (target / "layouts" / "two.svg").read_text() == LAYOUT
        assert (target / "assets" / "pic.png").read_bytes() == b"png"
        assert deck.slides[1].animations[0].element == "box"
        process_deck(deck, target, target / "deck.py")
        session.apply({"action": "undo"}, None)
        assert len(_deck(target).slides) == 1
        assert not (target / "slides" / "drawing-2.svg").exists()

    def test_a_clashing_layout_is_renamed_and_its_users_follow(
        self, project: Path, tmp_path_factory: pytest.TempPathFactory
    ) -> None:
        from inkflow.editor.transfer import export_slides

        (project / "slides" / "drawing.svg").write_text(
            DRAWING.replace(
                "<svg ", '<svg xmlns:inkflow="urn:inkflow" inkflow:parent="two" ', 1
            )
        )
        bundle = export_slides(_deck(project), project / "deck.py", [0, 2])
        target = _second_project(tmp_path_factory.mktemp("b"))
        (target / "layouts" / "two.svg").write_text(LAYOUT.replace("1760", "1700"))
        EditorSession(target / "deck.py").apply(
            {"action": "paste-slides", "after": 0, "bundle": bundle}, _deck(target)
        )
        deck = _deck(target)
        assert deck.slides[2].src == "local:two-2"
        assert (
            'inkflow:parent="local:two-2"'
            in (target / "slides" / "drawing-2.svg").read_text()
        )
        assert (target / "layouts" / "two.svg").read_text() != LAYOUT
        process_deck(deck, target, target / "deck.py")

    def test_pasting_into_the_same_deck_duplicates(self, project: Path) -> None:
        from inkflow.editor.transfer import export_slides

        bundle = export_slides(_deck(project), project / "deck.py", [0])
        EditorSession(project / "deck.py").apply(
            {"action": "paste-slides", "after": 2, "bundle": bundle}, _deck(project)
        )
        deck = _deck(project)
        assert deck.slides[3].src == "drawing-2.svg"
        assert deck.slides[3].notes == "notes/drawing-2.md"

    def test_custom_types_are_left_out(self, project: Path) -> None:
        from inkflow.editor.transfer import export_slides

        deck_py = project / "deck.py"
        deck_py.write_text(
            deck_py.read_text().replace(
                'animations=[animations.FadeIn("box")]',
                'animations=[animations.FadeIn("box"), Sparkle("box")]',
            )
            + "\n\nfrom dataclasses import dataclass\n\n\n@dataclass\n"
            + "class Sparkle(animations.Emphasis):\n    pass\n"
        )
        bundle = export_slides(_deck(project), deck_py, [0])
        slides = cast("list[dict[str, object]]", bundle["slides"])
        assert "Sparkle" not in str(slides[0]["code"])
        assert bundle["dropped"] == ['the animation Sparkle("box")']

    @pytest.mark.parametrize(
        "code",
        [
            'Slide(__import__("os").system("x"))',
            'Slide("a", notes=open("x").read())',
            'Slide(f"{x}")',
            'Slide("a", title=(lambda: 1)())',
            'Slide("a", zones={"t": Path("x")})',
            "os.system('x')",
            'Slide("a", animations=[animations.Animation("x")])',
        ],
    )
    def test_pasted_code_must_be_plain_data(self, code: str) -> None:
        from inkflow.editor.transfer import TransferError, check_slide_code

        with pytest.raises(TransferError):
            check_slide_code(code)

    def test_plain_slides_are_accepted(self) -> None:
        from inkflow.editor.transfer import check_slide_code

        check_slide_code(
            'Slide("a.svg", id="x", zones={"m": Image("p.png", fit=MediaFit.COVER)}, '
            + 'animations=[animations.SlideIn("b", Trigger.at(2), distance=-3.5, '
            + "easing=Easing.cubic_bezier(0.2, 0, 0.3, 1))], "
            + "transition=transitions.Push(direction=Direction.LEFT), visible=False)"
        )

    @pytest.mark.parametrize("rel", ["../evil.svg", "/etc/passwd", "slides/../../x"])
    def test_files_cannot_land_outside_the_project(
        self, project: Path, rel: str
    ) -> None:
        bundle: dict[str, object] = {
            "type": "inkflow-slides",
            "version": 1,
            "files": {rel: {"role": "asset", "data": base64.b64encode(b"x").decode()}},
            "slides": [{"code": 'Slide("drawing.svg")', "refs": {}}],
        }
        with pytest.raises(EditError, match="outside the project"):
            EditorSession(project / "deck.py").apply(
                {"action": "paste-slides", "after": 0, "bundle": bundle},
                _deck(project),
            )

    def test_objects_bring_their_images(
        self, project: Path, tmp_path_factory: pytest.TempPathFactory
    ) -> None:
        (project / "assets").mkdir()
        (project / "assets" / "pic.png").write_bytes(b"png")
        source = EditorSession(project / "deck.py")
        files = source.apply(
            {"action": "copy-assets", "refs": ["assets/pic.png", "https://x/y.png"]},
            None,
        )["files"]
        target = _second_project(tmp_path_factory.mktemp("b"))
        (target / "assets").mkdir()
        (target / "assets" / "pic.png").write_bytes(b"other")
        svg_path = target / "slides" / "drawing.svg"
        result = EditorSession(target / "deck.py").apply(
            {
                "action": "paste-objects",
                "file": str(svg_path),
                "fragments": ['<image href="assets/pic.png" width="5" height="5"/>'],
                "files": files,
            },
            _deck(target),
        )
        assert result["ids"] == {"paste0": "image"}
        assert (target / "assets" / "pic-2.png").read_bytes() == b"png"
        assert 'href="../assets/pic-2.png"' in svg_path.read_text()


def test_pick_ports_skips_busy_ones() -> None:
    import socket

    from inkflow.server import pick_ports

    with socket.socket() as busy:
        busy.bind(("localhost", 0))
        busy.listen()
        port = cast("int", busy.getsockname()[1])
        assert pick_ports("localhost", port, 9) == (port, 9)
        http, ws = pick_ports("localhost", port, None)
        assert http == port and ws != port


def test_a_port_taken_on_ipv6_only_is_busy(monkeypatch: pytest.MonkeyPatch) -> None:
    # The servers bind every address of "localhost"; a program on ::1 alone
    # (another inkflow, say) still takes the port.
    import socket

    from inkflow import server

    if not socket.has_ipv6:
        pytest.skip("no IPv6")
    try:
        busy = socket.socket(socket.AF_INET6)
    except OSError:
        pytest.skip("no IPv6")
    with busy:
        try:
            busy.bind(("::1", 0))
        except OSError:
            pytest.skip("no IPv6 loopback")
        busy.listen()
        port = cast("int", busy.getsockname()[1])
        assert not server._port_free("localhost", port)  # pyright: ignore[reportPrivateUsage]
        monkeypatch.setattr(server, "DEFAULT_PORT", port)
        http, ws = server.pick_ports("localhost", None, None)
        assert http != port and ws != port


def test_layout_previews_cover_every_layout(project: Path) -> None:
    from inkflow.editor.previews import layout_previews

    previews = layout_previews(_deck(project), project / "deck.py")
    names = [p["name"] for p in previews]
    # The project's own layout first, then the built-in ones in reading order.
    assert names[0] == "two"
    assert names[1:4] == ["numbered", "title", "content"]
    assert {"three-cols", "comparison", "agenda", "full-media"} <= set(names)
    cover = next(p for p in previews if p["name"] == "cover")
    assert "Slide title" in str(cover["svg"])
    assert [
        z["zone"] for z in cast("list[dict[str, object]]", cover["emptyZones"])
    ] == ["media"]
    assert "inkflow-slide-1" not in str(cover["svg"])
