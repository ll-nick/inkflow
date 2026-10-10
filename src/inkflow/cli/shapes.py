"""``inkflow shape``: draw on a slide the way the visual editor does.

Shapes, text boxes, pictures, charts and arrows attached to shapes, made by
the editor's own session actions (see ``editor/shapes.py``): an arrow's path
is routed exactly as the editor routes it, a text box is its zone and its
Markdown in one step, ids stay unique, moving a shape takes its arrows along,
and renaming one keeps its arrows and animations attached.

With ``inkflow edit``/``serve`` open on the deck, every command is one step in
the editor's undo history ("Agent: …"), shown at once; otherwise the files are
changed directly. ``batch`` runs a list of commands as a single step.
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar, cast

import click

from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides, apply_edit
from inkflow.editor.context import read_context
from inkflow.editor.scene import Scene, own_file
from inkflow.editor.shapes import (
    ALIGN,
    ANCHORS,
    ARROWS,
    CHART_KINDS,
    KINDS,
    ORDER,
    ShapeError,
    describe,
    layout_targets,
    parse_commands,
)
from inkflow.editor.svgops import file_hash
from inkflow.logging import report

CONTEXT_MAX_AGE = 2 * 60 * 60
"""How recent the editor's reported slide must be to stand in for ``-s``."""

F = TypeVar("F", bound=Callable[..., object])

_VERBS = {
    "add": "Created",
    "connect": "Connected",
    "duplicate": "Created",
    "group": "Grouped",
    "own drawing": "Detached",
}


def _common(fn: F) -> F:
    """``-d/--deck``, ``-s/--slide`` and ``--json`` on every command."""
    fn = click.option(
        "--json", "as_json", is_flag=True, help="Print the result as JSON."
    )(fn)
    fn = click.option(
        "-s",
        "--slide",
        "slide_ref",
        default=None,
        metavar="SLIDE",
        help="Slide number or id [default: the slide open in the editor].",
    )(fn)
    return deck_option(fn)


def _slide_index(slides: DeckSlides, ref: str | None) -> int:
    """SLIDE, or the slide the editor shows (its recent context)."""
    if ref is not None:
        return slides.index(ref)
    data = read_context(slides.project_dir) or {}
    updated = data.get("updatedAt")
    fresh = isinstance(updated, int | float) and time.time() - updated < CONTEXT_MAX_AGE
    deck = data.get("deck")
    same = isinstance(deck, str) and Path(deck).resolve() == slides.path
    slide = data.get("slide")
    if fresh and same and isinstance(slide, dict):
        info = cast("dict[str, object]", slide)
        index: int | None = None
        if isinstance(info.get("id"), str) and info["id"] in slides.ids:
            index = slides.ids.index(str(info["id"]))
        elif isinstance(info.get("deckIndex"), int):
            index = int(cast("int", info["deckIndex"]))
        if index is not None and 0 <= index < len(slides.ids):
            report("Slide", f"{slides.name(index)}, open in the editor", style="dim")
            return index
    raise click.UsageError(
        "say which slide: -s/--slide SLIDE (a number or an id); "
        + "without it, the slide open in `inkflow edit` is used"
    )


def _send(
    deck_path: Path,
    slide_ref: str | None,
    commands: list[dict[str, object]],
    summary: str,
    as_json: bool,
) -> None:
    """Run shape commands on one slide as one step; print what they did."""
    try:
        parse_commands(commands)
    except ShapeError as exc:
        raise click.UsageError(str(exc)) from exc
    slides = DeckSlides.load(deck_path)
    index = _slide_index(slides, slide_ref)
    request: dict[str, object] = {
        "action": "shape",
        "slide": index,
        "commands": commands,
    }
    own = own_file(slides.deck.slides[index], slides.deck, slides.project_dir)
    if own is not None:
        # What the commands were worked out against: refused if it changes.
        request["hash"] = file_hash(own.read_bytes())
    applied = apply_edit(slides, request, f"{summary} on {slides.name(index)}")
    result = applied.result
    reports = cast("list[dict[str, object]]", result.get("shapes") or [])
    if as_json:
        click.echo(
            json.dumps(
                {
                    "slide": slides.name(index),
                    "created": result.get("created") or [],
                    "commands": reports,
                    "changes": result.get("changes") or [],
                    "step": result.get("step"),
                    "server": applied.server.url() if applied.server else None,
                },
                indent=2,
            )
        )
        return
    for item in reports:
        command = str(item.get("command"))
        ids = ", ".join(str(i) for i in cast("list[object]", item.get("ids") or []))
        detail = str(item.get("detail") or "")
        verb = _VERBS.get(command.split(" ")[0], command.split(" ")[0].title())
        text = f"{ids} ({command})" if ids else ""
        report(verb, ": ".join(filter(None, [text, detail])) or command)


