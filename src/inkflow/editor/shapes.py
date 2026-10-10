"""``inkflow shape``: the visual editor's drawing actions, from the command line.

An agent drawing on a slide otherwise edits SVG and Markdown by hand: it has to
guess where an attached arrow's path goes (the routing lives in the editor's
TypeScript), make a text box out of two files, keep ids unique, add the arrow
marker, and rename an id together with every arrow and cue naming it. And a
raw edit is no step in the editor's undo history.

Here each command makes the change the editor makes for the same click, through
the same session actions, so the files come out as the editor writes them:

* new shapes, lines and pictures are the editor's ``svg`` ``insert`` (with its
  default looks), a text box is ``insert-textbox`` (a ``zone-text`` rect and its
  Markdown section), text typed into a shape ``shape-text``, a chart
  ``insert-chart``; a slide drawn straight from a shared layout first gets its
  own drawing (``slide`` ``detach``), as the editor gives it one;
* an arrow is a connector attached to its shapes, its path routed by the Python
  port of the editor's routing (``routing``, ``scene``);
* moving or resizing re-routes the arrows attached to what moved, in the same
  edit (the editor's ``withConnectors``);
* every other change is the ``svg`` operation the editor's panel sends.

All the commands of one request run inside one ``Session`` request, so
they are one undoable step (and one rebuild), however many there are: the
``batch`` form an agent draws a diagram with. A command sees the files as the
commands before it left them.

A request is ``{"action": "shape", "slide": <deck index>, "commands": [...]}``.
A command is an object with one key naming it, whose value holds its
positional arguments, and the options by their command-line names::

    {"add": "rect", "id": "start", "at": [100, 200], "size": [300, 120],
     "text": "Start"}
    {"connect": ["start", "end"], "style": "elbow", "from": "right"}
    {"move": ["start"], "by": "40,0"}
"""

from __future__ import annotations

import dataclasses
import math
import os
import re
import struct
import sys
import types
from collections.abc import Callable
from html import escape
from pathlib import Path
from typing import Protocol, cast

from inkflow import drawio, pdf
from inkflow.colors import SVG_TOKENS
from inkflow.editor import media
from inkflow.editor.bbox import local, prop
from inkflow.editor.geometry import Box, fmt, plan_resize, union_boxes
from inkflow.editor.geometry import distribute as spread
from inkflow.editor.provenance import INK, INK_TOP, is_element
from inkflow.editor.routing import (
    STYLES,
    End,
    Pt,
    Site,
    format_bend,
    js_round,
    parse_bend,
    parse_connection,
    parse_site,
    route,
)
from inkflow.editor.scene import CONNECT, SITES, Op, Scene, own_file
from inkflow.editor.svgops import file_hash
from inkflow.layout import resolve_default_zone
from inkflow.loaders import load_md
from inkflow.manifest import Chart, Deck, Image, Inline, Slide, TextBox, Video
from inkflow.pipeline import slide_ids, zone_origin
from inkflow.svgio import SvgElement
from inkflow.zones import parse_markdown_zones, zone_spans


class ShapeError(ValueError):
    """A command that cannot be applied; nothing of its request is written."""


class Session(Protocol):
    """What the commands use of ``EditorSession`` (which runs them)."""

    deck_path: Path
    project_dir: Path
    built_hash: str | None
    shape_deck_hash: str | None

    def apply(self, msg: dict[str, object], deck: Deck | None) -> dict[str, object]: ...

    def slide_id(self, slide: Slide, deck: Deck) -> str: ...


MAX_COMMANDS = 500

KINDS = ("rect", "ellipse", "line", "arrow", "text", "textbox", "image", "chart")
ANCHORS = (
    "top-left",
    "top",
    "top-right",
    "left",
    "center",
    "right",
    "bottom-left",
    "bottom",
    "bottom-right",
)
ALIGN = ("left", "center", "right", "top", "middle", "bottom")
ORDER = ("front", "back", "forward", "backward")
ARROWS = ("end", "start", "both", "none")
CHART_KINDS = ("bar", "line", "area", "scatter", "pie")

# The options each command takes (their command-line names), and how many
# positional arguments: (at least, at most; None = any number).
COMMANDS: dict[str, tuple[frozenset[str], int, int | None]] = {
    "add": (
        frozenset(
            {
                "at",
                "size",
                "id",
                "fill",
                "stroke",
                "stroke-width",
                "rx",
                "text",
                "font-size",
                "from",
                "to",
                "style",
                "arrow",
                "src",
                "page",
                "drawio",
                "data",
                "chart",
                "title",
            }
        ),
        1,
        1,
    ),
    "connect": (
        frozenset(
            {"from", "to", "style", "arrow", "bend", "id", "stroke", "stroke-width"}
        ),
        2,
        2,
    ),
    "sites": (frozenset(), 2, 2),
    "reroute": (frozenset(), 0, None),
    "move": (frozenset({"by", "to"}), 1, None),
    "resize": (frozenset({"size", "anchor"}), 1, 1),
    "align": (frozenset({"to"}), 2, None),
    "distribute": (frozenset(), 4, None),
    "style": (frozenset({"fill", "stroke", "stroke-width", "opacity"}), 1, None),
    "text": (frozenset(), 2, 2),
    "delete": (frozenset(), 1, None),
    "duplicate": (frozenset({"by"}), 1, 1),
    "group": (frozenset(), 2, None),
    "ungroup": (frozenset(), 1, 1),
    "order": (frozenset(), 2, 2),
    "rename": (frozenset(), 2, 2),
    "lock": (frozenset(), 1, None),
    "unlock": (frozenset(), 1, None),
    "hide": (frozenset(), 1, None),
    "show": (frozenset(), 1, None),
    "link": (frozenset(), 2, 2),
}

# The editor's new-object looks (insert.ts SHAPE_STYLE / textXml).
_SHAPE_CLASSES = ["inkflow-fill-surface", "inkflow-stroke-accent"]
_SHAPE_STYLE = {"stroke-width": "4"}
_LINE_CLASSES = ["inkflow-stroke-text"]
_LINE_STYLE = {"fill": "none", "stroke-width": "6", "stroke-linecap": "round"}
_TEXT_CLASSES = ["inkflow-fill-text"]
_ARROW = "url(#inkflow-arrow)"
_ID = re.compile(r"^[A-Za-z_][\w.-]*$")
_COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|none|transparent|currentColor)$")
_SAMPLE_TABLE = {
    "columns": ["category", "series 1", "series 2"],
    "rows": [["A", "4", "2"], ["B", "6", "3"], ["C", "5", "4"], ["D", "8", "5"]],
}
_FULL_SLIDE = 0.8
"""An object this much of the slide is a background, never an arrow's end."""


# ── Parsing commands ────────────────────────────────────────────────────────────


@dataclasses.dataclass
class Command:
    name: str
    args: list[str]
    opts: dict[str, object]

    def label(self) -> str:
        return " ".join([self.name, *self.args])


def parse_command(raw: object) -> Command:
    """A command object (see the module docstring), checked."""
    if not isinstance(raw, dict):
        raise ShapeError('a command is an object naming it: {"add": "rect", ...}')
    item = cast("dict[str, object]", raw)
    # The first key names the command ("text" is also an option of "add").
    name = next(iter(item), "")
    if name not in COMMANDS:
        known = ", ".join(COMMANDS)
        raise ShapeError(f"a command's first key names it ({known}): {item!r}")
    value = item[name]
    values = cast("list[object]", value) if isinstance(value, list) else [value]
    args = [
        str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)
        for v in values
        if v is not None
    ]
    options, low, high = COMMANDS[name]
    if len(args) < low or (high is not None and len(args) > high):
        want = f"{low}" if low == high else f"{low} or more"
        raise ShapeError(f"{name} takes {want} argument(s), not {len(args)}")
    opts: dict[str, object] = {}
    for key, v in item.items():
        if key == name:
            continue
        option = key.replace("_", "-")
        if option not in options:
            allowed = ", ".join(f"--{o}" for o in sorted(options)) or "no options"
            raise ShapeError(f"{name} has no option --{option} (it takes {allowed})")
        if v is not None:
            opts[option] = v
    return Command(name, args, opts)


