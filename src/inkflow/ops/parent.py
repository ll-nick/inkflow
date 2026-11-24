"""Ops on a slide SVG's ``inkflow:parent``."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

from rich.text import Text

from inkflow import ns, sync
from inkflow.clean import strip_preview_layers
from inkflow.layout import (
    AssetKind,
    has_preview_layers,
    resolve_parent_path,
    with_preview_layers,
)
from inkflow.ops.changeset import ChangeSet, OpError, read_svg
from inkflow.ops.registry import (
    DeckUse,
    OpContext,
    described,
    register,
    register_group,
)
from inkflow.svg import with_namespaces
from inkflow.svgio import SvgElement

__all__ = [
    "GROUP",
    "FileParent",
    "ParentGetRequest",
    "ParentGetResult",
    "ParentSetRequest",
    "ParentStripRequest",
    "get",
    "preview_context",
    "resolve_parent_file",
    "set",
    "strip",
    "with_parent",
]

GROUP = register_group("parent", "Manage slide layout parents.")

_FILES_HELP = described("SVG files (default: every project-local SVG the deck uses).")


@dataclass(frozen=True)
class ParentGetRequest:
    files: tuple[Path, ...] = field(default=(), metadata=_FILES_HELP)


@dataclass(frozen=True)
class FileParent:
    path: str
    parent: str | None
    """None when the file has no ``inkflow:parent``."""


@dataclass(frozen=True)
class ParentGetResult:
    files: list[FileParent]

    def to_json(self) -> dict[str, object]:
        return asdict(self)

    def render(self) -> Text:
        lines: list[str] = []
        for entry in self.files:
            shown = entry.parent if entry.parent is not None else "(no parent)"
            lines.append(f"{entry.path}: {shown}")
        return Text("\n".join(lines))


@register(GROUP, "get", ParentGetRequest, ParentGetResult, deck=DeckUse.SWEEP_ONLY)
def get(request: ParentGetRequest, context: OpContext) -> ParentGetResult:
    """Print the inkflow:parent value of slide SVGs, one 'file: parent' line each.

    If FILES is omitted, reports every project-local SVG the deck uses
    (each slide and its local layout ancestors). Scripts should read --json, where
    a missing parent is null:

    \b
        inkflow parent get s.svg --json | jq -r '.files[0].parent // empty'
    """
    return ParentGetResult(
        [
            FileParent(context.label(path), read_svg(path).get(ns.INKFLOW_PARENT))
            for path in context.target_files(request.files)
        ]
    )


@dataclass(frozen=True)
class ParentStripRequest:
    files: tuple[Path, ...] = field(default=(), metadata=_FILES_HELP)


@register(GROUP, "strip", ParentStripRequest, ChangeSet, deck=DeckUse.SWEEP_ONLY)
def strip(request: ParentStripRequest, context: OpContext) -> ChangeSet:
    """Remove inkflow:parent and injected layout layers from slide SVG(s).

    If FILES is omitted, strips every project-local SVG the deck uses
    (each slide and its local layout ancestors). Use --dry-run to preview.
    """
    paths = context.target_files(request.files)
    documents: dict[Path, SvgElement] = {}
    details: dict[Path, str] = {}
    for path in paths:
        root = read_svg(path)
        old_parent = root.get(ns.INKFLOW_PARENT)
        if old_parent is not None:
            del root.attrib[ns.INKFLOW_PARENT]
        strip_preview_layers(root)
        documents[path] = root
        details[path] = (
            "preview layers removed"
            if old_parent is None
            else f"parent {old_parent!r} removed"
        )
    changes = ChangeSet.from_svgs("", documents, details)
    count = len(changes.edits)
    summary = (
        f"stripped {count} of {len(paths)} file(s)"
        if count
        else f"nothing to strip in {len(paths)} file(s)"
    )
    return ChangeSet(summary, changes.edits)


def preview_context(context: OpContext) -> sync.PreviewContext:
    """The preview data `with_parent` plans from, in the deck's color mode."""
    try:
        return sync.build_context(
            context.deck, context.project_dir, context.theme, context.dark_mode()
        )
    except ValueError as exc:
        raise OpError(str(exc)) from exc


def resolve_parent_file(
    parent: str, svg_path: Path, context: OpContext, preview: sync.PreviewContext
) -> Path:
    """The file ``parent`` names from ``svg_path``, which must exist."""
    is_overlay = sync.is_overlay_file(svg_path, preview)
    kind = AssetKind.OVERLAY if is_overlay else AssetKind.LAYOUT
    try:
        parent_path = resolve_parent_path(
            parent, svg_path.parent, context.project_dir, context.theme, kind
        )
    except ValueError as exc:
        raise OpError(str(exc)) from exc
    if not parent_path.exists():
        raise OpError(f"parent not found: {parent_path}")
    return parent_path


def with_parent(
    root: SvgElement, svg_path: Path, parent: str, preview: sync.PreviewContext
) -> SvgElement:
    """``root`` set to ``parent``, with the preview layers `sync` would give it.

    The layers are planned from the edited tree: the file on disk (if any) still
    names the old parent until the change set is applied.
    """
    root = with_namespaces(root, {"inkflow": ns.INKFLOW})
    root.set(ns.INKFLOW_PARENT, parent)
    try:
        layers = sync.plan_preview(svg_path, preview, root).layers
    except ValueError as exc:
        raise OpError(str(exc)) from exc
    if has_preview_layers(root, layers):
        return root
    return with_preview_layers(root, layers)


@dataclass(frozen=True)
class ParentSetRequest:
    file: Path
    parent: str


@register(GROUP, "set", ParentSetRequest, ChangeSet, deck=DeckUse.OPTIONAL)
def set(request: ParentSetRequest, context: OpContext) -> ChangeSet:
    """Set the inkflow:parent of a slide SVG and refresh its preview layers.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path.

    The file is left exactly as `inkflow svg sync` would leave it: layout layers for
    the new parent, the overlays it previews and the theme preview styles (in the
    deck's color mode; dark without a deck).
    """
    svg_path = request.file.resolve()
    if not svg_path.exists():
        raise OpError(f"file not found: {svg_path}")
    preview = preview_context(context)
    resolve_parent_file(request.parent, svg_path, context, preview)
    root = read_svg(svg_path)
    old_parent = root.get(ns.INKFLOW_PARENT)
    root = with_parent(root, svg_path, request.parent, preview)

    label = context.label(svg_path)
    if old_parent in (None, request.parent):
        summary = f"{label}: parent {request.parent!r}"
    else:
        summary = f"{label}: parent {old_parent!r} → {request.parent!r}"
    return ChangeSet.from_svgs(summary, {svg_path: root})
