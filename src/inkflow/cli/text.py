"""``inkflow find`` and ``inkflow replace``: the editor's Find and Replace.

Both search what the editor's Find dialog searches (`editor/findreplace.py`):
the text of each slide's SVGs (its own drawing, and the layouts and overlays
of the project it is built on), its Markdown and notes, and in deck.py only
the strings an author would call text (``title=``, ``zones={...}`` text,
``Inline(...)``), never code. ``replace`` sends the session's own ``replace``
action, so with ``inkflow edit`` open on the deck it is one "Agent: …" step
the author can undo there; otherwise the files are changed directly.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides as SlideRefs
from inkflow.cli._edits import apply_edit as apply_step
from inkflow.editor.findreplace import FindError, Options, pattern
from inkflow.editor.session import EditError, EditorSession
from inkflow.logging import report
from inkflow.zones import zone_spans


@dataclass(frozen=True)
class _Scope:
    """What a search covers: the files, and deck.py's text of one slide or all."""

    slides: SlideRefs
    files: list[str]
    """Files the editor would search, absolute."""
    by_slide: list[list[str]]
    """Each deck index's files."""
    deck_slide: int | None
    notes: frozenset[str]
    """Notes files (no zones to name)."""


def _slide_files(entry: dict[str, object]) -> list[str]:
    """A slide's searchable files, as the editor's Find dialog lists them."""
    out = [
        str(s["path"])
        for s in cast("list[dict[str, object]]", entry.get("sources") or [])
        if s.get("writable")
    ]
    for key in ("md", "notes"):
        info = cast("dict[str, object] | None", entry.get(key))
        if info and isinstance(info.get("path"), str):
            out.append(cast(str, info["path"]))
    src = entry.get("srcPath")
    if isinstance(src, str):
        out.append(src)
    return list(dict.fromkeys(out))


def _scope(deck_path: Path, slide_ref: str | None) -> _Scope:
    from inkflow.editor.model import build_model
    from inkflow.pipeline import process_deck

    slides = SlideRefs.load(deck_path)
    try:
        built = process_deck(slides.deck, slides.path.parent, slides.path, editor=True)
        model = build_model(slides.deck, slides.path, built)
    except Exception as exc:
        raise click.ClickException(f"cannot build the deck: {exc}") from exc
    entries = cast("list[dict[str, object]]", model["slides"])
    by_slide = [_slide_files(e) for e in entries]
    notes = frozenset(
        path
        for e in entries
        if isinstance(path := cast("dict[str, object]", e["notes"]).get("path"), str)
    )
    if slide_ref is None:
        files = [f for fs in by_slide for f in fs]
        return _Scope(slides, list(dict.fromkeys(files)), by_slide, None, notes)
    index = slides.index(slide_ref)
    return _Scope(slides, by_slide[index], by_slide, index, notes)


def _request(
    text: str, scope: _Scope, regex: bool, case: bool, word: bool
) -> dict[str, object]:
    request: dict[str, object] = {
        "query": text,
        "files": scope.files,
        "regex": regex,
        "matchCase": case,
        "wholeWord": word,
    }
    if scope.deck_slide is not None:
        request["deckSlide"] = scope.deck_slide
    return request


def _hits(deck_path: Path, request: dict[str, object]) -> list[dict[str, object]]:
    """The session's own search (read-only, so never through a server)."""
    try:
        result = EditorSession(deck_path).apply({**request, "action": "find"}, None)
    except EditError as exc:
        raise click.ClickException(str(exc)) from exc
    return cast("list[dict[str, object]]", result["hits"])


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def _where(hit: dict[str, object], scope: _Scope) -> list[int]:
    """The deck indices of the slides a hit shows on."""
    if hit["kind"] == "deck":
        slide = hit.get("slide")
        return [slide] if isinstance(slide, int) else []
    return [i for i, files in enumerate(scope.by_slide) if hit["file"] in files]


def _slides_label(indices: list[int], scope: _Scope) -> str:
    if not indices:
        return "no slide"
    if len(indices) == 1:
        return scope.slides.name(indices[0])
    numbers = [scope.slides.numbers[i] for i in indices]
    shown = [str(n) for n in numbers if n is not None]
    hidden = len(numbers) - len(shown)
    label = "slides " + ", ".join(shown)
    if hidden:
        label += f" (+{hidden} hidden)"
    return label


def _rel(path: str, project_dir: Path) -> str:
    try:
        return Path(path).relative_to(project_dir).as_posix()
    except ValueError:
        return path


_md_cache: dict[str, str] = {}


def _zone_of(path: str, line: int) -> str | None:
    """The Markdown zone a line of a slide's .md is in."""
    if path not in _md_cache:
        try:
            _md_cache[path] = Path(path).read_text(encoding="utf-8")
        except OSError:
            _md_cache[path] = ""
    text = _md_cache[path]
    lines = text.splitlines(keepends=True)
    if not 1 <= line <= len(lines):
        return None
    start = sum(len(x) for x in lines[: line - 1])
    end = start + len(lines[line - 1])
    for name, (a, b) in zone_spans(text).items():
        if a < end and b > start:
            return name
    return None


