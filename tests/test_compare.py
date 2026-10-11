"""editor/compare.py: normalizing builds, pairing slides, element differences."""

from __future__ import annotations

from typing import cast

import pytest

from inkflow.editor.compare import (
    DeckFacts,
    SlideFacts,
    compare_decks,
    comparison_json,
    element_changes,
    format_comparison,
    moved_rows,
    normalize_svg,
    pair_slides,
    parse_transform,
    path_box,
    plain_text,
    strip_editor_attrs,
    what_changed,
)

SVG = "http://www.w3.org/2000/svg"
XHTML = "http://www.w3.org/1999/xhtml"


def slide(
    sid: str,
    index: int,
    *,
    svg: str | None = None,
    raw: str | None = None,
    explicit: bool = False,
    key: str | None = None,
    layout: str = "content",
    notes: str = "",
    files: dict[str, tuple[str, str]] | None = None,
    settings: dict[str, object] | None = None,
) -> SlideFacts:
    return SlideFacts(
        index=index,
        number=index + 1,
        id=sid,
        raw_id=raw or sid,
        explicit=explicit,
        title=sid,
        svg=svg if svg is not None else f"<svg>{sid}</svg>",
        notes=notes,
        settings={"layout": layout, **(settings or {})},
        files=files or {},
        key_file=key,
    )


def deck(*slides: SlideFacts, **settings: object) -> DeckFacts:
    return DeckFacts(list(slides), dict(settings))


def ids(left: DeckFacts, right: DeckFacts) -> list[tuple[str | None, str | None]]:
    return [
        (
            left.slides[i].id if i is not None else None,
            right.slides[j].id if j is not None else None,
        )
        for i, j in pair_slides(left.slides, right.slides)
    ]


# ── Normalization ─────────────────────────────────────────────────────────────


def test_normalize_drops_provenance_stamps_and_position() -> None:
    a = (
        f'<svg xmlns="{SVG}" id="inkflow-slide-3" viewBox="0 0 100 100">'
        + "<style>@scope(#inkflow-slide-3) { rect { fill: red } }</style>"
        + '<rect data-ink="0:1" data-ink-tag="rect" x="1" y="2" width="3" height="4"/>'
        + '<image href="assets/a.png?v=18f3a" width="5" height="5"/>'
        + '<text id="zone-slide-number">3</text><text id="zone-slide-total">12</text>'
        + "</svg>"
    )
    b = (
        a.replace("inkflow-slide-3", "inkflow-slide-7")
        .replace('data-ink="0:1"', 'data-ink="2:5"')
        .replace("?v=18f3a", "")
        .replace(">3<", ">7<")
        .replace(">12<", ">13<")
    )
    assert a != b
    assert normalize_svg(a) == normalize_svg(b)
    assert "data-ink" not in normalize_svg(a)
    # A real difference survives.
    assert normalize_svg(a) != normalize_svg(a.replace('x="1"', 'x="9"'))


def test_strip_editor_attrs_keeps_everything_else() -> None:
    svg = '<svg><rect data-ink="0:1" data-ink-locked="1" data-cues="[]" x="1"/></svg>'
    assert strip_editor_attrs(svg) == '<svg><rect data-cues="[]" x="1"/></svg>'


def test_plain_text_of_notes() -> None:
    assert plain_text("<p>Hello <b>you</b></p><p>Two &amp; three</p>") == (
        "Hello you\nTwo & three"
    )


# ── Pairing ───────────────────────────────────────────────────────────────────


def test_pairs_by_id_and_finds_added_removed() -> None:
    left = deck(slide("a", 0), slide("b", 1), slide("c", 2))
    right = deck(slide("a", 0), slide("c", 1), slide("d", 2, layout="other"))
    assert ids(left, right) == [("a", "a"), ("b", None), ("c", "c"), (None, "d")]
    result = compare_decks(left, right)
    assert [p.status for p in result.pairs] == ["same", "removed", "same", "added"]
    assert not any(p.moved for p in result.pairs)


def test_reordered_slide_is_moved_and_insertion_is_not() -> None:
    left = deck(slide("a", 0), slide("b", 1), slide("c", 2), slide("d", 3))
    right = deck(
        slide("new", 0, layout="x"),
        slide("a", 1),
        slide("c", 2),
        slide("d", 3),
        slide("b", 4),
    )
    result = compare_decks(left, right)
    moved = {right.slides[p.right].id for p in result.pairs if p.moved and p.right}
    assert moved == {"b"}


