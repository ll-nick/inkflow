"""Ops on a slide SVG's ``inkflow:parent``."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from lxml import etree

from inkflow import ns, sync
from inkflow.enums import ColorMode
from inkflow.layout import (
    AssetKind,
    has_preview_layers,
    resolve_parent_path,
    with_preview_layers,
)
from inkflow.ops.changeset import ChangeSet, OpError
from inkflow.ops.registry import DeckUse, OpContext, register, register_group
from inkflow.svg import with_namespaces
from inkflow.svgio import parse_svg_file

__all__ = ["GROUP", "ParentSetRequest", "set"]

GROUP = register_group("parent", "Manage slide layout parents.")


@dataclass(frozen=True)
class ParentSetRequest:
    file: Path
    parent: str


@register(GROUP, "set", ParentSetRequest, deck=DeckUse.OPTIONAL)
def set(request: ParentSetRequest, context: OpContext) -> ChangeSet:
    """Set the inkflow:parent of a slide SVG and refresh its preview layers.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path.

    The file is left exactly as `inkflow sync` would leave it: layout layers for
    the new parent, the overlays it previews and the theme preview styles (in the
    deck's color mode; dark without a deck).
    """
    svg_path = request.file.resolve()
    if not svg_path.exists():
        raise OpError(f"file not found: {svg_path}")
    dark_mode = context.deck is None or context.deck.effective_mode == ColorMode.DARK
    try:
        preview = sync.build_context(
            context.deck, context.project_dir, context.theme, dark_mode
        )
        is_overlay = sync.is_overlay_file(svg_path, preview)
        kind = AssetKind.OVERLAY if is_overlay else AssetKind.LAYOUT
        parent_path = resolve_parent_path(
            request.parent, svg_path.parent, context.project_dir, context.theme, kind
        )
        if not parent_path.exists():
            raise OpError(f"parent not found: {parent_path}")

        root = parse_svg_file(svg_path)
        old_parent = root.get(ns.INKFLOW_PARENT)
        root = with_namespaces(root, {"inkflow": ns.INKFLOW})
        root.set(ns.INKFLOW_PARENT, request.parent)
        # Planned from the edited tree: the file on disk still names the old parent
        # until the change set is applied.
        layers = sync.plan_preview(svg_path, preview, root).layers
    except ValueError as exc:
        raise OpError(str(exc)) from exc
    if not has_preview_layers(root, layers):
        root = with_preview_layers(root, layers)

    label = context.label(svg_path)
    if old_parent in (None, request.parent):
        summary = f"{label}: parent {request.parent!r}"
    else:
        summary = f"{label}: parent {old_parent!r} → {request.parent!r}"
    content = etree.tostring(root, encoding="unicode", xml_declaration=False)
    # lxml drops the final newline; keeping it spares an unchanged file a rewrite
    # (and a one-line diff).
    if svg_path.read_bytes().endswith(b"\n"):
        content += "\n"
    return ChangeSet.from_contents(summary, {svg_path: content})
