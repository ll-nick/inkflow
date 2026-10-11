"""Incremental rebuilds (``inkflow.incremental``): a served deck processes the
slides a change touched and keeps the rest, and what it keeps is never stale.

Every test builds with a `SlideCache` after a change and holds the result to
a full build of the same files (`rebuilt`), then says which slides the cache
processed."""

from __future__ import annotations

import asyncio
import gc
import json
import os
import sys
import textwrap
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from pathlib import Path
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from inkflow import deps, pdf, server
from inkflow.edit import NO_EDIT_COMMANDS
from inkflow.editor.model import ModelCache, build_model
from inkflow.incremental import SlideCache, as_patch, frozen, keys_of, set_keys
from inkflow.layout import builtin_theme_dir
from inkflow.logging import collect_logs, resolve_levels
from inkflow.manifest import Inline, Slide
from inkflow.pipeline import SlideData, process_deck
from inkflow.server import load_deck
from inkflow.tui import LiveUI

LAYOUT = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <style>#zone-title { --inkflow-valign: center; }</style>
      <rect width="1920" height="1080" class="inkflow-fill-bg"/>
      <rect id="zone-title" x="80" y="60" width="1760" height="100"/>
      <rect id="zone-content" x="80" y="200" width="1760" height="780"/>
      <rect id="zone-chart" x="80" y="200" width="800" height="600"/>
      <text id="zone-slide-number" x="1800" y="1040">99</text>
      <text id="zone-slide-total" x="1840" y="1040">99</text>
    </svg>
""")

CHILD = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"
         xmlns:inkflow="urn:inkflow"
         inkflow:parent="two">
      <rect id="accent" x="0" y="0" width="1920" height="8"/>
    </svg>
""")

DRAWING = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <rect id="box" x="100" y="100" width="200" height="100"/>
      <text id="label" x="120" y="160">Hello</text>
    </svg>
""")

FOOTER = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
      <text id="brand" x="80" y="1040">inkflow</text>
    </svg>
""")

DECK = textwrap.dedent("""\
    from inkflow import Chart, Deck, Overlay, Slide


    def main() -> Deck:
        return Deck(
            overlays=[Overlay("footer")],
            slides=[
                Slide("drawing.svg", notes="notes/drawing.md"),
                Slide("two", md="one.md"),
                Slide("child", md="two.md", notes="notes/two.md"),
                Slide(
                    "two",
                    zones={"title": "Sales", "chart": Chart("data/sales.csv")},
                ),
                Slide("two", md="five.md", extra_style="slides/five.css"),
            ],
        )
""")

IDS = ["drawing", "one", "two", "two-2", "five"]

# Lines of the slide list, as the tests move them about.
ONE = '            Slide("two", md="one.md"),'
TWO = '            Slide("child", md="two.md", notes="notes/two.md"),'
NEW = '            Slide("two", md="new.md"),'


class Project:
    """A deck in a folder, and one cache over its builds."""

    def __init__(self, root: Path) -> None:
        self.root: Path = root
        self.deck_path: Path = root / "deck.py"
        self.cache: SlideCache = SlideCache()
        self._clock: int = 1_700_000_000_000_000_000

    def write(self, rel: str, text: str | bytes) -> Path:
        """Write a file with a time of its own, later than any before it (a
        file system's clock would give two quick writes the same one)."""
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(text, bytes):
            _ = path.write_bytes(text)
        else:
            _ = path.write_text(text, encoding="utf-8")
        self._clock += 1_000_000_000
        os.utime(path, ns=(self._clock, self._clock))
        return path

    def edit(self, rel: str, old: str, new: str) -> None:
        text = (self.root / rel).read_text(encoding="utf-8")
        assert old in text
        _ = self.write(rel, text.replace(old, new))

    def full(self) -> list[SlideData]:
        deck = load_deck(self.deck_path)
        return process_deck(deck, self.root, self.deck_path, editor=True)

    def rebuilt(self) -> list[str]:
        """Build with the cache; the ids it processed. The result is what a
        full build of the files as they are gives."""
        deck = load_deck(self.deck_path)
        built = process_deck(
            deck, self.root, self.deck_path, editor=True, cache=self.cache
        )
        assert built == self.full()
        return list(self.cache.processed)


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Project:
    # Files written by a test are milliseconds old: trusted here, where every
    # write is given a time of its own (`Project.write`).
    monkeypatch.setattr(deps, "RACY_NS", 0)
    p = Project(tmp_path)
    _ = p.write("layouts/two.svg", LAYOUT)
    _ = p.write("layouts/child.svg", CHILD)
    _ = p.write("overlays/footer.svg", FOOTER)
    _ = p.write("slides/drawing.svg", DRAWING)
    _ = p.write("slides/one.md", "# One\n\nBody one\n")
    _ = p.write("slides/two.md", "# Two\n\nBody two\n")
    _ = p.write("slides/five.md", "# Five\n\nBody five\n")
    _ = p.write("slides/five.css", "#zone-title { fill: red; }\n")
    _ = p.write("notes/drawing.md", "Speak.\n")
    _ = p.write("notes/two.md", "Second *note*.\n")
    _ = p.write("data/sales.csv", "year,revenue\n2023,10\n2024,14\n")
    _ = p.write("styles.css", ":root { --x: 1; }\n")
    _ = p.write("deck.py", DECK)
    assert p.rebuilt() == IDS
    return p


