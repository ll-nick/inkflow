from __future__ import annotations

from pathlib import Path

from lxml import etree

from inkflow.clean import clean_inkscape_svg
from inkflow.layout import is_layout_current, resolve_chain
from inkflow.manifest import Media, Slide
from inkflow.markdown import parse_markdown_zones
from inkflow.pipeline import resolve_content_src, resolve_slide_src
from inkflow.svg import compose_with_ancestors

Issue = tuple[str, str]  # (level, message) — level is "error" or "warn"


def composed_svg_ids(
    src: Path, project_dir: Path | None, theme: str | None
) -> set[str]:
    """Return all element IDs from an SVG after compositing its ancestor chain."""
    svg_str = clean_inkscape_svg(src)
    chain = resolve_chain(src, project_dir, theme)
    if chain:
        svg_str = compose_with_ancestors(svg_str, chain)
    root = etree.fromstring(svg_str.encode())
    ids: set[str] = set()
    for el in root.iter():
        eid = el.get("id")
        if eid:
            ids.add(eid)
    return ids


def _check_files(slide: Slide, project_dir: Path) -> list[Issue]:
    issues: list[Issue] = []
    if slide.md is not None:
        md_path = resolve_content_src(slide.md, project_dir)
        if not md_path.exists():
            issues.append(("error", f"markdown not found: {slide.md}"))
    if isinstance(slide.notes, Path):
        notes_path = (
            slide.notes if slide.notes.is_absolute() else project_dir / slide.notes
        )
        if not notes_path.exists():
            issues.append(("error", f"notes file not found: {slide.notes}"))
    return issues


def _check_media(slide: Slide, project_dir: Path) -> list[Issue]:
    issues: list[Issue] = []
    for _key, content in slide.zones.items():
        if isinstance(content, Media):
            for src_field in filter(None, [content.src, content.alt_src]):
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
        md_path = resolve_content_src(slide.md, project_dir)
        if md_path.exists():
            for zone_name in parse_markdown_zones(md_path).zones:
                if zone_name == "notes":
                    continue
                zone_full = f"zone-{zone_name}"
                if zone_full not in zone_ids:
                    issues.append(
                        ("error", f"zone #{zone_full} (from markdown) not in layout")
                    )
    return issues


def _check_animations(slide: Slide, all_ids: set[str]) -> list[Issue]:
    issues: list[Issue] = []
    for anim in slide.animations:
        eid = anim.element.lstrip("#")
        if eid not in all_ids:
            issues.append(("error", f"animation element #{eid} not found in SVG"))
    if slide.animations:
        steps = sorted({a.step for a in slide.animations})
        expected = list(range(1, len(steps) + 1))
        if steps != expected:
            issues.append(
                ("warn", f"animation step gap: {steps} (expected {expected})")
            )
    return issues


def _check_sync(
    src: Path, project_dir: Path | None, theme: str | None, preview_css: str
) -> list[Issue]:
    chain = resolve_chain(src, project_dir, theme)
    if not is_layout_current(src, chain, preview_css):
        return [("warn", "layout layers stale — run inkflow sync")]
    return []


def verify_slide(
    slide: Slide,
    project_dir: Path,
    theme: str | None,
    preview_css: str,
) -> list[Issue]:
    """Return all (level, message) issues for one slide. Empty list means clean."""
    try:
        src = resolve_slide_src(slide.src, project_dir, theme)
    except ValueError:
        return [("error", f"source not found: {slide.src}")]
    if not src.exists():
        return [("error", f"source not found: {src}")]

    issues = _check_files(slide, project_dir)

    try:
        all_ids = composed_svg_ids(src, project_dir, theme)
    except Exception as exc:
        return [*issues, ("error", f"could not parse SVG: {exc}")]

    zone_ids = {eid for eid in all_ids if eid.startswith("zone-")}
    issues += _check_media(slide, project_dir)
    issues += _check_zones(slide, project_dir, zone_ids)
    issues += _check_animations(slide, all_ids)
    issues += _check_sync(src, project_dir, theme, preview_css)
    return issues
