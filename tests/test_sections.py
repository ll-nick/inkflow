"""Sections: named groups of consecutive slides, written as ``Section(...)``
entries in ``Deck(slides=[...])`` and edited through the session's ``slide``
action as one undoable step each."""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from inkflow import Deck, Section, Slide
from inkflow.editor.deckedit import (
    DeckEditError,
    DeckSource,
    Group,
    add_section,
    move_in_groups,
    move_section,
    remove_section,
)
from inkflow.editor.model import build_model
from inkflow.editor.outline import build_outline, format_outline, outline_json
from inkflow.editor.session import EditError, EditorSession
from inkflow.pipeline import process_deck
from inkflow.server import load_deck

# ── The DSL ───────────────────────────────────────────────────────────────────


class TestDeck:
    def test_sections_flatten_into_the_slide_list(self) -> None:
        a, b, c, d = (Slide(x) for x in "abcd")
        deck = Deck(
            slides=[
                a,
                Section("Method", slides=[b, c]),
                Section("Empty"),
                Section("End", [d]),
            ]
        )
        assert deck.slides == [a, b, c, d]
        assert [s.name for s in deck.sections] == ["Method", "Empty", "End"]
        assert deck.section_ranges() == [range(1, 3), range(3, 3), range(3, 4)]
        assert [deck.section_of(i) for i in range(4)] == [None, 0, 0, 2]

    def test_a_deck_without_sections_is_unchanged(self) -> None:
        deck = Deck(slides=[Slide("a")])
        assert deck.sections == [] and deck.section_ranges() == []
        assert Deck().slides == []
        deck.slides = [Slide("b")]  # assigning a plain list still works
        assert [s.src for s in deck.slides] == ["b"]

    def test_hidden_slides_keep_their_section(self) -> None:
        deck = Deck(slides=[Section("S", slides=[Slide("a", visible=False)])])
        assert deck.section_of(0) == 0

    def test_a_slide_after_a_section_is_refused(self) -> None:
        with pytest.raises(ValueError, match="belongs in one"):
            Deck(slides=[Section("A", slides=[Slide("a")]), Slide("b")])

    def test_names_are_required_but_may_repeat(self) -> None:
        with pytest.raises(ValueError, match="needs a name"):
            Section("  ")
        deck = Deck(slides=[Section("Part"), Section("Part")])
        assert len(deck.sections) == 2

    def test_sections_do_not_nest(self) -> None:
        with pytest.raises(TypeError, match="do not nest"):
            Section("A", slides=[Section("B")])  # pyright: ignore[reportArgumentType]

    def test_only_slides_and_sections(self) -> None:
        with pytest.raises(TypeError, match="Slide and Section"):
            Deck(slides=["a"])  # pyright: ignore[reportArgumentType]


# ── Group arithmetic ──────────────────────────────────────────────────────────


def _groups() -> list[Group]:
    """Slides 0-1 unsectioned, A = [2, 3], B = [4], C = []."""
    return [
        Group(None, [0, 1]),
        Group("A", [2, 3], 0),
        Group("B", [4], 1),
        Group("C", [], 2),
    ]


def _slides(groups: list[Group]) -> list[list[int | str]]:
    return [g.slides for g in groups]


