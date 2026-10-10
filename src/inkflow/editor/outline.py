"""A compact overview of a deck for agents: ``inkflow outline``.

Knowing what is on each slide otherwise takes reading deck.py and every
Markdown and SVG file. The outline answers it in a few lines per slide: the
slide's files and layout chain, each zone and where its content is written
(the slide's Markdown, deck.py, or nothing yet), the animations and the clicks
they take. It is built from the editor's own model (``build_model`` over an
editor build), so it reports what the editor and the presenter show, not a
second reading of the sources. ``slide_detail`` adds, for one slide, what an
agent needs to place or animate things: the canvas size, every zone's box,
the ids in the slide's own SVG and each animation as deck.py writes it.
"""

from __future__ import annotations

import dataclasses
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from inkflow.animations import Cue
from inkflow.editor.codegen import Code
from inkflow.editor.model import build_model
from inkflow.editor.provenance import is_element
from inkflow.layout import resolve_chain
from inkflow.manifest import Deck, Slide
from inkflow.pipeline import SlideData, resolve_slide_src, resolve_steps, slide_ids
from inkflow.svgio import SvgElement, parse_svg
from inkflow.zones import parse_markdown_zones, zone_spans

PREVIEW = 60
"""Characters of a zone's text the deck outline shows."""

_STEP_ID = "inkflow-step-"
_STEP_MARKER = re.compile(r"^::steps?\b(?! end)", re.MULTILINE)
_AUTO_ID = re.compile(
    r"^(?:rect|path|g|text|tspan|circle|ellipse|line|polyline|polygon|image|use"
    + r"|layer|svg|a|foreignObject|flowRoot|flowPara|flowRegion)-?\d+(?:-\d+)?$"
)
"""Ids an SVG editor makes up (``rect12``, ``g7``): nothing refers to them, and
listing them would bury the named ones."""
_TRIGGER_MARK = {"on-click": "", "with-previous": "+", "after-previous": ">"}


@dataclass
class ZoneOutline:
    name: str
    origin: str
    """``md`` (the slide's Markdown), ``deck`` (deck.py ``zones=``) or ``empty``."""
    kind: str
    """``md``, ``text`` (a Markdown string in deck.py), ``textbox``, ``image``,
    ``video``, ``chart`` or ``empty``."""
    text: str = ""
    src: str | None = None
    reveals: int = 0
    """Click reveals inside the zone (``::step::`` / ``::steps::`` items)."""
    box: list[float] | None = None
    """``[x, y, width, height]`` in slide units (before ``transform``)."""
    transform: str | None = None


@dataclass
class CueOutline:
    type: str
    element: str
    trigger: str
    step: int
    code: str
    """The cue as deck.py writes it."""


@dataclass
class SlideOutline:
    number: int | None
    """1-based position in the presented deck (what ``render``/``goto`` take);
    ``None`` for a hidden slide."""
    index: int
    """Position in ``Deck(slides=[...])``."""
    id: str
    title: str
    hidden: bool
    svg: str | None
    """The slide's own SVG; ``None`` when it is drawn straight from a layout."""
    layout: list[str]
    """Layout chain, nearest first (the layout itself when ``svg`` is ``None``)."""
    md: str | None
    notes: str | None
    ink: str | None
    transition: str | None
    """The slide's own transition as deck.py writes it; ``None`` = deck default."""
    overlays: list[str] | None
    """The slide's own ``overlays=``; ``None`` = deck default."""
    zones: list[ZoneOutline] = field(default_factory=list)
    animations: list[CueOutline] = field(default_factory=list)
    steps: int = 0
    """Clicks the slide takes before the next slide."""
    canvas: list[float] | None = None
    ids: list[str] = field(default_factory=list)
    """Named elements of the slide's own SVG, nested as ``group{child …}``."""
    notes_text: str = ""
    section: int | None = None
    """Index into ``DeckOutline.sections``; ``None`` before the first section."""


@dataclass
class SectionOutline:
    name: str
    index: int
    """Position in ``Deck(slides=[...])`` of its first slide (where it would
    start, when empty)."""
    count: int


