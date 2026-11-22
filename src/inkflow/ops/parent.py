"""Ops on a slide SVG's ``inkflow:parent``."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

from rich.text import Text

from inkflow import ns, sync
from inkflow.clean import strip_preview_layers
from inkflow.enums import ColorMode
from inkflow.layout import (
    AssetKind,
    has_preview_layers,
    resolve_parent_path,
    with_preview_layers,
)
from inkflow.ops.changeset import ChangeSet, OpError
from inkflow.ops.registry import (
    DeckUse,
    OpContext,
    described,
    register,
    register_group,
)
from inkflow.svg import with_namespaces
from inkflow.svgio import SvgElement, parse_svg_file

__all__ = [
    "GROUP",
    "FileParent",
    "ParentGetRequest",
    "ParentGetResult",
    "ParentSetRequest",
    "ParentStripRequest",
    "get",
    "set",
    "strip",
]

GROUP = register_group("parent", "Manage slide layout parents.")

_FILES_HELP = described("SVG files (default: every project-local SVG the deck uses).")


def _read(path: Path) -> SvgElement:
    try:
        return parse_svg_file(path)
    except ValueError as exc:
        raise OpError(str(exc)) from exc


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
            FileParent(context.label(path), _read(path).get(ns.INKFLOW_PARENT))
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
        root = _read(path)
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
    return ChangeSet.from_svgs(summary, {svg_path: root})