def _nowhere(_name: str) -> str | None:
    """`shutil.which` on a machine without the program."""
    return None


def _somewhere(name: str) -> str | None:
    """`shutil.which` on a machine that has every program."""
    return f"/usr/bin/{name}"


def _by_id(slides: list[SlideData]) -> dict[str, SlideData]:
    return {s["id"]: s for s in slides}


# ── One slide's own files ─────────────────────────────────────────────────────


def test_nothing_changed_processes_nothing(project: Project) -> None:
    assert project.rebuilt() == []
    assert project.cache.notes_read == []


def test_a_slides_markdown_rebuilds_only_that_slide(project: Project) -> None:
    project.edit("slides/one.md", "Body one", "Body one, edited")
    assert project.rebuilt() == ["one"]
    assert "Body one, edited" in _by_id(project.full())["one"]["svg"]
    assert project.rebuilt() == []


def test_a_slides_svg_rebuilds_only_that_slide(project: Project) -> None:
    project.edit("slides/drawing.svg", 'x="100"', 'x="140"')
    assert project.rebuilt() == ["drawing"]


def test_a_note_rebuilds_no_slide(project: Project) -> None:
    project.edit("notes/two.md", "Second", "Second, longer")
    assert project.rebuilt() == []
    assert project.cache.notes_read == ["two"]
    assert "Second, longer" in _by_id(project.full())["two"]["notes"]


def test_a_slides_style_file_rebuilds_that_slide(project: Project) -> None:
    project.edit("slides/five.css", "red", "blue")
    assert project.rebuilt() == ["five"]


def test_chart_data_rebuilds_the_slide_drawing_it(project: Project) -> None:
    project.edit("data/sales.csv", "2024,14", "2024,31")
    assert project.rebuilt() == ["two-2"]
    # Gone, the chart's place says so; back, it is drawn again.
    (project.root / "data" / "sales.csv").unlink()
    assert project.rebuilt() == ["two-2"]
    _ = project.write("data/sales.csv", "year,revenue\n2023,1\n")
    assert project.rebuilt() == ["two-2"]


def test_ink_appearing_and_going_rebuilds_its_slide(project: Project) -> None:
    ink = DRAWING.replace(
        '<text id="label"', '<path id="s1" d="M0 0L9 9"/><text id="t"'
    )
    _ = project.write("ink/one.svg", ink)
    assert project.rebuilt() == ["one"]
    assert 'id="s1"' in _by_id(project.full())["one"]["svg"]
    (project.root / "ink" / "one.svg").unlink()
    assert project.rebuilt() == ["one"]


# ── What several slides share ────────────────────────────────────────────────


def test_a_layout_rebuilds_the_slides_built_on_it(project: Project) -> None:
    project.edit("layouts/two.svg", 'y="60"', 'y="70"')
    # The drawing has no layout; "two" is on one built on it (its parent).
    assert project.rebuilt() == ["one", "two", "two-2", "five"]


def test_a_child_layout_rebuilds_only_its_own_slides(project: Project) -> None:
    project.edit("layouts/child.svg", 'height="8"', 'height="12"')
    assert project.rebuilt() == ["two"]


def test_an_overlay_rebuilds_every_slide_wearing_it(project: Project) -> None:
    project.edit("overlays/footer.svg", "inkflow</text>", "Inkflow</text>")
    assert project.rebuilt() == IDS


def test_the_stylesheet_rebuilds_no_slide(project: Project) -> None:
    # styles.css is the page's, not a slide's: the server sends it apart.
    project.edit("styles.css", "--x: 1", "--x: 2")
    assert project.rebuilt() == []


def test_a_picture_rebuilds_no_slide(project: Project) -> None:
    # A slide holds a picture's address; the server stamps each address with
    # the file's time on every build (server._versioned), outside the cache.
    project.edit(
        "slides/drawing.svg",
        "<text",
        '<image id="pic" href="../assets/p.png" width="10" height="10"/><text',
    )
    _ = project.write("assets/p.png", b"\x89PNG one")
    assert project.rebuilt() == ["drawing"]
    _ = project.write("assets/p.png", b"\x89PNG two")
    assert project.rebuilt() == []