def _location(hit: dict[str, object], scope: _Scope) -> str:
    project_dir = scope.slides.path.parent
    file = _rel(str(hit["file"]), project_dir)
    kind = hit["kind"]
    if kind == "svg":
        ident = hit.get("id")
        return f"{file} #{ident}" if ident else f"{file} <text>"
    if kind == "deck":
        return file
    line = hit.get("line")
    where = f"{file}:{line}"
    if isinstance(line, int) and str(hit["file"]) not in scope.notes:
        zone = _zone_of(str(hit["file"]), line)
        if zone:
            where += f" [{zone}]"
    return where


def _snippet(hit: dict[str, object], new: str | None = None) -> str:
    before = _flat(str(hit["before"]))[-30:]
    after = _flat(str(hit["after"]))[:30]
    match = str(hit["match"])
    middle = f"[{match}]" if new is None else f"[{match} -> {new}]"
    return f'"{before}{middle}{after}"'


def _summary(hits: list[dict[str, object]], scope: _Scope) -> str:
    slides = {i for h in hits for i in _where(h, scope)}
    n = len(hits)
    s = f"{n} match{'es' if n != 1 else ''}"
    if n >= 500:
        s += " (stopped at 500)"
    return s + f" on {len(slides)} slide{'s' if len(slides) != 1 else ''}"


_text_options = [
    click.option("--regex", "-r", is_flag=True, help="TEXT is a regular expression."),
    click.option("--case", "-c", is_flag=True, help="Match case."),
    click.option("--word", "-w", is_flag=True, help="Whole words only."),
    click.option(
        "--slide",
        "-s",
        "slide_ref",
        default=None,
        metavar="SLIDE",
        help="Only this slide (number or id): its files and its deck.py text.",
    ),
]


def _with_text_options(f: click.decorators.FC) -> click.decorators.FC:
    for option in reversed(_text_options):
        f = option(f)
    return f


@main.command("find")
@click.argument("text")
@deck_option
@_with_text_options
@click.option("--json", "as_json", is_flag=True, help="Print the matches as JSON.")
def find(
    text: str,
    deck_path: Path,
    regex: bool,
    case: bool,
    word: bool,
    slide_ref: str | None,
    as_json: bool,
) -> None:
    """Find text on the slides, as the editor's Find does.

    Searches each slide's SVG text, Markdown and notes, and deck.py's
    author text (titles, `zones={...}` text, `Inline(...)`), never code.
    Prints one line per match: the slide(s) it shows on, the file and where
    in it (`#id` of an SVG text, `line [zone]` in Markdown), and the match
    in [brackets] with its context.
    """
    scope = _scope(deck_path, slide_ref)
    hits = _hits(scope.slides.path, _request(text, scope, regex, case, word))
    if as_json:
        project_dir = scope.slides.path.parent
        out = [
            {
                **h,
                "file": _rel(str(h["file"]), project_dir),
                "slides": [
                    {"number": scope.slides.numbers[i], "id": scope.slides.ids[i]}
                    for i in _where(h, scope)
                ],
            }
            for h in hits
        ]
        click.echo(json.dumps(out, ensure_ascii=False))
        return
    for hit in hits:
        where = _slides_label(_where(hit, scope), scope)
        click.echo(f"{where}: {_location(hit, scope)}: {_snippet(hit)}")
    click.echo(_summary(hits, scope) if hits else "no matches")


@main.command("replace")
@click.argument("text")
@click.argument("new")
@deck_option
@_with_text_options
@click.option(
    "--dry-run", "-n", is_flag=True, help="Show what would change; write nothing."
)
def replace(
    text: str,
    new: str,
    deck_path: Path,
    regex: bool,
    case: bool,
    word: bool,
    slide_ref: str | None,
    dry_run: bool,
) -> None:
    """Replace text on the slides, as the editor's Replace All does.

    Matches what `inkflow find` matches (with `--regex`, NEW may use `\\1`
    or `\\g<name>`) and replaces every match in one step. With the editor
    open on the deck the step is the editor's ("Agent: Replace …"), so
    Ctrl+Z there takes it back; otherwise the files are changed directly.
    `--dry-run` lists each match with what it would become.
    """
    scope = _scope(deck_path, slide_ref)
    request = _request(text, scope, regex, case, word)
    hits = _hits(scope.slides.path, request)
    if not hits:
        click.echo("no matches")
        sys.exit(1)
    if dry_run:
        try:
            pat = pattern(text, Options(case, word, regex))
        except FindError as exc:
            raise click.ClickException(str(exc)) from exc
        for hit in hits:
            match = str(hit["match"])
            found = pat.fullmatch(match) if regex else None
            becomes = found.expand(new) if found else new
            where = _slides_label(_where(hit, scope), scope)
            click.echo(f"{where}: {_location(hit, scope)}: {_snippet(hit, becomes)}")
        click.echo(_summary(hits, scope) + " would be replaced")
        return
    summary = f'Replace "{_flat(text)}" with "{_flat(new)}"'
    if scope.deck_slide is not None:
        summary += f" on {scope.slides.name(scope.deck_slide)}"
    applied = apply_step(
        scope.slides, {**request, "action": "replace", "replacement": new}, summary
    )
    count = applied.result.get("replaced")
    if isinstance(count, int):
        report("Replaced", f"{count} match{'es' if count != 1 else ''}")
