"""The editor model: everything the browser editor needs beyond the slide SVGs.

Built once per rebuild from the loaded ``Deck`` and the editor build of its
slides (``process_deck(editor=True)``). It answers, for every slide: which files
it is composed from and which of them may be written, where each zone's content
was authored, its animations and transition as editable field values, and its
Markdown and notes source text.
"""

from __future__ import annotations

import dataclasses
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypedDict, cast

from inkflow import animations as animations_module
from inkflow import drawio
from inkflow import transitions as transitions_module
from inkflow.animations import Animation, Cue, PlayVideo
from inkflow.colors import SVG_TOKENS
from inkflow.deps import Stamp, Stamps, note, recording, stamp
from inkflow.editor import comments
from inkflow.editor.chartedit import chart_json
from inkflow.editor.codegen import field_schema, to_json
from inkflow.editor.deckedit import DeckSource
from inkflow.editor.stars import read_stars
from inkflow.editor.svgops import file_hash
from inkflow.incremental import frozen
from inkflow.layout import discover_layouts, label_of, layouts_for
from inkflow.loaders import load_md
from inkflow.manifest import Chart, Deck, Image, Inline, Slide, TextBox, Video
from inkflow.pipeline import SlideData, resolve_slide_src
from inkflow.transitions import Transition
from inkflow.zones import zone_spans


class SourceInfo(TypedDict):
    path: str
    rel: str
    hash: str
    role: str
    """``slide`` (the slide's own src), ``layout`` (an ancestor), ``overlay``,
    ``diagram`` (a draw.io diagram drawn into the slide, whose shapes the
    editor edits in its source: editor/drawioedit.py) or ``ink`` (the slide's
    saved pen drawing, see inkflow/ink.py)."""
    writable: bool
    """Inside the project and not an installed package (theme/built-in)."""
    usedBy: list[int]
    """Deck indices of every slide composed from this file."""


def _is_writable(path: Path, project_dir: Path) -> bool:
    note(path)
    resolved = path.resolve()
    if not resolved.is_relative_to(project_dir.resolve()):
        return False
    if any(part in (".venv", "site-packages") for part in resolved.parts):
        return False
    return os.access(resolved, os.W_OK)


def _rel(path: Path, project_dir: Path) -> str:
    try:
        return path.resolve().relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        return path.name


def _cue_json(cue: Cue, deck_module: str) -> dict[str, object]:
    cls = type(cue)
    fields = {
        f.name: to_json(cast("object", getattr(cue, f.name)))
        for f in dataclasses.fields(cue)
        if f.init and f.name not in ("element",)
    }
    return {
        "type": cls.__name__,
        "slug": cue.slug() if isinstance(cue, Animation) else "play-video",
        "kind": cue.kind.value if isinstance(cue, Animation) else "video",
        "custom": cls.__module__ == deck_module,
        "element": cue.element,
        "fields": fields,
    }


def _transition_json(t: Transition, deck_module: str) -> dict[str, object]:
    cls = type(t)
    return {
        "type": cls.__name__,
        "slug": cls.slug(),
        "custom": cls.__module__ == deck_module,
        "fields": {
            f.name: to_json(cast("object", getattr(t, f.name)))
            for f in dataclasses.fields(t)
            if f.init
        },
    }


def _type_catalog(
    base: type, module: object, deck_module: str
) -> list[dict[str, object]]:
    seen: dict[str, type] = {}
    stack = list(base.__subclasses__())
    while stack:
        cls = stack.pop()
        stack.extend(cls.__subclasses__())
        if cls.__module__ not in (getattr(module, "__name__", ""), deck_module):
            continue
        if not dataclasses.is_dataclass(cls) or cls.__name__.startswith("_"):
            continue
        seen[cls.__name__] = cls
    out: list[dict[str, object]] = []
    for name, cls in sorted(seen.items()):
        if cls.__name__ in ("Enter", "Exit", "Emphasis"):
            continue
        entry: dict[str, object] = {
            "type": name,
            "custom": cls.__module__ == deck_module,
            "fields": field_schema(cls),
        }
        if issubclass(cls, Animation):
            entry["slug"] = cls.slug()
            entry["kind"] = cls.kind.value
        elif issubclass(cls, Transition):
            entry["slug"] = cls.slug()
        else:
            entry["slug"] = "play-video"
            entry["kind"] = "video"
        out.append(entry)
    return out