def point(value: object, what: str) -> Pt:
    """``[x, y]`` or ``"x,y"`` (slide units)."""
    if isinstance(value, str):
        parts: list[object] = [p for p in re.split(r"[\s,]+", value.strip()) if p]
    elif isinstance(value, list | tuple):
        parts = list(cast("list[object]", value))
    else:
        parts = []
    try:
        x, y = (float(cast("str", p)) for p in parts)
    except (ValueError, TypeError):
        raise ShapeError(f"--{what} takes two numbers, X,Y: not {value!r}") from None
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ShapeError(f"--{what} takes two numbers, X,Y: not {value!r}")
    return Pt(x, y)


def number(value: object, what: str, low: float | None = None) -> float:
    try:
        n = float(cast("str", value))
    except (ValueError, TypeError):
        raise ShapeError(f"--{what} takes a number, not {value!r}") from None
    if not math.isfinite(n) or (low is not None and n < low):
        raise ShapeError(f"--{what} takes a number of at least {low:g}, not {value!r}")
    return n


def paint(value: object, what: str) -> dict[str, object]:
    """A theme colour (``accent``, the editor's swatches) or ``#hex``/``none``."""
    text = str(value).strip()
    if text in SVG_TOKENS:
        return {"token": text}
    if _COLOR.match(text):
        return {"color": text}
    tokens = ", ".join(SVG_TOKENS)
    raise ShapeError(
        f"--{what} takes a theme colour ({tokens}), #hex or none: not {text!r}"
    )


def _paint_attrs(
    classes: list[str], style: dict[str, str], prop_name: str, value: object
) -> None:
    """``svgops._paint`` on attributes not yet written: the token class or the
    style colour, never both."""
    paint_value = paint(value, prop_name)
    classes[:] = [c for c in classes if not c.startswith(f"inkflow-{prop_name}-")]
    style.pop(prop_name, None)
    if "token" in paint_value:
        classes.append(f"inkflow-{prop_name}-{paint_value['token']}")
    else:
        style[prop_name] = str(paint_value["color"])


def _attrs(classes: list[str], style: dict[str, str]) -> str:
    out = f'class="{" ".join(classes)}"' if classes else ""
    if style:
        out += f' style="{";".join(f"{k}:{v}" for k, v in style.items())}"'
    return out


# ── Image sizes (the editor asks the browser) ──────────────────────────────────


def image_size(path: Path) -> tuple[float, float] | None:
    """A picture's natural size from its header (PNG, GIF, JPEG, WebP, SVG)."""
    try:
        data = path.read_bytes()[: 1 << 20]
    except OSError:
        return None
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            w, h = struct.unpack(">II", data[16:24])
            return float(w), float(h)
        if data[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", data[6:10])
            return float(w), float(h)
        if data.startswith(b"\xff\xd8"):
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                size = struct.unpack(">H", data[i + 2 : i + 4])[0]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA):
                    h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                    return float(w), float(h)
                i += 2 + size
            return None
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X":
                w = int.from_bytes(data[24:27], "little") + 1
                h = int.from_bytes(data[27:30], "little") + 1
                return float(w), float(h)
            if chunk == b"VP8L":
                bits = int.from_bytes(data[21:25], "little")
                return float((bits & 0x3FFF) + 1), float(((bits >> 14) & 0x3FFF) + 1)
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return float(w & 0x3FFF), float(h & 0x3FFF)
            return None
        if path.suffix.lower() == ".svg":
            return drawio.size(data)
    except (struct.error, IndexError, ValueError):
        return None
    return None


# ── Running a request ───────────────────────────────────────────────────────────


def _load_deck(deck_path: Path, data: bytes) -> Deck:
    """The deck as deck.py makes it now (a command before this one may have
    changed it: a slide given its own drawing, a new Markdown file). Run as a
    module of its own, beside the one the server built."""
    module = types.ModuleType("_inkflow_shape_deck")
    module.__file__ = str(deck_path)
    sys.modules[module.__name__] = module
    try:
        exec(compile(data, str(deck_path), "exec"), module.__dict__)
        deck = cast("Callable[[], object]", module.main)()
    except Exception as exc:
        raise ShapeError(f"deck.py does not load after this change ({exc})") from exc
    if not isinstance(deck, Deck):
        raise ShapeError("deck.py's main() did not return a Deck")
    return deck


def parse_commands(raw: object) -> list[Command]:
    if not isinstance(raw, list) or not raw:
        raise ShapeError("no shape commands")
    items = cast("list[object]", raw)
    if len(items) > MAX_COMMANDS:
        raise ShapeError(f"at most {MAX_COMMANDS} commands in one request")
    commands: list[Command] = []
    for n, item in enumerate(items, 1):
        try:
            commands.append(parse_command(item))
        except ShapeError as exc:
            raise ShapeError(
                f"command {n}: {exc}" if len(items) > 1 else str(exc)
            ) from exc
    return commands


@dataclasses.dataclass
class Outcome:
    reports: list[dict[str, object]]
    created: list[str]
    last: dict[str, object] | None
    """The session's result for the last action that changed files."""


def run(session: Session, msg: dict[str, object], deck: Deck, coalesce: str) -> Outcome:
    """Run a request's commands, each action as its own session request, all
    under one ``coalesce`` key: the History merges them into one step. The
    caller (``EditorSession._shapes``) takes that step back when one fails."""
    commands = parse_commands(msg.get("commands"))
    runner = Runner(session, msg, deck, coalesce)
    for n, command in enumerate(commands, 1):
        try:
            runner.do(command)
        except ShapeError as exc:
            prefix = f"command {n} ({command.label()}): " if len(commands) > 1 else ""
            raise ShapeError(f"{prefix}{exc}") from exc
    return Outcome(runner.reports, runner.created, runner.last)