# ── Files that appear where a name is searched ──────────────────────────────


def test_a_file_that_now_shadows_a_layout_rebuilds_its_slides(
    project: Project,
) -> None:
    # Slide("two") looks in slides/ before the layouts.
    _ = project.write("slides/two.svg", LAYOUT.replace('y="60"', 'y="90"'))
    assert project.rebuilt() == ["one", "two-2", "five"]
    (project.root / "slides" / "two.svg").unlink()
    assert project.rebuilt() == ["one", "two-2", "five"]


def test_a_copy_of_a_theme_layout_rebuilds_the_slides_on_it(
    project: Project,
) -> None:
    project.edit(
        "deck.py", 'Slide("two", md="one.md")', 'Slide("content", md="one.md")'
    )
    assert project.rebuilt() == ["one"]
    theme = builtin_theme_dir() / "layouts"
    copy = (theme / "base.svg").read_text(encoding="utf-8")
    assert "<svg" in copy
    marked = copy.replace(
        "<svg",
        '<svg xmlns:inkflow="urn:inkflow"' + ' inkflow:copy-of="builtin:base"',
        1,
    )
    # The built-in "content" is built on "base": the deck's own copy of base
    # stands in for it from the moment it exists.
    _ = project.write("layouts/base.svg", marked)
    assert project.rebuilt() == ["one"]
    (project.root / "layouts" / "base.svg").unlink()
    assert project.rebuilt() == ["one"]


def test_a_missing_file_fails_like_a_full_build(project: Project) -> None:
    (project.root / "slides" / "one.md").unlink()
    with pytest.raises(FileNotFoundError):
        _ = project.rebuilt()
    # Nothing of the failed build is kept: back, the slide is as it was.
    _ = project.write("slides/one.md", "# One\n\nBody one\n")
    assert project.rebuilt() == ["one"]


# ── deck.py ──────────────────────────────────────────────────────────────────


def test_one_slides_arguments_rebuild_that_slide(project: Project) -> None:
    project.edit("deck.py", '"title": "Sales"', '"title": "Revenue"')
    assert project.rebuilt() == ["two-2"]


def test_a_deck_setting_rebuilds_every_slide(project: Project) -> None:
    project.edit("deck.py", 'overlays=[Overlay("footer")],', "overlays=[],")
    assert project.rebuilt() == IDS
    project.edit("deck.py", "overlays=[],", "overlays=[], font_size=30,")
    assert project.rebuilt() == IDS
    project.edit("deck.py", "font_size=30,", 'font_size=30, mode="light",')
    assert project.rebuilt() == IDS


def test_notes_and_title_arguments_do_not_touch_other_slides(
    project: Project,
) -> None:
    project.edit(
        "deck.py", 'Slide("two", md="one.md")', 'Slide("two", md="one.md", title="T")'
    )
    assert project.rebuilt() == ["one"]
    assert _by_id(project.full())["one"]["title"] == "T"


def test_an_inline_value_is_not_the_path_it_spells() -> None:
    assert frozen(Slide("two", md=Inline("one.md"))) != frozen(
        Slide("two", md="one.md")
    )
    assert frozen(Slide("two", font_size=1)) != frozen(Slide("two", font_size=True))
    assert frozen(Slide("two", md="one.md")) == frozen(Slide("two", md="one.md"))


def test_a_class_deck_py_defines_is_processed_on_every_load(
    project: Project,
) -> None:
    project.edit(
        "deck.py",
        "def main()",
        "from dataclasses import dataclass\n"
        + "from inkflow.animations import Emphasis\n\n\n"
        + "@dataclass\nclass Shake(Emphasis):\n    amount: int = 4\n\n\n"
        + "def main()",
    )
    project.edit(
        "deck.py",
        'Slide("drawing.svg", notes="notes/drawing.md")',
        'Slide("drawing.svg", notes="notes/drawing.md", animations=[Shake("box")])',
    )
    assert project.rebuilt() == ["drawing"]
    # The class is a new one on every load of deck.py: nothing says a slide
    # using it is what it was, so it is processed again; the others are kept.
    assert project.rebuilt() == ["drawing"]
    project.edit("deck.py", "amount: int = 4", "amount: int = 9")
    assert project.rebuilt() == ["drawing"]


def test_a_markdown_reveal_naming_a_deck_class_follows_deck_py(
    project: Project,
) -> None:
    project.edit(
        "deck.py",
        "def main()",
        "from dataclasses import dataclass\n"
        + "from inkflow.animations import Enter\n\n\n"
        + "@dataclass\nclass Drop(Enter):\n    duration: float = 0.5\n\n\n"
        + "def main()",
    )
    _ = project.write("slides/one.md", "# One\n\n::step type=Drop::\n\nLater\n")
    assert project.rebuilt() == ["one"]
    # Named in the Markdown only: the slide depends on the file defining it.
    project.edit("deck.py", "duration: float = 0.5", "duration: float = 2.5")
    assert project.rebuilt() == ["one"]
    assert "2.5" in _by_id(project.full())["one"]["svg"] or project.rebuilt() == ["one"]