class TestGroups:
    def test_move_joins_the_section_it_lands_before(self) -> None:
        assert _slides(move_in_groups(_groups(), [0], 2)) == [[1], [2, 0, 3], [4], []]
        # At a boundary: before slide 4, so in B.
        assert _slides(move_in_groups(_groups(), [0], 3)) == [[1], [2, 3], [0, 4], []]
        # Past the end: the last section, even an empty one.
        assert _slides(move_in_groups(_groups(), [0], 9)) == [[1], [2, 3], [4], [0]]

    def test_move_into_a_named_section(self) -> None:
        # The same place, but the end of A rather than the start of B.
        assert _slides(move_in_groups(_groups(), [0], 3, 0)) == [
            [1],
            [2, 3, 0],
            [4],
            [],
        ]
        # Into an empty section; ``to`` is clamped into it.
        assert _slides(move_in_groups(_groups(), [1], 0, 2)) == [[0], [2, 3], [4], [1]]
        # Out of the sections.
        assert _slides(move_in_groups(_groups(), [4], 9, None)) == [
            [0, 1, 4],
            [2, 3],
            [],
            [],
        ]

    def test_move_several_keeps_their_order(self) -> None:
        assert _slides(move_in_groups(_groups(), [4, 0], 2, 0)) == [
            [1],
            [2, 0, 4, 3],
            [],
            [],
        ]

    def test_add_section_splits_where_it_starts(self) -> None:
        out = add_section(_groups(), "New", 3)
        assert [(g.name, g.slides, g.origin) for g in out[1:3]] == [
            ("A", [2], 0),
            ("New", [3], None),
        ]
        assert _slides(add_section(_groups(), "Intro", 0))[:2] == [[], [0, 1]]
        assert add_section(_groups(), "Last", None)[-1].name == "Last"

    def test_remove_section(self) -> None:
        assert _slides(remove_section(_groups(), 1)) == [[0, 1], [2, 3, 4], []]
        assert _slides(remove_section(_groups(), 0)) == [[0, 1, 2, 3], [4], []]
        assert _slides(remove_section(_groups(), 0, with_slides=True)) == [
            [0, 1],
            [4],
            [],
        ]
        with pytest.raises(DeckEditError):
            remove_section(_groups(), 3)

    def test_move_section(self) -> None:
        out = move_section(_groups(), 2, 0)
        assert [g.name for g in out] == [None, "C", "A", "B"]
        assert out[0].slides == [0, 1]  # the unsectioned slides stay first


# ── deck.py edits ─────────────────────────────────────────────────────────────

DECK = textwrap.dedent("""\
    from inkflow import Deck, Section, Slide


    def main() -> Deck:
        return Deck(
            embed_fonts=False,
            slides=[
                # The title.
                Slide("plain", title="Title"),
                Section(
                    "Method",
                    slides=[
                        # How it was done.
                        Slide(
                            "plain",
                            title="Setup",  # the setup
                        ),
                        Slide("plain", title="Data"),
                    ],
                ),
                # Results last.
                Section("Results", slides=[Slide("plain", title="Plots")]),
            ],
        )
""")


class TestDeckSource:
    def test_reads_slides_and_sections(self) -> None:
        source = DeckSource(DECK)
        calls = source.slide_calls(expected=4)
        assert calls is not None and len(calls) == 4
        groups = source.groups()
        assert groups is not None
        assert [(g.name, g.slides) for g in groups] == [
            (None, [0]),
            ("Method", [1, 2]),
            ("Results", [3]),
        ]
        assert source.section_names() == ["Method", "Results"]

    def test_unchanged_layout_writes_the_same_text(self) -> None:
        source = DeckSource(DECK)
        groups = source.groups()
        assert groups is not None
        source.restructure(groups)
        assert source.code == DECK

    def test_moving_a_slide_out_reindents_it_with_its_comments(self) -> None:
        source = DeckSource(DECK)
        source.move_slides([1], 0, None)
        assert source.code == DECK.replace(
            textwrap.indent(
                textwrap.dedent("""\
                    # The title.
                    Slide("plain", title="Title"),
                    Section(
                        "Method",
                        slides=[
                            # How it was done.
                            Slide(
                                "plain",
                                title="Setup",  # the setup
                            ),
                    """),
                " " * 12,
            ),
            textwrap.indent(
                textwrap.dedent("""\
                    # How it was done.
                    Slide(
                        "plain",
                        title="Setup",  # the setup
                    ),
                    # The title.
                    Slide("plain", title="Title"),
                    Section(
                        "Method",
                        slides=[
                    """),
                " " * 12,
            ),
        )
        assert load_deck_text(source.code).section_ranges() == [
            range(2, 3),
            range(3, 4),
        ]

    def test_new_section_is_laid_out_like_the_deck(self) -> None:
        source = DeckSource(DECK)
        groups = source.groups()
        assert groups is not None
        source.restructure(add_section(groups, "Intro", 0))
        assert (
            textwrap.indent(
                textwrap.dedent("""\
                    Section(
                        "Intro",
                        slides=[
                            # The title.
                            Slide("plain", title="Title"),
                        ],
                    ),
                    """),
                " " * 12,
            )
            in source.code
        )
        deck = load_deck_text(source.code)
        assert [s.name for s in deck.sections] == ["Intro", "Method", "Results"]

    def test_rename_move_and_remove(self) -> None:
        source = DeckSource(DECK)
        source.rename_section(1, "Findings")
        assert 'Section("Findings", slides=[Slide("plain", title="Plots")])' in (
            source.code
        )
        groups = source.groups()
        assert groups is not None
        source.restructure(move_section(groups, 1, 0))
        code = source.code
        assert code.index("# Results last.") < code.index('"Method"')
        groups = source.groups()
        assert groups is not None
        source.restructure(remove_section(groups, 1))  # Method
        deck = load_deck_text(source.code)
        assert [s.name for s in deck.sections] == ["Findings"]
        assert [s.title for s in deck.sections[0].slides] == ["Plots", "Setup", "Data"]
        assert "# How it was done." in source.code

    def test_a_one_line_section_that_changes_gets_a_slide_per_line(self) -> None:
        source = DeckSource(DECK)
        source.move_slides([0], 9, 1)
        assert (
            textwrap.indent(
                textwrap.dedent("""\
                    # Results last.
                    Section("Results", slides=[
                        Slide("plain", title="Plots"),
                        # The title.
                        Slide("plain", title="Title"),
                    ]),
                    """),
                " " * 12,
            )
            in source.code
        )
        source = DeckSource(
            source.code.replace('Section("Results", slides=[', 'Section("R", slides=[')
        )
        groups = source.groups()
        assert groups is not None
        rest = [g.with_slides([x for x in g.slides if x != 0]) for g in groups]
        source.restructure([*rest, Group("Later", [0])])
        assert '"Later",\n                slides=[\n                    # How it' in (
            source.code
        )

    def test_insert_and_duplicate_stay_in_the_section(self) -> None:
        source = DeckSource(DECK)
        source.insert_slide(3, 'Slide("plain", title="New")')
        source.duplicate_slide(4, {"title": '"Copy"'})
        deck = load_deck_text(source.code)
        assert [s.title for s in deck.sections[0].slides] == ["Setup", "Data", "New"]
        assert [s.title for s in deck.sections[1].slides] == ["Plots", "Copy"]
        source.replace_slide(1, 'Slide("plain", title="Replaced")')
        assert load_deck_text(source.code).sections[0].slides[0].title == "Replaced"

    def test_section_built_in_code_is_not_editable(self) -> None:
        source = DeckSource(
            DECK.replace('slides=[Slide("plain", title="Plots")]', "slides=more")
        )
        assert source.slide_calls() is None
        assert source.groups() is None