class Runner:
    """One request's commands, run in order; each sees the files as the
    commands before it left them."""

    session: Session
    index: int
    coalesce: str
    reports: list[dict[str, object]]
    created: list[str]
    last: dict[str, object] | None
    _deck: Deck
    _deck_data: bytes
    _scene: Scene | None
    _scene_key: tuple[object, ...] | None
    _local: bool
    _agent: object

    def __init__(
        self, session: Session, msg: dict[str, object], deck: Deck, coalesce: str
    ) -> None:
        self.session = session
        self.coalesce = coalesce
        self._deck = deck
        self._deck_data = session.deck_path.read_bytes()
        self._scene = None
        self._scene_key = None
        self._local = msg.get("_local") is True
        self._agent = msg.get("agent")
        self.reports = []
        self.created = []
        self.last = None
        if session.built_hash is not None and (
            file_hash(self._deck_data) != session.built_hash
        ):
            raise ShapeError("deck.py changed since the last build; try again")
        index = msg.get("slide")
        if not isinstance(index, int) or not 0 <= index < len(deck.slides):
            raise ShapeError("no such slide")
        self.index = index
        expected = msg.get("hash")
        own = self.own_path()
        if (
            isinstance(expected, str)
            and expected
            and own is not None
            and file_hash(own.read_bytes()) != expected
        ):
            raise ShapeError(f"{own.name} changed on disk meanwhile; try again")

    # ── The deck and the slide as the commands so far have left them ──

    @property
    def project_dir(self) -> Path:
        return self.session.project_dir

    @property
    def deck(self) -> Deck:
        data = self.session.deck_path.read_bytes()
        if data != self._deck_data:
            self._deck = _load_deck(self.session.deck_path, data)
            self._deck_data = data
            if len(self._deck.slides) <= self.index:
                raise ShapeError("the slide is gone")
        # The session checks deck.py against its build; this request has
        # loaded what it changed itself.
        self.session.shape_deck_hash = file_hash(data)
        return self._deck

    @property
    def slide(self) -> Slide:
        return self.deck.slides[self.index]

    def rel(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.project_dir.resolve()).as_posix()
        except ValueError:
            return str(path)

    def own_path(self, create: bool = False) -> Path | None:
        """The slide's own SVG; with ``create``, given one first when the slide
        is drawn straight from a shared layout (the editor's ensureOwnDrawing)."""
        own = own_file(self.slide, self.deck, self.project_dir)
        if own is not None or not create:
            return own
        name = self.session.slide_id(self.slide, self.deck)
        self.action("slide", {"op": "detach", "slide": self.index, "name": name})
        own = own_file(self.slide, self.deck, self.project_dir)
        if own is None:
            raise ShapeError("could not give the slide a drawing of its own")
        self.report("own drawing", [], f"the slide now has its own {self.rel(own)}")
        return own

    def scene(self) -> Scene:
        """The slide composed as the editor shows it."""
        own = self.own_path()
        data = own.read_bytes() if own is not None else None
        key = (own, data, self._deck_data)
        if self._scene is None or key != self._scene_key:
            slide_id = self.session.slide_id(self.slide, self.deck)
            try:
                self._scene = Scene.compose(
                    self.project_dir, self.deck, self.slide, slide_id, data
                )
            except (ValueError, OSError) as exc:
                raise ShapeError(f"cannot read the slide's drawing: {exc}") from exc
            self._scene_key = key
        return self._scene

    def size(self) -> Box:
        return self.scene().size()

    def report(self, command: str, ids: list[str], detail: str = "") -> None:
        self.reports.append({"command": command, "ids": ids, "detail": detail})

    # ── Session actions ──

    def action(self, action: str, msg: dict[str, object]) -> dict[str, object]:
        """One of the editor's actions, as the session's request: it lands in
        the History under this request's key, so all merge into one step."""
        request: dict[str, object] = {
            **msg,
            "action": action,
            "coalesce": self.coalesce,
            "_local": self._local,
        }
        if self._agent is not None:
            request["agent"] = self._agent
        if action != "slide":
            request.setdefault("slide", self.index)
        result = self.session.apply(request, self.deck)
        if result.get("changes"):
            self.last = result
        return result

    def svg(self, ops: list[dict[str, object]], label: str = "") -> dict[str, str]:
        """The editor's ``svg`` action on the slide's own drawing."""
        if not ops:
            return {}
        own = self.own_path(create=True)
        assert own is not None
        result = self.action(
            "svg",
            {
                "file": str(own),
                "hash": file_hash(own.read_bytes()),
                "ops": ops,
                "zoneSlide": self.index,
                "label": label,
            },
        )
        return cast("dict[str, str]", result.get("ids") or {})

    # ── Finding objects ──

    def find(self, ident: str) -> SvgElement:
        """An object by id (``zone-`` may be left off a zone's): the slide's
        own first, else one from its layout or overlays."""
        scene = self.scene()
        names = [ident] if ident.startswith("zone-") else [ident, f"zone-{ident}"]
        for name in names:
            found = [
                el
                for el in scene.root.iter()
                if is_element(el) and el.get("id") == name
            ]
            if found:
                own = [el for el in found if scene.key(el) == 0]
                return (own or found)[0]
        raise ShapeError(
            f"no object with id {ident!r} on this slide (see `inkflow shape list`)"
        )

    def owned(self, ident: str) -> SvgElement:
        """An object of the slide's own drawing, which the editor may move."""
        el = self.find(ident)
        scene = self.scene()
        if scene.is_own(el):
            return el
        name = el.get("id") or ident
        if scene.locator_is_cell(el) or scene.attachable_cell(el) is not None:
            raise ShapeError(
                f"{name} is a shape of a draw.io diagram: change it in draw.io "
                + "(arrows can still attach to it)"
            )
        source = scene.source(el)
        if source is not None and scene.key(el) == 0:
            raise ShapeError(
                f"{name} is in {self.rel(source)}, which other slides show too: "
                + "change it there in `inkflow edit` (Edit layout)"
            )
        where = self.rel(source) if source is not None else "the layout"
        raise ShapeError(
            f"{name} is in {where} (a layout or overlay this slide is built on); "
            + "the editor changes it only in Edit layout"
        )

    def loc(self, el: SvgElement) -> str:
        loc = el.get(INK)
        if not loc:
            raise ShapeError("that element is not in a file the editor writes")
        return loc

    def check_new_id(self, new: str) -> None:
        if not _ID.match(new):
            raise ShapeError(
                f"{new!r} is not an id: a letter first, then letters, digits, - _ ."
            )
        if new in self.scene().all_ids():
            raise ShapeError(f"id {new!r} is already used on this slide")

    # ── Commands ──

    def do(self, command: Command) -> None:
        handlers: dict[str, Callable[[list[str], dict[str, object]], None]] = {
            "add": self.cmd_add,
            "connect": self.cmd_connect,
            "sites": self.cmd_sites,
            "reroute": self.cmd_reroute,
            "move": self.cmd_move,
            "resize": self.cmd_resize,
            "align": self.cmd_align,
            "distribute": self.cmd_distribute,
            "style": self.cmd_style,
            "text": self.cmd_text,
            "delete": self.cmd_delete,
            "duplicate": self.cmd_duplicate,
            "group": self.cmd_group,
            "ungroup": self.cmd_ungroup,
            "order": self.cmd_order,
            "rename": self.cmd_rename,
            "lock": self.cmd_lock,
            "unlock": self.cmd_unlock,
            "hide": self.cmd_hide,
            "show": self.cmd_show,
            "link": self.cmd_link,
        }
        handlers[command.name](command.args, command.opts)

    def _box(self, opts: dict[str, object], default: tuple[float, float]) -> Box:
        """``--at`` (top-left) and ``--size``; centred on the slide without
        ``--at``, the editor's size for the kind without ``--size``."""
        slide = self.size()
        w, h = default
        if "size" in opts:
            s = point(opts["size"], "size")
            w, h = s.x, s.y
            if w <= 0 or h <= 0:
                raise ShapeError("--size needs a width and height above 0")
        if "at" in opts:
            at = point(opts["at"], "at")
            return Box(at.x, at.y, w, h)
        return Box(
            slide.x + (slide.width - w) / 2, slide.y + (slide.height - h) / 2, w, h
        )

    def _in_parent(self, box: Box) -> tuple[str, SvgElement | None, Box]:
        """The insertion parent's locator and element, and ``box`` in its space."""
        scene = self.scene()
        parent = scene.insert_parent()
        a = scene.to_parent(parent, Pt(box.x, box.y))
        b = scene.to_parent(parent, Pt(box.right, box.bottom))
        return (
            scene.insert_loc(parent),
            parent,
            Box(min(a.x, b.x), min(a.y, b.y), abs(b.x - a.x), abs(b.y - a.y)),
        )

    def cmd_add(self, args: list[str], opts: dict[str, object]) -> None:
        kind = args[0]
        if kind not in KINDS:
            raise ShapeError(f"add what? {' | '.join(KINDS)} (not {kind!r})")
        allowed = {
            "rect": {
                "at",
                "size",
                "id",
                "fill",
                "stroke",
                "stroke-width",
                "rx",
                "text",
            },
            "ellipse": {"at", "size", "id", "fill", "stroke", "stroke-width", "text"},
            "line": {"from", "to", "id", "stroke", "stroke-width", "style", "arrow"},
            "arrow": {"from", "to", "id", "stroke", "stroke-width", "style", "arrow"},
            "text": {"at", "id", "text", "fill", "font-size"},
            "textbox": {"at", "size", "id", "text", "fill", "stroke", "stroke-width"},
            "image": {"at", "size", "id", "src", "page", "drawio"},
            "chart": {"at", "size", "id", "data", "chart", "title"},
        }[kind]
        wrong = sorted(set(opts) - allowed)
        if wrong:
            raise ShapeError(
                f"add {kind} has no --{wrong[0]} (it takes "
                + ", ".join(f"--{o}" for o in sorted(allowed))
                + ")"
            )
        self.own_path(create=True)
        requested = str(opts["id"]) if "id" in opts else None
        if requested is not None and kind not in ("textbox", "chart"):
            if "text" in opts and kind in ("rect", "ellipse"):
                self.check_new_id(f"zone-{requested.removeprefix('zone-')}")
            else:
                self.check_new_id(requested)
        getattr(self, f"_add_{kind}")(opts, requested)

    def _shape_xml(
        self,
        kind: str,
        box: Box,
        opts: dict[str, object],
        requested: str | None,
        with_id: bool,
    ) -> str:
        classes = list(_SHAPE_CLASSES)
        style = dict(_SHAPE_STYLE)
        for name in ("fill", "stroke"):
            if name in opts:
                _paint_attrs(classes, style, name, opts[name])
        if "stroke-width" in opts:
            style["stroke-width"] = fmt(number(opts["stroke-width"], "stroke-width", 0))
        ident = f' id="{escape(requested)}"' if requested and with_id else ""
        if kind == "rect":
            rx = number(opts["rx"], "rx", 0) if "rx" in opts else 16
            return (
                f'<rect{ident} x="{fmt(box.x)}" y="{fmt(box.y)}" '
                + f'width="{fmt(box.width)}" height="{fmt(box.height)}" '
                + f'rx="{fmt(rx)}" {_attrs(classes, style)}/>'
            )
        return (
            f'<ellipse{ident} cx="{fmt(box.x + box.width / 2)}" '
            + f'cy="{fmt(box.y + box.height / 2)}" rx="{fmt(box.width / 2)}" '
            + f'ry="{fmt(box.height / 2)}" {_attrs(classes, style)}/>'
        )

    def _add_shape(
        self, kind: str, opts: dict[str, object], requested: str | None
    ) -> None:
        loc, _, box = self._in_parent(self._box(opts, (360, 220)))
        text = str(opts["text"]) if "text" in opts else None
        xml = self._shape_xml(kind, box, opts, requested, with_id=text is None)
        ids = self.svg(
            [{"kind": "insert", "parent": loc, "xml": xml, "base": kind, "key": "new"}],
            f"Insert {kind}",
        )
        new = ids.get("new", "")
        if text is None:
            self.created.append(new)
            self.report(
                f"add {kind}", [new], f"in {self.rel(self.own_path() or Path())}"
            )
            return
        # Text typed into the shape: it becomes a text zone that keeps its look.
        el = self.scene().by_id(new)
        assert el is not None
        msg: dict[str, object] = {
            "slide": self.index,
            "file": str(self.own_path()),
            "loc": self.loc(el),
            "text": text,
        }
        if requested:
            msg["zone"] = requested
        result = self.action("shape-text", msg)
        zone = str(cast("dict[str, str]", result.get("ids") or {}).get("new", ""))
        if requested and zone != f"zone-{requested.removeprefix('zone-')}":
            raise ShapeError(
                f"zone {requested!r} is taken on this slide (Markdown or layout)"
            )
        self.created.append(zone)
        self.report(f"add {kind}", [zone], f"text in the shape: {self.md_where()}")

    def _add_rect(self, opts: dict[str, object], requested: str | None) -> None:
        self._add_shape("rect", opts, requested)

    def _add_ellipse(self, opts: dict[str, object], requested: str | None) -> None:
        self._add_shape("ellipse", opts, requested)

    def md_where(self) -> str:
        slide = self.slide
        if isinstance(slide.md, Inline):
            return "Markdown in deck.py"
        md = load_md(slide.md, self.project_dir)
        if md is not None and md.path is not None:
            return f"its section of {self.rel(md.path)}"
        return "deck.py"

    def _heads(self, opts: dict[str, object], default: str) -> str:
        heads = str(opts.get("arrow", default))
        if heads not in ARROWS:
            raise ShapeError(f"--arrow takes {' | '.join(ARROWS)}, not {heads!r}")
        return heads

    def _connector_attrs(
        self, style: str, heads: str, opts: dict[str, object]
    ) -> tuple[str, list[dict[str, object]]]:
        classes = list(_LINE_CLASSES)
        css = dict(_LINE_STYLE)
        if "stroke" in opts:
            _paint_attrs(classes, css, "stroke", opts["stroke"])
        if "stroke-width" in opts:
            css["stroke-width"] = fmt(number(opts["stroke-width"], "stroke-width", 0))
        attrs = [_attrs(classes, css), f'inkflow:connector="{style}"']
        if heads in ("start", "both"):
            attrs.append(f'marker-start="{_ARROW}"')
        if heads in ("end", "both"):
            attrs.append(f'marker-end="{_ARROW}"')
        before: list[dict[str, object]] = (
            [{"kind": "ensure-marker"}] if heads != "none" else []
        )
        return " ".join(attrs), before

    def _style(self, opts: dict[str, object]) -> str:
        style = str(opts.get("style", "straight"))
        if style not in STYLES:
            raise ShapeError(f"--style takes {' | '.join(STYLES)}, not {style!r}")
        return style

    def _add_line(
        self, opts: dict[str, object], requested: str | None, arrow: bool = False
    ) -> None:
        kind = "arrow" if arrow else "line"
        slide = self.size()
        cx, cy = slide.x + slide.width / 2, slide.y + slide.height / 2
        a = point(opts["from"], "from") if "from" in opts else Pt(cx - 150, cy)
        b = point(opts["to"], "to") if "to" in opts else Pt(cx + 150, cy)
        style = self._style(opts)
        heads = self._heads(opts, "end" if arrow else "none")
        scene = self.scene()
        parent = scene.insert_parent()
        d = scene.new_connector_path(style, End(a.x, a.y), End(b.x, b.y), parent)
        attrs, before = self._connector_attrs(style, heads, opts)
        ident = f' id="{escape(requested)}"' if requested else ""
        xml = f'<path{ident} d="{d}" {attrs}/>'
        ids = self.svg(
            [
                *before,
                {
                    "kind": "insert",
                    "parent": scene.insert_loc(parent),
                    "xml": xml,
                    "base": "arrow" if heads != "none" else "line",
                    "key": "new",
                },
            ],
            f"Insert {kind}",
        )
        new = ids.get("new", "")
        self.created.append(new)
        self.report(f"add {kind}", [new], "free ends (`connect` attaches an arrow)")

    def _add_arrow(self, opts: dict[str, object], requested: str | None) -> None:
        self._add_line(opts, requested, arrow=True)

    def _add_text(self, opts: dict[str, object], requested: str | None) -> None:
        slide = self.size()
        at = (
            point(opts["at"], "at")
            if "at" in opts
            else Pt(slide.x + slide.width * 0.1, slide.y + slide.height / 2)
        )
        scene = self.scene()
        parent = scene.insert_parent()
        p = scene.to_parent(parent, at)
        size = number(opts.get("font-size", 56), "font-size", 1)
        classes = list(_TEXT_CLASSES)
        style = {
            "font-size": f"{fmt(size)}px",
            "font-family": "var(--inkflow-body-font, sans-serif)",
        }
        if "fill" in opts:
            _paint_attrs(classes, style, "fill", opts["fill"])
        lines = str(opts.get("text", "Text")).split("\n")
        if len(lines) == 1:
            body = escape(lines[0], quote=False)
        else:
            body = "".join(
                (
                    f'<tspan x="{fmt(p.x)}" y="{fmt(p.y)}">'
                    if i == 0
                    else f'<tspan x="{fmt(p.x)}" dy="1.2em">'
                )
                + f"{escape(line, quote=False)}</tspan>"
                for i, line in enumerate(lines)
            )
        ident = f' id="{escape(requested)}"' if requested else ""
        xml = (
            f'<text{ident} x="{fmt(p.x)}" y="{fmt(p.y)}" {_attrs(classes, style)}>'
            + f"{body}</text>"
        )
        ids = self.svg(
            [
                {
                    "kind": "insert",
                    "parent": scene.insert_loc(parent),
                    "xml": xml,
                    "base": "text",
                    "key": "new",
                }
            ],
            "Insert text",
        )
        new = ids.get("new", "")
        self.created.append(new)
        self.report(
            "add text", [new], "an SVG <text> (no wrapping; `add textbox` wraps)"
        )

    def _add_textbox(self, opts: dict[str, object], requested: str | None) -> None:
        slide = self.size()
        width = min(900.0, slide.width * 0.6)
        loc, _, box = self._in_parent(self._box(opts, (width, 100)))
        msg: dict[str, object] = {
            "slide": self.index,
            "file": str(self.own_path(create=True)),
            "parent": loc,
            "x": js_round(box.x),
            "y": js_round(box.y),
            "width": js_round(box.width),
            "height": js_round(box.height),
            "text": str(opts.get("text", "Text")),
        }
        if requested:
            msg["zone"] = requested
        result = self.action("insert-textbox", msg)
        zone = str(cast("dict[str, str]", result.get("ids") or {}).get("new", ""))
        if requested and zone != f"zone-{requested.removeprefix('zone-')}":
            raise ShapeError(
                f"zone {requested!r} is taken on this slide (Markdown or layout)"
            )
        styling = {k: opts[k] for k in ("fill", "stroke", "stroke-width") if k in opts}
        if styling:
            self._style_ops([self.find(zone)], styling)
        self.created.append(zone)
        self.report("add textbox", [zone], f"text in {self.md_where()}")

    def _add_image(self, opts: dict[str, object], requested: str | None) -> None:
        if "src" not in opts:
            raise ShapeError("add image needs --src FILE")
        raw = Path(str(opts["src"])).expanduser()
        source = raw if raw.is_absolute() else self.project_dir / raw
        inside = source.resolve().is_relative_to(self.project_dir.resolve())
        if not inside and not self._local:
            raise ShapeError(
                "a picture from outside the project is copied in only by a "
                + "command on this computer"
            )
        if source.suffix.lower() not in media.IMAGE_SUFFIXES:
            raise ShapeError(
                f"not a picture: {source.name} (PNG, JPEG, GIF, WebP, SVG or PDF)"
            )
        try:
            arrival = media.import_path(self.project_dir, source.resolve())
        except media.MediaError as exc:
            raise ShapeError(str(exc)) from exc
        own = self.own_path(create=True)
        assert own is not None
        href = Path(os.path.relpath(arrival.path, own.parent)).as_posix()
        if pdf.is_pdf_ref(href):
            page = int(number(opts.get("page", 1), "page", 1))
            href = pdf.with_page(href, page)
        natural = image_size(arrival.path) or (400.0, 300.0)
        if "size" in opts:
            box = self._box(opts, natural)
        else:
            slide = self.size()
            k = min(1, slide.width * 0.5 / natural[0], slide.height * 0.5 / natural[1])
            box = self._box(opts, (natural[0] * k, natural[1] * k))
        loc, _, local_box = self._in_parent(box)
        ident = f' id="{escape(requested)}"' if requested else ""
        shown = ""
        if "drawio" in opts:
            # The diagram panel's "Show as": drawn into the slide, its shapes
            # named <picture id>-<cell id> (arrows attach to them).
            mode = str(opts["drawio"])
            if mode not in ("inline", "themed", "picture"):
                raise ShapeError("--drawio takes inline, themed or picture")
            if not drawio.is_drawio_path(arrival.path):
                raise ShapeError(f"{arrival.path.name} is not a draw.io diagram")
            if mode != "picture":
                shown = f' inkflow:drawio="{mode}"'
                if not requested:
                    ident = ' id="diagram"'
        xml = (
            f'<image{ident} href="{escape(href)}" '
            + f'x="{fmt(local_box.x)}" y="{fmt(local_box.y)}" '
            + f'width="{fmt(local_box.width)}" height="{fmt(local_box.height)}" '
            + f'preserveAspectRatio="xMidYMid meet"{shown}/>'
        )
        ids = self.svg(
            [
                {
                    "kind": "insert",
                    "parent": loc,
                    "xml": xml,
                    "base": "image",
                    "key": "new",
                }
            ],
            "Insert image",
        )
        new = ids.get("new", "")
        self.created.append(new)
        moved = "" if inside else f"; copied to {self.rel(arrival.path)}"
        self.report("add image", [new], f"{href}{moved}")

    def _add_chart(self, opts: dict[str, object], requested: str | None) -> None:
        slide = self.size()
        w = js_round(slide.width * 0.6)
        loc, _, box = self._in_parent(self._box(opts, (w, js_round(w * 9 / 16))))
        kind = str(opts.get("chart", "bar"))
        if kind not in CHART_KINDS:
            raise ShapeError(f"--chart takes {' | '.join(CHART_KINDS)}, not {kind!r}")
        settings: dict[str, object] = {"kind": kind}
        if "title" in opts:
            settings["title"] = str(opts["title"])
        msg: dict[str, object] = {
            "slide": self.index,
            "file": str(self.own_path(create=True)),
            "parent": loc,
            "x": js_round(box.x),
            "y": js_round(box.y),
            "width": js_round(box.width),
            "height": js_round(box.height),
            "chart": settings,
        }
        if "data" in opts:
            data = Path(str(opts["data"])).expanduser()
            msg["src"] = str(data if data.is_absolute() else self.project_dir / data)
        else:
            msg["table"] = _SAMPLE_TABLE
        if requested:
            msg["zone"] = requested
        result = self.action("insert-chart", msg)
        zone = str(cast("dict[str, str]", result.get("ids") or {}).get("new", ""))
        if requested and zone != f"zone-{requested.removeprefix('zone-')}":
            raise ShapeError(f"zone {requested!r} is taken on this slide")
        self.created.append(zone)
        chart = self.slide.zones.get(zone.removeprefix("zone-"))
        src = chart.src if isinstance(chart, Chart) else None
        self.report("add chart", [zone], f"Chart({src!r}) in deck.py" if src else "")

    # ── Connectors ──

    def attachable(self, ident: str) -> SvgElement:
        el = self.find(ident)
        scene = self.scene()
        name = el.get("id") or ident
        if scene.is_connector(el):
            raise ShapeError(
                f"{name} is an arrow: arrows attach to shapes, not to arrows"
            )
        if local(el) == "text":
            raise ShapeError(
                f"{name} is a plain <text>, whose box only a browser can measure: "
                + "put the text in a shape (`add rect --text`) or a text box "
                + "and connect to that"
            )
        corners = scene.corners_of(el)
        if corners is None:
            raise ShapeError(f"{name} has no size on the slide to attach to")
        box = scene.slide_box(el)
        area = scene.size()
        if (
            box is not None
            and box.width * box.height >= area.width * area.height * _FULL_SLIDE
        ):
            raise ShapeError(
                f"{name} covers the slide (a background): arrows do not attach to it"
            )
        return el

    def _site(self, el: SvgElement, name: str, what: str) -> Site:
        if parse_site(name) is None:
            raise ShapeError(
                f"--{what} takes a side (top, right, bottom, left) or side@fraction "
                + f"(top@0.25): not {name!r}"
            )
        site = self.scene().site_of(el, name)
        if site is None:
            raise ShapeError(f"no site {name} on {el.get('id')}")
        return site

    def choose_sites(
        self, a: SvgElement, b: SvgElement, sa: str | None, sb: str | None
    ) -> tuple[Site, Site]:
        """The sites to connect: as given, else the offered ones nearest each
        other (where a drag from one shape to the other would snap)."""
        scene = self.scene()
        site_a = self._site(a, sa, "from") if sa else None
        site_b = self._site(b, sb, "to") if sb else None
        offered_a = scene.sites_of(a) or []
        offered_b = scene.sites_of(b) or []

        def nearest(sites: list[Site], p: Site) -> Site:
            return min(sites, key=lambda s: math.hypot(s.x - p.x, s.y - p.y))

        if site_a is None and site_b is None:
            pairs = [(x, y) for x in offered_a for y in offered_b]
            return min(
                pairs, key=lambda q: math.hypot(q[0].x - q[1].x, q[0].y - q[1].y)
            )
        if site_a is None:
            assert site_b is not None
            return nearest(offered_a, site_b), site_b
        if site_b is None:
            return site_a, nearest(offered_b, site_a)
        return site_a, site_b

    def cmd_connect(self, args: list[str], opts: dict[str, object]) -> None:
        self.own_path(create=True)
        a = self.attachable(args[0])
        b = self.attachable(args[1])
        style = self._style(opts)
        heads = self._heads(opts, "end")
        site_a, site_b = self.choose_sites(
            a,
            b,
            str(opts["from"]) if "from" in opts else None,
            str(opts["to"]) if "to" in opts else None,
        )
        requested = str(opts["id"]) if "id" in opts else None
        if requested:
            self.check_new_id(requested)
        scene = self.scene()
        parent = scene.insert_parent()
        bend = None
        if "bend" in opts:
            if style != "elbow":
                raise ShapeError("--bend is for an elbow (--style elbow)")
            bend = parse_bend(str(opts["bend"]))
            if bend is None:
                raise ShapeError(
                    f"--bend takes x:NUMBER or y:NUMBER, not {opts['bend']!r}"
                )
            axis = route(style, site_a.end(), site_b.end()).bend
            if axis is not None and axis.axis != bend.axis:
                raise ShapeError(
                    f"this elbow's adjustable segment runs along {axis.axis} "
                    + f"(--bend {axis.axis}:…)"
                )
        d = scene.new_connector_path(style, site_a.end(), site_b.end(), parent, bend)
        attrs, before = self._connector_attrs(style, heads, opts)
        ends = (
            f'inkflow:connect-start="{escape(a.get("id") or "")}:{site_a.name}" '
            + f'inkflow:connect-end="{escape(b.get("id") or "")}:{site_b.name}"'
        )
        if bend is not None:
            ends += f' inkflow:bend="{format_bend(bend)}"'
        ident = f' id="{escape(requested)}"' if requested else ""
        xml = f'<path{ident} d="{d}" {attrs} {ends}/>'
        ids = self.svg(
            [
                *before,
                {
                    "kind": "insert",
                    "parent": scene.insert_loc(parent),
                    "xml": xml,
                    "base": "arrow" if heads != "none" else "line",
                    "key": "new",
                },
            ],
            "Connect",
        )
        new = ids.get("new", "")
        self.created.append(new)
        self.report(
            "connect",
            [new],
            f"{a.get('id')}:{site_a.name} -> {b.get('id')}:{site_b.name} ({style})",
        )

    def cmd_sites(self, args: list[str], _opts: dict[str, object]) -> None:
        el = self.owned(args[0])
        n = int(number(args[1], "N", 1))
        if not 1 <= n <= 9:
            raise ShapeError("a shape offers 1 to 9 connection points per side")
        self.svg(
            [
                {
                    "kind": "attrs",
                    "loc": self.loc(el),
                    "set": {"inkflow:sites": None if n == 1 else str(n)},
                }
            ],
            "Connection points",
        )
        self.report("sites", [el.get("id") or ""], f"{n} per side")

    def cmd_reroute(self, args: list[str], _opts: dict[str, object]) -> None:
        scene = self.scene()
        if args:
            conns: list[SvgElement] = []
            for ident in args:
                el = self.find(ident)
                if scene.is_connector(el):
                    conns.append(self.owned(ident))
                else:
                    conns += scene.connectors_to(el.get("id") or ident)
        else:
            conns = scene.attached()
        unique: list[SvgElement] = []
        for conn in conns:
            if all(conn is not other for other in unique):
                unique.append(conn)
        ops: list[dict[str, object]] = []
        skipped: list[str] = []
        for conn in unique:
            if scene.ends_on_text(conn):
                skipped.append(conn.get("id") or "?")
                continue
            d = scene.connector_path(conn)
            if d is not None and d != conn.get("d"):
                ops.append({"kind": "attrs", "loc": self.loc(conn), "set": {"d": d}})
        self.svg(ops, "Re-route arrows")
        detail = f"{len(ops)} of {len(unique)} arrows changed"
        if skipped:
            detail += f"; left {', '.join(skipped)} (attached to <text>)"
        self.report("reroute", [], detail)

    # ── Moving and resizing ──

    def _send_plans(self, plans: list[Op], label: str) -> int:
        ops = [op for p in plans for op in p.ops]
        self.svg(ops, label)
        return sum(1 for p in plans if self.scene_is_connector(p.el))

    @staticmethod
    def scene_is_connector(el: SvgElement) -> bool:
        return Scene.is_connector(el)

    def _followers(self, plans: list[Op], moved: list[SvgElement]) -> str:
        followed = [
            p.el.get("id") or "?"
            for p in plans
            if Scene.is_connector(p.el) and all(p.el is not m for m in moved)
        ]
        return f"; arrows followed: {', '.join(followed)}" if followed else ""

    def cmd_move(self, args: list[str], opts: dict[str, object]) -> None:
        if ("by" in opts) == ("to" in opts):
            raise ShapeError("move takes --by DX,DY or --to X,Y")
        els = [self.owned(i) for i in args]
        scene = self.scene()
        if "by" in opts:
            d = point(opts["by"], "by")
            dx, dy = d.x, d.y
        else:
            to = point(opts["to"], "to")
            box = union_boxes([b for e in els if (b := scene.slide_box(e)) is not None])
            if box is None:
                raise ShapeError("nothing there to move")
            dx, dy = to.x - box.x, to.y - box.y
        plans = scene.move_plans(els, dx, dy)
        self._send_plans(plans, "Move")
        self.report(
            "move",
            [e.get("id") or "" for e in els],
            f"by {fmt(dx)},{fmt(dy)}{self._followers(plans, els)}",
        )

    def cmd_resize(self, args: list[str], opts: dict[str, object]) -> None:
        if "size" not in opts:
            raise ShapeError("resize takes --size W,H")
        el = self.owned(args[0])
        scene = self.scene()
        if scene.is_connector(el):
            raise ShapeError(
                "an arrow is reshaped by its ends: `move` it or `connect` anew"
            )
        frm = scene.slide_box(el)
        if frm is None:
            raise ShapeError(f"{args[0]} has no size to change")
        size = point(opts["size"], "size")
        if size.x <= 0 or size.y <= 0:
            raise ShapeError("--size needs a width and height above 0")
        anchor = str(opts.get("anchor", "top-left"))
        if anchor not in ANCHORS:
            raise ShapeError(f"--anchor takes {' | '.join(ANCHORS)}")
        fx = 0.0 if "left" in anchor else 1.0 if "right" in anchor else 0.5
        fy = (
            0.0
            if anchor.startswith("top")
            else 1.0
            if anchor.startswith("bottom")
            else 0.5
        )
        if anchor in ("left", "right"):
            fy = 0.5
        to = Box(
            frm.x + (frm.width - size.x) * fx,
            frm.y + (frm.height - size.y) * fy,
            size.x,
            size.y,
        )
        plan = plan_resize(scene.element_geom(el), frm, to)
        plans = scene.with_connectors(
            [Op(el, [{"kind": "attrs", "loc": self.loc(el), "set": plan}])]
        )
        self._send_plans(plans, "Resize")
        self.report(
            "resize",
            [el.get("id") or ""],
            f"to {fmt(size.x)}x{fmt(size.y)}{self._followers(plans, [el])}",
        )

    def cmd_align(self, args: list[str], opts: dict[str, object]) -> None:
        how = args[-1]
        if how not in ALIGN:
            raise ShapeError(f"align ID... {' | '.join(ALIGN)} (not {how!r})")
        to = str(opts.get("to", ""))
        if to not in ("", "slide", "selection"):
            raise ShapeError("--to takes slide or selection")
        els = [self.owned(i) for i in args[:-1]]
        scene = self.scene()
        boxes = [scene.slide_box(e) for e in els]
        if any(b is None for b in boxes):
            raise ShapeError("one of them has no size to align")
        sized = [b for b in boxes if b is not None]
        ref = scene.size() if len(els) == 1 or to == "slide" else union_boxes(sized)
        assert ref is not None
        xs = [b.x for b in sized]
        ys = [b.y for b in sized]
        if how == "left":
            xs = [ref.x for _ in sized]
        elif how == "center":
            xs = [ref.x + (ref.width - b.width) / 2 for b in sized]
        elif how == "right":
            xs = [ref.x + ref.width - b.width for b in sized]
        elif how == "top":
            ys = [ref.y for _ in sized]
        elif how == "middle":
            ys = [ref.y + (ref.height - b.height) / 2 for b in sized]
        else:
            ys = [ref.y + ref.height - b.height for b in sized]
        self._place(els, sized, xs, ys, "Align")
        self.report("align", [e.get("id") or "" for e in els], how)

    def _place(
        self,
        els: list[SvgElement],
        boxes: list[Box],
        xs: list[float],
        ys: list[float],
        label: str,
    ) -> None:
        scene = self.scene()
        scene.moving_together = list(els)
        plans = [
            Op(e, scene.move_ops(e, x - b.x, y - b.y))
            for e, b, x, y in zip(els, boxes, xs, ys, strict=True)
        ]
        self._send_plans(scene.with_connectors(plans), label)

    def cmd_distribute(self, args: list[str], _opts: dict[str, object]) -> None:
        how = {
            "horizontal": "x",
            "h": "x",
            "x": "x",
            "vertical": "y",
            "v": "y",
            "y": "y",
        }.get(args[-1])
        if how is None:
            raise ShapeError(
                f"distribute ID... horizontal | vertical (not {args[-1]!r})"
            )
        els = [self.owned(i) for i in args[:-1]]
        scene = self.scene()
        boxes = [b for e in els if (b := scene.slide_box(e)) is not None]
        if len(boxes) != len(els):
            raise ShapeError("one of them has no size")
        targets = spread(boxes, how)
        xs = targets if how == "x" else [b.x for b in boxes]
        ys = targets if how == "y" else [b.y for b in boxes]
        self._place(els, boxes, xs, ys, "Distribute")
        self.report(
            "distribute",
            [e.get("id") or "" for e in els],
            "horizontal" if how == "x" else "vertical",
        )

    # ── Look and content ──

    def _style_ops(self, els: list[SvgElement], opts: dict[str, object]) -> None:
        ops: list[dict[str, object]] = []
        for el in els:
            loc = self.loc(el)
            if Scene.is_zone(el):
                # A text box's frame shows once it is styled (the editor's boxOps).
                ops.append(
                    {"kind": "attrs", "loc": loc, "set": {"inkflow:show-shape": "true"}}
                )
            for name in ("fill", "stroke"):
                if name in opts:
                    ops.append(
                        {
                            "kind": "paint",
                            "loc": loc,
                            "prop": name,
                            **paint(opts[name], name),
                        }
                    )
            css: dict[str, object] = {}
            if "stroke-width" in opts:
                css["stroke-width"] = fmt(
                    number(opts["stroke-width"], "stroke-width", 0)
                )
            if "opacity" in opts:
                opacity = number(opts["opacity"], "opacity", 0)
                if opacity > 1:
                    raise ShapeError("--opacity is 0 to 1")
                css["opacity"] = fmt(opacity)
            if css:
                ops.append({"kind": "style", "loc": loc, "set": css})
        self.svg(ops, "Style")

    def cmd_style(self, args: list[str], opts: dict[str, object]) -> None:
        if not opts:
            raise ShapeError(
                "style takes --fill, --stroke, --stroke-width or --opacity"
            )
        els = [self.owned(i) for i in args]
        self._style_ops(els, opts)
        self.report(
            "style",
            [e.get("id") or "" for e in els],
            ", ".join(f"{k} {v}" for k, v in opts.items()),
        )

    def zone_origin(self, name: str) -> str:
        slide = self.slide
        parsed = None
        md = load_md(slide.md, self.project_dir)
        if md is not None:
            parsed = parse_markdown_zones(md.text)
        root = self.scene().root
        zone_ids = {
            i
            for el in root.iter()
            if is_element(el) and (i := el.get("id") or "").startswith("zone-")
        }
        return zone_origin(
            name, slide, parsed, zone_ids, resolve_default_zone(root, zone_ids)
        )

    def cmd_text(self, args: list[str], _opts: dict[str, object]) -> None:
        el = self.find(args[0])
        text = args[1]
        scene = self.scene()
        if local(el) == "text":
            el = self.owned(args[0])
            self.svg(
                [{"kind": "text", "loc": self.loc(el), "lines": text.split("\n")}],
                "Edit text",
            )
            self.report("text", [el.get("id") or ""], "SVG text")
            return
        if Scene.is_zone(el):
            name = (el.get("id") or "").removeprefix("zone-")
            value = self.slide.zones.get(name)
            if isinstance(value, Image | Video | Chart):
                raise ShapeError(
                    f"zone {name} shows a {type(value).__name__.lower()}, not text"
                )
            self.action(
                "zone-text",
                {
                    "slide": self.index,
                    "zone": name,
                    "text": text,
                    "origin": self.zone_origin(name),
                },
            )
            where = "deck.py" if isinstance(value, TextBox | str) else self.md_where()
            self.report("text", [el.get("id") or ""], f"zone text in {where}")
            return
        if local(el) in ("rect", "ellipse", "circle") and scene.is_own(el):
            result = self.action(
                "shape-text",
                {
                    "slide": self.index,
                    "file": str(self.own_path()),
                    "loc": self.loc(el),
                    "text": text,
                },
            )
            zone = str(cast("dict[str, str]", result.get("ids") or {}).get("new", ""))
            self.created.append(zone)
            self.report(
                "text", [zone], f"{args[0]} is now text zone {zone} ({self.md_where()})"
            )
            return
        raise ShapeError(
            f"{args[0]} holds no text (an SVG <text>, a zone, or a rect or "
            + "ellipse to type into)"
        )

    # ── Structure ──

    def cmd_delete(self, args: list[str], _opts: dict[str, object]) -> None:
        els = [self.owned(i) for i in args]
        self.svg([{"kind": "delete", "loc": self.loc(e)} for e in els], "Delete")
        zones = [e.get("id") or "" for e in els if Scene.is_zone(e)]
        detail = f"zone content went too: {', '.join(zones)}" if zones else ""
        self.report("delete", [e.get("id") or "" for e in els], detail)

    def cmd_duplicate(self, args: list[str], opts: dict[str, object]) -> None:
        el = self.owned(args[0])
        by = point(opts["by"], "by") if "by" in opts else Pt(24, 24)
        ids = self.svg(
            [
                {
                    "kind": "duplicate",
                    "loc": self.loc(el),
                    "offset": [by.x, by.y],
                    "key": "dup0",
                }
            ],
            "Duplicate",
        )
        new = ids.get("dup0", "")
        self.created.append(new)
        self.report("duplicate", [new], f"copy of {args[0]}")

    def cmd_group(self, args: list[str], _opts: dict[str, object]) -> None:
        els = [self.owned(i) for i in args]
        parent = els[0].getparent()
        if any(e.getparent() is not parent for e in els):
            raise ShapeError("only objects side by side (same parent) can be grouped")
        ids = self.svg([{"kind": "group", "locs": [self.loc(e) for e in els]}], "Group")
        new = ids.get("group", "")
        self.created.append(new)
        self.report("group", [new], f"of {', '.join(args)}")

    def cmd_ungroup(self, args: list[str], _opts: dict[str, object]) -> None:
        el = self.owned(args[0])
        if local(el) != "g":
            raise ShapeError(f"{args[0]} is not a group")
        self.svg([{"kind": "ungroup", "loc": self.loc(el)}], "Ungroup")
        self.report("ungroup", [args[0]])

    def cmd_order(self, args: list[str], _opts: dict[str, object]) -> None:
        if args[1] not in ORDER:
            raise ShapeError(f"order ID {' | '.join(ORDER)}")
        el = self.owned(args[0])
        self.svg([{"kind": "order", "loc": self.loc(el), "to": args[1]}], "Arrange")
        self.report("order", [args[0]], args[1])

    def cmd_rename(self, args: list[str], _opts: dict[str, object]) -> None:
        el = self.owned(args[0])
        old = el.get("id") or ""
        new = args[1]
        if Scene.is_zone(el) or new.startswith("zone-"):
            raise ShapeError(
                "a zone's id names its content (its Markdown section, zones=): "
                + "it is not renamed"
            )
        self.check_new_id(new)
        self.svg(
            [{"kind": "id", "loc": self.loc(el), "id": new, "from": old or None}],
            "Rename",
        )
        self.report("rename", [new], f"{old} -> {new}; arrows and animations follow")

    def _set_all(
        self, args: list[str], op: Callable[[str], dict[str, object]], label: str
    ) -> None:
        els = [self.owned(i) for i in args]
        self.svg([op(self.loc(e)) for e in els], label)
        self.report(label.lower(), [e.get("id") or "" for e in els])

    def cmd_lock(self, args: list[str], _opts: dict[str, object]) -> None:
        self._set_all(
            args, lambda loc: {"kind": "lock", "loc": loc, "locked": True}, "Lock"
        )

    def cmd_unlock(self, args: list[str], _opts: dict[str, object]) -> None:
        self._set_all(
            args, lambda loc: {"kind": "lock", "loc": loc, "locked": False}, "Unlock"
        )

    def cmd_hide(self, args: list[str], _opts: dict[str, object]) -> None:
        self._set_all(
            args,
            lambda loc: {"kind": "style", "loc": loc, "set": {"display": "none"}},
            "Hide",
        )

    def cmd_show(self, args: list[str], _opts: dict[str, object]) -> None:
        self._set_all(
            args,
            lambda loc: {"kind": "style", "loc": loc, "set": {"display": None}},
            "Show",
        )

    def cmd_link(self, args: list[str], _opts: dict[str, object]) -> None:
        el = self.owned(args[0])
        target = args[1].strip()
        href: str | None
        if target in ("", "none"):
            href = None
        elif target.isdigit():
            visible = [s for s in self.deck.slides if s.visible]
            n = int(target)
            if not 1 <= n <= len(visible):
                raise ShapeError(f"no slide {n}: the deck shows {len(visible)}")
            href = f"slide:{slide_ids(visible)[n - 1]}"
        else:
            href = target
        self.svg([{"kind": "link", "loc": self.loc(el), "href": href}], "Link")
        self.report("link", [args[0]], href or "removed")