def _command(name: str, args: list[str] | str, **opts: object) -> dict[str, object]:
    out: dict[str, object] = {name: args}
    out.update({k.replace("_", "-"): v for k, v in opts.items() if v is not None})
    return out


@main.group()
def shape() -> None:
    """Draw on a slide as the visual editor does: shapes, text boxes, arrows.

    Every command acts on one slide (-s/--slide: its number as the presenter
    counts or its id; without it, the slide open in `inkflow edit`) and finds
    objects by id (`inkflow shape list` shows them; a zone's `zone-` may be
    left off). Coordinates are slide units (the slide's viewBox, 1920x1080 for
    the built-in layouts), X,Y and W,H as two numbers: --at 100,200.

    Arrows stay attached to their shapes (inkflow:connect-start/-end), routed
    exactly as the editor routes them, and follow the shapes they connect when
    `move`, `resize`, `align` or `distribute` moves them. After moving shapes
    any other way (Inkscape, a hand edit), `reroute` puts the arrows back on
    them; `inkflow verify` warns about arrows that no longer meet their shapes.

    With `inkflow edit` open on the deck, each command is one undoable step in
    the editor ("Agent: …"); `batch` runs many as one step.
    """


@shape.command("add")
@click.argument("kind", type=click.Choice(KINDS), metavar="KIND")
@_common
@click.option(
    "--at",
    default=None,
    metavar="X,Y",
    help="Top-left corner (a text's baseline start).",
)
@click.option("--size", default=None, metavar="W,H", help="Width and height.")
@click.option(
    "--id",
    "element_id",
    default=None,
    help="Its id (a text box's or chart's: its zone name).",
)
@click.option(
    "--text",
    default=None,
    help="Text: in a rect/ellipse (it becomes a text zone), a text box's "
    + "Markdown, a text's line(s).",
)
@click.option(
    "--fill",
    default=None,
    metavar="COLOUR",
    help="Theme colour (accent, surface, …), #hex or none.",
)
@click.option(
    "--stroke",
    default=None,
    metavar="COLOUR",
    help="Outline colour: theme colour, #hex or none.",
)
@click.option("--stroke-width", default=None, type=float, help="Outline width.")
@click.option("--rx", default=None, type=float, help="A rect's corner radius [16].")
@click.option("--font-size", default=None, type=float, help="A text's size [56].")
@click.option(
    "--from", "start", default=None, metavar="X,Y", help="A line's or arrow's start."
)
@click.option(
    "--to", "end", default=None, metavar="X,Y", help="A line's or arrow's end."
)
@click.option(
    "--style",
    default=None,
    type=click.Choice(["straight", "elbow", "curved"]),
    help="A line's route.",
)
@click.option("--arrow", default=None, type=click.Choice(ARROWS), help="Arrowheads.")
@click.option(
    "--src",
    default=None,
    metavar="FILE",
    help="An image's file (copied into assets/ from outside the project).",
)
@click.option("--page", default=None, type=int, help="A PDF's page.")
@click.option(
    "--drawio",
    "drawio_mode",
    default=None,
    type=click.Choice(["inline", "themed", "picture"]),
    help="A draw.io diagram drawn into the slide (its shapes take arrows).",
)
@click.option(
    "--data",
    default=None,
    metavar="FILE",
    help="A chart's data (CSV, TSV, JSON, Markdown table) [a sample table].",
)
@click.option(
    "--chart",
    "chart_kind",
    default=None,
    type=click.Choice(CHART_KINDS),
    help="A chart's kind [bar].",
)
@click.option("--title", default=None, help="A chart's title.")
def add(
    kind: str,
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    at: str | None,
    size: str | None,
    element_id: str | None,
    text: str | None,
    fill: str | None,
    stroke: str | None,
    stroke_width: float | None,
    rx: float | None,
    font_size: float | None,
    start: str | None,
    end: str | None,
    style: str | None,
    arrow: str | None,
    src: str | None,
    page: int | None,
    drawio_mode: str | None,
    data: str | None,
    chart_kind: str | None,
    title: str | None,
) -> None:
    """Add a rect, ellipse, line, arrow, text, textbox, image or chart.

    \b
    rect, ellipse  the editor's shape (surface fill, accent outline); --text
                   puts text in it: it becomes a text zone (id zone-<id>),
                   its text in the slide's Markdown
    line, arrow    free ends --from X,Y --to X,Y (`connect` attaches one)
    text           an SVG <text> line at --at (its baseline)
    textbox        a wrapping Markdown text box: a zone-text rect, its text
                   a section of the slide's Markdown
    image          --src FILE (a PDF shows --page)
    chart          --data FILE, or a sample table to edit in the editor
    """
    if src is not None and not Path(src).is_absolute():
        src = str(Path(src).resolve())
    if data is not None and not Path(data).is_absolute():
        data = str(Path(data).resolve())
    command = _command(
        "add",
        kind,
        at=at,
        size=size,
        id=element_id,
        text=text,
        fill=fill,
        stroke=stroke,
        stroke_width=stroke_width,
        rx=rx,
        font_size=font_size,
        **{"from": start, "to": end},
        style=style,
        arrow=arrow,
        src=src,
        page=page,
        drawio=drawio_mode,
        data=data,
        chart=chart_kind,
        title=title,
    )
    _send(deck_path, slide_ref, [command], f"Add {kind}", as_json)