def test_renamed_id_pairs_by_its_file() -> None:
    left = deck(slide("intro", 0, key="md:slides/intro.md"))
    right = deck(slide("welcome", 0, explicit=True, key="md:slides/intro.md"))
    assert ids(left, right) == [("intro", "welcome")]


def test_numbered_ids_follow_content_not_numbers() -> None:
    # Two slides both inferred as "content": swapping them renumbers the ids,
    # so they pair by what they show.
    one = f'<svg xmlns="{SVG}"><text>one</text></svg>'
    two = f'<svg xmlns="{SVG}"><text>two</text></svg>'
    left = deck(
        slide("content", 0, raw="content", svg=one),
        slide("content-2", 1, raw="content", svg=two),
    )
    right = deck(
        slide("content", 0, raw="content", svg=two),
        slide("content-2", 1, raw="content", svg=one),
    )
    pairs = pair_slides(left.slides, right.slides)
    assert sorted(pairs) == [(0, 1), (1, 0)]
    result = compare_decks(left, right)
    assert all(p.status == "same" for p in result.pairs)
    assert sum(p.moved for p in result.pairs) == 1


def test_duplicated_slide_is_added() -> None:
    left = deck(slide("intro", 0, explicit=True))
    right = deck(
        slide("intro", 0, explicit=True),
        slide("intro-copy", 1, explicit=True),
    )
    result = compare_decks(left, right)
    assert [p.status for p in result.pairs] == ["same", "added"]


def test_unrelated_slides_in_one_place_stay_apart() -> None:
    left = deck(slide("a", 0), slide("old", 1, layout="morph.svg"), slide("z", 2))
    right = deck(slide("a", 0), slide("new", 1, layout="content"), slide("z", 2))
    assert ids(left, right) == [("a", "a"), ("old", None), (None, "new"), ("z", "z")]


def test_related_slides_in_one_place_pair_as_changed() -> None:
    left = deck(slide("a", 0), slide("old", 1, layout="two"), slide("z", 2))
    right = deck(slide("a", 0), slide("new", 1, layout="two"), slide("z", 2))
    assert ids(left, right)[1] == ("old", "new")
    assert compare_decks(left, right).pairs[1].status == "changed"


def test_moved_rows_marks_the_minimum() -> None:
    assert moved_rows([(0, 0), (1, 1), (2, 2)]) == set()
    assert moved_rows([(1, 0), (2, 1), (0, 2)]) == {2}
    assert moved_rows([(0, 0), (None, 1), (1, 2)]) == set()


# ── What changed ──────────────────────────────────────────────────────────────


def test_changed_pair_says_files_notes_and_settings() -> None:
    left = deck(
        slide(
            "a",
            0,
            notes="old words",
            files={"slides/a.md": ("md", "1"), "notes/a.md": ("notes", "x")},
            settings={"transition": {"type": "Cut"}},
        )
    )
    right = deck(
        slide(
            "a",
            0,
            notes="new words",
            files={
                "slides/a.md": ("md", "2"),
                "notes/a.md": ("notes", "y"),
                "data/sales.csv": ("data", "z"),
            },
            settings={"transition": {"type": "Push"}},
        )
    )
    pair = compare_decks(left, right).pairs[0]
    assert pair.status == "changed"
    assert pair.notes and not pair.visual
    assert pair.settings == ["transition"]
    assert {(f.path, f.change) for f in pair.files} == {
        ("slides/a.md", "changed"),
        ("notes/a.md", "changed"),
        ("data/sales.csv", "added"),
    }
    assert what_changed(pair) == [
        "data/sales.csv",
        "slides/a.md",
        "notes",
        "transition",
    ]


def test_deck_settings_and_text_output() -> None:
    left = deck(
        slide("title", 0),
        slide("b", 1, files={"slides/b.md": ("md", "1")}),
        slide("c", 2),
        slide("gone", 3, layout="x"),
        theme="A",
    )
    right = deck(
        slide("title", 0),
        slide("b", 1, files={"slides/b.md": ("md", "2")}),
        slide("new", 2, layout="y"),
        slide("c", 3),
        theme="B",
    )
    result = compare_decks(left, right)
    assert result.deck == ["theme"]
    text = format_comparison(result, left, right, "Working copy", "abc Fix")
    assert text.splitlines() == [
        "Working copy ⟷ abc Fix",
        "! deck: theme",
        "~ 2 b: slides/b.md",
        "+ 3 new",
        "- 4 gone",
        "= 2 unchanged: 1, 4",
    ]
    data = comparison_json(result, left, right)
    assert len(cast("list[object]", data["pairs"])) == 5


