from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

from lxml import etree

from inkflow import ns
from inkflow.content import (
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
)
from inkflow.layout import resolve_chain, resolve_parent_path, strip_layout_layers
from inkflow.manifest import (
    Animation,
    Deck,
    MarkdownSlide,
    Slide,
    Transition,
)
from inkflow.markdown import markdown_to_html

# ── Slide wire format ────────────────────────────────────────────────────────


class SlideData(TypedDict):
    svg: str
    title: str
    notes: str


@dataclass
class _ResolvedMarkdown:
    slide: Slide
    notes: str


# ── Path conventions ─────────────────────────────────────────────────────────


def _infer_slide_title(src: str) -> str:
    stem = Path(src).stem
    stem = re.sub(r"^\d+-", "", stem)
    return stem.replace("-", " ").replace("_", " ").title()


def _infer_md_title(entry: MarkdownSlide, slide_num: int, project_dir: Path) -> str:
    if entry.title:
        return entry.title
    if entry.content is not None:
        from inkflow.markdown import parse_markdown_zones

        content_path = _resolve_content_src(entry.content, project_dir)
        zones = parse_markdown_zones(content_path)
        chunks = zones.get("title", [])
        if chunks:
            return chunks[0].lstrip("#").strip()
    return f"Slide {slide_num}"


def _resolve_notes(notes: str | Path | None, project_dir: Path) -> str:
    if notes is None:
        return ""
    if isinstance(notes, Path):
        resolved = notes if notes.is_absolute() else project_dir / notes
        text = resolved.read_text(encoding="utf-8")
        return markdown_to_html(text) if resolved.suffix == ".md" else text
    return markdown_to_html(notes)


def resolve_slide_src(src: str, project_dir: Path) -> Path:
    """Resolve a Slide.src string to an absolute Path.

    Bare single-part names (no separator) are looked up in slides/.
    Explicit paths (with / or absolute) are resolved relative to project_dir.
    """
    p = Path(src)
    if p.is_absolute():
        return p if p.suffix else p.with_suffix(".svg")
    if len(p.parts) == 1:
        name = p.stem if p.suffix else src
        return project_dir / "slides" / (name + ".svg")
    if not p.suffix:
        p = p.with_suffix(".svg")
    return (project_dir / p).resolve()


def _resolve_content_src(src: str, project_dir: Path) -> Path:
    """Resolve a MarkdownSlide content path to an absolute Path.

    Bare single-part names are looked up in slides/ with a .md suffix.
    """
    p = Path(src)
    if p.is_absolute():
        return p if p.suffix else p.with_suffix(".md")
    if len(p.parts) == 1:
        name = p.stem if p.suffix else src
        return project_dir / "slides" / (name + ".md")
    if not p.suffix:
        p = p.with_suffix(".md")
    return (project_dir / p).resolve()


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


_INKSCAPE_NAMESPACES: frozenset[str] = frozenset({ns.INKSCAPE, ns.SODIPODI})

# These attributes carry structural meaning (layer identity and lock state) and
# survive the clean pass so Inkscape keeps recognising layers correctly.
_PRESERVE_ATTRS: frozenset[str] = frozenset(
    {
        f"{{{ns.INKSCAPE}}}groupmode",
        f"{{{ns.INKSCAPE}}}label",
        f"{{{ns.SODIPODI}}}insensitive",
    }
)


def clean_inkscape_svg(src: Path) -> str:
    tree = etree.parse(src)
    root = tree.getroot()

    for ns_uri in _INKSCAPE_NAMESPACES:
        for el in root.findall(f".//{{{ns_uri}}}*"):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

    for el in root.iter():
        to_del = [
            k
            for k in el.attrib
            if isinstance(k, str)
            and k not in _PRESERVE_ATTRS
            and any(k.startswith(f"{{{ns_uri}}}") for ns_uri in _INKSCAPE_NAMESPACES)
        ]
        for k in to_del:
            del el.attrib[k]

    etree.cleanup_namespaces(root)
    return etree.tostring(root, encoding="unicode", pretty_print=True)


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
    return {"type": type(t).__name__.lower(), **vars(t)}


def resolve_transitions(deck: Deck) -> list[dict[str, object]]:
    return [
        _serialize_transition(
            slide.transition if slide.transition is not None else deck.transition
        )
        for slide in deck.slides
    ]


