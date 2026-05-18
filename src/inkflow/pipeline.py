from __future__ import annotations

from pathlib import Path

from lxml import etree

from inkflow.manifest import Bounce, Fade, FadeOut, Slide

_ANIM_CLASS: dict[type, str] = {
    Fade: "anim-fade-in",
    FadeOut: "anim-fade-out",
    Bounce: "anim-bounce",
}

# Namespaces added by Inkscape that should be stripped from SVG output
_INKSCAPE_NAMESPACES = frozenset([
    "http://www.inkscape.org/namespaces/inkscape",
    "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
])


def clean_inkscape_svg(src: Path) -> str:
    """Read an SVG and return a clean string with Inkscape/Sodipodi metadata removed."""
    tree = etree.parse(src)
    root = tree.getroot()

    # Remove elements that belong to Inkscape/Sodipodi namespaces
    for ns in _INKSCAPE_NAMESPACES:
        for el in root.findall(f'.//{{{ns}}}*'):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

    # Remove namespace-prefixed attributes (e.g. inkscape:version, sodipodi:docname)
    for el in root.iter():
        to_del = [
            k for k in el.attrib
            if any(k.startswith(f'{{{ns}}}') for ns in _INKSCAPE_NAMESPACES)
        ]
        for k in to_del:
            del el.attrib[k]

    etree.cleanup_namespaces(root)
    return etree.tostring(root, encoding="unicode", pretty_print=True)


def annotate_svg(svg_str: str, animations: list) -> str:
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


def process_slide(slide: Slide, project_dir: Path, out_dir: Path) -> str:
    src = project_dir / slide.src
    svg_str = clean_inkscape_svg(src)
    if slide.animations:
        svg_str = annotate_svg(svg_str, slide.animations)
    return svg_str


def process_deck(deck, project_dir: Path, out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    return [process_slide(s, project_dir, out_dir) for s in deck.slides]
