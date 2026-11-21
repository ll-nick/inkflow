from __future__ import annotations

import textwrap
from pathlib import Path

from inkflow.deck_source import Editability, SlideSource, locate_slides
from inkflow.manifest import Deck, Slide
from inkflow.server import load_deck


def _locate(tmp_path: Path, source: str) -> list[SlideSource]:
    deck_path = tmp_path / "deck.py"
    deck_path.write_text(textwrap.dedent(source), encoding="utf-8")
    return locate_slides(load_deck(deck_path), deck_path)


def _levels(sources: list[SlideSource]) -> list[Editability]:
    return [source.editability for source in sources]


class TestLiteralSlides:
    def test_slides_written_in_the_list_are_literal(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            def main():
                return Deck(
                    slides=[
                        Slide("title.svg"),
                        Slide(
                            "content",
                            md="intro.md",
                        ),
                    ]
                )
            """,
        )

        assert _levels(sources) == [Editability.LITERAL, Editability.LITERAL]
        assert all(source.reason is None for source in sources)
        element = sources[1].element
        assert element is not None
        assert (element.line, element.end_line) == (7, 10)

    def test_qualified_slide_call_is_literal(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            import inkflow

            def main():
                return inkflow.Deck(slides=[inkflow.Slide("a")])
            """,
        )

        assert _levels(sources) == [Editability.LITERAL]

    def test_list_bound_to_a_name_once_is_followed(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            SLIDES = [Slide("a"), Slide("b")]

            def main():
                return Deck(SLIDES)
            """,
        )

        assert _levels(sources) == [Editability.LITERAL, Editability.LITERAL]

    def test_empty_deck_has_no_slides_to_locate(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck

            def main():
                return Deck()
            """,
        )

        assert sources == []


class TestComputedElements:
    def test_helper_call_and_variable_are_opaque(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            def section(name):
                return Slide("section", title=name)

            END = Slide("end")

            def main():
                return Deck(slides=[Slide("a"), section("Q&A"), END])
            """,
        )

        assert _levels(sources) == [
            Editability.LITERAL,
            Editability.OPAQUE,
            Editability.OPAQUE,
        ]
        assert sources[1].reason == 'written as `section("Q&A")` at line 9'
        assert sources[2].reason == "written as `END` at line 9"

    def test_spread_slides_form_one_block(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            def main():
                return Deck(
                    slides=[
                        Slide("a"),
                        *[Slide(name) for name in ("b", "c")],
                        Slide("d"),
                    ]
                )
            """,
        )

        assert _levels(sources) == [
            Editability.LITERAL,
            Editability.BLOCK,
            Editability.BLOCK,
            Editability.LITERAL,
        ]
        assert sources[1].element == sources[2].element
        assert sources[1].reason is not None
        assert sources[1].reason.startswith("one of 2 slides from `*[Slide(name)")

    def test_empty_spread_between_literals(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            def main():
                return Deck(slides=[Slide("a"), *[], Slide("b")])
            """,
        )

        assert _levels(sources) == [Editability.LITERAL, Editability.LITERAL]

    def test_adjacent_spreads_are_ambiguous_but_literals_stay(
        self, tmp_path: Path
    ) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            def main():
                return Deck(
                    slides=[
                        Slide("a"),
                        *[Slide("b")],
                        *[Slide("c")],
                        Slide("d"),
                    ]
                )
            """,
        )

        assert _levels(sources) == [
            Editability.LITERAL,
            Editability.NONE,
            Editability.NONE,
            Editability.LITERAL,
        ]


class TestUnmatchable:
    def test_computed_list_makes_every_slide_uneditable(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            def main():
                return Deck(slides=[Slide(name) for name in ("a", "b")])
            """,
        )

        assert _levels(sources) == [Editability.NONE, Editability.NONE]
        assert sources[0].reason is not None
        assert sources[0].reason.startswith("slides= is computed (`[Slide(name)")

    def test_list_mutated_after_construction(self, tmp_path: Path) -> None:
        sources = _locate(
            tmp_path,
            """\
            from inkflow import Deck, Slide

            SLIDES = [Slide("a")]
            SLIDES.append(Slide("b"))

            def main():
                return Deck(slides=SLIDES)
            """,
        )

        assert _levels(sources) == [Editability.NONE, Editability.NONE]

    def test_deck_built_outside_deck_py(self, tmp_path: Path) -> None:
        deck_path = tmp_path / "deck.py"
        deck_path.write_text("", encoding="utf-8")
        deck = Deck(slides=[Slide("a")])

        sources = locate_slides(deck, deck_path)

        assert _levels(sources) == [Editability.NONE]
        assert sources[0].reason == "the Deck(...) is not constructed in deck.py"

    def test_source_edited_since_loading(self, tmp_path: Path) -> None:
        deck_path = tmp_path / "deck.py"
        deck_path.write_text(
            "from inkflow import Deck, Slide\n\n"
            + "def main():\n    return Deck(slides=[Slide('a')])\n",
            encoding="utf-8",
        )
        deck = load_deck(deck_path)
        deck_path.write_text(
            "from inkflow import Deck, Slide\n\n\n"
            + "def main():\n    return Deck(slides=[Slide('a')])\n",
            encoding="utf-8",
        )

        sources = locate_slides(deck, deck_path)

        assert _levels(sources) == [Editability.NONE]
        assert sources[0].reason == "deck.py changed since the deck was loaded"
