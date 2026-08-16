from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from inkflow.animations import Animation, PlayVideo
from inkflow.clean import clean_inkscape_tree
from inkflow.layout import (
    are_preview_layers_current,
    discover_layouts,
    resolve_chain,
    resolve_default_zone,
)
from inkflow.loaders import load_md, resolve_content_src
from inkflow.manifest import Inline, Media, Slide, Video
from inkflow.pipeline import resolve_overlay_chains, resolve_slide_src
from inkflow.svg import (
    compose_overlays,
    compose_with_ancestors,
    duplicate_zone_ids,
    is_full_canvas_fill,
)
from inkflow.sync import PreviewContext, plan_preview, slide_overlays
from inkflow.zones import build_slide_content, parse_markdown_zones

if TYPE_CHECKING:
    from inkflow.themes import Theme

Issue = tuple[str, str]  # (level, message) — level is "error" or "warn"


def composed_svg_ids(
    src: Path, project_dir: Path | None, theme: Theme | None
) -> set[str]:
    """Return all element IDs from an SVG after compositing its ancestor chain."""
    root = clean_inkscape_tree(src)
    chain = resolve_chain(src, project_dir, theme)
    if chain:
        root = compose_with_ancestors(root, chain)
    ids: set[str] = set()
    for el in root.iter():
        eid = el.get("id")
        if eid:
            ids.add(eid)
    return ids


def _check_files(slide: Slide, project_dir: Path) -> list[Issue]:
    issues: list[Issue] = []
    if slide.md is not None and not isinstance(slide.md, Inline):
        md_path = resolve_content_src(slide.md, project_dir)
        if not md_path.exists():
            issues.append(("error", f"markdown not found: {slide.md}"))
    if slide.notes is not None and not isinstance(slide.notes, Inline):
        notes_path = Path(slide.notes)
        if not notes_path.is_absolute():
            notes_path = project_dir / notes_path
        if not notes_path.exists():
            issues.append(("error", f"notes file not found: {slide.notes}"))
    return issues


def _check_media(slide: Slide, project_dir: Path) -> list[Issue]:
    issues: list[Issue] = []
    for _key, content in slide.zones.items():
        if isinstance(content, Media):
            refs = [content.src, content.alt_src]
            if isinstance(content, Video):
                refs.append(content.poster)
            for src_field in filter(None, refs):
                if src_field.startswith(("http://", "https://", "//")):
                    continue
                media_p = (
                    Path(src_field)
                    if Path(src_field).is_absolute()
                    else project_dir / src_field
                )
                if not media_p.exists():
                    issues.append(("error", f"media not found: {src_field}"))
    return issues


def _check_zones(slide: Slide, project_dir: Path, zone_ids: set[str]) -> list[Issue]:
    issues: list[Issue] = []
    for zone_key in slide.zones:
        zone_full = f"zone-{zone_key}"
        if zone_full not in zone_ids:
            issues.append(("error", f"zone #{zone_full} not found in layout"))
    if slide.md is not None:
        try:
            md_text = load_md(slide.md, project_dir)
        except (FileNotFoundError, OSError):
            md_text = None
        if md_text is not None:
            parsed = parse_markdown_zones(md_text)
            for zone_name in parsed.zones:
                if zone_name == "notes":
                    continue
                zone_full = f"zone-{zone_name}"
                if zone_full not in zone_ids:
                    if zone_name in parsed.auto_zones:
                        continue
                    issues.append(
                        ("error", f"zone #{zone_full} (from markdown) not in layout")
                    )
    return issues


def _check_animations(slide: Slide, all_ids: set[str]) -> list[Issue]:
    issues: list[Issue] = []
    for cue in slide.animations:
        if isinstance(cue, PlayVideo):
            zone_id = f"zone-{cue.element}"
            if zone_id not in all_ids:
                issues.append(
                    ("error", f"PlayVideo target #{zone_id} not found in SVG")
                )
            target = slide.zones.get(cue.element)
            if isinstance(target, Video) and target.autoplay:
                msg = (
                    f"video in zone {cue.element}: autoplay overridden by PlayVideo cue"
                )
                issues.append(("warn", msg))
        elif isinstance(cue, Animation) and cue.element not in all_ids:
            issues.append(
                ("error", f"animation element #{cue.element} not found in SVG")
            )
    return issues


def _check_default_zone(
    slide: Slide,
    project_dir: Path,
    zone_ids: set[str],
    default_zone: str,
) -> list[Issue]:
    if slide.md is None:
        return []
    try:
        md_text = load_md(slide.md, project_dir)
    except (FileNotFoundError, OSError):
        return []
    if md_text is None:
        return []
    try:
        build_slide_content(
            parse_markdown_zones(md_text),
            slide.zones,
            available_zones=zone_ids,
            default_zone=default_zone,
        )
    except ValueError as exc:
        return [("error", str(exc))]
    return []


