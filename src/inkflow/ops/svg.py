"""Ops on SVG files: editor-metadata cleanup, preview sync, ids and colors."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

from inkflow import colors, loaders, ns
from inkflow import sync as preview_sync
from inkflow.clean import clean_inkscape_tree, serialize_cleaned
from inkflow.enums import ColorMode
from inkflow.label2id import promote_labels_to_ids
from inkflow.layout import has_preview_layers, with_preview_layers
from inkflow.logging import logger
from inkflow.ops.changeset import ChangeSet, OpError
from inkflow.ops.parent import preview_context, resolve_parent_file, with_parent
from inkflow.ops.registry import (
    DeckUse,
    OpContext,
    described,
    register,
    register_group,
)
from inkflow.svgio import SvgElement, parse_svg, parse_svg_file, svg_matches_file

__all__ = [
    "GROUP",
    "CleanedSvg",
    "SvgCleanRequest",
    "SvgCleanedRequest",
    "SvgColorizeRequest",
    "SvgLabel2IdRequest",
    "SvgNewRequest",
    "SvgSyncRequest",
    "clean",
    "cleaned",
    "colorize",
    "label2id",
    "new",
    "sync",
]

GROUP = register_group("svg", "Maintain slide, layout and overlay SVG files.")

_FILES_HELP = described("SVG files (default: every project-local SVG the deck uses).")
_MODE_HELP = described(
    "Color mode for the preview colors (default: the deck's; dark without a deck)."
)


def _read(path: Path) -> SvgElement:
    try:
        return parse_svg_file(path)
    except ValueError as exc:
        raise OpError(str(exc)) from exc


def _cleaned_tree(path: Path) -> SvgElement:
    try:
        return clean_inkscape_tree(path, keep_preview=True)
    except ValueError as exc:
        raise OpError(str(exc)) from exc


def _counted(changes: ChangeSet, total: int, done: str, nothing: str) -> ChangeSet:
    count = len(changes.edits)
    summary = (
        f"{done} {count} of {total} file(s)" if count else f"{nothing} {total} file(s)"
    )
    return ChangeSet(summary, changes.edits)


@dataclass(frozen=True)
class SvgCleanRequest:
    files: tuple[Path, ...] = field(default=(), metadata=_FILES_HELP)


@register(GROUP, "clean", SvgCleanRequest, ChangeSet, deck=DeckUse.SWEEP_ONLY)
def clean(request: SvgCleanRequest, context: OpContext) -> ChangeSet:
    """Strip Inkscape editor metadata from SVG files.

    Keeps what Inkscape needs to recognise layers, and the injected preview
    layers. If FILES is omitted, cleans every project-local SVG the deck uses
    (each slide and its local layout ancestors). The pre-commit hook installed by
    `inkflow setup-git` runs this on staged SVGs.
    """
    paths = context.target_files(request.files)
    contents: dict[Path, str] = {}
    for path in paths:
        root = _cleaned_tree(path)
        if not svg_matches_file(root, path):
            contents[path] = serialize_cleaned(root)
    changes = ChangeSet.from_contents("", contents)
    return _counted(changes, len(paths), "cleaned", "nothing to clean in")


@dataclass(frozen=True)
class SvgCleanedRequest:
    file: Path


@dataclass(frozen=True)
class CleanedSvg:
    path: str
    svg: str

    def to_json(self) -> dict[str, object]:
        return asdict(self)

    def render(self) -> str:
        return self.svg


@register(GROUP, "cleaned", SvgCleanedRequest, CleanedSvg, deck=DeckUse.NONE)
def cleaned(request: SvgCleanedRequest, context: OpContext) -> CleanedSvg:
    """Print FILE as `inkflow svg clean` would write it, leaving it untouched.

    The SVG diff driver `inkflow setup-git` configures runs this (git calls it a
    textconv), so diffs show only visual changes. Unlike `svg clean` it always
    re-serializes, even an already clean file: both sides of a diff must be
    formatted the same way.
    """
    path = request.file.resolve()
    if not path.exists():
        raise OpError(f"file not found: {path}")
    return CleanedSvg(context.label(path), serialize_cleaned(_cleaned_tree(path)))


@dataclass(frozen=True)
class SvgLabel2IdRequest:
    files: tuple[Path, ...] = field(default=(), metadata=_FILES_HELP)
    all_tags: bool = field(
        default=False,
        metadata=described(
            "Also rename non-shape elements (tspan, stop, gradients, …)."
        ),
    )
    refs: bool = field(
        default=True,
        metadata=described(
            "Rewrite url(#id) / href='#id' references pointing at renamed ids."
        ),
    )


@register(GROUP, "label2id", SvgLabel2IdRequest, ChangeSet, deck=DeckUse.SWEEP_ONLY)
def label2id(request: SvgLabel2IdRequest, context: OpContext) -> ChangeSet:
    """Promote each element's inkscape:label to its SVG id.

    Name a group in Inkscape's Layers & Objects panel, run this, and deck.py can
    animate it by id (and the Morph transition can match it across slides). A
    label that is already a valid id is used verbatim; anything else is slugified.
    Labels need not be unique but ids must, so a clash is warned about and
    skipped, never clobbered. Elements inside injected inkflow preview layers are
    left alone.

    If FILES is omitted, processes every project-local SVG the deck uses (each
    slide and its local layout/overlay ancestors). After renaming ids in a layout
    or overlay, run `inkflow svg sync` so the slides that preview it pick up the
    change.
    """
    paths = context.target_files(request.files)
    contents: dict[Path, str] = {}
    details: dict[Path, str] = {}
    for path in paths:
        label = context.label(path)
        try:
            result = promote_labels_to_ids(
                path.read_text(encoding="utf-8"),
                all_tags=request.all_tags,
                rewrite_refs=request.refs,
            )
        except (ValueError, RuntimeError) as exc:
            raise OpError(f"{label}: {exc}") from exc
        for skip in result.skips:
            logger.warning(
                f"label2id: {label}: {skip.tag} {skip.label!r}: {skip.reason}"
            )
        if not result.changed:
            continue
        renames = [
            f"{rename.old_id} → {rename.new_id}"
            for rename in result.renames
            if rename.old_id is not None
        ]
        detail = ", ".join(renames)
        if result.reference_edits:
            detail += f" ({result.reference_edits} reference(s))"
        contents[path] = result.text
        details[path] = detail
    changes = ChangeSet.from_contents("", contents, details)
    return _counted(changes, len(paths), "renamed ids in", "no labels to promote in")


@dataclass(frozen=True)
class SvgSyncRequest:
    files: tuple[Path, ...] = field(default=(), metadata=_FILES_HELP)
    mode: ColorMode | None = field(default=None, metadata=_MODE_HELP)


def _sync_detail(plan: preview_sync.PreviewPlan) -> str:
    """Which rule decided this file's chrome, so the deck-default guess is never silent.

    Falling back to the deck default is a guess by design (a shared layout has no
    per-slide answer), so naming the rule is what points at
    ``inkflow:preview-overlays`` when the guess is wrong. An overlay file reports
    its backdrop for the same reason: there is no default, so "no backdrop" has to
    be visible rather than look like nothing happened.
    """
    if plan.is_overlay:
        backdrop = f"backdrop: {plan.backdrop.ref}" if plan.backdrop else "no backdrop"
        return f"{preview_sync.PreviewRule.OVERLAY_FILE}, {backdrop}"
    if plan.rule is preview_sync.PreviewRule.NO_DECK:
        return f"no deck, {preview_sync.PreviewRule.ATTRIBUTE} only"
    if not plan.layers.overlays:
        return ""
    count = sum(len(chain) for chain in plan.layers.overlays)
    plural = "" if count == 1 else "s"
    return f"{count} overlay layer{plural}, {plan.rule}"


@register(GROUP, "sync", SvgSyncRequest, ChangeSet, deck=DeckUse.OPTIONAL)
def sync(request: SvgSyncRequest, context: OpContext) -> ChangeSet:
    """Refresh layout layers, overlay layers and preview styles in slide SVG(s).

    Injects ancestor layout layers below the slide and the overlays it gets at
    runtime above it, plus a style block so Inkscape renders semantic CSS classes
    (e.g. inkflow-fill-accent) with the correct theme colors.

    Which overlays a file previews is decided by, in order: an explicit
    `inkflow:preview-overlays` attribute on the file, agreement among the slides
    backed by it, or the deck default. The rule that fired is shown per file.
    Overlay files themselves get no chrome, only an `inkflow:preview` backdrop.

    If FILES is omitted, refreshes every project-local SVG the deck uses
    (each slide, its local layout ancestors, and the project's overlays).
    Use `--check` to fail on stale files, and `--no-deck` when authoring a theme
    without a project deck.py.
    """
    try:
        preview = preview_sync.build_context(
            context.deck,
            context.project_dir,
            context.theme,
            context.dark_mode(request.mode),
        )
    except ValueError as exc:
        raise OpError(str(exc)) from exc
    paths = context.target_files(request.files)
    documents: dict[Path, SvgElement] = {}
    details: dict[Path, str] = {}
    for path in paths:
        root = _read(path)
        try:
            plan = preview_sync.plan_preview(path, preview, root)
        except ValueError as exc:
            raise OpError(str(exc)) from exc
        # A file with no layers only gains the preview style block, which is worth
        # writing when it was named but not when sweeping the whole deck. An overlay
        # file is the exception: it is swept precisely to get that block, and it
        # legitimately has no layers until it names a backdrop.
        if plan.is_bare and not plan.is_overlay and not request.files:
            continue
        if not has_preview_layers(root, plan.layers):
            root = with_preview_layers(root, plan.layers)
        documents[path] = root
        details[path] = _sync_detail(plan)
    changes = ChangeSet.from_svgs("", documents, details)
    return _counted(changes, len(documents), "refreshed", "up to date:")


@dataclass(frozen=True)
class SvgColorizeRequest:
    files: tuple[Path, ...] = field(default=(), metadata=_FILES_HELP)
    mode: ColorMode | None = field(
        default=None,
        metadata=described(
            "Color mode whose tokens are matched (default: the deck's; dark without "
            + "a deck)."
        ),
    )


@register(GROUP, "colorize", SvgColorizeRequest, ChangeSet, deck=DeckUse.OPTIONAL)
def colorize(request: SvgColorizeRequest, context: OpContext) -> ChangeSet:
    """Replace hardcoded theme hex colors in SVG files with semantic CSS classes.

    Reads the active theme's color tokens and replaces matching fill/stroke
    attributes and inline style declarations with inkflow-fill-* / inkflow-stroke-*
    classes. The hardcoded attributes are removed after replacement.

    If FILES is omitted, colorizes every project-local SVG the deck uses
    (each slide and its local layout ancestors).
    """
    styles = loaders.load_deck_styles(context.deck, context.project_dir)
    tokens = colors.extract_tokens(styles, context.dark_mode(request.mode))
    hex_map = colors.hex_to_class_map(tokens)
    paths = context.target_files(request.files)
    documents: dict[Path, SvgElement] = {}
    for path in paths:
        root = _read(path)
        if colors.colorize_tree(root, hex_map):
            documents[path] = root
    changes = ChangeSet.from_svgs("", documents)
    return _counted(changes, len(paths), "colorized", "no theme colors in")


_CANVAS = {"viewBox": "0 0 1920 1080", "width": "1920", "height": "1080"}


@dataclass(frozen=True)
class SvgNewRequest:
    file: Path
    parent: str | None = field(
        default=None,
        metadata=described(
            "Layout name or inkflow:parent string; omit for a blank slide.", "PARENT"
        ),
    )


@register(GROUP, "new", SvgNewRequest, ChangeSet, deck=DeckUse.OPTIONAL)
def new(request: SvgNewRequest, context: OpContext) -> ChangeSet:
    """Create a new slide SVG, optionally built on a layout parent.

    With --parent (bare name, 'local:foo', 'theme:foo', 'builtin:foo', or a
    relative path) the slide takes the layout's canvas size and is left as
    `inkflow svg sync` would leave it. Without it, a blank 1920x1080 slide is
    created. The slide is not added to deck.py.
    """
    path = request.file.resolve()
    if path.exists():
        raise OpError(f"file already exists: {path}")
    attributes = " ".join(f'{key}="{value}"' for key, value in _CANVAS.items())
    root = parse_svg(f'<svg xmlns="{ns.SVG}" {attributes}>\n</svg>')
    if request.parent is not None:
        preview = preview_context(context)
        layout = _read(resolve_parent_file(request.parent, path, context, preview))
        for key, value in _CANVAS.items():
            root.set(key, layout.get(key, value))
        root = with_parent(root, path, request.parent, preview)

    label = context.label(path)
    summary = f'new slide {label}; add Slide("{label}") to deck.py'
    return ChangeSet.from_svgs(summary, {path: root})