def _zone_json(value: object, project_dir: Path) -> dict[str, object]:
    if isinstance(value, Chart):
        return chart_json(value, project_dir)
    if isinstance(value, str):
        return {"kind": "text", "text": str(value)}
    if isinstance(value, TextBox):
        return {"kind": "textbox", "text": value.text or ""}
    if isinstance(value, Image | Video):
        return {
            "kind": "video" if isinstance(value, Video) else "image",
            "src": value.src,
            "fit": str(value.fit),
            "fields": {
                f["name"]: to_json(
                    cast("object", getattr(value, cast("str", f["name"])))
                )
                for f in media_schema(type(value))
            },
        }
    return {"kind": "other"}


MEDIA_HIDDEN_FIELDS = ("src", "alt_src", "x", "y")
"""Media fields the settings panel leaves to deck.py: the file itself is picked
with "Replace media…", and the pixel offsets are what dragging the zone is for."""


def media_schema(cls: type) -> list[dict[str, object]]:
    """The editable settings of an `Image` or `Video` zone value."""
    return [f for f in field_schema(cls) if f["name"] not in MEDIA_HIDDEN_FIELDS]


def _notes_json(slide: Slide, project_dir: Path) -> dict[str, object]:
    notes = slide.notes
    if not notes:
        return {"kind": "none", "path": None, "rel": None, "text": ""}
    if isinstance(notes, Inline):
        return {"kind": "inline", "path": None, "rel": None, "text": str(notes)}
    path = Path(str(notes))
    if not path.is_absolute():
        path = project_dir / path
    note(path)
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    return {
        "kind": "file",
        "path": str(path),
        "rel": _rel(path, project_dir),
        "text": text,
    }


def _md_json(slide: Slide, project_dir: Path) -> dict[str, object] | None:
    if slide.md is None:
        return None
    if isinstance(slide.md, Inline):
        return {"kind": "inline", "path": None, "rel": None, "text": str(slide.md)}
    loaded = load_md(slide.md, project_dir)
    if loaded is None or loaded.path is None:
        return None
    return {
        "kind": "file",
        "path": str(loaded.path),
        "rel": _rel(loaded.path, project_dir),
        "text": loaded.text,
    }


@dataclass
class _Kept:
    key: object
    deps: dict[str, Stamp]
    facts: dict[str, object]
    resolved: list[str]
    """Each source's resolved path, the key of ``usedBy``."""


@dataclass
class ModelCache:
    """A served deck's last model, slide by slide: what `build_model` read
    from each slide's files (its Markdown, notes, source hashes, chart
    columns) is kept until one of those files, or what deck.py says of the
    slide, changes. See `inkflow.incremental` for the slides' own cache."""

    slides: dict[object, _Kept] = field(default_factory=dict)
    deck: tuple[str, list[int | None] | None] | None = None
    """deck.py by hash: each slide's animation count (None: not editable)."""
    read: list[int] = field(default_factory=list)
    """Deck indices of the slides the last model read again."""

    def clear(self) -> None:
        self.slides.clear()
        self.deck = None


