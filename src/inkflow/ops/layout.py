"""Read ops on the layouts and overlays a deck can build on."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from rich import box
from rich.console import Group, RenderableType
from rich.table import Table
from rich.text import Text

from inkflow.layout import AssetKind, discover_assets, layout_zones, resolve_chain
from inkflow.ops.changeset import OpError
from inkflow.ops.registry import DeckUse, OpContext, register, register_group
from inkflow.themes import Theme

__all__ = ["GROUP", "AssetEntry", "LayoutList", "LayoutListRequest", "list_assets"]

GROUP = register_group("layout", "Inspect layouts and overlays.")


@dataclass(frozen=True)
class LayoutListRequest:
    pass


@dataclass(frozen=True)
class AssetEntry:
    name: str
    source: str
    """Where it was found: ``builtin``, ``theme`` or ``local``."""
    parents: list[str]
    """The ancestor chain, root first (the direct parent last)."""
    zones: list[str]
    """Zone names without the ``zone-`` prefix, slide-number zones excluded."""
    default_zone: str
    numbered: bool
    """Whether it carries a ``zone-slide-number`` or ``zone-slide-total``."""


_SOURCE_STYLES = [
    ("builtin", "steel_blue", "Built-in"),
    ("theme", "dark_orange", "Theme"),
    ("local", "green", "Local"),
]


def _tables(entries: list[AssetEntry]) -> list[RenderableType]:
    parts: list[RenderableType] = []
    for source, color, title in _SOURCE_STYLES:
        rows = [entry for entry in entries if entry.source == source]
        if not rows:
            continue
        if parts:
            parts.append(Text())
        parts.append(Text(f"‣ {title}", style=f"bold {color}"))
        table = Table(
            box=box.ROUNDED,
            header_style=f"bold {color}",
            border_style=color,
            pad_edge=True,
        )
        table.add_column("NAME", style="bold", min_width=12)
        table.add_column("PARENT", style="dim", min_width=14)
        table.add_column("ZONES", min_width=20)
        table.add_column("#", justify="center", min_width=1)
        for row in rows:
            zones = Text(", ").join(
                Text(
                    zone,
                    style=f"bold underline {color}"
                    if zone == row.default_zone
                    else color,
                )
                for zone in row.zones
            )
            table.add_row(
                Text(row.name),
                Text(" → ".join(row.parents) or "—"),
                zones if row.zones else Text("—", style="dim"),
                Text("✓", style=color) if row.numbered else Text(),
            )
        parts.append(table)
    return parts


@dataclass(frozen=True)
class LayoutList:
    layouts: list[AssetEntry]
    overlays: list[AssetEntry]

    def to_json(self) -> dict[str, object]:
        return asdict(self)

    def render(self) -> RenderableType:
        parts = _tables(self.layouts)
        if self.overlays:
            parts += [
                Text(),
                Text.assemble(
                    ("OVERLAYS", "bold"), " ", ("(composited on top)", "dim")
                ),
                *_tables(self.overlays),
            ]
        return Group(*parts)


def _entries(
    kind: AssetKind, context: OpContext, theme: Theme | None
) -> list[AssetEntry]:
    entries: list[AssetEntry] = []
    for source, path in discover_assets(kind, context.project_dir, theme):
        try:
            chain = resolve_chain(path, context.project_dir, theme, kind)
            info = layout_zones(path, context.project_dir, theme, kind)
        except ValueError as exc:
            raise OpError(str(exc)) from exc
        entries.append(
            AssetEntry(
                path.stem,
                source,
                [parent.stem for parent in chain],
                info.zones,
                info.default_zone,
                info.numbered,
            )
        )
    return entries


@register(GROUP, "list", LayoutListRequest, LayoutList, deck=DeckUse.OPTIONAL)
def list_assets(_request: LayoutListRequest, context: OpContext) -> LayoutList:
    """List available layouts and overlays with their zones and parent chain.

    Discovers both from three sources — built-in, theme, then project-local — and
    prints a table per source with each entry's parent chain and zone names. The
    default zone is underlined; a checkmark marks entries that carry a slide number
    (a `zone-slide-number` or `zone-slide-total`). Layouts compose behind a slide,
    overlays on top of it, and the two are separate namespaces. The overlay section
    is omitted when no overlays exist. Pass `--no-deck` to list only the built-ins.
    """
    return LayoutList(
        _entries(AssetKind.LAYOUT, context, context.theme),
        _entries(AssetKind.OVERLAY, context, context.theme),
    )
