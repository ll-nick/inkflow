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
from pathlib import Path
from typing import TypedDict, cast

from inkflow import animations as animations_module
from inkflow import drawio
from inkflow import transitions as transitions_module
from inkflow.animations import Animation, Cue, PlayVideo
from inkflow.colors import SVG_TOKENS
from inkflow.editor.chartedit import chart_json
from inkflow.editor.codegen import field_schema, to_json
from inkflow.editor.deckedit import DeckSource
from inkflow.editor.svgops import file_hash
from inkflow.layout import discover_layouts, layouts_for
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


def build_model(
    deck: Deck,
    deck_path: Path,
    slides: list[SlideData],
    deck_module: str = "_inkflow_deck",
) -> dict[str, object]:
    """The editor model for one build. ``slides`` must come from an editor build;
    ``deck_module`` is the module deck.py ran as (`server.load_deck`)."""
    project_dir = deck_path.parent
    try:
        source = DeckSource.read(deck_path)
        calls = source.slide_calls(expected=len(deck.slides))
    except Exception:
        source, calls = None, None
    deck_editable = calls is not None

    # Which deck slides each file feeds, for "shared layout" warnings.
    used_by: dict[str, list[int]] = {}
    srcs: list[Path | None] = []
    for i, slide in enumerate(deck.slides):
        try:
            path = resolve_slide_src(slide.src, project_dir, deck.theme).resolve()
        except Exception:
            srcs.append(None)
            continue
        srcs.append(path)
        used_by.setdefault(str(path), []).append(i)

    hashes: dict[str, str] = {}

    def hash_of(path: Path) -> str:
        key = str(path)
        if key not in hashes:
            try:
                hashes[key] = file_hash(path.read_bytes())
            except OSError:
                hashes[key] = ""
        return hashes[key]

    out_slides: list[dict[str, object]] = []
    visible_index = 0
    for deck_index, slide in enumerate(deck.slides):
        entry: dict[str, object] = {
            "deckIndex": deck_index,
            "visible": slide.visible,
            "visibleIndex": visible_index if slide.visible else None,
            "src": slide.src,
            "title": slide.title,
            "explicitId": slide.id,
        }
        src_path = srcs[deck_index]
        entry["srcPath"] = str(src_path) if src_path else None
        entry["srcRel"] = _rel(src_path, project_dir) if src_path else None
        entry["srcShared"] = bool(
            src_path is not None
            and (
                len(used_by.get(str(src_path), [])) > 1
                or "layouts" in src_path.parts
                or not _is_writable(src_path, project_dir)
            )
        )
        entry["md"] = _md_json(slide, project_dir)
        entry["notes"] = _notes_json(slide, project_dir)
        entry["zones"] = {k: _zone_json(v, project_dir) for k, v in slide.zones.items()}
        entry["transition"] = (
            _transition_json(slide.transition, deck_module)
            if slide.transition is not None
            else None
        )
        entry["animations"] = [_cue_json(c, deck_module) for c in slide.animations]
        entry["animationsEditable"] = bool(
            source is not None
            and calls is not None
            and source.animation_count(deck_index) == len(slide.animations)
        )
        entry["fontSize"] = slide.font_size
        if slide.visible:
            data = slides[visible_index]
            entry["id"] = data["id"]
            entry["title"] = data["title"]
            edit = data.get("edit")
            if edit is not None:
                sources: list[SourceInfo] = []
                for k, p in enumerate(edit["sources"]):
                    path = Path(p)
                    role = "slide" if k == 0 else "layout"
                    sources.append(
                        {
                            "path": str(path),
                            "rel": _rel(path, project_dir),
                            "hash": hash_of(path),
                            "role": role,
                            "writable": _is_writable(path, project_dir),
                            "usedBy": used_by.get(str(path.resolve()), []),
                        }
                    )
                _mark_overlays(sources)
                ink = Path(edit["ink"])
                for info in sources:
                    if Path(info["path"]) == ink:
                        info["role"] = "ink"
                entry["ink"] = {
                    "path": str(ink),
                    "rel": _rel(ink, project_dir),
                    "exists": ink.is_file(),
                }
                entry["sources"] = sources
                entry["emptyZones"] = edit["emptyZones"]
                entry["zoneOrigins"] = edit["zoneOrigins"]
                entry["zoneText"] = _zone_text(entry, slide, edit["zoneOrigins"])
            visible_index += 1
        out_slides.append(entry)

    return {
        "deckPath": str(deck_path),
        "projectDir": str(project_dir),
        "deckEditable": deck_editable,
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
    }


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
        seen[path.stem] = {"name": path.stem, "source": label, "path": str(path)}
    hidden = {"base", "numbered", "poster-base"}
    return [v for k, v in sorted(seen.items()) if k not in hidden]


def slide_by_visible(model: dict[str, object], visible_index: int) -> dict[str, object]:
    for s in cast("list[dict[str, object]]", model["slides"]):
        if s.get("visibleIndex") == visible_index:
            return s
    raise IndexError(visible_index)
