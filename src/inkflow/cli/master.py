"""``inkflow layout`` and ``inkflow overlay``: the slide master from the
command line.

A theme's layouts live in an installed package. ``layout copy`` gives the deck
its own copy of one (``layouts/<name>.svg``), which every slide on it then
follows, also through the theme's own chains: a copy of ``base`` is the
background of every built-in layout. ``layout revert`` deletes the copy.
``layout save`` makes a new layout (a template) from a slide. ``overlay new``
adds an overlay, drawn on top of every slide (or of one). ``layout
placeholder`` adds, renames, prompts and removes a layout's placeholders (its
zones), a rename following every slide's content for it; ``layout
placeholders`` lists them.

Like ``inkflow slide``, each command is the visual editor's own session
action (``master``), so with an editor open it is an undoable "Agent: …" step
there (``editor.remote``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides, apply_edit, report_rename
from inkflow.editor.remote import RemoteEditError, apply_request
from inkflow.logging import report


@main.group("layout")
def layout_group() -> None:
    """Change the deck's layouts: the slide master behind every slide.

    A theme's layout is never written: `layout copy` gives the deck its own
    copy (layouts/NAME.svg), which every slide on that layout follows, and
    `layout revert` goes back to the theme's. Copying `base`, the background
    of every built-in layout, changes the background of every slide.
    `layout save` makes a new layout (a template) from a slide. See
    `inkflow layouts` for the names.

    When `inkflow edit` (or `serve`) has the deck open, the change is an
    undoable "Agent: …" step in that editor.
    """


@layout_group.command("copy")
@click.argument("name")
@deck_option
def layout_copy(name: str, deck_path: Path) -> None:
    """Give the deck its own copy of the theme's layout NAME.

    The copy is layouts/NAME.svg; slides on NAME (and layouts built on it)
    follow it from now on. Edit it in the editor's slide master or in
    Inkscape; `inkflow layout revert NAME` goes back to the theme's.
    """
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {"action": "master", "op": "copy", "name": name},
        f"Copy layout {name} into the deck",
    )
    _note(applied.result)


@layout_group.command("revert")
@click.argument("name")
@deck_option
def layout_revert(name: str, deck_path: Path) -> None:
    """Delete the deck's copy of layout NAME: slides go back to the theme's."""
    slides = DeckSlides.load(deck_path)
    _ = apply_edit(
        slides,
        {"action": "master", "op": "revert", "name": name},
        f"Revert layout {name} to the theme's",
    )


@layout_group.command("save")
@click.argument("ref", metavar="SLIDE")
@click.argument("name")
@deck_option
@click.option(
    "--hints",
    is_flag=True,
    help="Keep the slide's text as each empty zone's placeholder prompt.",
)
@click.option(
    "--pictures",
    is_flag=True,
    help="Turn the slide's own pictures into picture placeholders.",
)
def layout_save(
    ref: str, name: str, deck_path: Path, hints: bool, pictures: bool
) -> None:
    """Save SLIDE as a new layout called NAME (a template).

    NAME is kept as typed for the editor ("customCodeExamples"); the file is
    layouts/<name in kebab case>.svg (custom-code-examples.svg). The slide's
    drawing and the layout it is built on carry over; its zones stay, empty.
    New slides then use it: `inkflow slide add --layout custom-code-examples`.
    """
    slides = DeckSlides.load(deck_path)
    index = slides.index(ref)
    applied = apply_edit(
        slides,
        {
            "action": "master",
            "op": "save",
            "slide": index,
            "name": name,
            "hints": hints,
            "pictures": pictures,
        },
        f"Save {slides.name(index)} as layout {name}",
    )
    stem = applied.result.get("layout")
    if isinstance(stem, str):
        report("Layout", f"{stem}: inkflow slide add --layout {stem}")


@layout_group.command("rename")
@click.argument("name")
@click.argument("new")
@deck_option
def layout_rename(name: str, new: str, deck_path: Path) -> None:
    """Rename the deck's own layout NAME to NEW, every reference following.

    A copy of a theme's layout keeps the theme's name (it replaces that
    layout); save a slide as a new layout instead.
    """
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {"action": "master", "op": "rename", "name": name, "to": new},
        f"Rename layout {name} to {new}",
    )
    if "rename" in applied.result:
        report_rename(applied.result, dry_run=False)


@layout_group.command("delete")
@click.argument("name")
@deck_option
@click.option(
    "--move-to",
    default=None,
    metavar="LAYOUT",
    help="Move the slides (and layouts) built on NAME to LAYOUT first.",
)
def layout_delete(name: str, deck_path: Path, move_to: str | None) -> None:
    """Delete the deck's own layout NAME.

    Refused while slides or other layouts are built on it, unless --move-to
    names the layout they move to. A copy of a theme's layout is reverted
    with `inkflow layout revert` instead.
    """
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {"action": "master", "op": "delete", "name": name}
    if move_to:
        request["moveTo"] = move_to
    _ = apply_edit(slides, request, f"Delete layout {name}")


@main.group("overlay")
def overlay_group() -> None:
    """Change the deck's overlays: what is drawn on top of every slide.

    An overlay (overlays/NAME.svg) holds the chrome every slide shows
    whatever its layout: a logo, footer text, the slide number. `overlay new`
    creates one at the deck's size and adds it to `Deck(overlays=[...])`.
    """


@overlay_group.command("new")
@click.argument("name")
@deck_option
@click.option(
    "--all",
    "every",
    is_flag=True,
    default=True,
    help="On every slide: added to Deck(overlays=[...]) [default].",
)
@click.option(
    "--slide",
    "ref",
    default=None,
    metavar="SLIDE",
    help="On SLIDE only: added to its own Slide(overlays=[...]).",
)
def overlay_new(name: str, deck_path: Path, every: bool, ref: str | None) -> None:
    """Create an empty overlay NAME and put it on top of every slide.

    It is overlays/<name>.svg at the deck's size (Deck(size=...), else the
    background layout's), added after the overlays the deck (or with --slide,
    that slide) already gets. Draw into it in the editor's slide master
    ("All slides · On top") or in Inkscape.
    """
    _ = every
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {"action": "master", "op": "new-overlay", "name": name}
    summary = f"New overlay {name}"
    if ref is not None:
        index = slides.index(ref)
        request["slide"] = index
        summary += f" on {slides.name(index)}"
    applied = apply_edit(slides, request, summary)
    _note(applied.result)


@overlay_group.command("copy")
@click.argument("name")
@deck_option
def overlay_copy(name: str, deck_path: Path) -> None:
    """Give the deck its own copy of the theme's overlay NAME."""
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {"action": "master", "op": "copy", "kind": "overlay", "name": name},
        f"Copy overlay {name} into the deck",
    )
    _note(applied.result)


