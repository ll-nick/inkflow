"""Reusable preview-sync logic shared by the ``sync`` command, ``verify`` and ``init``.

Injecting ancestor layout layers, the overlays a file will actually get at runtime,
and a theme-colored preview ``<style>`` into a slide SVG makes editors (Inkscape)
render the composited background, the chrome on top, and semantic ``inkflow-fill-*``
classes with the right colors. The serve/build pipeline never needs these — it
resolves parent chains and overlays in memory — so this is purely an authoring aid
written to the file on disk.

The mapping is the hard part: ``sync`` works on files while overlays are declared on
slides, so one file can be backed by slides that disagree. ``resolve_overlay_preview``
holds that rule, and ``PreviewRule`` names which branch fired so the command can say so.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

from inkflow import colors, loaders
from inkflow.layout import (
    AssetKind,
    PreviewLayer,
    PreviewLayers,
    chain_layers,
    inject_preview_layers,
    resolve_chain,
    resolve_parent_path,
)
from inkflow.logging import logger
from inkflow.manifest import Deck, Slide
from inkflow.ns import INKFLOW_PREVIEW, INKFLOW_PREVIEW_OVERLAYS
from inkflow.overlay import Overlay
from inkflow.pipeline import resolve_overlay_chains, resolve_slide_src
from inkflow.svgio import parse_svg_file

if TYPE_CHECKING:
    from inkflow.themes import Theme


def build_preview_css(
    deck_obj: Deck | None, project_dir: Path | None, dark_mode: bool
) -> str:
    """Build the theme preview ``<style>`` block from a deck's resolved styles."""
    css = loaders.load_deck_styles(deck_obj, project_dir)
    tokens = colors.extract_tokens(css, dark_mode)
    return colors.build_preview_style(tokens)


class PreviewRule(StrEnum):
    """Which rule decided the overlays a file previews. Reported by ``sync``."""

    ATTRIBUTE = "inkflow:preview-overlays"
    SLIDES = "slides agree"
    DECK = "deck default overlays"
    OVERLAY_FILE = "overlay file"
    NO_DECK = "no deck"


@dataclass(frozen=True)
class PreviewContext:
    """Everything needed to plan previews for one sync run, resolved once.

    ``slides_by_file`` and ``overlay_files`` are the inputs to the file → overlays
    rule, and cost a full deck walk, so they are built once per command rather than
    per target.
    """

    deck: Deck | None
    project_dir: Path | None
    theme: Theme | None
    preview_css: str = ""
    slides_by_file: dict[Path, list[Slide]] = field(default_factory=dict)
    overlay_files: frozenset[Path] = frozenset()


def slide_overlays(slide: Slide, deck_obj: Deck) -> Sequence[Overlay]:
    """The overlays one slide ends up with: its own, else the deck's."""
    return slide.overlays if slide.overlays is not None else deck_obj.effective_overlays


def slides_by_file(
    deck_obj: Deck, project_dir: Path, theme: Theme | None
) -> dict[Path, list[Slide]]:
    """Map each SVG the deck reaches to the slides backed by it.

    A slide backs its own ``src`` and every layout in that file's ancestor chain,
    which is what makes a shared layout ambiguous: it is backed by every slide
    using it, and those slides may disagree about chrome.
    """
    backing: dict[Path, list[Slide]] = {}
    for slide in deck_obj.slides:
        base = resolve_slide_src(slide.src, project_dir, theme)
        for path in (base, *resolve_chain(base, project_dir, theme)):
            backing.setdefault(path.resolve(), []).append(slide)
    return backing


def overlay_files(
    deck_obj: Deck | None, project_dir: Path | None, theme: Theme | None
) -> frozenset[Path]:
    """Every file that is an overlay rather than something overlays land on.

    The union of the ``overlays/`` directory and everything the deck references as
    an overlay. The directory half covers drafts not yet added to ``deck.py``, the
    reference half covers overlays parked outside the convention by a relative path.
    Without both, an overlay file would be previewed with the deck's own chrome
    stamped on top of the chrome being drawn.
    """
    files: set[Path] = set()
    if project_dir is not None:
        files.update(p.resolve() for p in (project_dir / "overlays").glob("*.svg"))
    if deck_obj is None or project_dir is None:
        return frozenset(files)

    declared = [*deck_obj.effective_overlays]
    declared += [o for slide in deck_obj.slides for o in (slide.overlays or [])]
    for chain in resolve_overlay_chains(declared, project_dir, theme):
        files.update(p.resolve() for p in chain)
    return frozenset(files)


def build_context(
    deck_obj: Deck | None,
    project_dir: Path | None,
    theme: Theme | None,
    dark_mode: bool,
) -> PreviewContext:
    """Resolve the per-run data every target's preview plan is derived from."""
    backing: dict[Path, list[Slide]] = {}
    if deck_obj is not None and project_dir is not None:
        backing = slides_by_file(deck_obj, project_dir, theme)
    return PreviewContext(
        deck=deck_obj,
        project_dir=project_dir,
        theme=theme,
        preview_css=build_preview_css(deck_obj, project_dir, dark_mode),
        slides_by_file=backing,
        overlay_files=overlay_files(deck_obj, project_dir, theme),
    )


def is_overlay_file(path: Path, ctx: PreviewContext) -> bool:
    """True when ``path`` is chrome itself rather than something chrome lands on."""
    return path.parent.name == AssetKind.OVERLAY or path.resolve() in ctx.overlay_files


