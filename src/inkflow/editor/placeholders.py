"""Placeholders: the zones a layout (or an overlay) leaves for its slides to
fill, as the slide master and ``inkflow layout placeholder`` change them.

A placeholder is a ``zone-<name>`` shape in the layout's SVG, optionally with a
prompt (``<inkflow:hint zone="<name>">``: what the empty zone says on a new
slide, and the text a click types in). Its kind is in its name: a zone named
for a picture (`is_media_zone`) takes a picture or video, any other text.

What fills a placeholder lives in the slides, never in the layout: a
``::name::`` section of a slide's Markdown, a ``zones={"name": …}`` entry of
its ``Slide(...)``, animations aimed at ``zone-name``. So renaming one is a plan
over every slide built on the layout (directly or through a child layout; for
an overlay, every slide that gets it), made here without writing anything
(`plan_rename`, `plan_remove`); the session writes the plan as one step.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.animations import Cue, PlayVideo
from inkflow.clean import is_preview_layer
from inkflow.content import zone_box
from inkflow.editor.codegen import Code
from inkflow.editor.deckedit import DeckSource
from inkflow.editor.master import (
    MasterError,
    layout_entries,
    overlay_entries,
    slide_layouts,
    slug_name,
    with_inkflow,
)
from inkflow.editor.model import is_media_zone
from inkflow.editor.provenance import is_element
from inkflow.editor.svgops import CONNECT_ENDS, SvgFile, set_style
from inkflow.layout import AssetKind, builtin_theme_dir, resolve_chain
from inkflow.manifest import Chart, Deck, Inline, Slide
from inkflow.pipeline import resolve_overlay_chains, resolve_slide_src
from inkflow.svgio import SvgElement
from inkflow.zones import (
    parse_markdown_zones,
    remove_zone_section,
    rename_zone,
    zone_names,
)

Reader = Callable[[Path], bytes | None]
"""A file's bytes as the current request left them (None: no such file)."""

MdPath = Callable[[Slide], Path | None]
"""A slide's Markdown file (None: none, or written inline in deck.py)."""

_SHAPES = ("rect", "ellipse", "circle", "polygon", "polyline", "path")
TEXT_SHAPES = ("rect", "ellipse", "circle")
"""What a text placeholder can be made from: text reflows in its box."""
PICTURE_SHAPES = ("rect", "ellipse", "circle", "polygon", "path")
"""What a picture placeholder can be made from: the picture is cut to it."""

_RESERVED = frozenset({"notes", "slide", "slide-number", "slide-total"})
_STEP = re.compile(r"^steps?(?!\w)")
_NAME = re.compile(r"^[a-z][a-z0-9-]*$")
_ZONE_VARS = ("--inkflow-align", "--inkflow-valign", "--inkflow-padding")


# ── Names ─────────────────────────────────────────────────────────────────────


def kind_of(name: str) -> str:
    """``picture`` for a zone named for a picture or video, else ``text``."""
    return "picture" if is_media_zone(name) else "text"


def zone_name(kind: str, typed: str) -> str:
    """The zone name a typed placeholder name gives (``Code example`` →
    ``code-example``); a picture placeholder's says it is one (``hero`` →
    ``picture-hero``), which is how the editor knows to offer a picture for
    it. Empty when nothing usable was typed."""
    name = slug_name(typed.strip().removeprefix("zone-"))
    if name and kind == "picture" and not is_media_zone(name):
        name = f"picture-{name}"
    return name


def reserved_problem(name: str) -> str | None:
    """Why ``name`` is taken by inkflow itself (speaker notes, the slide
    numbers, step reveals), or None."""
    if name.lower() in _RESERVED:
        return f"'{name}' is a reserved zone name"
    if _STEP.match(name.lower()):
        return "a zone name cannot start with 'step': Markdown reads that as a reveal"
    return None


def name_problem(name: str) -> str | None:
    """Why ``name`` cannot name a zone, or None."""
    if not name:
        return "give the placeholder a name"
    if not _NAME.match(name):
        return f"'{name}' is not a zone name: start with a letter"
    return reserved_problem(name)


# ── Reading a file's zones ────────────────────────────────────────────────────