@overlay_group.command("revert")
@click.argument("name")
@deck_option
def overlay_revert(name: str, deck_path: Path) -> None:
    """Delete the deck's copy of overlay NAME: the theme's is used again."""
    slides = DeckSlides.load(deck_path)
    _ = apply_edit(
        slides,
        {"action": "master", "op": "revert", "kind": "overlay", "name": name},
        f"Revert overlay {name} to the theme's",
    )


def _note(result: dict[str, object]) -> None:
    copied = result.get("copied")
    if isinstance(copied, dict):
        note = cast("dict[str, str]", copied).get("note", "")
        report("Note", note, style="dim")
    overlay = result.get("overlay")
    if isinstance(overlay, dict):
        made = cast("dict[str, str]", overlay)
        report("Overlay", f"{made.get('name')} is drawn on {made.get('where')}")


# ── Placeholders ──────────────────────────────────────────────────────────────


def _box(raw: str | None) -> dict[str, float]:
    if raw is None:
        return {}
    try:
        x, y, w, h = (float(v) for v in raw.split(","))
    except ValueError as exc:
        raise click.BadParameter(
            "give the box as x,y,width,height", param_hint="--box"
        ) from exc
    return {"x": x, "y": y, "width": w, "height": h}


def _where(layout: str, overlay: bool) -> dict[str, object]:
    return {"overlay": layout} if overlay else {"layout": layout}