def _check_overlays(overlay_chains: list[list[Path]]) -> list[Issue]:
    """Flag overlays that would blank the deck, and report their composition.

    The failure this catches is an overlay whose `inkflow:parent` points at a
    layout instead of another overlay: layouts paint a full-bleed background, and
    on top of a slide that hides everything. The symptom (a blank deck) is two
    files removed from the cause, so name the file.
    """
    issues: list[Issue] = []
    for chain in overlay_chains:
        for path in chain:
            if is_full_canvas_fill(clean_inkscape_tree(path)):
                issues.append(
                    (
                        "error",
                        f"overlay {path.name} paints an opaque full-canvas rect, "
                        + "which would hide the slide beneath it — overlays inherit "
                        + "from overlays, not from layouts",
                    )
                )
    return issues


def _check_sync(src: Path, preview: PreviewContext) -> list[Issue]:
    """Staleness through the same plan ``sync`` writes, so the two agree.

    Deriving the expected layers here instead would disagree the moment a file is
    backed by slides that want different chrome, reporting a correctly synced file
    as stale forever.
    """
    # Only files `inkflow sync` would actually write: a slide built straight on a
    # built-in or theme layout resolves outside the project, and nothing may edit
    # those, so reporting them as stale would be advice no one can follow.
    if preview.project_dir is None or not src.is_relative_to(preview.project_dir):
        return []
    if not are_preview_layers_current(src, plan_preview(src, preview).layers):
        return [("warn", "preview layers stale — run inkflow sync")]
    return []


def _unresolved_src_issue(src: str, project_dir: Path, theme: Theme | None) -> Issue:
    """Author-facing issue for an unresolvable ``Slide.src``.

    A bare, suffix-less name is a layout reference, so list the layouts actually
    available across the project, theme, and built-in dirs to guide the fix.
    """
    p = Path(src)
    is_layout_ref = (
        len(p.parts) == 1
        and not p.suffix
        and not src.startswith(("local:", "theme:", "builtin:", "./", "../"))
    )
    if not is_layout_ref:
        return ("error", f"source not found: {src}")
    available = sorted({lp.stem for _, lp in discover_layouts(project_dir, theme)})
    listed = ", ".join(available) or "(none)"
    return ("error", f"layout '{src}' not found. Available: {listed}")


def verify_slide(
    slide: Slide,
    project_dir: Path,
    theme: Theme | None,
    preview: PreviewContext,
) -> list[Issue]:
    """Return all (level, message) issues for one slide. Empty list means clean.

    ``preview`` carries the deck (whose overlays the slide may override) and the
    preview styles the sync check compares against. Overlays are composed into the
    tree before the id checks run, since a zone or animation target may legitimately
    live in the chrome.
    """
    try:
        src = resolve_slide_src(slide.src, project_dir, theme)
    except ValueError:
        return [_unresolved_src_issue(slide.src, project_dir, theme)]
    if not src.exists():
        return [("error", f"source not found: {src}")]

    issues = _check_files(slide, project_dir)

    overlays = (
        slide_overlays(slide, preview.deck)
        if preview.deck is not None
        else slide.overlays or []
    )
    try:
        root = clean_inkscape_tree(src)
        chain = resolve_chain(src, project_dir, theme)
        if chain:
            root = compose_with_ancestors(root, chain)
        overlay_chains = resolve_overlay_chains(overlays, project_dir, theme)
        root = compose_overlays(root, overlay_chains)
    except (ValueError, OSError) as exc:
        return [*issues, ("error", f"could not compose SVG: {exc}")]
    except Exception as exc:
        return [*issues, ("error", f"could not parse SVG: {exc}")]

    all_ids = {eid for el in root.iter() if (eid := el.get("id")) is not None}
    zone_ids = {eid for eid in all_ids if eid.startswith("zone-")}
    default_zone = resolve_default_zone(root, zone_ids)

    issues += _check_media(slide, project_dir)
    issues += _check_zones(slide, project_dir, zone_ids)
    issues += _check_animations(slide, all_ids)
    issues += _check_default_zone(slide, project_dir, zone_ids, default_zone)
    issues += _check_overlays(overlay_chains)
    issues += [
        (
            "warn",
            f"{zone_id} is declared more than once — "
            + "zone ids must be unique across a slide and its overlays",
        )
        for zone_id in duplicate_zone_ids(root)
    ]
    issues += _check_sync(src, preview)
    return issues