def own_elements(root: SvgElement) -> list[SvgElement]:
    """The file's own elements, not what its Inkscape preview layers copy in."""
    out: list[SvgElement] = []
    for child in root:
        if is_element(child) and not is_preview_layer(child):
            out.extend(el for el in child.iter() if is_element(el))
    return out


def _local(el: SvgElement) -> str:
    return str(el.tag).rsplit("}", 1)[-1]


def zone_elements(root: SvgElement) -> list[SvgElement]:
    """The file's own placeholder shapes (not the slide number's texts)."""
    return [
        el
        for el in own_elements(root)
        if (el.get("id") or "").startswith("zone-") and _local(el) in _SHAPES
    ]


def own_zone(root: SvgElement, name: str) -> SvgElement | None:
    for el in zone_elements(root):
        if el.get("id") == f"zone-{name}":
            return el
    return None


def hint_elements(root: SvgElement) -> list[SvgElement]:
    return [el for el in own_elements(root) if el.tag == ns.INKFLOW_HINT]


def _hints(root: SvgElement) -> dict[str, str]:
    hints: dict[str, str] = {}
    for el in hint_elements(root):
        zone, text = el.get("zone"), (el.text or "").strip()
        if zone and text:
            hints[zone] = text
    return hints


def _ids(root: SvgElement) -> set[str]:
    return {i for el in own_elements(root) if (i := el.get("id"))}


def parse(path: Path, read: Reader) -> SvgFile | None:
    data = read(path)
    if data is None:
        return None
    try:
        return SvgFile.from_bytes(path, data)
    except Exception:
        return None


# ── Which file, and who uses it ───────────────────────────────────────────────


@dataclass
class Target:
    """A layout or an overlay whose placeholders are edited."""

    path: Path
    kind: AssetKind
    aliases: set[Path]
    """``path`` and, for the deck's copy of a theme's file, that file."""
    slides: list[int]
    """Deck indices of the slides that get it (through child layouts too)."""
    chain: list[Path]
    """Its ancestors, root first."""
    children: list[Path] = field(default_factory=list)
    """Layouts built on it, directly or not."""

    @property
    def name(self) -> str:
        return self.path.stem


def target(deck: Deck, project_dir: Path, path: Path, kind: AssetKind) -> Target:
    """``path`` (a layout's or an overlay's file; the project's copy of a
    theme's one also before it is written) as a `Target`."""
    resolved = path.resolve()
    aliases = {resolved}
    copy = (project_dir / kind / path.name).resolve() == resolved
    slides: list[int] = []
    children: list[Path] = []
    if kind is AssetKind.LAYOUT:
        entries = layout_entries(deck, project_dir)
        entry = entries.get(path.stem)
        if entry is not None and (entry.path.resolve() == resolved or copy):
            aliases.add(entry.path.resolve())
        for i, (_direct, chain) in enumerate(slide_layouts(deck, project_dir)):
            if aliases & set(chain):
                slides.append(i)
        for e in entries.values():
            if e.path.resolve() in aliases:
                continue
            try:
                above = resolve_chain(e.path, project_dir, deck.theme)
            except (ValueError, OSError):
                continue
            if aliases & {p.resolve() for p in above}:
                children.append(e.path)
    else:
        for o in overlay_entries(deck, project_dir):
            if o.path is None:
                continue
            if o.path.resolve() == resolved or (copy and o.name == path.stem):
                aliases.add(o.path.resolve())
                slides = sorted(set(slides) | set(o.slides))
    existing = next((p for p in sorted(aliases) if p.exists()), resolved)
    try:
        chain = resolve_chain(existing, project_dir, deck.theme, kind)
    except (ValueError, OSError):
        chain = []
    return Target(resolved, kind, aliases, slides, chain, children)


def slide_label(deck: Deck, index: int) -> str:
    """``slide 3`` as the presenter numbers it; ``hidden slide (deck 4)``."""
    slide = deck.slides[index]
    if not slide.visible:
        return f"hidden slide {index + 1} of deck.py"
    number = sum(1 for s in deck.slides[: index + 1] if s.visible)
    return f"slide {number}"


def _md_text(slide: Slide, md_path: MdPath, read: Reader) -> str:
    if isinstance(slide.md, Inline):
        return str(slide.md)
    path = md_path(slide)
    data = read(path) if path is not None else None
    return data.decode("utf-8") if data is not None else ""