def _report_plan(result: dict[str, object], dry_run: bool) -> None:
    plan = cast("dict[str, object]", result.get("placeholder") or {})
    for edit in cast("list[str]", plan.get("edits") or []):
        report(
            "Would edit" if dry_run else "Edited",
            edit,
            style="yellow" if dry_run else "dim",
        )
    names = cast("list[str]", plan.get("slideNames") or [])
    if names:
        report("Slides", ", ".join(names), style="yellow" if dry_run else "green")
    for warning in cast("list[str]", plan.get("warnings") or []):
        report("Warning", warning, style="yellow")


_overlay_flag = click.option(
    "--overlay",
    is_flag=True,
    help="LAYOUT names an overlay (drawn on top of every slide).",
)


@layout_group.command("placeholders")
@click.argument("layout")
@deck_option
@_overlay_flag
@click.option("--json", "as_json", is_flag=True, help="Print JSON.")
def layout_placeholders(
    layout: str, deck_path: Path, overlay: bool, as_json: bool
) -> None:
    """List the placeholders (zones) of LAYOUT.

    Each with its kind (text, or picture for a zone named for one), its
    prompt (what the empty zone says on a new slide), its box, the layout it
    is written in (LAYOUT's own, or one it is built on) and the slides that
    fill it.
    """
    from inkflow.editor.session import EditError, EditorSession

    slides = DeckSlides.load(deck_path)
    session = EditorSession(slides.path)
    try:
        info = session.apply(
            {"action": "master-placeholders", **_where(layout, overlay)}, slides.deck
        )
    except EditError as exc:
        raise click.ClickException(str(exc)) from exc
    found = cast("list[dict[str, object]]", info["placeholders"])
    if as_json:
        out = {
            "layout": info["name"],
            "file": info["file"],
            "slides": info["slides"],
            "placeholders": found,
        }
        click.echo(json.dumps(out, indent=2))
        return
    users = cast("list[int]", info["slides"])
    report("Layout", f"{info['name']} · on {len(users)} slide{'s' * (len(users) != 1)}")
    for p in found:
        box = ",".join(f"{v:g}" for v in cast("list[float]", p["box"]))
        filled = cast("list[int]", p["filled"])
        shown = ", ".join(
            str(slides.numbers[i]) if slides.numbers[i] is not None else slides.ids[i]
            for i in filled
        )
        where = "" if p["own"] else f" (from {p['layout']})"
        prompt = f" · prompt {p['prompt']!r}" if p["prompt"] else ""
        fills = f"filled on slides {shown}" if filled else "no slide fills it"
        report(
            str(p["name"]),
            f"{p['kind']} · box {box}{where}{prompt} · {fills}",
            style="green" if p["own"] else "dim",
        )


@layout_group.group("placeholder")
def placeholder_group() -> None:
    """Add, rename, prompt or remove a layout's placeholders (its zones).

    A placeholder is an empty zone each slide on the layout fills with its
    own text or picture; its prompt is what the empty zone says on a new
    slide. A theme's layout is copied into the deck on the first change, as
    the editor's slide master does.
    """


