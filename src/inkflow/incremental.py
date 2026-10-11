"""Rebuilding only what changed: a served deck's slides, kept between builds.

`inkflow serve` and `edit` rebuild on every change of any file in the project.
`SlideCache` makes that rebuild cost what the change touched: `process_deck`
asks it for each slide, and it hands back the last build's result unless one
of the slide's inputs changed. One-shot commands (`build`, `export`,
`render`, `verify`) pass no cache and build every slide, as before.

What a slide's result depends on, and how each part is watched:

- **The files it read or looked for** (its SVG, layout chain, overlays, ink,
  Markdown, chart data, PDFs and their converted or committed pages, a
  drawn-in diagram, a style file, every candidate a name was searched at):
  recorded while it is processed (`inkflow.deps`) and compared by stamp
  (time, size, inode; "not there" included) at the next build. A layout or an
  overlay edited is thus every slide built on it, and nothing else.
- **What deck.py says of it** (`Slide(...)`, every field) **and of the deck**
  (theme, mode, font size, overlays, deck style, size): compared by value
  (`_frozen`). A class deck.py defines itself (a custom animation) is new on
  every load, so slides using one are processed every time.
- **Its id**: entries are kept by id, and the id is part of the key.
- **Its number and the deck's slide count**: *not* part of the key. They
  only ever reach the output as the root's ``inkflow-slide-N`` id (and the
  ``@scope`` naming it) and the text of ``zone-slide-number`` /
  ``zone-slide-total``, so a slide is processed with stand-in numbers and
  kept as a template the real ones are put into (`_Template`). A slide
  inserted or moved renumbers the ones after it without processing them.
  A slide whose result shows a stand-in anywhere else is kept by number
  instead (`_plain`).
- **Its notes file**: kept apart (`Build.notes`), so typing a note
  processes no slide.

Pictures and videos a slide shows are not inputs: the slide holds their
address, and the server stamps each address with the file's time on every
build (`server._versioned`).

Warnings logged while a slide was processed are logged again when it is
taken from the cache, so the banner and the terminal show what a full build
would.

The pages are sent what changed, the same way: every slide (and every slide's
entry in the editor's model) carries a ``key``, a digest of its content
(`set_keys`), and a rebuild's message names by key what the last build already
had (`as_patch`). A page that does not hold a key it is sent asks for
everything again (``resync``), so a patch never has to be right about what a
page has.
"""

from __future__ import annotations

import dataclasses
import enum
import hashlib
import json
import logging
import threading
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePath
from typing import cast

from typing_extensions import override

from inkflow import pdf
from inkflow.deps import Stamp, Stamps, recording
from inkflow.logging import logger
from inkflow.manifest import Slide
from inkflow.pipeline import BuiltSlide, DeckContext, build_slide, slide_notes

# Stand-ins for a slide's number and the deck's slide count while a slide is
# processed for the cache: long digit runs nothing else in a slide spells.
_NUMBER = 918273645546372819
_TOTAL = 827364554637281910
_ROOT_ID = "inkflow-slide-"


def frozen(value: object, depth: int = 0) -> object:
    """``value`` as something two builds can compare: equal exactly when the
    pipeline would treat both the same. Types are part of it (``Inline("a")``
    is not the path ``"a"``, ``True`` is not ``1``), held as the class itself:
    a class from an earlier load of deck.py never equals the next load's."""
    kind = type(value)
    if value is None or kind in (str, int, float, bool, bytes):
        return (kind, value)
    if depth > 40:
        raise ValueError("deck value nested too deeply to compare")
    if isinstance(value, enum.Enum):
        return (kind, value.name)
    for base in (str, int, float):
        # A str or number subclass (Inline, Easing, Trigger, PageSize).
        if isinstance(value, base):
            own = cast("dict[str, object]", getattr(value, "__dict__", {}))
            return (kind, base(value), frozen(dict(own), depth + 1))
    if isinstance(value, PurePath):
        return (kind, str(value))
    if isinstance(value, dict):
        items = cast("dict[object, object]", value).items()
        return (
            kind,
            tuple((frozen(k, depth + 1), frozen(v, depth + 1)) for k, v in items),
        )
    if isinstance(value, list | tuple):
        return (
            kind,
            tuple(frozen(v, depth + 1) for v in cast("list[object]", value)),
        )
    if isinstance(value, set | frozenset):
        members = cast("set[object]", value)
        return (kind, tuple(sorted(repr(frozen(v, depth + 1)) for v in members)))
    if dataclasses.is_dataclass(value):
        names = [f.name for f in dataclasses.fields(value)]
        # And what was set on it besides its fields (an animation's cue is
        # written from everything it holds).
        extra = cast("dict[str, object]", getattr(value, "__dict__", {}))
        names += [name for name in extra if name not in names]
        return (
            kind,
            tuple(
                (name, frozen(cast("object", getattr(value, name)), depth + 1))
                for name in names
            ),
        )
    if isinstance(value, type):
        return (kind, value)
    state = cast("object", getattr(value, "__dict__", None))
    if isinstance(state, dict):
        return (kind, frozen(cast("dict[str, object]", state), depth + 1))
    # Anything else (a function, an object without fields) by its repr, which
    # names its address: equal only to itself, so the slide is processed again.
    return (kind, repr(value))