# ── Listing a slide's objects ───────────────────────────────────────────────────


def _rounded(box: Box | None) -> list[float] | None:
    if box is None:
        return None
    return [round(v, 1) for v in (box.x, box.y, box.width, box.height)]


def _preview(text: str, limit: int = 60) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def zone_text(slide: Slide, project_dir: Path, name: str) -> str:
    value = slide.zones.get(name)
    if isinstance(value, str):
        return value
    if isinstance(value, TextBox):
        return value.text or ""
    md = load_md(slide.md, project_dir)
    if md is None:
        return ""
    spans = zone_spans(md.text)
    if name in spans:
        start, end = spans[name]
        return md.text[start:end]
    return ""


def describe(scene: Scene, slide: Slide, project_dir: Path) -> list[dict[str, object]]:
    """The slide's own objects: id, kind, box (slide units), text, and for an
    arrow its ends (``id:site``) and whether they still meet their shapes."""
    out: list[dict[str, object]] = []
    for el in scene.root.iter():
        if not is_element(el) or el.get(INK_TOP) is None or scene.key(el) != 0:
            continue
        out.append(_object(scene, slide, project_dir, el))
    return out


def _kind(scene: Scene, slide: Slide, el: SvgElement) -> str:
    tag = local(el)
    if Scene.is_zone(el):
        value = slide.zones.get((el.get("id") or "").removeprefix("zone-"))
        content = (
            "chart"
            if isinstance(value, Chart)
            else "video"
            if isinstance(value, Video)
            else "image"
            if isinstance(value, Image)
            else "text"
        )
        if el.get("{urn:inkflow}show-shape") == "true" and content == "text":
            return f"text in {tag}"
        return f"{content} zone"
    if scene.is_connector(el):
        heads = (el.get("marker-end") or "") + (el.get("marker-start") or "")
        return (
            "arrow" if "inkflow-arrow" in heads else "line"
        ) + f" ({Scene.connector_style(el)})"
    if tag == "svg" and el.get("data-drawio"):
        return "diagram"
    if tag == "svg":
        return "image (cropped)"
    if tag == "g":
        return f"group ({sum(1 for c in el if is_element(c))})"
    if tag == "a":
        inner = [c for c in el if is_element(c)]
        return f"link ({local(inner[0]) if inner else ''})"
    return tag


