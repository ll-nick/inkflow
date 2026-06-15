"""Low-level SVG tree utilities shared across the inkflow pipeline."""

from __future__ import annotations

from pathlib import Path
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.clean import clean_inkscape_svg, strip_layout_layers


def ensure_defs(
    root: etree._Element,  # pyright: ignore[reportPrivateUsage]
) -> etree._Element:  # pyright: ignore[reportPrivateUsage]
    """Return the ``<defs>`` child of root, creating and prepending it if absent."""
    defs = root.find(f"{{{ns.SVG}}}defs")
    if defs is None:
        defs = etree.Element(f"{{{ns.SVG}}}defs")
        root.insert(0, defs)
    return defs


def with_namespaces(
    root: etree._Element,  # pyright: ignore[reportPrivateUsage]
    additions: dict[str, str],
) -> etree._Element:  # pyright: ignore[reportPrivateUsage]
    """Return root with extra namespace prefixes declared.

    lxml nsmap is immutable after construction, so adding prefixes requires
    rebuilding the root element with an extended nsmap.
    """
    missing = {k: v for k, v in additions.items() if k not in root.nsmap}
    if not missing:
        return root
    new_root = etree.Element(
        root.tag,
        attrib=cast("dict[str, str]", dict(root.attrib)),
        nsmap=cast("dict[str, str]", {**root.nsmap, **missing}),
    )
    for child in root:
        new_root.append(child)
    return new_root


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