@placeholder_group.command("add")
@click.argument("layout")
@click.argument("name")
@deck_option
@_overlay_flag
@click.option(
    "--kind",
    type=click.Choice(["text", "picture"]),
    default="text",
    show_default=True,
    help="A text placeholder, or one for a picture or video.",
)
@click.option("--prompt", default=None, help="What the empty zone says on a new slide.")
@click.option(
    "--box", default=None, metavar="X,Y,W,H", help="Its box [default: the middle]."
)
def placeholder_add(
    layout: str,
    name: str,
    deck_path: Path,
    overlay: bool,
    kind: str,
    prompt: str | None,
    box: str | None,
) -> None:
    """Add the placeholder NAME to LAYOUT (zone-NAME).

    A picture placeholder's name says it is one: `hero` becomes
    zone-picture-hero. Refused when a slide on LAYOUT already has the name.
    """
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {
        "action": "master",
        "op": "add-zone",
        **_where(layout, overlay),
        "zoneKind": kind,
        "name": name,
        "exact": True,
        "previews": True,
        **_box(box),
    }
    if prompt:
        request["prompt"] = prompt
    applied = apply_edit(slides, request, f"Add {kind} placeholder {name} to {layout}")
    _note(applied.result)
    zone = applied.result.get("zone")
    if isinstance(zone, str):
        report("Zone", f"zone-{zone}: slides fill it with ::{zone}:: in their Markdown")


@placeholder_group.command("rename")
@click.argument("layout")
@click.argument("old")
@click.argument("new")
@deck_option
@_overlay_flag
@click.option("-n", "--dry-run", is_flag=True, help="Only say what would change.")
def placeholder_rename(
    layout: str, old: str, new: str, deck_path: Path, overlay: bool, dry_run: bool
) -> None:
    """Rename placeholder OLD of LAYOUT to NEW, the slides following.

    On every slide built on LAYOUT (also through a layout built on it):
    `::OLD::` in its Markdown, `zones={"OLD": ...}` and animations aimed at
    zone-OLD. Refused when one of them already uses NEW.
    """
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {
        "action": "master",
        "op": "zone-rename",
        **_where(layout, overlay),
        "zone": old,
        "to": new,
        "previews": True,
    }
    if dry_run:
        try:
            applied = apply_request(
                slides.path, slides.deck, slides.hash, {**request, "dryRun": True}
            )
        except RemoteEditError as exc:
            raise click.ClickException(str(exc)) from exc
        _report_plan(applied.result, dry_run=True)
        return
    applied = apply_edit(
        slides, request, f"Rename placeholder {old} to {new} on layout {layout}"
    )
    _note(applied.result)
    _report_plan(applied.result, dry_run=False)


@placeholder_group.command("prompt")
@click.argument("layout")
@click.argument("name")
@click.argument("text", required=False)
@deck_option
@_overlay_flag
@click.option("--clear", is_flag=True, help="Remove the prompt.")
def placeholder_prompt(
    layout: str,
    name: str,
    text: str | None,
    deck_path: Path,
    overlay: bool,
    clear: bool,
) -> None:
    """Set the prompt of placeholder NAME of LAYOUT: what its empty zone says
    on a new slide, and the text a click there types in."""
    if clear == (text is not None):
        raise click.UsageError("give the prompt TEXT, or --clear")
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {
            "action": "master",
            "op": "zone-prompt",
            **_where(layout, overlay),
            "zone": name,
            "prompt": "" if clear else text,
            "previews": True,
        },
        f"{'Clear' if clear else 'Set'} the prompt of {name} on layout {layout}",
    )
    _note(applied.result)


@placeholder_group.command("remove")
@click.argument("layout")
@click.argument("name")
@deck_option
@_overlay_flag
@click.option(
    "--drop-content",
    is_flag=True,
    help="Also delete what the slides put in it (their ::NAME:: text, zones= entry).",
)
def placeholder_remove(
    layout: str, name: str, deck_path: Path, overlay: bool, drop_content: bool
) -> None:
    """Remove placeholder NAME from LAYOUT.

    A placeholder made from a drawn shape stays as that shape. The slides'
    content for it stays in their files (and no longer shows) unless
    --drop-content.
    """
    slides = DeckSlides.load(deck_path)
    applied = apply_edit(
        slides,
        {
            "action": "master",
            "op": "zone-remove",
            **_where(layout, overlay),
            "zone": name,
            "dropContent": drop_content,
            "previews": True,
        },
        f"Remove placeholder {name} from layout {layout}",
    )
    _report_plan(applied.result, dry_run=False)
