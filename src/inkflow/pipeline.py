from __future__ import annotations

from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.content import (
    DEFAULT_ZONE_CSS,
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
)
from inkflow.layout import resolve_chain, strip_layout_layers
from inkflow.manifest import (
    Animation,
    Bounce,
    Deck,
    FadeIn,
    FadeOut,
    MarkdownSlide,
    Slide,
    Transition,
)

_ANIM_CLASS: dict[type, str] = {
    FadeIn: "anim-fade-in",
    FadeOut: "anim-fade-out",
    Bounce: "anim-bounce",
}

_INKSCAPE_NAMESPACES: frozenset[str] = frozenset({ns.INKSCAPE, ns.SODIPODI})


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
            and any(k.startswith(f"{{{ns_uri}}}") for ns_uri in _INKSCAPE_NAMESPACES)
        ]
        for k in to_del:
            del el.attrib[k]

    etree.cleanup_namespaces(root)
    return etree.tostring(root, encoding="unicode", pretty_print=True)


def annotate_svg(svg_str: str, animations: list[Animation]) -> str:
    root = etree.fromstring(svg_str.encode())

    for anim in animations:
        css_class = _ANIM_CLASS.get(type(anim))
        if css_class is None:
            continue

        eid = anim.element.lstrip("#")
        el = root.find(f'.//*[@id="{eid}"]')
        if el is None:
            print(f"[inkflow] warning: element #{eid} not found in SVG")
            continue

        existing = el.get("class", "")
        el.set("class", f"{existing} {css_class}".strip())
        el.set("data-step", str(anim.step))

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


def _expand_markdown_slide(ms: MarkdownSlide, project_dir: Path) -> Slide:
    from inkflow.markdown import expand_markdown_slide

    content = expand_markdown_slide(ms, project_dir)
    return Slide(
        src=ms.layout,
        animations=ms.animations,
        content=content,
        transition=ms.transition,
        style=ms.style,
    )


def process_slide(
    slide: Slide,
    project_dir: Path,
    themes: dict[str, str],
    slide_number: int,
    total_slides: int,
    deck_style: str = "",
    font_size: int = 36,
) -> str:
    src = project_dir / slide.src
    svg_str = clean_inkscape_svg(src)
    chain = resolve_chain(src, project_dir, themes)
    if chain:
        svg_str = compose_with_ancestors(svg_str, chain)
    svg_str = substitute_zone_numbers(svg_str, slide_number, total_slides)
    if slide.content:
        svg_str = substitute_content(svg_str, slide.content, project_dir, font_size)
    if slide.animations:
        svg_str = annotate_svg(svg_str, slide.animations)
    combined_css = "\n".join(filter(None, [DEFAULT_ZONE_CSS, deck_style, slide.style]))
    svg_str = inject_style(svg_str, combined_css)
    svg_str = remove_unreferenced_zones(svg_str)
    return svg_str


def process_deck(deck: Deck, project_dir: Path) -> list[str]:
    total = len(deck.slides)
    results: list[str] = []
    for i, entry in enumerate(deck.slides):
        if isinstance(entry, MarkdownSlide):
            slide = _expand_markdown_slide(entry, project_dir)
        else:
            slide = entry
        results.append(
            process_slide(
                slide,
                project_dir,
                deck.themes,
                i + 1,
                total,
                deck.style,
                deck.font_size,
            )
        )
    return results