def compose_with_ancestors(svg_str: str, chain: list[Path]) -> str:
    """Prepend ancestor SVG content below the slide's own content."""
    slide_root = etree.fromstring(svg_str.encode())
    strip_layout_layers(slide_root)

    ancestor_groups: list[etree._Element] = []  # pyright: ignore[reportPrivateUsage]
    merged_defs: list[etree._Element] = []  # pyright: ignore[reportPrivateUsage]

    for ancestor_path in chain:
        anc_str = clean_inkscape_svg(ancestor_path)
        anc_root = etree.fromstring(anc_str.encode())
        strip_layout_layers(anc_root)

        for defs_el in anc_root.findall(f"{{{ns.SVG}}}defs"):
            merged_defs.extend(list(defs_el))

        children = [el for el in anc_root if el.tag != f"{{{ns.SVG}}}defs"]
        if children:
            g = etree.Element(f"{{{ns.SVG}}}g")
            for child in children:
                g.append(child)
            ancestor_groups.append(g)

    if merged_defs:
        slide_defs = slide_root.find(f"{{{ns.SVG}}}defs")
        if slide_defs is None:
            slide_defs = etree.Element(f"{{{ns.SVG}}}defs")
            slide_root.insert(0, slide_defs)
        for i, def_el in enumerate(merged_defs):
            slide_defs.insert(i, def_el)

    insert_pos = next(
        (i + 1 for i, el in enumerate(slide_root) if el.tag == f"{{{ns.SVG}}}defs"),
        0,
    )
    for i, group in enumerate(ancestor_groups):
        slide_root.insert(insert_pos + i, group)

    return etree.tostring(slide_root, encoding="unicode")


def _resolve_markdown_slide(
    ms: MarkdownSlide, project_dir: Path, theme: str | None
) -> _ResolvedMarkdown:
    from inkflow.markdown import build_slide_content

    # Use project_dir as the synthetic svg_path parent so multi-part relative
    # paths in the template string resolve relative to the project root.
    template_path = resolve_parent_path(
        ms.template, project_dir / "_", project_dir, theme
    )
    content_path = (
        _resolve_content_src(ms.content, project_dir)
        if ms.content is not None
        else None
    )
    result = build_slide_content(content_path, ms.steps, ms.extra)
    explicit_notes = _resolve_notes(ms.notes, project_dir)
    notes_html = "\n".join(filter(None, [explicit_notes, result.notes]))
    return _ResolvedMarkdown(
        slide=Slide(
            src=str(template_path),
            animations=ms.animations,
            content=result.content,
            transition=ms.transition,
            style=ms.style,
        ),
        notes=notes_html,
    )


def process_slide(
    slide: Slide,
    project_dir: Path,
    theme: str | None,
    slide_number: int,
    total_slides: int,
    deck_style: str = "",
    font_size: int = 36,
) -> str:
    src = resolve_slide_src(slide.src, project_dir)
    svg_str = clean_inkscape_svg(src)
    chain = resolve_chain(src, project_dir, theme)
    if chain:
        svg_str = compose_with_ancestors(svg_str, chain)
    svg_str = substitute_zone_numbers(svg_str, slide_number, total_slides)
    if slide.content:
        svg_str = substitute_content(svg_str, slide.content, project_dir, font_size)
    if slide.animations:
        svg_str = annotate_svg(svg_str, slide.animations)
    combined_css = "\n".join(filter(None, [deck_style, slide.style]))
    if combined_css:
        svg_str = inject_style(svg_str, combined_css)
    svg_str = remove_unreferenced_zones(svg_str)
    return svg_str


def process_deck(deck: Deck, project_dir: Path) -> list[SlideData]:
    total = len(deck.slides)
    results: list[SlideData] = []
    for i, entry in enumerate(deck.slides):
        if isinstance(entry, MarkdownSlide):
            title = _infer_md_title(entry, i + 1, project_dir)
            resolved = _resolve_markdown_slide(entry, project_dir, deck.theme)
            slide, notes = resolved.slide, resolved.notes
        else:
            title = entry.title or _infer_slide_title(entry.src)
            slide = entry
            notes = _resolve_notes(entry.notes, project_dir)
        svg = process_slide(
            slide,
            project_dir,
            deck.theme,
            i + 1,
            total,
            deck.style,
            deck.font_size,
        )
        results.append({"svg": svg, "title": title, "notes": notes})
    return results
