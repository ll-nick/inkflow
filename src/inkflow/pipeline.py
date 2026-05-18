from __future__ import annotations

from pathlib import Path

from lxml import etree

from inkflow.manifest import Animation, Bounce, Deck, FadeIn, FadeOut, Morph, Slide

_ANIM_CLASS: dict[type, str] = {
    FadeIn: "anim-fade-in",
    FadeOut: "anim-fade-out",
    Bounce: "anim-bounce",
}

_INKSCAPE_NAMESPACES: frozenset[str] = frozenset(
    {
        "http://www.inkscape.org/namespaces/inkscape",
        "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
    }
)


def clean_inkscape_svg(src: Path) -> str:
    tree = etree.parse(src)
    root = tree.getroot()

    for ns in _INKSCAPE_NAMESPACES:
        for el in root.findall(f".//{{{ns}}}*"):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

    for el in root.iter():
        to_del = [
            k
            for k in el.attrib
            if isinstance(k, str)
            and any(k.startswith(f"{{{ns}}}") for ns in _INKSCAPE_NAMESPACES)
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
            if isinstance(anim, Morph):
                eid = anim.element.lstrip("#")
                print(f"[inkflow] warning: Morph is not yet implemented (#{eid})")
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


def process_slide(slide: Slide, project_dir: Path) -> str:
    src = project_dir / slide.src
    svg_str = clean_inkscape_svg(src)
    if slide.animations:
        svg_str = annotate_svg(svg_str, slide.animations)
    return svg_str


def process_deck(deck: Deck, project_dir: Path) -> list[str]:
    return [process_slide(slide, project_dir) for slide in deck.slides]