def filled_by(
    deck: Deck, slides: list[int], name: str, md_path: MdPath, read: Reader
) -> list[int]:
    """Which of ``slides`` put something into zone ``name``."""
    out: list[int] = []
    for i in slides:
        slide = deck.slides[i]
        if name in slide.zones:
            out.append(i)
            continue
        text = _md_text(slide, md_path, read)
        if text.strip() and name in parse_markdown_zones(text).zones:
            out.append(i)
    return out


@dataclass
class Placeholder:
    name: str
    kind: str
    prompt: str | None
    box: tuple[float, float, float, float]
    tag: str
    shape: bool
    """Drawn as a box of its own (``inkflow:show-shape``)."""
    layout: str
    """The file it is written in (its stem)."""
    own: bool
    """Written in the file asked about, not in one of its ancestors."""
    filled: list[int]

    def json(self) -> dict[str, object]:
        return {
            "name": self.name,
            "zone": f"zone-{self.name}",
            "kind": self.kind,
            "prompt": self.prompt,
            "box": list(self.box),
            "tag": self.tag,
            "shape": self.shape,
            "layout": self.layout,
            "own": self.own,
            "filled": self.filled,
        }


def placeholders(
    deck: Deck, t: Target, read: Reader, md_path: MdPath
) -> list[Placeholder]:
    """The file's own placeholders, then those of the layouts it is built on
    (nearest first), each with its prompt and the slides that fill it."""
    files = [t.path, *reversed(t.chain)]
    prompts: dict[str, str] = {}
    for p in reversed(files):  # nearest last: it wins
        svg = parse(p, read)
        if svg is not None:
            prompts.update(_hints(svg.root))
    out: list[Placeholder] = []
    seen: set[str] = set()
    for k, p in enumerate(files):
        svg = parse(p, read)
        if svg is None:
            continue
        for el in zone_elements(svg.root):
            name = str(el.get("id")).removeprefix("zone-")
            if name in seen:
                continue
            seen.add(name)
            try:
                box = zone_box(el)
            except Exception:
                box = (0.0, 0.0, 0.0, 0.0)
            out.append(
                Placeholder(
                    name,
                    kind_of(name),
                    prompts.get(name),
                    box,
                    _local(el),
                    el.get(ns.INKFLOW_SHOW_SHAPE) == "true",
                    p.stem,
                    k == 0,
                    filled_by(deck, t.slides, name, md_path, read),
                )
            )
    return out


def composition(deck: Deck, project_dir: Path, index: int) -> list[Path]:
    """The files slide ``index`` is composed of: its own, its layouts, its
    overlays (and theirs)."""
    slide = deck.slides[index]
    files: list[Path] = []
    try:
        src = resolve_slide_src(slide.src, project_dir, deck.theme)
        files += [src, *resolve_chain(src, project_dir, deck.theme)]
    except (ValueError, OSError):
        pass
    overlays = slide.overlays if slide.overlays is not None else deck.effective_overlays
    try:
        for stack in resolve_overlay_chains(overlays, project_dir, deck.theme):
            files += stack
    except (ValueError, OSError):
        pass
    return files


def taken_ids(deck: Deck, project_dir: Path, t: Target, read: Reader) -> set[str]:
    """Every id a new zone in ``t`` must not take: its own and its
    ancestors', its child layouts', those of each slide that gets it, and the
    deck's overlays' (a zone id is one per composed slide)."""
    files: set[Path] = {t.path, *t.chain, *t.children}
    for i in t.slides:
        files.update(composition(deck, project_dir, i))
    for o in overlay_entries(deck, project_dir):
        if o.path is not None and o.deck:
            files.add(o.path)
    ids: set[str] = set()
    for p in files:
        if p.resolve() in t.aliases and p.resolve() != t.path:
            continue  # the theme's file the deck's copy replaces
        svg = parse(p, read)
        if svg is not None:
            ids |= _ids(svg.root)
    return ids


# ── Changing the layout's own file ────────────────────────────────────────────


def _hint(zone: str, text: str) -> SvgElement:
    el = etree.Element(ns.INKFLOW_HINT, nsmap={"inkflow": ns.INKFLOW})
    el.set("zone", zone)
    el.text = text
    el.tail = "\n"
    return el