@shape.command("connect")
@click.argument("a", metavar="A")
@click.argument("b", metavar="B")
@_common
@click.option(
    "--from",
    "site_a",
    default=None,
    metavar="SITE",
    help="Where on A: top|right|bottom|left or side@fraction (top@0.25) [the nearest].",
)
@click.option(
    "--to", "site_b", default=None, metavar="SITE", help="Where on B [the nearest]."
)
@click.option(
    "--style",
    default=None,
    type=click.Choice(["straight", "elbow", "curved"]),
    help="The route [straight].",
)
@click.option(
    "--arrow", default=None, type=click.Choice(ARROWS), help="Arrowheads [end]."
)
@click.option(
    "--bend",
    default=None,
    metavar="x:N|y:N",
    help="An elbow's adjustable segment, in slide units.",
)
@click.option("--id", "element_id", default=None, help="The arrow's id.")
@click.option(
    "--stroke", default=None, metavar="COLOUR", help="Its colour: theme colour or #hex."
)
@click.option("--stroke-width", default=None, type=float, help="Its width [6].")
def connect(
    a: str,
    b: str,
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    site_a: str | None,
    site_b: str | None,
    style: str | None,
    arrow: str | None,
    bend: str | None,
    element_id: str | None,
    stroke: str | None,
    stroke_width: float | None,
) -> None:
    """Draw an arrow from A to B, attached to both (it follows them).

    A and B are ids of shapes, zones or the shapes of a draw.io diagram drawn
    into the slide (`<diagram id>-<cell id>`). Without --from/--to the arrow
    joins the two connection points nearest each other, of those the shapes
    offer (`sites`); a named site is used whether offered or not.
    """
    command = _command(
        "connect",
        [a, b],
        **{"from": site_a, "to": site_b},
        style=style,
        arrow=arrow,
        bend=bend,
        id=element_id,
        stroke=stroke,
        stroke_width=stroke_width,
    )
    _send(deck_path, slide_ref, [command], f"Connect {a} to {b}", as_json)


@shape.command("sites")
@click.argument("element_id", metavar="ID")
@click.argument("count", metavar="N", type=click.IntRange(1, 9))
@_common
def sites(
    element_id: str, count: int, deck_path: Path, slide_ref: str | None, as_json: bool
) -> None:
    """Offer N connection points per side on ID (1 = each side's middle)."""
    _send(
        deck_path,
        slide_ref,
        [_command("sites", [element_id, str(count)])],
        f"Connection points on {element_id}",
        as_json,
    )


