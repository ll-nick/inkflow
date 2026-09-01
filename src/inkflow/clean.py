from __future__ import annotations

from pathlib import Path

from lxml import etree

from inkflow import ns
from inkflow.svgio import SvgElement, parse_svg_file

_INKSCAPE_NAMESPACES: frozenset[str] = frozenset({ns.INKSCAPE, ns.SODIPODI})

# These attributes carry structural meaning (layer identity and lock state) and
# survive the clean pass so Inkscape keeps recognising layers correctly.
_PRESERVE_ATTRS: frozenset[str] = frozenset(
    {
        f"{{{ns.INKSCAPE}}}groupmode",
        ns.INKSCAPE_LABEL,
        f"{{{ns.SODIPODI}}}insensitive",
    }
)


def is_preview_layer(el: SvgElement) -> bool:
    """True for a <g> injected by inject_preview_layers, either layer class."""
    return (
        el.get(ns.INKFLOW_LAYOUT_SRC) is not None
        or el.get(ns.INKFLOW_OVERLAY_SRC) is not None
    )


def strip_preview_layers(root: SvgElement) -> None:
    """Remove direct-child <g> elements injected by inject_preview_layers."""
    for el in [el for el in root if is_preview_layer(el)]:
        root.remove(el)


def clean_inkscape_tree(src: Path, keep_preview: bool = False) -> SvgElement:
    """Parse an SVG file, strip Inkscape/Sodipodi editor metadata, return the root.

    When keep_preview is False (default), also removes inkflow preview content
    (injected layout/overlay layers and the inkflow-preview style block) so the tree is
    suitable for the presentation pipeline.  Pass keep_preview=True to preserve
    that content for Inkscape editing (used by the clean CLI and pre-commit hook).
    """
    root = parse_svg_file(src)

    # Before the namespace cleanup, not after: the injected layers are the only
    # users of the inkscape/sodipodi prefixes in an otherwise clean file, so
    # dropping them afterwards would leave the declarations stranded on the root
    # and make the cleaned output of a synced file differ from an unsynced one.
    # Layer hashes are taken from exactly this output, so that difference would
    # report every file whose ancestor or overlay has been synced as stale.
    if not keep_preview:
        strip_preview_layers(root)
        for el in root.findall(f'.//{{{ns.SVG}}}style[@id="inkflow-preview"]'):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
                # The <defs> may exist only to hold that style, and an empty one
                # left behind would be the same stale-forever hash difference.
                if parent.tag == f"{{{ns.SVG}}}defs" and len(parent) == 0:
                    grandparent = parent.getparent()
                    if grandparent is not None:
                        grandparent.remove(parent)

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

    return root


def _protect_text_whitespace(root: SvgElement) -> None:
    """Stop pretty-printing from injecting whitespace into <text>/<tspan> runs.

    lxml's pretty_print inserts newline+indent text/tail nodes wherever it finds
    None, unaware that Inkscape always sets xml:space="preserve" on the document,
    which makes that inserted whitespace render as literal glyph-width gaps (e.g.
    between adjacent tspans coloured separately). Pinning every text/tail in a
    <text> subtree to "" (rather than None) tells lxml content is already present,
    so it leaves the subtree untouched.
    """
    for text_el in root.iter(f"{{{ns.SVG}}}text"):
        text_el.text = text_el.text if text_el.text is not None else ""
        for el in text_el.iter():
            if el is text_el:
                continue
            el.text = el.text if el.text is not None else ""
            el.tail = el.tail if el.tail is not None else ""


def clean_inkscape_svg(src: Path, keep_preview: bool = False) -> str:
    """Cleaned SVG as a pretty-printed string. See ``clean_inkscape_tree``."""
    root = clean_inkscape_tree(src, keep_preview)
    _protect_text_whitespace(root)
    return etree.tostring(root, encoding="unicode", pretty_print=True)
