from __future__ import annotations

import re
from pathlib import Path
from typing import TypedDict, cast

from lxml import etree

from inkflow import ns
from inkflow.clean import clean_inkscape_svg
from inkflow.content import (
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
)
from inkflow.layout import resolve_chain, resolve_default_zone, resolve_parent_path
from inkflow.loaders import load_md, load_notes, load_style
from inkflow.manifest import Animation, ColorMode, Deck, Inline, Slide, Transition
from inkflow.markdown import build_slide_content, parse_markdown_zones
from inkflow.svg import compose_with_ancestors

# ── Slide wire format ────────────────────────────────────────────────────────


class SlideData(TypedDict):
    id: str
    svg: str
    title: str
    notes: str


# ── Path conventions ─────────────────────────────────────────────────────────


def _infer_slide_id(slide: Slide) -> str:
    if slide.id:
        return slide.id
    if slide.md is not None and not isinstance(slide.md, Inline):
        return Path(slide.md).stem
    src = Path(slide.src)
    return src.stem if src.suffix else slide.src.replace("/", "-").replace(":", "-")


def _deduplicate_ids(raw_ids: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    result: list[str] = []
    for raw in raw_ids:
        if raw not in seen:
            seen[raw] = 1
            result.append(raw)
        else:
            seen[raw] += 1
            result.append(f"{raw}-{seen[raw]}")
    return result


def _infer_slide_title(slide: Slide, slide_id: str, project_dir: Path) -> str:
    if slide.title:
        return slide.title
    if slide.md is not None:
        md_text = load_md(slide.md, project_dir)
        if md_text is not None:
            zones = parse_markdown_zones(md_text).zones
            chunks = zones.get("title", [])
            if chunks and isinstance(chunks[0], str):
                return chunks[0].lstrip("#").strip()
    stem = re.sub(r"^\d+-", "", slide_id)
    return stem.replace("-", " ").replace("_", " ").title()


def resolve_slide_src(src: str, project_dir: Path, theme: str | None = None) -> Path:
    """Resolve a Slide.src string to an absolute Path.

    Single-part names (no directory separator, no scheme prefix) are checked
    against slides/ first: bare names get .svg appended, names that already
    carry an extension are tried as-is. If the slides/ candidate does not
    exist, the 3-level layout search runs (project layouts/ → theme layouts/
    → builtin layouts/). Everything else delegates directly to resolve_parent_path.
    """
    p = Path(src)
    if (
        not p.is_absolute()
        and len(p.parts) == 1
        and not src.startswith(("local:", "theme:", "builtin:", "./", "../"))
    ):
        name = src if p.suffix else src + ".svg"
        slides_candidate = project_dir / "slides" / name
        if slides_candidate.exists():
            return slides_candidate
    return resolve_parent_path(src, project_dir, project_dir, theme)


# ── Animation classes ─────────────────────────────────────────────────────────

# Fields that map to a modifier class instead of a CSS custom property, because
# CSS cannot branch on a custom-property *value* (e.g. pick a slide axis).
_ANIM_MODIFIER_FIELDS: frozenset[str] = frozenset({"direction"})

# Per-field unit suffix for the emitted `--anim-<field>` custom properties. The
# single place value formatting lives: times are seconds, distances are user
# units (px == SVG user units here), everything else is emitted raw.
_ANIM_UNIT: dict[str, str] = {"duration": "s", "delay": "s", "distance": "px"}


def _camel_to_kebab(name: str) -> str:
    """`FadeIn` -> `fade-in`, `SlideIn` -> `slide-in`, `Highlight` -> `highlight`."""
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()


def _anim_classes(anim: Animation) -> list[str]:
    """CSS classes for an animation: a name-derived base plus modifier classes."""
    classes = [f"anim-{_camel_to_kebab(type(anim).__name__)}"]
    direction = getattr(anim, "direction", None)
    if direction is not None:
        classes.append(f"anim-from-{direction}")
    return classes


def _anim_style(anim: Animation) -> str:
    """Inline `--anim-<field>` custom properties for an animation's set params.

    Generic over fields: anything beyond `element`/`step`/modifier fields that is
    not `None` becomes a custom property. `None` means "let the CSS default win".
    """
    fields: dict[str, object] = vars(anim)
    decls: list[str] = []
    for name, value in fields.items():
        if name in ("element", "step") or name in _ANIM_MODIFIER_FIELDS:
            continue
        if value is None:
            continue
        decls.append(f"--anim-{name}: {value}{_ANIM_UNIT.get(name, '')}")
    return "; ".join(decls)


def annotate_svg(svg_str: str, animations: list[Animation]) -> str:
    root = etree.fromstring(svg_str.encode())

    for anim in animations:
        eid = anim.element.lstrip("#")
        el = root.find(f'.//*[@id="{eid}"]')
        if el is None:
            print(f"[inkflow] warning: element #{eid} not found in SVG")
            continue

        existing_class = el.get("class", "")
        classes = [c for c in [existing_class, *_anim_classes(anim)] if c]
        el.set("class", " ".join(classes))
        el.set("data-step", str(anim.step))

        style = _anim_style(anim)
        if style:
            existing_style = el.get("style", "").strip().rstrip(";")
            el.set("style", f"{existing_style}; {style}" if existing_style else style)

    return etree.tostring(root, encoding="unicode")


def _serialize_transition(t: Transition | None) -> dict[str, object]:
    if t is None:
        return {"type": "cut", "duration": 0.0}
    all_fields = cast(dict[str, object], vars(t))
    fields = {k: v for k, v in all_fields.items() if v is not None}
    return {"type": _camel_to_kebab(type(t).__name__), **fields}


def resolve_transitions(deck: Deck) -> list[dict[str, object]]:
    return [
        _serialize_transition(
            slide.transition if slide.transition is not None else deck.transition
        )
        for slide in deck.slides
        if slide.visible
    ]


def _scope_slide_styles(svg_str: str, slide_number: int) -> str:
    """Assign a unique ID to the SVG root and wrap any inline <style> in @scope.

    SVG style blocks would bleed onto adjacent slides
    during CSS transitions without this guard.
    """
    root = etree.fromstring(svg_str.encode())
    slide_id = f"inkflow-slide-{slide_number}"
    root.set("id", slide_id)
    for style_el in root.findall(f".//{{{ns.SVG}}}style"):
        css = style_el.text
        if not css or not css.strip():
            continue
        style_el.text = f"@scope(#{slide_id}) {{\n{css}\n}}"
    return etree.tostring(root, encoding="unicode")


def _add_layout_classes(svg_str: str, chain: list[Path], src: Path) -> str:
    """Add layout-<stem> classes to the SVG root for every entry in [*chain, src].

    This scopes CSS rules in styles.css to a slide type
    (e.g. `.layout-cover #zone-title`)
    """
    root = etree.fromstring(svg_str.encode())
    existing = [c for c in root.get("class", "").split() if not c.startswith("layout-")]
    new_classes = [f"layout-{p.stem}" for p in [*chain, src]]
    root.set("class", " ".join(existing + new_classes))
    return etree.tostring(root, encoding="unicode")


def process_slide(
    slide: Slide,
    project_dir: Path,
    theme: str | None,
    slide_number: int,
    total_slides: int,
    deck_style: str = "",
    font_size: int = 36,
    mode: ColorMode = ColorMode.DARK,
) -> str:
    src = resolve_slide_src(slide.src, project_dir, theme)

    svg_str = clean_inkscape_svg(src)
    chain = resolve_chain(src, project_dir, theme)
    if chain:
        svg_str = compose_with_ancestors(svg_str, chain)
    svg_str = _add_layout_classes(svg_str, chain, src)
    svg_str = substitute_zone_numbers(svg_str, slide_number, total_slides)

    if slide.md is not None or slide.zones:
        md_text = load_md(slide.md, project_dir) if slide.md is not None else None
        _root = etree.fromstring(svg_str.encode())
        _zone_ids = {
            eid
            for el in _root.iter()
            if (eid := el.get("id")) is not None and eid.startswith("zone-")
        }
        _default_zone = resolve_default_zone(_root, _zone_ids)
        result = build_slide_content(
            md_text,
            slide.zones,
            available_zones=_zone_ids,
            default_zone=_default_zone,
        )
        if result.content:
            svg_str = substitute_content(
                svg_str, result.content, font_size, mode == ColorMode.DARK
            )

    if slide.animations:
        svg_str = annotate_svg(svg_str, slide.animations)
    slide_style_css = load_style(slide.extra_style, project_dir)
    combined_css = "\n".join(filter(None, [deck_style, slide_style_css]))
    if combined_css:
        svg_str = inject_style(svg_str, combined_css)
    svg_str = remove_unreferenced_zones(svg_str)
    svg_str = _scope_slide_styles(svg_str, slide_number)
    return svg_str


def process_deck(deck: Deck, project_dir: Path) -> list[SlideData]:
    visible_slides = [s for s in deck.slides if s.visible]
    total = len(visible_slides)
    deck_style_css = load_style(deck.style, project_dir)
    raw_ids = [_infer_slide_id(s) for s in visible_slides]
    slide_ids = _deduplicate_ids(raw_ids)
    results: list[SlideData] = []
    for i, (slide, slide_id) in enumerate(zip(visible_slides, slide_ids, strict=True)):
        title = _infer_slide_title(slide, slide_id, project_dir)
        explicit_notes = load_notes(slide.notes, project_dir)
        md_notes = ""
        if slide.md is not None:
            md_text = load_md(slide.md, project_dir)
            md_notes = build_slide_content(md_text, slide.zones).notes
        notes = "\n".join(filter(None, [explicit_notes, md_notes]))
        svg = process_slide(
            slide,
            project_dir,
            deck.theme,
            i + 1,
            total,
            deck_style_css,
            slide.font_size if slide.font_size is not None else deck.font_size,
            mode=deck.mode,
        )

        results.append({"id": slide_id, "svg": svg, "title": title, "notes": notes})
    return results
