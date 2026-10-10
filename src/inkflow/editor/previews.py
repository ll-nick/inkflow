"""Sample renders of every layout, for the editor's layout gallery.

Each layout is built as a one-slide deck would build it, in this deck's theme,
colour mode and overlays, with its text zones filled with sample content that
shows what the zone is for. Media zones are left empty: the gallery draws them
as image placeholders from the reported geometry.
"""

from __future__ import annotations

import re
from pathlib import Path

from inkflow.assets import AssetSource
from inkflow.editor.model import is_media_zone
from inkflow.layout import discover_layouts, layout_zones, layouts_for
from inkflow.logging import collect_logs
from inkflow.manifest import Deck, Slide, ZoneContent
from inkflow.pipeline import deck_context, process_slide

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


def _sample(zone: str) -> str:
    if zone in _SAMPLES:
        return _SAMPLES[zone]
    if zone.startswith("card"):
        return _CARD
    if zone.startswith("col-"):
        return f"## Section\n\nA sentence or two.\n\n{_BULLETS}"
    if re.match(r"(top|bottom)-", zone):
        return "**Point**  \nA short explanation"
    return _BULLETS


def _layouts(deck: Deck, project_dir: Path) -> list[tuple[str, str, Path]]:
    """(name, source, path) for every usable layout, the later source winning."""
    seen: dict[str, tuple[str, str, Path]] = {}
    found = discover_layouts(project_dir, deck.theme)
    for label, path in layouts_for(found, deck.effective_size):
        seen[path.stem] = (path.stem, label, path)
    order = {name: i for i, name in enumerate(BUILTIN_ORDER)}
    entries = [v for k, v in seen.items() if k not in ("base", "poster-base")]
    # The project's own layouts first, then the built-in order, then the rest.
    return sorted(
        entries,
        key=lambda e: (e[1] != "local", order.get(e[0], len(order)), e[0]),
    )


def layout_previews(deck: Deck, deck_path: Path) -> list[dict[str, object]]:
    project_dir = deck_path.parent
    ctx = deck_context(deck, project_dir, 1, editor=True)
    out: list[dict[str, object]] = []
    for name, source, path in _layouts(deck, project_dir):
        prefix = {"builtin": "builtin", "theme": "theme"}.get(source, "local")
        try:
            info = layout_zones(path, project_dir, deck.theme)
            zones: dict[str, ZoneContent] = {
                z: _sample(z) for z in info.zones if not is_media_zone(z)
            }
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
                "source": source,
                "zones": info.zones,
                "svg": svg,
                "emptyZones": processed.edit["emptyZones"] if processed.edit else [],
            }
        )
    return out