@dataclass
class DeckOutline:
    deck: str
    slides: list[SlideOutline]
    canvas: list[float] | None
    mode: str
    transition: str
    overlays: list[str]
    size: str | None = None
    """The deck's ``Deck(size=)`` (``a0``, ``16:9``), ``None`` when it sets none."""
    page: str | None = None
    """The printed page that size names (``A0 portrait (841 x 1189 mm)``)."""
    sections: list[SectionOutline] = field(default_factory=list)


def _rel(path: str | Path | None, project_dir: Path) -> str | None:
    if path is None:
        return None
    p = Path(path)
    try:
        return p.resolve().relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        return p.name


def _code(obj: object) -> str:
    text = Code().call(obj)
    return text.removeprefix("transitions.").removeprefix("animations.")


def _flat(text: str) -> str:
    return " ".join(text.split())


def _preview(text: str, limit: int = PREVIEW) -> str:
    flat = _flat(text)
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def _num(value: float) -> float:
    rounded = round(value, 1)
    return int(rounded) if rounded.is_integer() else rounded


def _floats(el: SvgElement, *names: str) -> list[float] | None:
    try:
        return [_num(float(el.get(n, ""))) for n in names]
    except ValueError:
        return None


def _canvas(root: SvgElement) -> list[float] | None:
    box = (root.get("viewBox") or "").replace(",", " ").split()
    if len(box) == 4:
        try:
            return [_num(float(box[2])), _num(float(box[3]))]
        except ValueError:
            pass
    return _floats(root, "width", "height")


def _max_step(root: SvgElement) -> int:
    """The slide's last step, as the presenter's ``maxStep`` reads the markup."""
    top = 0
    for el in root.iter():
        cues = el.get("data-cues")
        if cues:
            try:
                entries = cast("list[dict[str, object]]", json.loads(cues))
            except ValueError:
                entries = []
            for entry in entries:
                step = entry.get("step")
                if isinstance(step, int):
                    top = max(top, step)
        play = el.get("data-play-on-step")
        if play and play.isdigit():
            top = max(top, int(play))
        spec, base = el.get("data-hl-spec"), el.get("data-base-step")
        if spec and base and base.isdigit():
            try:
                stages = cast("list[object]", json.loads(spec))
            except ValueError:
                continue
            top = max(top, int(base) + len(stages) - 1)
    return top


def _reveal_base(root: SvgElement) -> int:
    """The last step the Markdown reveals take; deck.py animations follow it."""
    top = 0
    for el in root.iter():
        rid = el.get("id") or ""
        cues = el.get("data-cues")
        if rid.startswith(_STEP_ID) and cues:
            for entry in cast("list[dict[str, object]]", json.loads(cues)):
                step = entry.get("step")
                if isinstance(step, int):
                    top = max(top, step)
        spec, base = el.get("data-hl-spec"), el.get("data-base-step")
        if spec and base and base.isdigit():
            top = max(top, int(base) + len(cast("list[object]", json.loads(spec))) - 1)
    return top


def _is_named(el: SvgElement) -> bool:
    eid = el.get("id")
    if not eid or eid.startswith(("zone-", "inkflow-")) or _AUTO_ID.match(eid):
        return False
    ink = el.get("data-ink") or ""
    return (
        ink.startswith("0:")
        or "-series-" in eid
        or "-slice-" in eid
        or el.get("data-cell-kind") is not None
    )


def _named_ids(el: SvgElement) -> list[str]:
    """Named descendants of ``el``, nested as ``group{child …}``."""
    out: list[str] = []
    for child in el:
        if not is_element(child) or child.tag.endswith("}defs"):
            continue
        inner = _named_ids(child)
        if _is_named(child):
            token = cast("str", child.get("id"))
            if child.tag.endswith("}text"):
                said = _preview(" ".join(cast("list[str]", list(child.itertext()))), 30)
                if said:
                    token += f'="{said}"'
            out.append(token + ("{" + " ".join(inner) + "}" if inner else ""))
        else:
            out.extend(inner)
    return out