def set_prompt(root: SvgElement, name: str, prompt: str | None) -> bool:
    """Write (or with an empty ``prompt``, remove) zone ``name``'s prompt in
    this file; True when that changed anything."""
    text = (prompt or "").strip()
    found = [el for el in hint_elements(root) if el.get("zone") == name]
    if not text:
        for el in found:
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
        return bool(found)
    if found:
        changed = (found[0].text or "").strip() != text
        found[0].text = text
        for el in found[1:]:
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
        return changed or len(found) > 1
    root.append(_hint(name, text))
    return True


def _style_selector(old: str) -> re.Pattern[str]:
    return re.compile(rf"#zone-{re.escape(old)}(?![\w-])")


def _rename_refs(root: SvgElement, old: str, new: str) -> bool:
    """Prompts, connector ends, ``<style>`` rules and the default zone
    (``inkflow:default-zone``) naming zone ``old`` follow it to ``new`` (the
    zone itself is renamed by the caller)."""
    changed = False
    if root.get(ns.INKFLOW_DEFAULT_ZONE) == old:
        root.set(ns.INKFLOW_DEFAULT_ZONE, new)
        changed = True
    for el in own_elements(root):
        if el.tag == ns.INKFLOW_HINT and el.get("zone") == old:
            el.set("zone", new)
            changed = True
        for attr in CONNECT_ENDS:
            value = el.get(attr)
            if value and value.rpartition(":")[0] == f"zone-{old}":
                el.set(attr, f"zone-{new}:{value.rpartition(':')[2]}")
                changed = True
        if _local(el) == "style" and el.text:
            text = _style_selector(old).sub(f"#zone-{new}", el.text)
            if text != el.text:
                el.text = text
                changed = True
    return changed


# ── Plans ─────────────────────────────────────────────────────────────────────


@dataclass
class Plan:
    """What a placeholder change writes, for the session to make one step."""

    writes: dict[Path, bytes] = field(default_factory=dict)
    deck_changed: bool = False
    imports: set[str] = field(default_factory=set)
    slides: list[int] = field(default_factory=list)
    """Deck indices of the slides whose content followed."""
    edits: list[str] = field(default_factory=list)
    """What changed where, a line each ("slides/a.md: ::code:: → ::sample::")."""
    warnings: list[str] = field(default_factory=list)
    source: DeckSource | None = None
    """deck.py as the plan left it, when ``deck_changed``."""

    def read(self, read: Reader) -> Reader:
        def reader(path: Path) -> bytes | None:
            key = path.resolve()
            return self.writes[key] if key in self.writes else read(path)

        return reader

    def summary(self, deck: Deck, project_dir: Path) -> dict[str, object]:
        def rel(p: Path) -> str:
            try:
                return p.resolve().relative_to(project_dir.resolve()).as_posix()
            except ValueError:
                return str(p)

        files = sorted(rel(p) for p in self.writes)
        if self.deck_changed:
            files.append("deck.py")
        return {
            "slides": self.slides,
            "slideNames": [slide_label(deck, i) for i in self.slides],
            "files": files,
            "edits": self.edits,
            "warnings": self.warnings,
        }


def _cue_target(cue: Cue, old: str, new: str, chart: bool) -> str | None:
    """Where ``cue`` points once zone ``old`` is ``new`` (None: unchanged)."""
    element = cue.element
    if isinstance(cue, PlayVideo):
        return new if element == old else None
    if element == f"zone-{old}":
        return f"zone-{new}"
    if chart and element.startswith(f"{old}-"):
        return f"{new}-{element.removeprefix(f'{old}-')}"
    return None