@shape.command("reroute")
@click.argument("ids", nargs=-1, metavar="[ID]...")
@_common
@click.option("--all", "every_slide", is_flag=True, help="Every slide (one step each).")
def reroute(
    ids: tuple[str, ...],
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    every_slide: bool,
) -> None:
    """Re-attach arrows to their shapes where the shapes are now.

    IDs are arrows, or shapes whose arrows to re-route; none: every arrow
    attached on the slide (the editor's "Re-route all"). Use it after moving
    shapes in Inkscape, draw.io or by hand.
    """
    if not every_slide:
        _send(
            deck_path,
            slide_ref,
            [_command("reroute", list(ids))],
            "Re-route arrows",
            as_json,
        )
        return
    if ids or slide_ref:
        raise click.UsageError(
            "--all re-routes every arrow of every slide: no IDs or --slide"
        )
    slides = DeckSlides.load(deck_path)
    stale: list[int] = []
    for index, slide in enumerate(slides.deck.slides):
        if own_file(slide, slides.deck, slides.project_dir) is None:
            continue
        try:
            scene = Scene.compose(
                slides.project_dir, slides.deck, slide, slides.ids[index]
            )
        except (ValueError, OSError):
            continue  # `inkflow verify` says what is wrong with it
        if any(
            scene.connector_path(c) not in (None, c.get("d"))
            for c in scene.attached()
            if not scene.ends_on_text(c)
        ):
            stale.append(index)
    if not stale:
        report("Unchanged", "every attached arrow meets its shapes", style="dim")
        return
    for index in stale:
        slides = DeckSlides.load(deck_path)
        _send(
            deck_path,
            slides.ids[index],
            [_command("reroute", [])],
            "Re-route arrows",
            as_json,
        )


def _ids_command(name: str, summary: str, help_text: str) -> None:
    """A command taking IDs only (delete, lock, …)."""

    @click.argument("ids", nargs=-1, required=True, metavar="ID...")
    @_common
    def command(
        ids: tuple[str, ...], deck_path: Path, slide_ref: str | None, as_json: bool
    ) -> None:
        _send(
            deck_path,
            slide_ref,
            [_command(name, list(ids))],
            f"{summary} {', '.join(ids)}",
            as_json,
        )

    command.__doc__ = help_text
    shape.command(name)(command)


@shape.command("move")
@click.argument("ids", nargs=-1, required=True, metavar="ID...")
@_common
@click.option("--by", default=None, metavar="DX,DY", help="Move by this much.")
@click.option(
    "--to",
    "to",
    default=None,
    metavar="X,Y",
    help="Move the top-left corner (of them all) here.",
)
def move(
    ids: tuple[str, ...],
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    by: str | None,
    to: str | None,
) -> None:
    """Move objects; arrows attached to them follow (an arrow moved without
    the shape at one end lets go of it there, as in the editor)."""
    _send(
        deck_path,
        slide_ref,
        [_command("move", list(ids), by=by, to=to)],
        f"Move {', '.join(ids)}",
        as_json,
    )


@shape.command("resize")
@click.argument("element_id", metavar="ID")
@_common
@click.option("--size", required=True, metavar="W,H", help="The new width and height.")
@click.option(
    "--anchor",
    default=None,
    type=click.Choice(ANCHORS),
    help="What stays put [top-left].",
)
def resize(
    element_id: str,
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    size: str,
    anchor: str | None,
) -> None:
    """Resize an object (its box, in slide units); its arrows follow."""
    _send(
        deck_path,
        slide_ref,
        [_command("resize", element_id, size=size, anchor=anchor)],
        f"Resize {element_id}",
        as_json,
    )


@shape.command("align")
@click.argument("ids", nargs=-1, required=True, metavar="ID...")
@click.argument("how", type=click.Choice(ALIGN), metavar="HOW")
@_common
@click.option(
    "--to",
    "to",
    default=None,
    type=click.Choice(["slide"]),
    help="Align to the slide, not to each other.",
)
def align(
    ids: tuple[str, ...],
    how: str,
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    to: str | None,
) -> None:
    """Line objects up: left|center|right|top|middle|bottom (one object: on
    the slide), as the editor's Align buttons do."""
    _send(
        deck_path,
        slide_ref,
        [_command("align", [*ids, how], to=to)],
        f"Align {', '.join(ids)} {how}",
        as_json,
    )


@shape.command("distribute")
@click.argument("ids", nargs=-1, required=True, metavar="ID...")
@click.argument(
    "how", type=click.Choice(["horizontal", "vertical"]), metavar="horizontal|vertical"
)
@_common
def distribute(
    ids: tuple[str, ...],
    how: str,
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
) -> None:
    """Space three or more objects evenly between the outermost two."""
    _send(
        deck_path,
        slide_ref,
        [_command("distribute", [*ids, how])],
        f"Distribute {', '.join(ids)}",
        as_json,
    )