def load_deck_text(code: str) -> Deck:
    namespace: dict[str, object] = {}
    exec(compile(code, "deck.py", "exec"), namespace)
    main = namespace["main"]
    assert callable(main)
    deck = main()
    assert isinstance(deck, Deck)
    return deck


# ── The session: one undoable step each ───────────────────────────────────────

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
    </svg>
""")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "layouts").mkdir()
    (tmp_path / "layouts" / "plain.svg").write_text(LAYOUT, encoding="utf-8")
    (tmp_path / "deck.py").write_text(DECK, encoding="utf-8")
    return tmp_path


def _apply(project: Path, request: dict[str, object]) -> dict[str, object]:
    session = EditorSession(project / "deck.py")
    deck = load_deck(project / "deck.py")
    result = session.apply({"action": "slide", **request}, deck)
    _SESSIONS[project] = session
    return result


_SESSIONS: dict[Path, EditorSession] = {}


def _layout(project: Path) -> list[tuple[str | None, list[str | None]]]:
    deck = load_deck(project / "deck.py")
    out: list[tuple[str | None, list[str | None]]] = []
    ranges = deck.section_ranges()
    first = ranges[0].start if ranges else len(deck.slides)
    out.append((None, [s.title for s in deck.slides[:first]]))
    for section, span in zip(deck.sections, ranges, strict=True):
        out.append((section.name, [deck.slides[i].title for i in span]))
    return out


_Layout = list[tuple[str | None, list[str | None]]]
_CASES: list[tuple[dict[str, object], str, _Layout]] = [
    (
        {"op": "section-add", "slide": 2, "name": " Data  set "},
        "Add section Data set",
        [
            (None, ["Title"]),
            ("Method", ["Setup"]),
            ("Data set", ["Data"]),
            ("Results", ["Plots"]),
        ],
    ),
    (
        {"op": "section-rename", "section": 0, "name": "How"},
        "Rename section",
        [(None, ["Title"]), ("How", ["Setup", "Data"]), ("Results", ["Plots"])],
    ),
    (
        {"op": "section-remove", "section": 1},
        "Remove section",
        [(None, ["Title"]), ("Method", ["Setup", "Data", "Plots"])],
    ),
    (
        {"op": "section-remove", "section": 0, "slides": True},
        "Remove section and its slides",
        [(None, ["Title"]), ("Results", ["Plots"])],
    ),
    (
        {"op": "section-move", "section": 1, "to": 0},
        "Move section",
        [(None, ["Title"]), ("Results", ["Plots"]), ("Method", ["Setup", "Data"])],
    ),
    (
        {"op": "move", "from": 3, "to": 1, "section": 0},
        "Move slide",
        [
            (None, ["Title"]),
            ("Method", ["Plots", "Setup", "Data"]),
            ("Results", []),
        ],
    ),
    (
        {"op": "move", "slides": [0, 3], "to": 2, "section": None},
        "Move slides",
        [
            (None, ["Title", "Plots"]),
            ("Method", ["Setup", "Data"]),
            ("Results", []),
        ],
    ),
    (
        {"op": "move", "from": 0, "to": 2},
        "Move slide",
        [
            (None, []),
            ("Method", ["Setup", "Data"]),
            ("Results", ["Title", "Plots"]),
        ],
    ),
]


@pytest.mark.parametrize(("request_", "label", "expected"), _CASES)
def test_each_section_edit_is_one_undoable_step(
    project: Path,
    request_: dict[str, object],
    label: str,
    expected: list[tuple[str | None, list[str | None]]],
) -> None:
    result = _apply(project, request_)
    assert result["ok"] and result["label"] == label
    assert _layout(project) == expected
    session = _SESSIONS[project]
    assert len(session.history.done) == 1
    session.apply({"action": "undo"}, None)
    assert (project / "deck.py").read_text(encoding="utf-8") == DECK


def test_section_edits_are_refused_cleanly(project: Path) -> None:
    with pytest.raises(EditError, match="no such section"):
        _apply(project, {"op": "section-rename", "section": 5, "name": "x"})
    with pytest.raises(EditError, match="needs a name"):
        _apply(project, {"op": "section-add", "slide": 0, "name": "  "})
    with pytest.raises(EditError, match="no such slide"):
        _apply(project, {"op": "section-add", "slide": 9, "name": "x"})
    (project / "deck.py").write_text(
        DECK.replace('Slide("plain", title="Title"),\n', ""), encoding="utf-8"
    )
    with pytest.raises(EditError, match="at least one slide"):
        _apply(project, {"op": "section-remove", "section": 0, "slides": True})
        _apply(project, {"op": "section-remove", "section": 0, "slides": True})


def test_the_editor_follows_its_slide_through_a_move(project: Path) -> None:
    # The editor shows "Setup" (1); moving Results first puts it at 2.
    result = _apply(project, {"op": "section-move", "section": 1, "to": 0, "follow": 1})
    assert result["select"] == 2
    # A moved slide is followed too (here: the one moved).
    result = _apply(project, {"op": "move", "from": 0, "to": 3, "section": 1})
    assert result["select"] == 3


def test_an_agent_step_is_labelled_as_such(project: Path) -> None:
    result = _apply(
        project,
        {"op": "section-add", "name": "Appendix", "agent": "Add section Appendix"},
    )
    assert result["label"] == "Agent: Add section Appendix"
    assert _layout(project)[-1] == ("Appendix", [])


# ── What the editor, the presenter and agents see ─────────────────────────────


def test_model_presenter_data_and_outline_carry_the_sections(project: Path) -> None:
    deck = load_deck(project / "deck.py")
    deck.slides[1].visible = False  # hidden: still in the section
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    model = build_model(deck, project / "deck.py", slides)
    assert model["sections"] == [
        {"name": "Method", "start": 1, "count": 2},
        {"name": "Results", "start": 3, "count": 1},
    ]
    assert "section" not in slides[0]
    assert slides[1].get("section") == {"name": "Method", "index": 0}
    assert slides[2].get("section") == {"name": "Results", "index": 1}

    outline = build_outline(deck, project / "deck.py", slides)
    assert [s.section for s in outline.slides] == [None, 0, 0, 1]
    text = format_outline(outline)
    assert "\n## Method  (2 slides)\n\n-. " in text
    assert text.index("## Results  (1 slide)") > text.index("## Method")
    data = outline_json(outline)
    assert data["sections"] == [
        {"name": "Method", "index": 1, "count": 2},
        {"name": "Results", "index": 3, "count": 1},
    ]
