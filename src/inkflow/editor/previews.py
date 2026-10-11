"""Sample renders of every layout, for the editor's layout gallery.

Each layout is built as a one-slide deck would build it, in this deck's theme,
colour mode and overlays, with its text zones filled with sample content that
shows what the zone is for. Media zones are left empty: the gallery draws them
as image placeholders from the reported geometry.
"""

from __future__ import annotations

import re
from pathlib import Path

from inkflow import ns
from inkflow.assets import AssetSource
from inkflow.editor.model import is_media_zone
from inkflow.layout import (
    copy_of,
    discover_layouts,
    label_of,
    layout_zones,
    layouts_for,
    resolve_chain,
)
from inkflow.logging import collect_logs
from inkflow.manifest import Deck, Slide, ZoneContent
from inkflow.pipeline import deck_context, process_slide
from inkflow.svgio import parse_svg_file
from inkflow.themes import Theme

# The order a slide editor lists layouts in: from the everyday to the special.
BUILTIN_ORDER = (
    "numbered",
    "title",
    "content",
    "two-cols",
    "three-cols",
    "comparison",
    "agenda",
    "quad",
    "three-cards",
    "media-left",
    "media-right",
    "title-media",
    "full-media",
    "cover",
    "section",
    "center",
    "fact",
    "quote",
    "end",
    "poster-3col",
    "poster-2col",
    "poster-landscape-3col",
    "poster-landscape-4col",
)

_BULLETS = "- A first point\n- A second point\n- A third point"
_SAMPLES: dict[str, str] = {
    "title": "# Slide title",
    "subtitle": "## A subtitle",
    "fact": "# 42%",
    "caption": "What the number or picture shows",
    "quote": "> A short, memorable line worth quoting.",
    "attribution": "Someone notable",
    "left-title": "Option A",
    "right-title": "Option B",
    "authors": "Ada Lovelace, Charles Babbage, Grace Hopper",
    "affiliations": "University of Somewhere",
    "references": "1. Author, A. (2024). A title. *Journal* 1, 2-3.",
    "contact": "name@example.org",
}
_CARD = "### Heading\n\nA sentence or two."


def sample_text(zone: str) -> str:
    """Sample Markdown showing what a zone of this name is for."""
    if zone in _SAMPLES:
        return _SAMPLES[zone]
    if zone.startswith("card"):
        return _CARD
    if zone.startswith("col-"):
        return f"## Section\n\nA sentence or two.\n\n{_BULLETS}"
    if re.match(r"(top|bottom)-", zone):
        return "**Point**  \nA short explanation"
    return _BULLETS


def sample_zones(path: Path, project_dir: Path, theme: Theme | None) -> dict[str, str]:
    """Sample text for a layout's text zones (its hints where it has them),
    so the master view shows each zone's type and place."""
    info = layout_zones(path, project_dir, theme)
    hints = layout_hints(path, project_dir, theme)
    out: dict[str, str] = {}
    for zone in info.zones:
        if is_media_zone(zone):
            continue
        hint = hints.get(zone)
        if hint:
            out[zone] = f"# {hint}" if zone == "title" else hint
        else:
            out[zone] = sample_text(zone)
    return out


def layout_hints(path: Path, project_dir: Path, theme: Theme | None) -> dict[str, str]:
    """``inkflow:hint`` prompts of a layout and its ancestors (nearest wins)."""
    try:
        chain = [*resolve_chain(path, project_dir, theme), path]
    except ValueError:
        chain = [path]
    hints: dict[str, str] = {}
    for p in chain:
        try:
            root = parse_svg_file(p)
        except Exception:
            continue
        for el in root.iter(ns.INKFLOW_HINT):
            zone, text = el.get("zone"), (el.text or "").strip()
            if zone and text:
                hints[zone] = text
    return hints


def _layouts(
    deck: Deck, project_dir: Path, roots: bool = False
) -> list[tuple[str, str, Path]]:
    """(name, source, path) for every usable layout, the later source winning."""
    seen: dict[str, tuple[str, str, Path]] = {}
    found = discover_layouts(project_dir, deck.theme)
    for label, path in layouts_for(found, deck.effective_size):
        seen[path.stem] = (path.stem, label, path)
    order = {name: i for i, name in enumerate(BUILTIN_ORDER)}
    hidden = () if roots else ("base", "poster-base")
    entries = [v for k, v in seen.items() if k not in hidden]
    # The project's own layouts first (its copies of the theme's keep their
    # place), then the built-in order, then the rest.
    return sorted(
        entries,
        key=lambda e: (
            e[1] != "local" or copy_of(e[2]) is not None,
            order.get(e[0], len(order)),
            e[0],
        ),
    )


def layout_previews(
    deck: Deck, deck_path: Path, roots: bool = False
) -> list[dict[str, object]]:
    """Every layout drawn with sample text; with ``roots`` also the
    backgrounds the others are built on (``base``: the slide master's)."""
    project_dir = deck_path.parent
    ctx = deck_context(deck, project_dir, 1, editor=True)
    out: list[dict[str, object]] = []
    for name, source, path in _layouts(deck, project_dir, roots):
        prefix = {"builtin": "builtin", "theme": "theme"}.get(source, "local")
        try:
            info = layout_zones(path, project_dir, deck.theme)
            # Sample text, or what a template's zones are for (its hints).
            zones: dict[str, ZoneContent] = dict(
                sample_zones(path, project_dir, deck.theme)
            )
            slide = Slide(f"{prefix}:{name}", zones=zones)
            # A preview that does not build is skipped rather than reported:
            # the deck itself never uses it.
            with collect_logs(100):
                processed = process_slide(
                    slide, ctx, 1, None, AssetSource.for_deck(ctx.assets), name
                )
        except Exception:
            continue
        svg = processed.svg.replace("inkflow-slide-1", f"inkflow-preview-{name}")
        out.append(
            {
                "name": name,
                "label": label_of(path),
                "copyOf": copy_of(path) if source == "local" else None,
                "source": source,
                "zones": info.zones,
                "svg": svg,
                "emptyZones": processed.edit["emptyZones"] if processed.edit else [],
            }
        )
    return out
