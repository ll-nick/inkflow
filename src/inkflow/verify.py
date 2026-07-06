from __future__ import annotations

from pathlib import Path

from inkflow.clean import clean_inkscape_tree
from inkflow.layout import is_layout_current, resolve_chain, resolve_default_zone
from inkflow.loaders import load_md, resolve_content_src
from inkflow.manifest import Inline, Media, Slide
from inkflow.pipeline import resolve_slide_src
from inkflow.svg import compose_with_ancestors
from inkflow.zones import build_slide_content, parse_markdown_zones

Issue = tuple[str, str]  # (level, message) — level is "error" or "warn"


def composed_svg_ids(
    src: Path, project_dir: Path | None, theme: str | None
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
        root = clean_inkscape_tree(src)
        chain = resolve_chain(src, project_dir, theme)
        if chain:
            root = compose_with_ancestors(root, chain)
    except Exception as exc:
        return [*issues, ("error", f"could not parse SVG: {exc}")]

    all_ids = {eid for el in root.iter() if (eid := el.get("id")) is not None}
    zone_ids = {eid for eid in all_ids if eid.startswith("zone-")}
    default_zone = resolve_default_zone(root, zone_ids)

    issues += _check_media(slide, project_dir)
    issues += _check_zones(slide, project_dir, zone_ids)
    issues += _check_animations(slide, all_ids)
    issues += _check_default_zone(slide, project_dir, zone_ids, default_zone)
    issues += _check_sync(src, project_dir, theme, preview_css)
    return issues
