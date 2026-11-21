# pyright: reportPrivateUsage=none
from __future__ import annotations

import copy
import pickle
import textwrap
from dataclasses import dataclass, fields
from pathlib import Path
from typing import cast

from inkflow import Slide, transitions
from inkflow.animations import Enter, FadeIn
from inkflow.manifest import Deck, Image, TextBox
from inkflow.overlay import Overlay
from inkflow.pipeline import _serialize_transition, _set_fields
from inkflow.provenance import SourceLocation, source_location


def _run_deck_source(source: str, path: Path) -> dict[str, object]:
    """Execute ``source`` as if it were the file at ``path``."""
    path.write_text(textwrap.dedent(source), encoding="utf-8")
    namespace: dict[str, object] = {}
    exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), namespace)
    return namespace


def _location(obj: object) -> SourceLocation:
    location = source_location(obj)
    assert location is not None
    return location


class TestCallSite:
    def test_records_the_full_span_of_a_multiline_call(self, tmp_path: Path) -> None:
        deck_file = tmp_path / "deck.py"
        namespace = _run_deck_source(
            """\
            from inkflow import Slide

            SLIDES = [
                Slide("title.svg"),
                Slide(
                    "content",
                    md="intro.md",
                ),
            ]
            """,
            deck_file,
        )
        title, content = cast("list[Slide]", namespace["SLIDES"])

        assert _location(title) == SourceLocation(
            path=deck_file, line=4, column=4, end_line=4, end_column=22
        )
        assert _location(content) == SourceLocation(
            path=deck_file, line=5, column=4, end_line=8, end_column=5
        )

    def test_objects_from_one_call_site_share_its_location(
        self, tmp_path: Path
    ) -> None:
        namespace = _run_deck_source(
            """\
            from inkflow import Slide

            def chapter(name):
                return Slide(name)

            SLIDES = [chapter(name) for name in ("a", "b")]
            """,
            tmp_path / "deck.py",
        )
        first, second = cast("list[Slide]", namespace["SLIDES"])

        assert _location(first) == _location(second)
        assert _location(first).line == 4

    def test_nested_values_record_their_own_call_site(self, tmp_path: Path) -> None:
        namespace = _run_deck_source(
            """\
            from inkflow import Image, Slide, TextBox, transitions
            from inkflow.animations import FadeIn
            from inkflow.overlay import Overlay

            SLIDE = Slide(
                "content",
                zones={"media": Image("a.png"), "title": TextBox("x")},
                animations=[FadeIn("box")],
                transition=transitions.Push(),
                overlays=[Overlay("footer")],
            )
            """,
            tmp_path / "deck.py",
        )
        slide = cast("Slide", namespace["SLIDE"])

        assert _location(slide.zones["media"]).line == 7
        assert _location(slide.zones["title"]).line == 7
        assert _location(slide.animations[0]).line == 8
        assert _location(slide.transition).line == 9
        assert slide.overlays is not None
        assert _location(slide.overlays[0]).line == 10

    def test_every_dsl_type_is_tracked(self) -> None:
        values: list[object] = [
            Deck(),
            Slide("x"),
            Image("a.png"),
            TextBox(),
            Overlay("footer"),
            FadeIn("box"),
            transitions.Crossfade(),
        ]
        for value in values:
            assert _location(value).path == Path(__file__)


class TestInvisibleToTheDataModel:
    def test_not_a_field_and_not_in_equality_or_repr(self) -> None:
        first, second = Slide("x"), Slide("x")

        assert _location(first) != _location(second)
        assert first == second
        assert repr(first) == "Slide(src='x', id=None, md=None, zones={}, " + (
            "animations=[], transition=None, overlays=None, extra_style=None, "
            + "title=None, notes=None, visible=True, font_size=None)"
        )
        assert "_inkflow_source_location" not in {f.name for f in fields(Slide)}

    def test_copies_and_pickles_keep_the_original_location(self) -> None:
        slide = Slide("x", animations=[FadeIn("box")])
        original = _location(slide)

        assert _location(copy.copy(slide)) == original
        assert _location(copy.deepcopy(slide)) == original
        unpickled = cast("Slide", pickle.loads(pickle.dumps(slide)))
        assert _location(unpickled) == original

    def test_not_serialized_into_transitions_or_cues(self) -> None:
        assert _serialize_transition(transitions.Push()) == {
            "type": "push",
            "duration": 0.5,
            "easing": "ease-in-out",
            "direction": "left",
        }
        assert "_inkflow_source_location" not in _set_fields(FadeIn("box"))

    def test_untracked_object_has_no_location(self) -> None:
        assert source_location(object()) is None


@dataclass
class _NoSuperPostInit(Enter):
    """A user subclass whose ``__post_init__`` skips ``super()``."""

    origin: str = "center"
    """A field name a user might plausibly pick, e.g. for transform-origin."""

    def __post_init__(self) -> None:
        self.origin = self.origin.upper()


class TestUserSubclasses:
    def test_tracked_even_when_post_init_skips_super(self) -> None:
        cue = _NoSuperPostInit("box")

        assert _location(cue).path == Path(__file__)
        assert cue.origin == "CENTER"

    def test_user_field_names_do_not_collide(self) -> None:
        cue = _NoSuperPostInit("box", origin="top")

        assert _set_fields(cue)["origin"] == "TOP"
        assert source_location(cue) is not None


def test_describe_is_relative_inside_the_given_directory(tmp_path: Path) -> None:
    location = SourceLocation(
        path=tmp_path / "deck.py", line=57, column=4, end_line=57, end_column=20
    )

    assert location.describe(tmp_path) == "deck.py:57"
    assert location.describe(tmp_path / "elsewhere") == (
        f"{(tmp_path / 'deck.py').as_posix()}:57"
    )
    assert location.describe() == f"{(tmp_path / 'deck.py').as_posix()}:57"