class _Slides:
    """The slides' side of a plan: their Markdown, ``zones={...}``,
    animations and own drawings, read and written through the plan."""

    deck: Deck
    project_dir: Path
    plan: Plan
    read: Reader
    md_path: MdPath
    _source: Callable[[], DeckSource]
    _deck: DeckSource | None
    code: Code

    def __init__(
        self,
        deck: Deck,
        project_dir: Path,
        plan: Plan,
        read: Reader,
        md_path: MdPath,
        source: Callable[[], DeckSource],
    ) -> None:
        self.deck = deck
        self.project_dir = project_dir
        self.plan = plan
        self.read = plan.read(read)
        self.md_path = md_path
        self._source = source
        self._deck = None
        self.code = Code()

    def source(self, why: str) -> DeckSource:
        if self._deck is None:
            self._deck = self._source()
            if self._deck.slide_calls(expected=len(self.deck.slides)) is None:
                raise MasterError(
                    f"deck.py builds its slides in code: {why} there by hand"
                )
        self.plan.deck_changed = True
        return self._deck

    def text(self, path: Path) -> str:
        data = self.read(path)
        return data.decode("utf-8") if data is not None else ""

    def write(self, path: Path, data: bytes) -> None:
        self.plan.writes[path.resolve()] = data

    def rel(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.project_dir.resolve()).as_posix()
        except ValueError:
            return path.name

    def users_of(self, md: Path) -> list[int]:
        out: list[int] = []
        for i, s in enumerate(self.deck.slides):
            if s.md is None or isinstance(s.md, Inline):
                continue
            p = self.md_path(s)
            if p is not None and p.resolve() == md.resolve():
                out.append(i)
        return out

    def finish(self) -> None:
        if self._deck is not None and self.plan.deck_changed:
            self.plan.imports |= self.code.imports
            self.plan.source = self._deck


def _check_free(slides: _Slides, t: Target, old: str, new: str, deck: Deck) -> None:
    """Refuse a rename onto a zone any slide on ``t`` already names: its
    text for ``new`` would land in the renamed zone."""
    for i in t.slides:
        slide = deck.slides[i]
        label = slide_label(deck, i)
        if new in slide.zones:
            raise MasterError(f"{label} already fills '{new}' in deck.py zones=")
        if isinstance(slide.md, Inline):
            if new in zone_names(str(slide.md)):
                raise MasterError(f"{label} already has a '{new}' zone in its text")
            continue
        md = slides.md_path(slide) if slide.md is not None else None
        if md is None:
            continue
        text = slides.text(md)
        if new in zone_names(text):
            raise MasterError(f"{label} already has a '{new}' zone in {slides.rel(md)}")
        others = [u for u in slides.users_of(md) if u not in t.slides]
        if old in zone_names(text) and others:
            raise MasterError(
                f"{slides.rel(md)} is also the Markdown of "
                + f"{slide_label(deck, others[0])}, which is not built on '{t.name}'"
            )


def _rename_slides(slides: _Slides, t: Target, old: str, new: str, deck: Deck) -> None:
    _check_free(slides, t, old, new, deck)
    plan = slides.plan
    md_done: set[Path] = set()
    for i in t.slides:
        slide = deck.slides[i]
        label = slide_label(deck, i)
        touched = False
        # Markdown: ::old:: markers (or the auto-extracted heading/body).
        if isinstance(slide.md, Inline):
            text = str(slide.md)
            if old in zone_names(text):
                source = slides.source("rename the zone")
                renamed = rename_zone(text, old, new)
                source.set_slide_arg(i, "md", f"Inline({slides.code.literal(renamed)})")
                slides.code.imports.add("Inline")
                plan.edits.append(f"deck.py: {label}'s Markdown ::{old}:: → ::{new}::")
                touched = True
        else:
            md = slides.md_path(slide) if slide.md is not None else None
            if md is not None and old in zone_names(slides.text(md)):
                if md.resolve() not in md_done:
                    md_done.add(md.resolve())
                    renamed = rename_zone(slides.text(md), old, new)
                    slides.write(md, renamed.encode("utf-8"))
                    plan.edits.append(f"{slides.rel(md)}: ::{old}:: → ::{new}::")
                touched = True
        # zones={"old": …}
        if old in slide.zones:
            source = slides.source("rename the zone")
            _ = source.rename_zone_key(i, old, new)
            plan.edits.append(f'deck.py: {label} zones={{"{old}": …}} → "{new}"')
            touched = True
        # animations=[...] aimed at the zone (a chart's series too).
        chart = isinstance(slide.zones.get(old), Chart)
        moves = [
            (k, element)
            for k, cue in enumerate(slide.animations)
            if (element := _cue_target(cue, old, new, chart)) is not None
        ]
        if moves:
            source = slides.source("rename the zone")
            if source.animation_count(i) != len(slide.animations):
                raise MasterError(
                    f"{label}'s animations are not a literal list: "
                    + f"rename '{old}' there by hand"
                )
            for k, element in moves:
                cue = dataclasses.replace(slide.animations[k], element=element)
                source.edit_animations(i, replace=(k, slides.code.call(cue)))
            plan.edits.append(
                f"deck.py: {label}: {len(moves)} animation"
                + f"{'s' if len(moves) != 1 else ''} follow"
            )
            touched = True
        # Arrows on the slide's own drawing attached to the zone.
        own = _own_drawing(slide, deck, slides.project_dir, t)
        if own is not None:
            svg = parse(own, slides.read)
            if svg is not None and _rename_refs(svg.root, old, new):
                slides.write(own, svg.to_bytes())
                plan.edits.append(f"{slides.rel(own)}: what pointed at zone-{old}")
                touched = True
        if touched:
            plan.slides.append(i)