def test_a_reveal_type_defined_later_reaches_the_slide_naming_it(
    project: Project,
) -> None:
    _ = gc.collect()  # no class of an earlier test's deck is left to find
    # Named before deck.py has it: drawn as the default, with a warning.
    _ = project.write("slides/one.md", "# One\n\n::step type=Drop::\n\nLater\n")
    with collect_logs(0) as said:
        assert project.rebuilt() == ["one"]
    assert any("unknown animation type 'Drop'" in e.message for e in said)
    assert "anim-fade-in" in _by_id(project.full())["one"]["svg"]
    project.edit(
        "deck.py",
        "def main()",
        "from dataclasses import dataclass\n"
        + "from inkflow.animations import Enter\n\n\n"
        + "@dataclass\nclass Drop(Enter):\n    pass\n\n\n"
        + "def main()",
    )
    # A slide that looked a class up by name is deck.py's to change.
    assert project.rebuilt() == ["one"]
    assert "anim-drop" in _by_id(project.full())["one"]["svg"]
    # A built-in named in Markdown is looked up the same way.
    _ = project.write("slides/five.md", "# Five\n\n::step type=FadeIn::\n\nLater\n")
    assert project.rebuilt() == ["five"]
    project.edit("deck.py", "class Drop(Enter):", "class Drop(Enter):  # same")
    assert project.rebuilt() == ["one", "five"]


def test_what_is_set_on_an_animation_besides_its_fields_counts() -> None:
    from inkflow.animations import FadeIn

    plain, marked = FadeIn("box"), FadeIn("box")
    marked.glow = 3  # pyright: ignore[reportAttributeAccessIssue]
    # A cue is written from everything the animation holds.
    assert frozen(Slide("two", animations=[plain])) != frozen(
        Slide("two", animations=[marked])
    )


# ── Numbers ──────────────────────────────────────────────────────────────────


def _numbers(slide: SlideData) -> tuple[str, str]:
    svg = slide["svg"]
    number = svg.split('id="zone-slide-number"')[1].split(">")[1].split("<")[0]
    total = svg.split('id="zone-slide-total"')[1].split(">")[1].split("<")[0]
    return number, total


def test_an_inserted_slide_renumbers_the_rest_without_processing_them(
    project: Project,
) -> None:
    _ = project.write("slides/new.md", "# New\n\nInserted\n")
    project.edit(
        "deck.py",
        ONE,
        f"{NEW}\n{ONE}",
    )
    assert project.rebuilt() == ["new"]
    slides = project.full()
    assert [s["id"] for s in slides] == [
        "drawing",
        "new",
        "one",
        "two",
        "two-2",
        "five",
    ]
    assert [_numbers(s) for s in slides[1:]] == [
        ("2", "6"),
        ("3", "6"),
        ("4", "6"),
        ("5", "6"),
        ("6", "6"),
    ]
    assert 'id="inkflow-slide-3"' in slides[2]["svg"]
    # And taken out again.
    project.edit("deck.py", f"{NEW}\n", "")
    assert project.rebuilt() == []
    assert _numbers(_by_id(project.full())["five"]) == ("5", "5")


def test_moved_and_hidden_slides_renumber_without_processing(
    project: Project,
) -> None:
    project.edit(
        "deck.py",
        f"{ONE}\n{TWO}",
        f"{TWO}\n{ONE}",
    )
    assert project.rebuilt() == []
    assert [s["id"] for s in project.full()] == [
        "drawing",
        "two",
        "one",
        "two-2",
        "five",
    ]
    project.edit(
        "deck.py",
        'Slide("two", md="one.md"),',
        'Slide("two", md="one.md", visible=False),',
    )
    assert project.rebuilt() == []
    assert _numbers(_by_id(project.full())["five"]) == ("4", "4")


def test_a_slide_spelling_the_stand_in_number_is_kept_by_its_number(
    project: Project,
) -> None:
    # The cache processes a slide with stand-ins for its number and the slide
    # count and puts the real ones in afterwards; a slide whose own text holds
    # those very digits cannot be renumbered that way.
    from inkflow.incremental import _NUMBER  # pyright: ignore[reportPrivateUsage]

    _ = project.write("slides/five.md", f"# Five\n\nA number: {_NUMBER}\n")
    assert project.rebuilt() == ["five"]
    assert str(_NUMBER) in _by_id(project.full())["five"]["svg"]
    _ = project.write("slides/new.md", "# New\n")
    project.edit(
        "deck.py",
        ONE,
        f"{NEW}\n{ONE}",
    )
    assert project.rebuilt() == ["new", "five"]
    assert project.rebuilt() == []