def _overlay_layers(
    overlays: Sequence[Overlay], base_dir: Path, ctx: PreviewContext
) -> list[list[PreviewLayer]]:
    """Resolve overlays to layer lists, each ``[*ancestors, overlay]``."""
    if not overlays:
        return []
    chains = resolve_overlay_chains(overlays, ctx.project_dir, ctx.theme, base_dir)
    return [
        [*chain_layers(chain[-1], chain[:-1]), PreviewLayer(chain[-1], overlay.src)]
        for overlay, chain in zip(overlays, chains, strict=True)
    ]


def _attribute_overlays(path: Path) -> list[Overlay] | None:
    """Rule 1: the ``inkflow:preview-overlays`` attribute, or None when absent."""
    declared = parse_svg_file(path).get(INKFLOW_PREVIEW_OVERLAYS)
    if declared is None:
        return None
    return [Overlay(name) for name in declared.split()]


def _unanimous_overlays(
    slides: list[Slide], deck_obj: Deck, ctx: PreviewContext
) -> Sequence[Overlay] | None:
    """Rule 2: what every slide backed by this file agrees on, else None."""
    if not slides or ctx.project_dir is None:
        return None
    # Compare the resolved chains, not the src strings, so "footer" and
    # "local:footer" naming the same file count as agreement.
    resolved = [
        tuple(
            tuple(chain)
            for chain in resolve_overlay_chains(
                slide_overlays(slide, deck_obj), ctx.project_dir, ctx.theme
            )
        )
        for slide in slides
    ]
    if any(entry != resolved[0] for entry in resolved):
        return None
    return slide_overlays(slides[0], deck_obj)


def resolve_overlay_preview(
    path: Path, ctx: PreviewContext
) -> tuple[list[list[PreviewLayer]], PreviewRule]:
    """Decide which overlays ``path`` previews, and which rule decided it.

    Rule order is attribute, unanimous slides, deck default. Falling back to the
    deck biases toward *showing* chrome: the question being answered in Inkscape is
    how much room to leave, and a preview showing chrome a slide will not have makes
    you leave extra room, while the opposite causes overlap.
    """
    declared = _attribute_overlays(path)
    if declared is not None:
        return _overlay_layers(declared, path.parent, ctx), PreviewRule.ATTRIBUTE
    if ctx.deck is None or ctx.project_dir is None:
        return [], PreviewRule.NO_DECK
    if is_overlay_file(path, ctx):
        return [], PreviewRule.OVERLAY_FILE

    slides = ctx.slides_by_file.get(path.resolve(), [])
    agreed = _unanimous_overlays(slides, ctx.deck, ctx)
    if agreed is not None:
        return _overlay_layers(agreed, ctx.project_dir, ctx), PreviewRule.SLIDES
    return (
        _overlay_layers(ctx.deck.effective_overlays, ctx.project_dir, ctx),
        PreviewRule.DECK,
    )


def _backdrop_layers(path: Path, ctx: PreviewContext) -> list[PreviewLayer]:
    """What ``inkflow:preview`` names, drawn behind an overlay file being authored.

    Purely a reference so the overlay is not drawn on a checkerboard. Naming a
    backdrop is a preview choice, not a claim about where the overlay lands, so a
    mismatch with the layouts it actually covers is not a contradiction.

    There is deliberately no default. Any guess is one an overlay cannot make for
    itself: a deck of raw SVGs is built on no layout at all, so falling back to the
    theme's ``base`` would preview chrome against a canvas of the wrong size in a
    background colour the deck never paints.
    """
    ref = parse_svg_file(path).get(INKFLOW_PREVIEW)
    if not ref:
        return []
    try:
        backdrop = resolve_parent_path(
            ref, path.parent, ctx.project_dir, ctx.theme, AssetKind.LAYOUT
        )
    except ValueError as exc:
        logger.warning(f"{path.name}: inkflow:preview backdrop not found ({exc})")
        return []
    chain = resolve_chain(backdrop, ctx.project_dir, ctx.theme)
    return [*chain_layers(backdrop, chain), PreviewLayer(backdrop, ref)]


class PreviewPlan(NamedTuple):
    """What to inject into one file, and enough of the why to report it."""

    layers: PreviewLayers
    rule: PreviewRule
    is_overlay: bool
    backdrop: PreviewLayer | None

    @property
    def is_bare(self) -> bool:
        """True when only the preview style block would be written."""
        return not self.layers.behind and not self.layers.overlays


def plan_preview(path: Path, ctx: PreviewContext) -> PreviewPlan:
    """Resolve everything to inject into one file, and the overlay rule that fired.

    The single answer to "what does this file preview", shared by the ``sync``
    write path, ``sync --check`` and ``verify``, so the three cannot disagree about
    whether a file is up to date.
    """
    is_overlay = is_overlay_file(path, ctx)
    kind = AssetKind.OVERLAY if is_overlay else AssetKind.LAYOUT
    chain = resolve_chain(path, ctx.project_dir, ctx.theme, kind)
    behind = chain_layers(path, chain)
    backdrop_layers = _backdrop_layers(path, ctx) if is_overlay else []
    behind = [*backdrop_layers, *behind]

    overlays, rule = resolve_overlay_preview(path, ctx)
    return PreviewPlan(
        layers=PreviewLayers(behind, overlays, ctx.preview_css),
        rule=rule,
        is_overlay=is_overlay,
        backdrop=backdrop_layers[-1] if backdrop_layers else None,
    )


def sync_slides(paths: Iterable[Path], ctx: PreviewContext) -> None:
    """Inject preview layers + theme preview styles into each SVG.

    Parentless files still receive the preview style block (empty chain). Raises
    ``ValueError`` if any file's parent chain cannot be resolved.
    """
    for path in paths:
        inject_preview_layers(path, plan_preview(path, ctx).layers)