def _own_drawing(slide: Slide, deck: Deck, project_dir: Path, t: Target) -> Path | None:
    """The slide's own SVG when it is a file of the project's that is not a
    layout this plan already handles."""
    try:
        src = resolve_slide_src(slide.src, project_dir, deck.theme).resolve()
    except (ValueError, OSError):
        return None
    if src in t.aliases or src in {c.resolve() for c in t.children}:
        return None
    if not src.is_relative_to(project_dir.resolve()) or src.parent.name == "layouts":
        return None
    return src


def _style_warnings(deck: Deck, project_dir: Path, old: str) -> list[str]:
    sheets = [
        builtin_theme_dir() / "styles.css",
        deck.theme.styles_path,
        project_dir / "styles.css",
    ]
    out: list[str] = []
    seen: set[Path] = set()
    for sheet in sheets:
        if sheet.resolve() in seen or not sheet.is_file():
            continue
        seen.add(sheet.resolve())
        if _style_selector(old).search(sheet.read_text(encoding="utf-8")):
            where = (
                "styles.css"
                if sheet.resolve() == (project_dir / "styles.css").resolve()
                else "the theme's styles.css"
            )
            out.append(f"{where} styles #zone-{old}: that look stays with the old name")
    return out


def plan_rename(
    deck: Deck,
    project_dir: Path,
    t: Target,
    old: str,
    new: str,
    read: Reader,
    md_path: MdPath,
    source: Callable[[], DeckSource],
) -> Plan:
    """Rename placeholder ``old`` of ``t`` to ``new``: the zone, its prompt,
    what its child layouts and the slides say about it (Markdown markers,
    ``zones=`` keys, animation targets, attached arrows). Refused (MasterError)
    when any of them already has a ``new``."""
    problem = name_problem(new)
    if problem:
        raise MasterError(problem)
    plan = Plan()
    svg = parse(t.path, read)
    if svg is None:
        raise MasterError(f"{t.path.name} cannot be read")
    el = own_zone(svg.root, old)
    if el is None:
        raise MasterError(_not_here(t, old, read))
    if new == old:
        raise MasterError(f"the placeholder is already called '{old}'")
    if f"zone-{new}" in taken_ids(deck, project_dir, t, read):
        raise MasterError(f"zone-{new} is already used on a slide built on '{t.name}'")
    el.set("id", f"zone-{new}")
    if old == "content" and svg.root.get(ns.INKFLOW_DEFAULT_ZONE) is None:
        # zone-content was the default zone without saying so: Markdown no
        # zone claims keeps flowing into it under its new name.
        with_inkflow(svg).set(ns.INKFLOW_DEFAULT_ZONE, new)
    _ = _rename_refs(svg.root, old, new)
    plan.writes[t.path] = svg.to_bytes()
    plan.edits.append(f"{t.path.name}: zone-{old} → zone-{new}")
    for child in t.children:
        if not child.resolve().is_relative_to(project_dir.resolve()):
            continue
        child_svg = parse(child, read)
        if child_svg is not None and _rename_refs(child_svg.root, old, new):
            plan.writes[child.resolve()] = child_svg.to_bytes()
            plan.edits.append(f"{child.name}: what said zone-{old}")
    slides = _Slides(deck, project_dir, plan, read, md_path, source)
    _rename_slides(slides, t, old, new, deck)
    slides.finish()
    plan.warnings += _style_warnings(deck, project_dir, old)
    return plan