def test_a_renamed_id_rebuilds_that_slide(project: Project) -> None:
    project.edit(
        "deck.py", 'Slide("two", md="one.md")', 'Slide("two", md="one.md", id="intro")'
    )
    assert project.rebuilt() == ["intro"]
    assert set(project.cache.slides) == {"drawing", "intro", "two", "two-2", "five"}


# ── PDF figures ──────────────────────────────────────────────────────────────


def test_a_page_committed_beside_its_pdf_rebuilds_the_slide(
    project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No converter on this machine, whatever it has.
    monkeypatch.setattr(pdf, "_pymupdf", lambda: None)
    monkeypatch.setattr("shutil.which", _nowhere)
    # Which converter draws the pages is every slide's (one installed while
    # the server runs shows the figures without a restart).
    assert project.rebuilt() == IDS
    _ = project.write("figures/plot.pdf", b"%PDF-1.4 one")
    project.edit(
        "slides/drawing.svg",
        "<text",
        '<image id="fig" href="../figures/plot.pdf" width="300" height="160"/><text',
    )
    with collect_logs(0) as first:
        assert project.rebuilt() == ["drawing"]
    said = [e.message for e in first if "cannot show plot.pdf" in e.message]
    # One warning per build (the full build `rebuilt` compares with says it too).
    assert len(said) == 2
    with collect_logs(0) as again:
        assert project.rebuilt() == []
    assert len([e for e in again if "cannot show plot.pdf" in e.message]) == 2
    # The page drawn once and committed beside the PDF: shown from now on.
    digest = pdf.digest(project.root / "figures" / "plot.pdf")
    page = (
        f'<svg xmlns="http://www.w3.org/2000/svg" data-inkflow-pdf-digest="{digest}"/>'
    )
    _ = project.write("figures/plot.pdf.p1.svg", page)
    assert project.rebuilt() == ["drawing"]
    assert "figures/plot.pdf.p1.svg" in _by_id(project.full())["drawing"]["svg"]
    # The PDF saved again: the committed page is no longer its page.
    _ = project.write("figures/plot.pdf", b"%PDF-1.4 two")
    assert project.rebuilt() == ["drawing"]
    assert "plot.pdf.p1.svg" not in _by_id(project.full())["drawing"]["svg"]


def test_a_page_that_could_not_be_converted_is_tried_again(
    project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    tried: list[Path] = []

    def failing(pdf_path: Path, _page: int, _project: Path, _tool: str) -> Path:
        tried.append(pdf_path)
        raise pdf.PdfError("the converter timed out")

    monkeypatch.setattr(pdf, "_pymupdf", lambda: None)
    monkeypatch.setattr("shutil.which", _somewhere)
    monkeypatch.setattr(pdf, "convert", failing)
    _ = project.write("figures/plot.pdf", b"%PDF-1.4 one")
    project.edit(
        "slides/drawing.svg",
        "<text",
        '<image id="fig" href="../figures/plot.pdf" width="300" height="160"/><text',
    )
    _ = project.rebuilt()
    tried.clear()
    # A failure that may pass (a timeout, a full disk) is not kept: the
    # slide is processed again, as a full build would try again.
    assert "drawing" in project.rebuilt()
    assert tried


# ── Warnings ─────────────────────────────────────────────────────────────────


def test_a_notes_warning_is_said_again_and_its_pictures_follow_the_theme(
    project: Project,
) -> None:
    _ = project.write("notes/two.md", "A picture: ![far](../../outside.png)\n")
    with collect_logs(0) as first:
        assert project.rebuilt() == []
    assert project.cache.notes_read == ["two"]
    with collect_logs(0) as second:
        assert project.rebuilt() == []
    assert project.cache.notes_read == []

    def outside(entries: list[object]) -> int:
        return sum("outside the project" in str(e) for e in entries)

    assert outside(cast("list[object]", first)) == 2  # this build + the full one
    assert outside(cast("list[object]", second)) == 2


def test_a_kept_slides_warnings_are_said_again(project: Project) -> None:
    project.edit("data/sales.csv", "year,revenue", "year,revenue\nbroken,row,too,long")
    (project.root / "data" / "sales.csv").unlink()
    with collect_logs(0) as first:
        assert project.rebuilt() == ["two-2"]
    with collect_logs(0) as second:
        assert project.rebuilt() == []

    def warnings(entries: list[object]) -> list[str]:
        return sorted(str(e) for e in entries if "chart data not found" in str(e))

    assert warnings(cast("list[object]", first))
    assert warnings(cast("list[object]", first)) == warnings(
        cast("list[object]", second)
    )


# ── Stamps ───────────────────────────────────────────────────────────────────


def test_a_file_too_fresh_to_trust_is_read_again(
    project: Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(deps, "RACY_NS", 10**18)
    project.edit("slides/one.md", "Body one", "Body 1")
    # Every file looks freshly written: nothing read now is trusted later.
    assert project.rebuilt() == ["one"]
    assert project.rebuilt() == ["one"]


def test_a_file_replaced_by_one_of_the_same_size_and_time(project: Project) -> None:
    path = project.root / "slides" / "one.md"
    before = path.stat()
    other = project.root / "slides" / "one.md.new"
    _ = other.write_text("# One\n\nBody two\n", encoding="utf-8")
    assert other.stat().st_size == before.st_size
    os.replace(other, path)
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert path.stat().st_mtime_ns == before.st_mtime_ns
    # Another file under the same name: told apart by its inode.
    assert project.rebuilt() == ["one"]


@pytest.fixture
def opened(project: Project) -> Iterator[set[str]]:
    """Every file under the project Python opens while the fixture is live."""
    seen: set[str] = set()
    root = str(project.root)
    live = [True]

    def hook(event: str, args: tuple[object, ...]) -> None:
        if live[0] and event == "open" and isinstance(args[0], str | bytes):
            name = os.fsdecode(args[0])
            if name.startswith(root):
                seen.add(name)

    sys.addaudithook(hook)
    yield seen
    live[0] = False


def test_every_file_a_slide_opens_is_one_it_depends_on(
    project: Project, opened: set[str]
) -> None:
    """A read the pipeline does not note (`inkflow.deps.note`) is a slide
    that stays as it was when that file changes. Python tells of every file
    it opens; each must be among some slide's dependencies. (lxml reads SVG
    files itself, unseen here: those all go through svgio.parse_svg_file.)"""
    project.cache.clear()
    opened.clear()
    deck = load_deck(project.deck_path)
    seen_before = set(opened)  # deck.py itself, read by the loader
    _ = process_deck(
        deck, project.root, project.deck_path, editor=True, cache=project.cache
    )
    noted: set[str] = set()
    for entry in project.cache.slides.values():
        noted |= set(entry.deps)
    for entry in project.cache.notes.values():
        noted |= set(entry.deps)
    read = opened - seen_before
    assert read, "the build opened nothing: the audit hook saw no file"
    assert read <= noted, f"read but not noted: {sorted(read - noted)}"
    # And what lxml read: every SVG a slide is composed of.
    for name in ("layouts/two.svg", "layouts/child.svg", "overlays/footer.svg"):
        assert str(project.root / name) in noted


# ── The editor's model ───────────────────────────────────────────────────────


def _model(project: Project, cache: ModelCache | None) -> dict[str, object]:
    # The model lists every animation class alive, an earlier test's deck's
    # own among them until they are collected.
    _ = gc.collect()
    deck = load_deck(project.deck_path)
    slides = process_deck(deck, project.root, project.deck_path, editor=True)
    return build_model(deck, project.deck_path, slides, cache=cache)


def test_the_model_reads_only_the_slides_that_changed(project: Project) -> None:
    cache = ModelCache()
    assert _model(project, cache) == _model(project, None)
    assert cache.read == [0, 1, 2, 3, 4]
    assert _model(project, cache) == _model(project, None)
    assert cache.read == []
    project.edit("slides/one.md", "Body one", "Body one, edited")
    assert _model(project, cache) == _model(project, None)
    assert cache.read == [1]
    project.edit("notes/two.md", "Second", "Second, longer")
    model = _model(project, cache)
    assert model == _model(project, None)
    assert cache.read == [2]
    entries = cast("list[dict[str, object]]", model["slides"])
    assert "Second, longer" in str(entries[2]["notes"])
    # A layout's hash is in every slide built on it.
    project.edit("layouts/two.svg", 'y="60"', 'y="70"')
    assert _model(project, cache) == _model(project, None)
    assert cache.read == [1, 2, 3, 4]


def test_the_model_follows_moves_without_reading_again(project: Project) -> None:
    cache = ModelCache()
    _ = _model(project, cache)
    project.edit(
        "deck.py",
        f"{ONE}\n{TWO}",
        f"{TWO}\n{ONE}",
    )
    model = _model(project, cache)
    assert model == _model(project, None)
    assert cache.read == []
    entries = cast("list[dict[str, object]]", model["slides"])
    assert [e["id"] for e in entries] == ["drawing", "two", "one", "two-2", "five"]
    assert [e["deckIndex"] for e in entries] == [0, 1, 2, 3, 4]
    # Which slides share the layout, by where they stand now.
    sources = cast("list[dict[str, object]]", entries[2]["sources"])
    assert sources[0]["usedBy"] == [2, 3, 4]
    # Hidden, a slide is not built: it keeps a place in the model by index.
    project.edit(
        "deck.py",
        'Slide("two", md="one.md"),',
        'Slide("two", md="one.md", visible=False),',
    )
    assert _model(project, cache) == _model(project, None)


def test_the_model_sees_a_file_made_read_only(project: Project) -> None:
    cache = ModelCache()
    _ = _model(project, cache)
    path = project.root / "slides" / "drawing.svg"
    path.chmod(0o444)
    try:
        model = _model(project, cache)
        assert model == _model(project, None)
        if os.access(path, os.W_OK):
            pytest.skip("this user writes read-only files (root)")
        # Permissions move the file's change time, which a stamp holds.
        assert cache.read == [0]
        entries = cast("list[dict[str, object]]", model["slides"])
        sources = cast("list[dict[str, object]]", entries[0]["sources"])
        assert sources[0]["writable"] is False
    finally:
        path.chmod(0o644)


def test_the_model_says_whether_animations_are_written_out(
    project: Project,
) -> None:
    cache = ModelCache()
    assert cast("bool", _model(project, cache)["deckEditable"])
    project.edit("deck.py", "slides=[", "slides=[*[],")
    model = _model(project, cache)
    assert model == _model(project, None)
    assert model["deckEditable"] is False


# ── What the pages are sent ──────────────────────────────────────────────────


def test_keys_name_content_and_patches_name_what_is_held(project: Project) -> None:
    before = project.full()
    set_keys(before)
    keys = [s.get("key", "") for s in before]
    assert len(set(keys)) == len(keys)
    again = project.full()
    set_keys(again)
    assert [s.get("key") for s in again] == keys  # the same content, the same key
    project.edit("slides/one.md", "Body one", "Body one, edited")
    after = project.full()
    set_keys(after)
    patch = as_patch(after, keys_of(before))
    assert [p if isinstance(p, str) else "whole" for p in patch] == [
        keys[0],
        "whole",
        keys[2],
        keys[3],
        keys[4],
    ]
    assert patch[1] is after[1]
    # A page holding nothing is sent everything.
    assert as_patch(after, frozenset()) == after


# ── The server: what each page is sent ───────────────────────────────────────


class _Peer:
    """A WebSocket peer: what it sends, and what the server sends it."""

    remote_address: tuple[str, int] = ("127.0.0.1", 5000)

    def __init__(self, inbox: list[dict[str, object]] | None = None) -> None:
        self.sent: list[dict[str, object]] = []
        self.inbox: list[dict[str, object]] = inbox or []

    async def send(self, msg: str) -> None:
        self.sent.append(cast("dict[str, object]", json.loads(msg)))

    def __aiter__(self) -> AsyncIterator[str]:
        return self._messages()

    async def _messages(self) -> AsyncIterator[str]:
        for msg in self.inbox:
            yield json.dumps(msg)

    def last(self, kind: str) -> dict[str, object]:
        return [m for m in self.sent if m["type"] == kind][-1]


class _UI:
    def refresh(self) -> None:
        pass

    def set_building(self) -> None:
        pass

    def set_ok(self, *_args: object, **_kwargs: object) -> None:
        pass

    def set_error(self, trace: str) -> None:
        raise AssertionError(trace)


def _kinds(items: object) -> list[str]:
    """Each item of a sent list: named by key, or sent whole."""
    return [
        "key" if isinstance(item, str) else "whole"
        for item in cast("list[object]", items)
    ]


@pytest.fixture
def served(project: Project) -> Iterator[tuple[Project, _Peer, _Peer]]:
    """The deck built by the server, with two owner's pages connected: one
    that takes patches and one of an older inkflow that does not."""
    people = server._share.people  # pyright: ignore[reportPrivateUsage]
    state = server._state  # pyright: ignore[reportPrivateUsage]
    editor = server._editor  # pyright: ignore[reportPrivateUsage]
    patching, plain = _Peer(), _Peer()
    sockets = [cast("ServerConnection", cast("object", p)) for p in (patching, plain)]
    for ws in sockets:
        _ = people.join(ws, "owner", None, "127.0.0.1")
        state["ws_clients"].add(ws)
        editor["clients"].add(ws)
    client = people.get(sockets[0])
    assert client is not None
    client.patches = True
    session, editor["session"] = editor["session"], None
    try:
        _rebuild(project)
        yield project, patching, plain
    finally:
        editor["session"] = session
        for ws in sockets:
            state["ws_clients"].discard(ws)
            editor["clients"].discard(ws)
            _ = people.leave(ws)


async def _serve(
    handler: Callable[[ServerConnection], Awaitable[None]], ws: ServerConnection
) -> None:
    await handler(ws)


def _rebuild(project: Project, *, full: bool = False) -> None:
    ui = cast("LiveUI", cast("object", _UI()))
    asyncio.run(server.rebuild(project.deck_path, ui, resolve_levels(), full=full))


def test_a_rebuild_sends_a_page_the_slides_that_changed(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, plain = served
    project.edit("slides/one.md", "Body one", "Body one, edited")
    _rebuild(project)
    update = patching.last("update")
    assert _kinds(update["slides"]) == ["key", "whole", "key", "key", "key"]
    changed = cast("list[dict[str, str]]", update["slides"])[1]
    assert changed["id"] == "one" and "Body one, edited" in changed["svg"]
    model = cast("dict[str, object]", patching.last("editor-model")["model"])
    assert _kinds(model["slides"]) == ["key", "whole", "key", "key", "key"]
    # A page that never asked for patches gets every slide, as it always did.
    assert _kinds(plain.last("update")["slides"]) == ["whole"] * 5
    old = cast("dict[str, object]", plain.last("editor-model")["model"])
    assert _kinds(old["slides"]) == ["whole"] * 5
    # The keys a patch names are the ones the last build sent.
    held = cast("list[dict[str, str]]", plain.sent[0]["slides"])
    assert cast("list[object]", update["slides"])[0] == held[0]["key"]


def test_a_note_sends_its_slide_and_processes_none(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, _plain = served
    project.edit("notes/two.md", "Second", "Second, longer")
    _rebuild(project)
    kept = server._editor["kept"]  # pyright: ignore[reportPrivateUsage]
    assert kept is not None and kept.slides.processed == []
    update = patching.last("update")
    assert _kinds(update["slides"]) == ["key", "key", "whole", "key", "key"]
    sent = cast("list[dict[str, str]]", update["slides"])[2]
    assert "Second, longer" in sent["notes"]


def test_the_stylesheet_is_sent_and_no_slide_with_it(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, _plain = served
    project.edit("styles.css", "--x: 1", "--x: 2")
    _rebuild(project)
    update = patching.last("update")
    assert "--x: 2" in str(update["styles"])
    assert _kinds(update["slides"]) == ["key"] * 5
    project.edit("slides/one.md", "Body one", "Body 1")
    _rebuild(project)
    assert "styles" not in patching.last("update")  # only when it changed


def test_a_full_rebuild_processes_every_slide_again(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    project, patching, _plain = served
    _rebuild(project, full=True)
    kept = server._editor["kept"]  # pyright: ignore[reportPrivateUsage]
    assert kept is not None and kept.slides.processed == IDS
    # The slides are what they were: a page holding them is sent their keys.
    assert _kinds(patching.last("update")["slides"]) == ["key"] * 5


def test_a_page_says_hello_and_asks_again_when_it_missed_a_build(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    del served
    page = _Peer(
        [
            {"type": "hello", "role": "editor", "patch": True},
            {"type": "resync"},
        ]
    )
    ws = cast("ServerConnection", cast("object", page))
    people = server._share.people  # pyright: ignore[reportPrivateUsage]
    _ = people.join(ws, "owner", None, "127.0.0.1")
    handler = server.make_ws_handler(
        cast("LiveUI", cast("object", _UI())), NO_EDIT_COMMANDS
    )
    try:
        asyncio.run(_serve(handler, ws))
    finally:
        _ = people.leave(ws)
    sent = [m for m in page.sent if m["type"] in ("update", "editor-model")]
    assert [m["type"] for m in sent] == ["update", "editor-model"] * 2
    # On hello: the slides by key (its HTML came with them), the model whole.
    assert _kinds(sent[0]["slides"]) == ["key"] * 5
    assert (
        _kinds(cast("dict[str, object]", sent[1]["model"])["slides"]) == ["whole"] * 5
    )
    # Asked again: everything whole.
    assert _kinds(sent[2]["slides"]) == ["whole"] * 5
    assert (
        _kinds(cast("dict[str, object]", sent[3]["model"])["slides"]) == ["whole"] * 5
    )


def test_a_presenter_page_gets_slides_and_no_model(
    served: tuple[Project, _Peer, _Peer],
) -> None:
    del served
    page = _Peer([{"type": "hello", "role": "presenter", "patch": True}])
    ws = cast("ServerConnection", cast("object", page))
    people = server._share.people  # pyright: ignore[reportPrivateUsage]
    _ = people.join(ws, "viewer", "token", "192.168.1.9")
    handler = server.make_ws_handler(
        cast("LiveUI", cast("object", _UI())), NO_EDIT_COMMANDS
    )
    try:
        asyncio.run(_serve(handler, ws))
    finally:
        _ = people.leave(ws)
    kinds = [m["type"] for m in page.sent]
    assert "update" in kinds and "editor-model" not in kinds