def _animation_counts(
    deck_path: Path, expected: int, cache: ModelCache | None
) -> list[int | None] | None:
    """Each slide's ``animations=[...]`` length as written in deck.py, or None
    when its slides are not a plain list of ``expected`` Slide(...) calls.
    Read off the slide list once: asking the source slide by slide walks
    deck.py once per slide, which on a 300-slide deck took most of a rebuild."""
    try:
        code = deck_path.read_bytes()
    except OSError:
        return None
    digest = file_hash(code)
    if cache is not None and cache.deck is not None and cache.deck[0] == digest:
        counts = cache.deck[1]
    else:
        try:
            counts = DeckSource(code.decode("utf-8")).animation_counts()
        except Exception:
            counts = None
        if cache is not None:
            cache.deck = (digest, counts)
    return counts if counts is not None and len(counts) == expected else None


def _slide_facts(
    slide: Slide,
    data: SlideData | None,
    src_path: Path | None,
    project_dir: Path,
    deck_module: str,
    hash_of: Callable[[Path], str],
) -> tuple[dict[str, object], list[str]]:
    """What the model says of one slide wherever it stands in the deck, and
    each of its sources' resolved paths."""
    facts: dict[str, object] = {
        "visible": slide.visible,
        "src": slide.src,
        "title": slide.title,
        "explicitId": slide.id,
        "srcPath": str(src_path) if src_path else None,
        "srcRel": _rel(src_path, project_dir) if src_path else None,
        # Shared whatever else uses it: a layout, or a file not the deck's.
        "srcShared": bool(
            src_path is not None
            and ("layouts" in src_path.parts or not _is_writable(src_path, project_dir))
        ),
        "md": _md_json(slide, project_dir),
        "notes": _notes_json(slide, project_dir),
        "zones": {k: _zone_json(v, project_dir) for k, v in slide.zones.items()},
        "transition": (
            _transition_json(slide.transition, deck_module)
            if slide.transition is not None
            else None
        ),
        "animations": [_cue_json(c, deck_module) for c in slide.animations],
        "fontSize": slide.font_size,
    }
    resolved: list[str] = []
    if data is not None:
        facts["id"] = data["id"]
        facts["title"] = data["title"]
        edit = data.get("edit")
        if edit is not None:
            sources = source_infos(edit["sources"], project_dir, {}, hash_of)
            resolved = [str(Path(p).resolve()) for p in edit["sources"]]
            ink = Path(edit["ink"])
            for info in sources:
                if Path(info["path"]) == ink:
                    info["role"] = "ink"
            note(ink)
            facts["ink"] = {
                "path": str(ink),
                "rel": _rel(ink, project_dir),
                "exists": ink.is_file(),
            }
            facts["sources"] = sources
            facts["emptyZones"] = edit["emptyZones"]
            facts["zoneOrigins"] = edit["zoneOrigins"]
            facts["zoneText"] = _zone_text(facts, slide, edit["zoneOrigins"])
    return facts, resolved