def _not_here(t: Target, name: str, read: Reader) -> str:
    for p in reversed(t.chain):
        svg = parse(p, read)
        if svg is not None and own_zone(svg.root, name) is not None:
            return f"zone '{name}' is the layout '{p.stem}''s: change it there"
    return f"'{t.name}' has no placeholder '{name}'"


def plan_remove(
    deck: Deck,
    project_dir: Path,
    t: Target,
    name: str,
    read: Reader,
    md_path: MdPath,
    source: Callable[[], DeckSource],
    drop_content: bool,
) -> Plan:
    """Take placeholder ``name`` out of ``t``: a shape that shows itself
    (``inkflow:show-shape``) stays as a plain shape, a bare zone goes; its
    prompt goes. With ``drop_content``, what the slides put in it goes too."""
    plan = Plan()
    svg = parse(t.path, read)
    if svg is None:
        raise MasterError(f"{t.path.name} cannot be read")
    el = own_zone(svg.root, name)
    if el is None:
        raise MasterError(_not_here(t, name, read))
    if el.get(ns.INKFLOW_SHOW_SHAPE) == "true" or el.get("class"):
        taken = _ids(svg.root)
        base, n = name, 2
        while base in taken:
            base, n = f"{name}-{n}", n + 1
        el.set("id", base)
        if ns.INKFLOW_SHOW_SHAPE in el.attrib:
            del el.attrib[ns.INKFLOW_SHOW_SHAPE]
        set_style(el, dict.fromkeys(_ZONE_VARS))
        plan.edits.append(f"{t.path.name}: zone-{name} is the shape '{base}' again")
    else:
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
        plan.edits.append(f"{t.path.name}: zone-{name} removed")
    _ = set_prompt(svg.root, name, None)
    plan.writes[t.path] = svg.to_bytes()
    filled = filled_by(deck, t.slides, name, md_path, plan.read(read))
    if not drop_content:
        if filled:
            names = ", ".join(slide_label(deck, i) for i in filled)
            plan.warnings.append(
                f"{names} still {'has' if len(filled) == 1 else 'have'} content "
                + f"for '{name}': it no longer shows"
            )
        return plan
    slides = _Slides(deck, project_dir, plan, read, md_path, source)
    _drop_slides(slides, t, name, deck)
    slides.finish()
    return plan


def _drop_slides(slides: _Slides, t: Target, name: str, deck: Deck) -> None:
    plan = slides.plan
    md_done: set[Path] = set()
    for i in t.slides:
        slide = deck.slides[i]
        label = slide_label(deck, i)
        touched = False
        if isinstance(slide.md, Inline):
            text = str(slide.md)
            if name in zone_names(text):
                source = slides.source("remove the zone's text")
                kept = remove_zone_section(text, name)
                source.set_slide_arg(i, "md", f"Inline({slides.code.literal(kept)})")
                slides.code.imports.add("Inline")
                touched = True
        else:
            md = slides.md_path(slide) if slide.md is not None else None
            if md is not None and md.resolve() not in md_done:
                text = slides.text(md)
                if name in zone_names(text):
                    md_done.add(md.resolve())
                    kept = remove_zone_section(text, name)
                    slides.write(md, kept.encode("utf-8"))
                    plan.edits.append(f"{slides.rel(md)}: ::{name}:: removed")
                    touched = True
        if name in slide.zones:
            source = slides.source("remove the zone's content")
            source.set_zone(i, name, None)
            plan.edits.append(f'deck.py: {label} zones={{"{name}": …}} removed')
            touched = True
        chart = isinstance(slide.zones.get(name), Chart)
        gone = [
            k
            for k, cue in enumerate(slide.animations)
            if _cue_target(cue, name, name, chart) is not None
        ]
        if gone:
            source = slides.source("remove the zone's animations")
            if source.animation_count(i) != len(slide.animations):
                raise MasterError(f"{label}'s animations are not a literal list")
            for k in reversed(gone):
                source.edit_animations(i, remove=k)
            touched = True
        if touched:
            plan.slides.append(i)