@shape.command("style")
@click.argument("ids", nargs=-1, required=True, metavar="ID...")
@_common
@click.option(
    "--fill",
    default=None,
    metavar="COLOUR",
    help="Theme colour (accent, surface, …), #hex or none.",
)
@click.option(
    "--stroke",
    default=None,
    metavar="COLOUR",
    help="Outline: theme colour, #hex or none.",
)
@click.option("--stroke-width", default=None, type=float, help="Outline width.")
@click.option("--opacity", default=None, type=click.FloatRange(0, 1), help="0 to 1.")
def style(
    ids: tuple[str, ...],
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    fill: str | None,
    stroke: str | None,
    stroke_width: float | None,
    opacity: float | None,
) -> None:
    """Colour objects: a theme colour follows the deck's theme and mode; a
    text box shows its frame once styled."""
    command = _command(
        "style",
        list(ids),
        fill=fill,
        stroke=stroke,
        stroke_width=stroke_width,
        opacity=opacity,
    )
    _send(deck_path, slide_ref, [command], f"Style {', '.join(ids)}", as_json)


@shape.command("text")
@click.argument("element_id", metavar="ID")
@click.argument("text", metavar="TEXT")
@_common
def text_cmd(
    element_id: str, text: str, deck_path: Path, slide_ref: str | None, as_json: bool
) -> None:
    """Set the text of a <text>, of a zone (its Markdown), or type it into a
    rect or ellipse (which becomes a text zone). TEXT `-` reads stdin."""
    if text == "-":
        text = sys.stdin.read().rstrip("\n")
    _send(
        deck_path,
        slide_ref,
        [_command("text", [element_id, text])],
        f"Text of {element_id}",
        as_json,
    )


_ids_command("delete", "Delete", "Delete objects; a zone's text or media goes with it.")
_ids_command("group", "Group", "Group objects side by side in the same layer.")
_ids_command("lock", "Lock", "Lock objects (the editor will not select them).")
_ids_command("unlock", "Unlock", "Unlock objects.")
_ids_command("hide", "Hide", "Hide objects (display:none, in the presentation too).")
_ids_command("show", "Show", "Show hidden objects.")


@shape.command("duplicate")
@click.argument("element_id", metavar="ID")
@_common
@click.option("--by", default=None, metavar="DX,DY", help="Offset of the copy [24,24].")
def duplicate(
    element_id: str,
    deck_path: Path,
    slide_ref: str | None,
    as_json: bool,
    by: str | None,
) -> None:
    """Copy an object (a zone with its content)."""
    _send(
        deck_path,
        slide_ref,
        [_command("duplicate", element_id, by=by)],
        f"Duplicate {element_id}",
        as_json,
    )


@shape.command("ungroup")
@click.argument("element_id", metavar="ID")
@_common
def ungroup(
    element_id: str, deck_path: Path, slide_ref: str | None, as_json: bool
) -> None:
    """Dissolve a group, keeping where its objects are."""
    _send(
        deck_path,
        slide_ref,
        [_command("ungroup", element_id)],
        f"Ungroup {element_id}",
        as_json,
    )


@shape.command("order")
@click.argument("element_id", metavar="ID")
@click.argument(
    "where", type=click.Choice(ORDER), metavar="front|back|forward|backward"
)
@_common
def order(
    element_id: str, where: str, deck_path: Path, slide_ref: str | None, as_json: bool
) -> None:
    """Bring an object to the front or send it back."""
    _send(
        deck_path,
        slide_ref,
        [_command("order", [element_id, where])],
        f"Arrange {element_id}",
        as_json,
    )


@shape.command("rename")
@click.argument("element_id", metavar="ID")
@click.argument("new_id", metavar="NEW")
@_common
def rename(
    element_id: str, new_id: str, deck_path: Path, slide_ref: str | None, as_json: bool
) -> None:
    """Give an object a new id: arrows attached to it, its animations in
    deck.py and (for a draw.io diagram) its shapes' names follow."""
    _send(
        deck_path,
        slide_ref,
        [_command("rename", [element_id, new_id])],
        f"Rename {element_id} to {new_id}",
        as_json,
    )


@shape.command("link")
@click.argument("element_id", metavar="ID")
@click.argument("target", metavar="TARGET")
@_common
def link(
    element_id: str, target: str, deck_path: Path, slide_ref: str | None, as_json: bool
) -> None:
    """Link an object: `slide:<id>`, a slide number, a URL; `none` removes it."""
    _send(
        deck_path,
        slide_ref,
        [_command("link", [element_id, target])],
        f"Link {element_id}",
        as_json,
    )