def _context_key(ctx: DeckContext, deck_path: Path) -> object:
    """Everything of the deck a slide's result depends on, except the slide
    count (see `_Template`)."""
    return (
        str(ctx.project_dir),
        str(deck_path),
        frozen(ctx.theme),
        str(ctx.theme.asset_dir()),
        ctx.deck_style,
        ctx.font_size,
        frozen(list(ctx.overlays)),
        ctx.mode,
        ctx.pdf_pages.tool,
        ctx.chart_scale,
        ctx.editor,
        ctx.print_page,
        ctx.sized,
    )


class _Capture(logging.Handler):
    """The warnings logged on this thread while one slide is processed."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.records: list[tuple[int, str]] = []
        self._thread: int = threading.get_ident()

    @override
    def emit(self, record: logging.LogRecord) -> None:
        if record.thread == self._thread:
            self.records.append((record.levelno, record.getMessage()))


@dataclass
class _Template:
    """A built slide with stand-ins where its number and the slide count go."""

    built: BuiltSlide

    def numbered(self, number: int, total: int) -> BuiltSlide:
        svg = self.built.svg.replace(str(_NUMBER), str(number))
        return self.built._replace(svg=svg.replace(str(_TOTAL), str(total)))


def _plain(built: BuiltSlide) -> bool:
    """Whether the stand-in numbers sit only where a slide's number and the
    slide count are written: the root's id and its ``@scope``, and the text of
    a number zone. Anywhere else (a slide that spells out those very digits)
    the result cannot be renumbered by putting numbers in."""
    number, total = str(_NUMBER), str(_TOTAL)
    svg = built.svg
    expected = svg.count(_ROOT_ID + number) + svg.count(f">{number}<")
    if svg.count(number) != expected or svg.count(total) != svg.count(f">{total}<"):
        return False
    rest = json.dumps([built.title, built.notes, built.editable_files, built.edit])
    return number not in rest and total not in rest


@dataclass
class _Entry:
    key: object
    deps: dict[str, Stamp]
    result: _Template | BuiltSlide
    """A template, or (see `_plain`) the slide as built for ``numbers``."""
    numbers: tuple[int, int] | None
    warnings: list[tuple[int, str]]
    unconverted: str | None
    """The first PDF picture of the slide no converter could draw."""


@dataclass
class _Notes:
    key: object
    deps: dict[str, Stamp]
    html: str
    warnings: list[tuple[int, str]]


@dataclass
class SlideCache:
    """The slides of a deck's last build, by id (see the module's doc)."""

    slides: dict[str, _Entry] = field(default_factory=dict)
    notes: dict[str, _Notes] = field(default_factory=dict)
    processed: list[str] = field(default_factory=list)
    """The ids of the slides the last build processed (the rest it kept)."""
    notes_read: list[str] = field(default_factory=list)
    """The ids of the slides whose notes the last build rendered."""

    def build(self, ctx: DeckContext, deck_path: Path) -> Build:
        """One build's use of the cache (`process_deck`)."""
        return Build(self, ctx, deck_path)

    def clear(self) -> None:
        """Forget everything: the next build processes every slide."""
        self.slides.clear()
        self.notes.clear()


