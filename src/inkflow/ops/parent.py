"""Ops on a slide SVG's ``inkflow:parent``."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.layout import (
    PreviewLayer,
    PreviewLayers,
    chain_layers,
    has_preview_layers,
    resolve_chain,
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
    """Set the inkflow:parent of a slide SVG and refresh its layout layers.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path.
    """
    svg_path = request.file.resolve()
    if not svg_path.exists():
        raise OpError(f"file not found: {svg_path}")
    try:
        parent_path = resolve_parent_path(
            request.parent, svg_path.parent, context.project_dir, context.theme
        )
        if not parent_path.exists():
            raise OpError(f"parent not found: {parent_path}")
        ancestors = resolve_chain(parent_path, context.project_dir, context.theme)
        root = parse_svg_file(svg_path)
    except ValueError as exc:
        raise OpError(str(exc)) from exc
    if svg_path in (*ancestors, parent_path):
        raise OpError(f"{request.parent!r} would make {svg_path.name} its own ancestor")

    old_parent = root.get(ns.INKFLOW_PARENT)
    root = with_namespaces(root, {"inkflow": ns.INKFLOW})
    root.set(ns.INKFLOW_PARENT, request.parent)
    # Built from the new parent rather than read back from the file, which still
    # names the old one until the change set is applied.
    layers = PreviewLayers(
        behind=[
            *chain_layers(parent_path, ancestors),
            PreviewLayer(parent_path, request.parent),
        ]
    )
    if not has_preview_layers(root, layers):
        root = with_preview_layers(root, layers)

    label = context.label(svg_path)
    if old_parent in (None, request.parent):
        summary = f"{label}: parent {request.parent!r}"
    else:
        summary = f"{label}: parent {old_parent!r} → {request.parent!r}"
    content = etree.tostring(root, encoding="unicode", xml_declaration=False)
    return ChangeSet.from_contents(summary, {svg_path: content})