def _zone_from_md(name: str, text: str) -> ZoneOutline:
    return ZoneOutline(
        name, "md", "md", text.strip(), reveals=len(_STEP_MARKER.findall(text))
    )


def _zone_from_deck(name: str, value: dict[str, object]) -> ZoneOutline:
    kind = str(value.get("kind", "other"))
    src = value.get("src")
    text = str(value.get("text", ""))
    if kind == "chart":
        fields = cast("dict[str, object]", value.get("fields") or {})
        text = str(fields.get("kind") or "")
        if fields.get("title"):
            text += f' "{fields["title"]}"'
        if value.get("inline"):
            src = "inline data"
    return ZoneOutline(
        name,
        "deck",
        kind,
        text,
        src=str(src) if isinstance(src, str) else None,
        reveals=len(_STEP_MARKER.findall(text)) if kind == "text" else 0,
    )


def _layout_chain(
    slide: Slide, deck: Deck, project_dir: Path
) -> tuple[str | None, list[str]]:
    try:
        path = resolve_slide_src(slide.src, project_dir, deck.theme)
        chain = resolve_chain(path, project_dir, deck.theme)
    except Exception:
        return slide.src, []
    names = [p.stem for p in reversed(chain)]
    if "layouts" in path.parts:
        return None, [path.stem, *names]
    return _rel(path, project_dir), names


def _hidden_zones(entry: dict[str, object]) -> list[ZoneOutline]:
    """A hidden slide is not built: its zones come from its sources alone."""
    zones: list[ZoneOutline] = []
    md = cast("dict[str, object] | None", entry.get("md"))
    if md is not None:
        text = str(md["text"])
        spans = zone_spans(text)
        for name in parse_markdown_zones(text).zones:
            start, end = spans.get(name, (0, len(text)))
            zones.append(_zone_from_md(name, text[start:end]))
    deck_zones = cast("dict[str, dict[str, object]]", entry.get("zones") or {})
    zones.extend(_zone_from_deck(n, v) for n, v in deck_zones.items())
    return zones


def _built_zones(entry: dict[str, object], root: SvgElement) -> list[ZoneOutline]:
    origins = cast("dict[str, str]", entry.get("zoneOrigins") or {})
    texts = cast("dict[str, str]", entry.get("zoneText") or {})
    deck_zones = cast("dict[str, dict[str, object]]", entry.get("zones") or {})
    zones: list[ZoneOutline] = []
    for name, origin in origins.items():
        if origin == "deck" and name in deck_zones:
            zone = _zone_from_deck(name, deck_zones[name])
        else:
            zone = _zone_from_md(name, texts.get(name, ""))
        el = root.find(f'.//*[@id="zone-{name}"]')
        if el is not None:
            zone.box = _floats(el, "x", "y", "width", "height")
            zone.transform = el.get("transform")
            reveals = el.xpath(f'.//*[starts-with(@id, "{_STEP_ID}")]')
            zone.reveals = len(cast("list[object]", reveals))
        zones.append(zone)
    for empty in cast("list[dict[str, object]]", entry.get("emptyZones") or []):
        box = [
            _num(float(cast("float", empty[k]))) for k in ("x", "y", "width", "height")
        ]
        transform = cast("str | None", empty.get("transform"))
        zones.append(
            ZoneOutline(
                str(empty["zone"]), "empty", "empty", "", None, 0, box, transform
            )
        )
    # Reading order: top to bottom, then left to right.
    zones.sort(key=lambda z: (z.box[1], z.box[0]) if z.box else (float("inf"), 0.0))
    return zones