def test_moved_and_changed_line() -> None:
    left = deck(slide("a", 0), slide("m", 1, svg="<svg>1</svg>"), slide("b", 2))
    right = deck(slide("a", 0), slide("b", 1), slide("m", 2, svg="<svg>2</svg>"))
    result = compare_decks(left, right, elements=False)
    text = format_comparison(result, left, right, "L", "R")
    assert "↕ 2 → 3 m: look" in text.splitlines()


# ── Elements ──────────────────────────────────────────────────────────────────


def _svg(body: str) -> str:
    return f'<svg xmlns="{SVG}" xmlns:h="{XHTML}" viewBox="0 0 1000 500">{body}</svg>'


def test_element_moved_by_id_has_both_boxes() -> None:
    a = _svg('<rect id="box" x="10" y="20" width="100" height="50"/>')
    b = _svg('<rect id="box" x="40" y="20" width="100" height="50"/>')
    [change] = element_changes(a, b)
    assert change.change == "changed" and change.id == "box"
    assert change.left and change.left.box == (10.0, 20.0, 100.0, 50.0)
    assert change.right and change.right.box == (40.0, 20.0, 100.0, 50.0)
    assert change.right.path == (0,)


def test_group_moved_by_transform() -> None:
    inner = '<rect x="0" y="0" width="10" height="10"/><text x="0" y="20">Hi</text>'
    a = _svg(f'<g id="grp" transform="translate(10,10)">{inner}</g>')
    b = _svg(f'<g id="grp" transform="translate(50,10)">{inner}</g>')
    [change] = element_changes(a, b)
    assert change.id == "grp" and change.change == "changed"
    assert change.right and change.right.box and change.right.box[0] == 50.0


def test_unnamed_group_move_shows_its_shapes() -> None:
    a = _svg('<g transform="translate(0,0)"><circle cx="5" cy="5" r="5"/></g>')
    b = _svg('<g transform="translate(100,0)"><circle cx="5" cy="5" r="5"/></g>')
    [change] = element_changes(a, b)
    assert change.change == "changed" and change.right
    assert change.right.box == (100.0, 0.0, 10.0, 10.0)


def test_inserted_paragraph_is_added_and_the_rest_unchanged() -> None:
    def zone(*paras: str) -> str:
        body = "".join(f"<h:p>{p}</h:p>" for p in paras)
        return _svg(
            '<foreignObject id="zone-content" x="10" y="10" width="500" height="300">'
            + f'<h:div class="inkflow-wrapper">{body}</h:div></foreignObject>'
        )

    changes = element_changes(zone("one", "three"), zone("one", "two", "three"))
    assert [(c.change, c.text) for c in changes] == [("added", "two")]
    added = changes[0].right
    assert added and added.path == (0, 0, 1) and added.tag == "p"
    # Inside a foreignObject the box is the zone's.
    assert added.box == (10.0, 10.0, 500.0, 300.0)
    [edit] = element_changes(zone("one", "two"), zone("one", "2"))
    assert edit.change == "changed" and edit.text == "2"


def test_removed_and_added_named_elements() -> None:
    a = _svg('<rect id="old" width="1" height="1"/>')
    b = _svg('<rect id="new" width="1" height="1"/>')
    kinds = {(c.change, c.id) for c in element_changes(a, b)}
    assert kinds == {("removed", "old"), ("added", "new")}


def test_defs_and_identical_slides_have_no_changes() -> None:
    a = _svg('<defs><linearGradient id="g"/></defs><rect width="1" height="1"/>')
    assert element_changes(a, a) == []


def test_path_box_and_transforms() -> None:
    assert path_box("M10 10 h 20 v 30 Z") == (10.0, 10.0, 20.0, 30.0)
    assert path_box("m0 0 l10 5 l-20 5") == (-10.0, 0.0, 20.0, 10.0)
    m = parse_transform("translate(10 20) scale(2)")
    assert m == (2.0, 0.0, 0.0, 2.0, 10.0, 20.0)
    r = parse_transform("rotate(90 10 10)")
    assert r[4] == pytest.approx(20.0) and r[5] == pytest.approx(0.0)
