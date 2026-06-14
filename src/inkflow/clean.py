from __future__ import annotations

from pathlib import Path

from lxml import etree

from inkflow import ns

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


def strip_layout_layers(root: etree._Element) -> None:  # pyright: ignore[reportPrivateUsage]
    """Remove direct-child <g> elements injected by inject_layout_layers."""
    to_remove = [el for el in root if el.get(ns.INKFLOW_LAYOUT_SRC) is not None]
    for el in to_remove:
        root.remove(el)


def clean_inkscape_svg(src: Path, keep_preview: bool = False) -> str:
    """Strip Inkscape/Sodipodi editor metadata from an SVG file.

    When keep_preview is False (default), also removes inkflow preview content
    (injected layout layers and the inkflow-preview style block) so the output
    is suitable for the presentation pipeline.  Pass keep_preview=True to
    preserve that content for Inkscape editing (used by the clean CLI command
    and the pre-commit hook).
    """
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

    if not keep_preview:
        strip_layout_layers(root)
        for el in root.findall(f'.//{{{ns.SVG}}}style[@id="inkflow-preview"]'):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

    return etree.tostring(root, encoding="unicode", pretty_print=True)