def build_outline(deck: Deck, deck_path: Path, slides: list[SlideData]) -> DeckOutline:
    """The deck's outline. ``slides`` must come from ``process_deck(editor=True)``."""
    project_dir = deck_path.parent
    model = build_model(deck, deck_path, slides)
    entries = cast("list[dict[str, object]]", model["slides"])
    out: list[SlideOutline] = []
    canvas: list[float] | None = None
    for slide, entry in zip(deck.slides, entries, strict=True):
        index = cast("int", entry["deckIndex"])
        visible = cast("int | None", entry.get("visibleIndex"))
        svg, layout = _layout_chain(slide, deck, project_dir)
        md = cast("dict[str, object] | None", entry.get("md"))
        notes = cast("dict[str, object]", entry["notes"])
        ink = cast("dict[str, object] | None", entry.get("ink"))
        item = SlideOutline(
            number=visible + 1 if visible is not None else None,
            index=index,
            id=str(entry.get("id") or slide_ids([slide])[0]),
            title=str(entry.get("title") or ""),
            hidden=not slide.visible,
            svg=svg,
            layout=layout,
            md=(str(md["rel"]) if md.get("rel") else "inline") if md else None,
            notes=(
                None
                if notes["kind"] == "none"
                else str(notes["rel"])
                if notes.get("rel")
                else "inline"
            ),
            ink=str(ink["rel"]) if ink and ink.get("exists") else None,
            transition=_code(slide.transition) if slide.transition else None,
            overlays=(
                [o.src for o in slide.overlays] if slide.overlays is not None else None
            ),
            notes_text=str(notes.get("text") or ""),
            section=deck.section_of(index),
        )
        if visible is None:
            item.zones = _hidden_zones(entry)
            item.animations = _cues(slide.animations, 0)
            item.steps = max((c.step for c in item.animations), default=0)
        else:
            root = parse_svg(slides[visible]["svg"])
            item.canvas = _canvas(root)
            canvas = canvas or item.canvas
            item.zones = _built_zones(entry, root)
            item.animations = _cues(slide.animations, _reveal_base(root))
            item.steps = _max_step(root)
            item.ids = _named_ids(root)
        out.append(item)
    return DeckOutline(
        deck=deck_path.name,
        slides=out,
        canvas=canvas
        or ([_num(v) for v in deck.effective_size.canvas] if deck.size else None),
        mode=str(deck.effective_mode),
        transition=_code(deck.effective_transition),
        overlays=[o.src for o in deck.effective_overlays],
        size=str(deck.size) if deck.size is not None else None,
        page=deck.effective_size.label if deck.size is not None else None,
        sections=[
            SectionOutline(section.name, span.start, len(span))
            for section, span in zip(deck.sections, deck.section_ranges(), strict=True)
        ],
    )


def _cues(cues: list[Cue], base: int) -> list[CueOutline]:
    return [
        CueOutline(type(c).__name__, c.element, str(c.trigger), step, _code(c))
        for c, step in resolve_steps(cues, base)
    ]


def outline_json(outline: DeckOutline) -> dict[str, object]:
    return dataclasses.asdict(outline)


# ── Text ──────────────────────────────────────────────────────────────────────


def _size(canvas: list[float] | None) -> str:
    if not canvas:
        return "?"
    return "x".join(f"{v:g}" for v in canvas)


def _box(zone: ZoneOutline) -> str:
    if not zone.box:
        return ""
    x, y, w, h = zone.box
    text = f"@{x:g},{y:g} {w:g}x{h:g}"
    return text + (f" transform={zone.transform}" if zone.transform else "")


def _zone_line(zone: ZoneOutline, width: int, full: bool) -> list[str]:
    where = {"md": "md", "deck": "deck.py", "empty": "empty"}[zone.origin]
    parts = [f"  {zone.name:<{width}} {where:<7}"]
    if full:
        parts.append(_box(zone))
    if zone.kind in ("image", "video", "chart"):
        parts += [zone.kind, zone.src or "", zone.text]
    elif zone.kind == "textbox":
        parts.append("TextBox")
    if zone.kind in ("md", "text", "textbox") and not full:
        parts.append(_preview(zone.text))
    if zone.reveals:
        parts.append(f"({zone.reveals} reveal{'s' if zone.reveals > 1 else ''})")
    lines = [" ".join(p for p in parts if p).rstrip()]
    if full and zone.kind in ("md", "text", "textbox") and zone.text:
        lines.extend(f"      {line}" for line in zone.text.splitlines())
    return lines