class Build:
    """One build reading from, and filling, a `SlideCache`."""

    def __init__(self, cache: SlideCache, ctx: DeckContext, deck_path: Path) -> None:
        self.cache: SlideCache = cache
        self.ctx: DeckContext = ctx
        self.deck_path: Path = deck_path
        self.stamps: Stamps = Stamps()
        self.key: object = _context_key(ctx, deck_path)
        self.seen: set[str] = set()
        self.unconverted: str | None = None
        cache.processed = []
        cache.notes_read = []
        # One "no PDF converter" warning per build, whichever slide wants one
        # first: said in `finish`, not by a slide that may come from the cache.
        ctx.pdf_pages.warned = True

    def slide(self, slide: Slide, number: int, slide_id: str) -> BuiltSlide:
        """`build_slide`, from the cache when nothing it depends on changed."""
        self.seen.add(slide_id)
        total = self.ctx.total_slides
        key = (self.key, slide_id, frozen(slide))
        entry = self.cache.slides.get(slide_id)
        if (
            entry is None
            or entry.key != key
            or entry.numbers not in (None, (number, total))
            or not self.stamps.unchanged(entry.deps)
        ):
            entry = self._process(slide, number, slide_id, key)
            self.cache.slides[slide_id] = entry
            self.cache.processed.append(slide_id)
        else:
            for level, message in entry.warnings:
                logger.log(level, message)
        if self.unconverted is None:
            self.unconverted = entry.unconverted
        if isinstance(entry.result, _Template):
            return entry.result.numbered(number, total)
        return entry.result

    def _process(self, slide: Slide, number: int, slide_id: str, key: object) -> _Entry:
        pages = self.ctx.pdf_pages
        capture = _Capture()
        logger.addHandler(capture)
        try:
            before = len(pages.unconverted)
            with recording(self.deck_path) as deps:
                stand_in = replace(self.ctx, total_slides=_TOTAL)
                built = build_slide(slide, stand_in, _NUMBER, slide_id, self.deck_path)
            result: _Template | BuiltSlide = _Template(built)
            numbers = None
            if not _plain(built):
                # Its own text spells a stand-in: built with its real numbers,
                # and kept only while those stay.
                capture.records.clear()
                del pages.unconverted[before:]
                with recording(self.deck_path) as deps:
                    result = build_slide(
                        slide, self.ctx, number, slide_id, self.deck_path
                    )
                numbers = (number, self.ctx.total_slides)
        finally:
            logger.removeHandler(capture)
        wanted = pages.unconverted[before:]
        return _Entry(
            key, deps, result, numbers, capture.records, wanted[0] if wanted else None
        )

    def notes(self, slide: Slide, slide_id: str) -> str:
        """`slide_notes`, from the cache while the notes file is the same."""
        # Where its pictures are looked for is the project's and the theme's.
        roots = (str(self.ctx.project_dir), str(self.ctx.theme.asset_dir()))
        key = (roots, frozen(slide.notes))
        entry = self.cache.notes.get(slide_id)
        if entry is None or entry.key != key or not self.stamps.unchanged(entry.deps):
            capture = _Capture()
            logger.addHandler(capture)
            try:
                with recording() as deps:
                    html = slide_notes(slide, self.ctx)
            finally:
                logger.removeHandler(capture)
            entry = _Notes(key, deps, html, capture.records)
            self.cache.notes[slide_id] = entry
            self.cache.notes_read.append(slide_id)
        else:
            for level, message in entry.warnings:
                logger.log(level, message)
        return entry.html

    def finish(self) -> None:
        """After the last slide: forget the slides the deck no longer has."""
        for kept in (self.cache.slides, self.cache.notes):
            for gone in [k for k in kept if k not in self.seen]:
                del kept[gone]
        if self.unconverted is not None:
            logger.warning(f"cannot show {self.unconverted}: {pdf.install_hint()}")


# ── What the pages are sent ──────────────────────────────────────────────────


def set_keys(items: Sequence[Mapping[str, object]]) -> None:
    """Give each item (a served slide, a slide's entry in the editor's model)
    its ``key``: a digest of everything else it holds."""
    for item in items:
        data = cast("dict[str, object]", item)
        _ = data.pop("key", None)
        digest = hashlib.blake2b(digest_size=10)
        for name in sorted(data):
            value = data[name]
            # A slide is mostly one long string (its SVG): hashed as it is.
            text = value if isinstance(value, str) else json.dumps(value)
            digest.update(f"{name}\0{type(value).__name__}\0{len(text)}\0".encode())
            digest.update(text.encode("utf-8", "surrogatepass"))
        data["key"] = digest.hexdigest()


def keys_of(items: Sequence[Mapping[str, object]]) -> frozenset[str]:
    return frozenset(str(item["key"]) for item in items if "key" in item)


def as_patch(
    items: Sequence[Mapping[str, object]], held: Collection[str]
) -> list[object]:
    """``items`` as sent to a page that holds the items keyed ``held``: those
    are named by key, the rest sent whole."""
    return [item["key"] if item.get("key") in held else item for item in items]