def build_model(
    deck: Deck,
    deck_path: Path,
    slides: list[SlideData],
    deck_module: str = "_inkflow_deck",
    cache: ModelCache | None = None,
) -> dict[str, object]:
    """The editor model for one build. ``slides`` must come from an editor build;
    ``deck_module`` is the module deck.py ran as (`server.load_deck`). With
    ``cache`` (a server rebuilding on every change) a slide is read again only
    when its files or its ``Slide(...)`` changed."""
    project_dir = deck_path.parent
    counts = _animation_counts(deck_path, len(deck.slides), cache)

    # Which deck slides each file feeds, for "shared layout" warnings.
    used_by: dict[str, list[int]] = {}
    srcs: list[Path | None] = []
    shown = iter(slides)
    for i, slide in enumerate(deck.slides):
        edit = next(shown).get("edit") if slide.visible else None
        try:
            # A built slide's first source is the file it was read from.
            path = (
                Path(edit["sources"][0])
                if edit is not None and edit["sources"]
                else resolve_slide_src(slide.src, project_dir, deck.theme)
            ).resolve()
        except Exception:
            srcs.append(None)
            continue
        srcs.append(path)
        used_by.setdefault(str(path), []).append(i)

    hashes: dict[str, tuple[Stamp, str]] = {}

    def hash_of(path: Path) -> str:
        """The file's hash, read once per build while the file is the same
        (a slide notes the file's stamp before asking: a hash older than
        that stamp would stay in the model)."""
        key = str(path)
        now = stamp(key)
        cached = hashes.get(key)
        if cached is None or cached[0] != now:
            try:
                cached = (now, file_hash(path.read_bytes()))
            except OSError:
                cached = (now, "")
            hashes[key] = cached
        return cached[1]

    stamps = Stamps()
    seen: set[object] = set()
    if cache is not None:
        cache.read = []
    out_slides: list[dict[str, object]] = []
    visible_index = 0
    for deck_index, slide in enumerate(deck.slides):
        data = slides[visible_index] if slide.visible else None
        src_path = srcs[deck_index]
        if cache is None:
            facts, resolved = _slide_facts(
                slide, data, src_path, project_dir, deck_module, hash_of
            )
        else:
            # By id, so a slide keeps its entry wherever it moves; a hidden
            # slide (never built, so without an id) by its place.
            name: object = data["id"] if data is not None else deck_index
            key = (
                frozen(slide),
                str(src_path),
                (data["id"], data["title"], data.get("edit")) if data else None,
                str(project_dir),
                deck_module,
            )
            kept = cache.slides.get(name)
            if kept is None or kept.key != key or not stamps.unchanged(kept.deps):
                with recording() as deps:
                    facts, resolved = _slide_facts(
                        slide, data, src_path, project_dir, deck_module, hash_of
                    )
                kept = _Kept(key, deps, facts, resolved)
                cache.slides[name] = kept
                cache.read.append(deck_index)
            seen.add(name)
            facts, resolved = kept.facts, kept.resolved
        entry: dict[str, object] = {
            **facts,
            "deckIndex": deck_index,
            "visibleIndex": visible_index if slide.visible else None,
            "srcShared": bool(
                facts["srcShared"]
                or (src_path is not None and len(used_by.get(str(src_path), [])) > 1)
            ),
            "animationsEditable": bool(
                counts is not None and counts[deck_index] == len(slide.animations)
            ),
        }
        if "sources" in facts:
            entry["sources"] = [
                {**info, "usedBy": used_by.get(path, [])}
                for info, path in zip(
                    cast("list[SourceInfo]", facts["sources"]), resolved, strict=True
                )
            ]
        if slide.visible:
            visible_index += 1
        out_slides.append(entry)
    if cache is not None:
        for gone in [k for k in cache.slides if k not in seen]:
            del cache.slides[gone]

    return {
        "deckPath": str(deck_path),
        "projectDir": str(project_dir),
        "deckEditable": counts is not None,
        "slides": out_slides,
        "sections": [
            {"name": section.name, "start": span.start, "count": len(span)}
            for section, span in zip(deck.sections, deck.section_ranges(), strict=True)
        ],
        "animationTypes": [
            *_type_catalog(Animation, animations_module, deck_module),
            *[
                t
                for t in _type_catalog(Cue, animations_module, deck_module)
                if t["type"] == PlayVideo.__name__
            ],
        ],
        "transitionTypes": _type_catalog(Transition, transitions_module, deck_module),
        "mediaTypes": {"image": media_schema(Image), "video": media_schema(Video)},
        "defaultTransition": _transition_json(deck.effective_transition, deck_module),
        "layouts": _layouts(project_dir, deck),
        "colorTokens": list(SVG_TOKENS),
        "deckSize": size_json(deck),
        "stars": starred_ids(project_dir, out_slides),
        "comments": comment_threads(project_dir, out_slides),
    }


def comment_threads(
    project_dir: Path, entries: list[dict[str, object]]
) -> list[dict[str, object]]:
    """The review comments on the deck's shown slides (editor/comments.py)."""
    return comments.visible(
        comments.read_threads(project_dir),
        [str(e["id"]) for e in entries if e.get("id")],
    )