def _object(
    scene: Scene, slide: Slide, project_dir: Path, el: SvgElement
) -> dict[str, object]:
    item: dict[str, object] = {
        "id": el.get("id"),
        "kind": _kind(scene, slide, el),
        "box": _rounded(scene.slide_box(el)),
    }
    if local(el) == "text":
        item["text"] = _preview("".join(str(t) for t in el.itertext()))
    elif Scene.is_zone(el):
        text = zone_text(slide, project_dir, (el.get("id") or "").removeprefix("zone-"))
        if text:
            item["text"] = _preview(text)
    if scene.is_connector(el):
        ends: dict[str, object] = {}
        for which in ("start", "end"):
            c = parse_connection(el.get(CONNECT[which]))
            ends[which] = f"{c.id}:{c.site}" if c else None
        item["ends"] = ends
        item["stale"] = scene.is_stale(el)
    if el.get(SITES):
        item["sites"] = Scene.sites_per_side(el)
    if el.get("data-drawio"):
        item["shapes"] = [
            c.get("id")
            for c in el.iter()
            if is_element(c) and c.get("data-cell-kind") == "vertex" and c.get("id")
        ]
    if el.get("data-ink-locked") is not None:
        item["locked"] = True
    if prop(el, "display") == "none":
        item["hidden"] = True
    return item


def layout_targets(scene: Scene) -> list[dict[str, object]]:
    """Named objects of the slide's layout and overlays: arrows may attach
    to them, nothing else here changes them."""
    out: list[dict[str, object]] = []
    for el in scene.root.iter():
        if not is_element(el) or not el.get("id") or scene.key(el) in (0, None):
            continue
        if el.get(INK_TOP) is None:
            continue
        source = scene.source(el)
        out.append(
            {
                "id": el.get("id"),
                "kind": local(el),
                "box": _rounded(scene.slide_box(el)),
                "file": str(source) if source is not None else None,
            }
        )
    return out