@shape.command("batch")
@click.argument("source", default="-", metavar="[FILE]")
@_common
def batch(source: str, deck_path: Path, slide_ref: str | None, as_json: bool) -> None:
    """Run a JSON list of commands as ONE step (one undo, one rebuild).

    Each command is an object whose first key names it, its value the
    command's arguments, and whose other keys are its options by their
    long names (from FILE, or stdin):

    \b
      [{"add": "rect", "id": "a", "at": [200, 400], "text": "Draft"},
       {"add": "rect", "id": "b", "at": [800, 400], "text": "Review"},
       {"connect": ["a", "b"], "style": "elbow"},
       {"style": ["b"], "fill": "accent"}]

    Later commands see what earlier ones made (ids, zones, arrows). One
    refused command leaves nothing changed.
    """
    try:
        text = sys.stdin.read() if source == "-" else Path(source).read_text("utf-8")
        raw = cast("object", json.loads(text))
    except OSError as exc:
        raise click.UsageError(f"cannot read {source}: {exc}") from exc
    except ValueError as exc:
        raise click.UsageError(f"batch takes a JSON list of commands: {exc}") from exc
    if isinstance(raw, dict) and "commands" in raw:
        data = cast("dict[str, object]", raw)
        if slide_ref is None and data.get("slide") is not None:
            slide_ref = str(data["slide"])
        raw = data["commands"]
    if not isinstance(raw, list):
        raise click.UsageError("batch takes a JSON list of commands")
    commands = cast("list[dict[str, object]]", raw)
    for command in commands:
        if "add" in command:
            for key in ("src", "data"):
                value = command.get(key)
                if isinstance(value, str) and not Path(value).is_absolute():
                    command[key] = str(Path(value).resolve())
    n = len(commands)
    _send(
        deck_path,
        slide_ref,
        commands,
        f"{n} shape command{'s' if n != 1 else ''}",
        as_json,
    )


@shape.command("list")
@_common
def list_cmd(deck_path: Path, slide_ref: str | None, as_json: bool) -> None:
    """The slide's own objects: id, kind, box (x,y WxH in slide units), text,
    and each arrow's ends (`id:site`), flagged `stale` when they no longer
    meet their shapes. Then the ids its layout and overlays name (arrows may
    attach to those)."""
    slides = DeckSlides.load(deck_path)
    index = _slide_index(slides, slide_ref)
    slide = slides.deck.slides[index]
    scene = Scene.compose(slides.project_dir, slides.deck, slide, slides.ids[index])
    objects = describe(scene, slide, slides.project_dir)
    targets = layout_targets(scene)
    own = own_file(slide, slides.deck, slides.project_dir)
    size = scene.size()
    if as_json:
        click.echo(
            json.dumps(
                {
                    "slide": slides.name(index),
                    "file": own.relative_to(slides.project_dir).as_posix()
                    if own
                    else None,
                    "size": [size.width, size.height],
                    "objects": objects,
                    "layout": targets,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return
    where = (
        own.relative_to(slides.project_dir).as_posix()
        if own
        else "drawn straight from a shared layout (no drawing of its own yet)"
    )
    click.echo(f"{slides.name(index)}: {where}, {size.width:g}x{size.height:g}")
    if not objects:
        click.echo("  (nothing drawn on it yet)")
    for item in objects:
        click.echo("  " + _line(item))
    names = [str(t["id"]) for t in targets]
    if names:
        click.echo(f"layout and overlays: {', '.join(names)}")


def _line(item: dict[str, object]) -> str:
    box = cast("list[float] | None", item.get("box"))
    where = f"{box[0]:g},{box[1]:g} {box[2]:g}x{box[3]:g}" if box else "-"
    parts = [str(item.get("id") or "(no id)"), str(item.get("kind")), where]
    ends = cast("dict[str, object] | None", item.get("ends"))
    if ends is not None:
        parts.append(f"{ends.get('start') or 'free'} -> {ends.get('end') or 'free'}")
        if item.get("stale"):
            parts.append("STALE (inkflow shape reroute)")
    if item.get("text"):
        parts.append(json.dumps(item["text"], ensure_ascii=False))
    if item.get("sites"):
        parts.append(f"{item['sites']} sites per side")
    if item.get("shapes"):
        parts.append(
            "shapes: " + ", ".join(str(s) for s in cast("list[object]", item["shapes"]))
        )
    for flag in ("hidden", "locked"):
        if item.get(flag):
            parts.append(flag)
    return "  ".join(parts)