def starred_ids(project_dir: Path, entries: list[dict[str, object]]) -> list[str]:
    """The ids of the deck's starred slides (editor/stars.py), in deck order:
    a star whose slide is gone, or hidden, is not shown."""
    starred = set(read_stars(project_dir))
    return [str(e["id"]) for e in entries if e.get("id") in starred]


def size_json(deck: Deck) -> dict[str, object]:
    """The deck's size for the editor: the canvas new slides get (and the
    thumbnails' shape), and whether it is printed."""
    size = deck.effective_size
    return {
        "name": str(deck.size) if deck.size is not None else None,
        "label": size.label,
        "canvas": list(size.canvas),
        "page": [round(v, 2) for v in size.page_pt],
        "print": deck.is_print,
        "fontSize": deck.effective_font_size,
    }


def _zone_text(
    entry: dict[str, object], slide: Slide, origins: dict[str, str]
) -> dict[str, str]:
    """The source text of each zone, as the editor's text box shows it."""
    md = cast("dict[str, object] | None", entry.get("md"))
    md_text = str(md["text"]) if md else ""
    spans = zone_spans(md_text) if md_text else {}
    out: dict[str, str] = {}
    for name, origin in origins.items():
        value = slide.zones.get(name)
        if origin == "deck":
            if isinstance(value, str):
                out[name] = str(value)
            elif isinstance(value, TextBox):
                out[name] = value.text or ""
        elif origin == "md-file":
            out[name] = md_text
        elif name in spans:
            start, end = spans[name]
            out[name] = md_text[start:end]
    return out


_MEDIA_ZONE = re.compile(r"media|image|img|picture|photo|figure|video|logo")


def is_media_zone(name: str) -> bool:
    """Whether a zone's name says it is meant for an image or video."""
    return bool(_MEDIA_ZONE.search(name))


def source_infos(
    paths: list[str],
    project_dir: Path,
    used_by: dict[str, list[int]],
    hash_of: Callable[[Path], str],
) -> list[SourceInfo]:
    """A slide's source files (``SlideEditInfo.sources``) as the editor sees
    them: role, whether it may write them, which slides use them."""
    sources: list[SourceInfo] = []
    for k, p in enumerate(paths):
        path = Path(p)
        note(path)
        sources.append(
            {
                "path": str(path),
                "rel": _rel(path, project_dir),
                "hash": hash_of(path),
                "role": "slide" if k == 0 else "layout",
                "writable": _is_writable(path, project_dir),
                "usedBy": used_by.get(str(path.resolve()), []),
            }
        )
    _mark_overlays(sources)
    return sources


def _mark_overlays(sources: list[SourceInfo]) -> None:
    for s in sources:
        if drawio.is_drawio_path(Path(s["path"])):
            s["role"] = "diagram"
        elif "overlays" in Path(s["path"]).parts:
            s["role"] = "overlay"


def _layouts(project_dir: Path, deck: Deck) -> list[dict[str, str]]:
    seen: dict[str, dict[str, str]] = {}
    found = discover_layouts(project_dir, deck.theme)
    for label, path in layouts_for(found, deck.effective_size):
        # Later sources (theme, local) shadow earlier ones with the same name.
        entry = {"name": path.stem, "source": label, "path": str(path)}
        if label == "local" and (typed := label_of(path)):
            entry["label"] = typed
        seen[path.stem] = entry
    hidden = {"base", "numbered", "poster-base"}
    return [v for k, v in sorted(seen.items()) if k not in hidden]


def slide_by_visible(model: dict[str, object], visible_index: int) -> dict[str, object]:
    for s in cast("list[dict[str, object]]", model["slides"]):
        if s.get("visibleIndex") == visible_index:
            return s
    raise IndexError(visible_index)
