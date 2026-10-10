"""What the agent-facing edit commands share (``inkflow slide``, ``inkflow shape``).

They address slides as the presenter numbers them (or by id), send the visual
editor's own session actions through ``editor.remote`` (the running editor
server, as an undoable "Agent: …" step, else the files directly), and print
what changed in the same terse lines.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import resolve_deck_path
from inkflow.editor.remote import (
    Applied,
    RemoteEditError,
    apply_request,
    deck_file_hash,
)
from inkflow.logging import report
from inkflow.manifest import Deck
from inkflow.pipeline import slide_ids
from inkflow.server import load_deck


@dataclass(frozen=True)
class DeckSlides:
    """The deck as a command addresses it: numbers and ids by deck index."""

    deck: Deck
    path: Path
    hash: str
    ids: list[str]
    numbers: list[int | None]
    """Presentation number per deck index; None for a hidden slide."""

    @classmethod
    def load(cls, deck_path: Path) -> DeckSlides:
        resolved = resolve_deck_path(deck_path)
        deck_hash = deck_file_hash(resolved)
        try:
            deck = load_deck(resolved)
        except Exception as exc:
            raise click.ClickException(
                f"deck.py does not load ({type(exc).__name__}: {exc}); fix it first"
            ) from exc
        visible = [s for s in deck.slides if s.visible]
        shown = dict(zip(map(id, visible), slide_ids(visible), strict=True))
        numbers: list[int | None] = []
        count = 0
        for slide in deck.slides:
            if slide.visible:
                count += 1
            numbers.append(count if slide.visible else None)
        # A hidden slide has no id in the presentation; it goes by the one it
        # would infer, numbered on (-2, -3…) past any shown slide's id.
        taken = set(shown.values())
        ids: list[str] = []
        for slide in deck.slides:
            name = shown.get(id(slide))
            if name is None:
                raw = slide_ids([slide])[0]
                name, n = raw, 2
                while name in taken:
                    name, n = f"{raw}-{n}", n + 1
                taken.add(name)
            ids.append(name)
        return cls(deck, resolved, deck_hash, ids, numbers)

    @property
    def project_dir(self) -> Path:
        return self.path.parent

    def index(self, ref: str) -> int:
        """The deck index of SLIDE (a presentation number or an id)."""
        ref = ref.strip()
        if ref.isdigit():
            if int(ref) in self.numbers:
                return self.numbers.index(int(ref))
            shown = sum(n is not None for n in self.numbers)
            raise click.BadParameter(
                f"no slide {ref}: the deck shows {shown} slides "
                + "(a hidden slide goes by its id)",
                param_hint="SLIDE",
            )
        if ref in self.ids:  # unique: see load
            return self.ids.index(ref)
        raise click.BadParameter(f"no slide with id {ref!r}", param_hint="SLIDE")

    def section(self, ref: str) -> int:
        """The index of SECTION (a name, any case, or a 1-based position)."""
        names = [s.name for s in self.deck.sections]
        if not names:
            raise click.BadParameter("the deck has no sections", param_hint="SECTION")
        ref = ref.strip()
        if ref.isdigit() and 1 <= int(ref) <= len(names):
            return int(ref) - 1
        found = [k for k, name in enumerate(names) if name.casefold() == ref.casefold()]
        if len(found) == 1:
            return found[0]
        if found:
            places = ", ".join(str(k + 1) for k in found)
            raise click.BadParameter(
                f"{len(found)} sections are called {ref!r} ({places}): "
                + "give its number",
                param_hint="SECTION",
            )
        raise click.BadParameter(
            f"no section {ref!r} (sections: {', '.join(names)})", param_hint="SECTION"
        )

    def section_name(self, k: int) -> str:
        return repr(self.deck.sections[k].name)

    def name(self, index: int) -> str:
        number = self.numbers[index]
        if number is None:
            return f"hidden slide {self.ids[index]}"
        return f"slide {number} ({self.ids[index]})"


def apply_edit(slides: DeckSlides, request: dict[str, object], summary: str) -> Applied:
    """Run one session action as the agent's step ``summary``; print what it
    changed. Exits with the session's message when it is refused."""
    try:
        applied = apply_request(
            slides.path,
            slides.deck,
            slides.hash,
            {**request, "agent": summary},
        )
    except RemoteEditError as exc:
        raise click.ClickException(str(exc)) from exc
    changes = cast("list[dict[str, str]]", applied.result.get("changes") or [])
    if not changes:
        report("Unchanged", summary, style="dim")
        return applied
    report("Done", summary)
    verbs = {
        "modified": "Wrote",
        "created": "Created",
        "deleted": "Deleted",
        "renamed": "Renamed",
    }
    for change in changes:
        kind = change.get("change", "modified")
        detail = change["path"]
        if kind == "renamed":
            detail = f"{change.get('from')} -> {detail}"
        report(verbs.get(kind, kind), detail)
    links = applied.result.get("links")
    if isinstance(links, int) and links:
        report("Relinked", f"{links} slide: link{'s' if links > 1 else ''}")
    if applied.server is None:
        return applied
    report("Undo", f"Ctrl+Z in the editor at {applied.server.url()}", style="dim")
    if applied.build_error:
        last = applied.build_error.strip().splitlines()[-1:]
        report("Build", f"failed after this change: {' '.join(last)}", style="red")
    elif not applied.built:
        report("Build", "the server has not rebuilt yet", style="yellow")
    return applied


def report_rename(result: dict[str, object], dry_run: bool) -> None:
    """Print what a rename changes (``rename`` in a session result): the
    files that move and every reference rewritten, file by file."""
    plan = cast("dict[str, object]", result.get("rename") or {})
    moves = cast("list[dict[str, str]]", plan.get("moves") or [])
    edits = cast("list[dict[str, str]]", plan.get("edits") or [])
    if dry_run:
        for move in moves:
            report("Would move", f"{move['from']} -> {move['to']}", style="yellow")
    for edit in edits:
        report(
            "Would edit" if dry_run else "Reference",
            f"{edit['file']}: {edit['kind']} {edit['old']!r} -> {edit['new']!r}",
            style="yellow" if dry_run else "dim",
        )
    ids = cast("dict[str, str]", plan.get("ids") or {})
    for old, new in ids.items():
        report("Slide id", f"{old} -> {new} (its ink and slide: links follow)")
    for shared in cast("list[str]", plan.get("shared") or []):
        report("Kept", f"{shared}: not this slide's alone", style="dim")
    count, files = plan.get("references", 0), plan.get("files", 0)
    report(
        "References",
        f"{count} in {files} file{'' if files == 1 else 's'}"
        + (" would be updated" if dry_run else " updated"),
        style="yellow" if dry_run else "green",
    )
    for warning in cast("list[str]", plan.get("warnings") or []):
        report("Warning", warning, style="yellow")


def rename_request(
    slides: DeckSlides, request: dict[str, object], summary: str, dry_run: bool
) -> None:
    """Run a ``rename`` session action (``inkflow mv``, ``inkflow slide
    rename-files``): with ``dry_run`` only print what it would change."""
    if not dry_run:
        applied = apply_edit(slides, request, summary)
        report_rename(applied.result, dry_run=False)
        return
    try:
        applied = apply_request(
            slides.path, slides.deck, slides.hash, {**request, "dryRun": True}
        )
    except RemoteEditError as exc:
        raise click.ClickException(str(exc)) from exc
    report_rename(applied.result, dry_run=True)
