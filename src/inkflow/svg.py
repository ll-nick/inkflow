"""Low-level SVG tree utilities shared across the inkflow pipeline."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.clean import clean_inkscape_tree, strip_layout_layers
from inkflow.svgio import SvgElement


def ensure_defs(root: SvgElement) -> SvgElement:
    """Return the ``<defs>`` child of root, creating and prepending it if absent."""
    defs = root.find(f"{{{ns.SVG}}}defs")
    if defs is None:
        defs = etree.Element(f"{{{ns.SVG}}}defs")
        root.insert(0, defs)
    return defs


def with_namespaces(
    root: SvgElement,
    additions: dict[str, str],
) -> SvgElement:
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


def duplicate_zone_ids(root: SvgElement) -> list[str]:
    """Zone ids declared more than once, e.g. by both a layout and an overlay.

    Always a mistake, but it fails two different ways: `substitute_content` binds
    the first match only, so the extra content zone is inert and then pruned, while
    `substitute_zone_numbers` fills every match, so a duplicated slide number is
    drawn twice.
    """
    counts = Counter(
        eid
        for el in root.iter()
        if (eid := el.get("id")) is not None and eid.startswith("zone-")
    )
    return sorted(z for z, n in counts.items() if n > 1)


def is_full_canvas_fill(root: SvgElement) -> bool:
    """Whether the tree paints an opaque rect covering the whole canvas.

    An overlay that does this hides the entire deck, and the cause (usually an
    `inkflow:parent` pointing at a layout rather than another overlay) is two files
    away from the symptom.
    """
    width, height = root.get("width", ""), root.get("height", "")
    view_box = (root.get("viewBox") or "").split()
    if len(view_box) == 4:
        width, height = view_box[2], view_box[3]
    if not width or not height:
        return False

    for el in root.iter(f"{{{ns.SVG}}}rect"):
        if float(el.get("x", "0")) != 0 or float(el.get("y", "0")) != 0:
            continue
        if el.get("width") != width or el.get("height") != height:
            continue
        if (el.get("fill") or "").lower() == "none":
            continue
        opacities = (el.get("opacity"), el.get("fill-opacity"))
        if any(o is not None and float(o) < 1 for o in opacities):
            continue
        return True
    return False


def _read_groups(paths: list[Path]) -> tuple[list[SvgElement], list[SvgElement]]:
    """Return (content groups, defs children) for a root-first list of SVG paths.

    One ``<g>`` per file, in the order given, so the caller only has to decide where
    the groups land relative to the slide's own content.
    """
    groups: list[SvgElement] = []
    merged_defs: list[SvgElement] = []

    for path in paths:
        root = clean_inkscape_tree(path)

        for defs_el in root.findall(f"{{{ns.SVG}}}defs"):
            merged_defs.extend(list(defs_el))

        children = [el for el in root if el.tag != f"{{{ns.SVG}}}defs"]
        if children:
            g = etree.Element(f"{{{ns.SVG}}}g")
            for child in children:
                g.append(child)
            groups.append(g)

    return groups, merged_defs


def _slide_defs(slide_root: SvgElement) -> SvgElement:
    defs = slide_root.find(f"{{{ns.SVG}}}defs")
    if defs is None:
        defs = etree.Element(f"{{{ns.SVG}}}defs")
        slide_root.insert(0, defs)
    return defs


def compose_with_ancestors(slide_root: SvgElement, chain: list[Path]) -> SvgElement:
    """Prepend ancestor SVG content below the slide's own, mutating slide_root."""
    strip_layout_layers(slide_root)

    ancestor_groups, merged_defs = _read_groups(chain)

    if merged_defs:
        slide_defs = _slide_defs(slide_root)
        for i, def_el in enumerate(merged_defs):
            slide_defs.insert(i, def_el)

    insert_pos = next(
        (i + 1 for i, el in enumerate(slide_root) if el.tag == f"{{{ns.SVG}}}defs"),
        0,
    )
    for i, group in enumerate(ancestor_groups):
        slide_root.insert(insert_pos + i, group)

    return slide_root


def compose_overlays(
    slide_root: SvgElement, overlay_chains: list[list[Path]]
) -> SvgElement:
    """Append overlay content on top of the slide's own, mutating slide_root.

    Each entry of ``overlay_chains`` is one overlay as a root-first path list,
    ``[*ancestors, overlay]``. An overlay's own ancestors paint behind it inside the
    overlay's own stack, while every overlay still lands above the whole slide.

    Overlay ``<defs>`` are appended after the slide's, so a slide's own definition
    wins an id collision. Overlays are decoration and must not shadow the slide.
    """
    all_groups: list[SvgElement] = []
    all_defs: list[SvgElement] = []
    for chain in overlay_chains:
        groups, defs = _read_groups(chain)
        all_groups.extend(groups)
        all_defs.extend(defs)

    if all_defs:
        slide_defs = _slide_defs(slide_root)
        slide_defs.extend(all_defs)

    slide_root.extend(all_groups)
    return slide_root