def _anim_token(cue: CueOutline) -> str:
    mark = _TRIGGER_MARK.get(cue.trigger, f"@{cue.trigger}")
    slug = re.sub(r"(?<!^)(?=[A-Z])", "-", cue.type).lower()
    return f"{mark}{slug} {cue.element}"


def _slide_lines(s: SlideOutline, full: bool) -> list[str]:
    num = str(s.number) if s.number is not None else "-"
    head = f"{num}. {s.id}"
    if s.title and s.title.lower() != s.id.lower():
        head += f' "{s.title}"'
    head += f"  slides[{s.index}]"
    if s.hidden:
        head += " HIDDEN"
    if s.transition:
        head += f"  {s.transition}"
    lines = [head]
    files: list[str] = []
    chain = " < ".join(s.layout)
    if s.svg:
        files.append(f"svg {s.svg}" + (f" < {chain}" if chain else ""))
    elif chain:
        files.append(f"layout {chain}")
    if s.overlays is not None:
        files.append("overlays " + (", ".join(s.overlays) or "none"))
    if s.md:
        files.append(f"md {s.md}")
    if s.notes:
        files.append(f"notes {s.notes}")
    if s.ink:
        files.append(f"ink {s.ink}")
    lines.append("  " + "  ".join(files))
    if full and s.canvas:
        lines.append(f"  canvas {_size(s.canvas)}")
    width = max((len(z.name) for z in s.zones), default=0)
    for zone in s.zones:
        lines.extend(_zone_line(zone, width, full))
    if s.animations:
        clicks = f", {s.steps} click{'s' if s.steps != 1 else ''}"
        if full:
            lines.append(f"  animations ({len(s.animations)}{clicks}):")
            lines.extend(f"    {c.step}: {c.code}" for c in s.animations)
        else:
            tokens = ", ".join(_anim_token(c) for c in s.animations)
            lines.append(f"  anims {len(s.animations)}{clicks}: {tokens}")
    elif s.steps:
        lines.append(f"  {s.steps} click{'s' if s.steps != 1 else ''}")
    if full:
        if s.ids:
            lines.append("  ids: " + " ".join(s.ids))
        if s.notes_text.strip():
            lines.append("  notes: " + _preview(s.notes_text, 200))
    return lines


def format_outline(outline: DeckOutline, number: int | None = None) -> str:
    """Plain text: the whole deck, or slide ``number`` (1-based) in detail."""
    if number is not None:
        for s in outline.slides:
            if s.number == number:
                return "\n".join(_slide_lines(s, full=True))
        raise IndexError(number)
    shown = sum(1 for s in outline.slides if not s.hidden)
    hidden = len(outline.slides) - shown
    head = f"{outline.deck}: {shown} slides"
    if hidden:
        head += f" (+{hidden} hidden)"
    if outline.size is not None:
        head += f", size {outline.size}: {outline.page}, canvas"
    head += (
        f" {_size(outline.canvas)}" if outline.size else f", {_size(outline.canvas)}"
    )
    head += f", mode {outline.mode}"
    head += f", transition {outline.transition}"
    head += ", overlays " + (", ".join(outline.overlays) or "none")
    lines = [
        head,
        "zone origins: md = the slide's .md, deck.py = Slide(zones=...); "
        + "anims: + with previous, > after previous, @n pinned",
    ]
    starts: dict[int, list[SectionOutline]] = {}
    for section in outline.sections:
        starts.setdefault(section.index, []).append(section)
    for s in outline.slides:
        for section in starts.pop(s.index, []):
            lines.extend(["", _section_line(section)])
        lines.append("")
        lines.extend(_slide_lines(s, full=False))
    for rest in starts.values():  # empty sections at the end
        for section in rest:
            lines.extend(["", _section_line(section)])
    return "\n".join(lines)


def _section_line(section: SectionOutline) -> str:
    count = f"{section.count} slide{'s' if section.count != 1 else ''}"
    return f"## {section.name}  ({count})"
