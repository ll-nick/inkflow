"""Low-level SVG tree utilities shared across the inkflow pipeline."""

from __future__ import annotations

import re
from collections import Counter
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.clean import strip_preview_layers
from inkflow.sizes import parse_view_box
from inkflow.svgio import SvgElement


def canvas_size(root: SvgElement) -> tuple[float, float] | None:
    """An SVG root's drawing size in user units: its viewBox's width and
    height, else its plain ``width``/``height``; ``None`` when it has neither."""
    box = parse_view_box(root.get("viewBox"))
    if box is not None:
        return box[2], box[3]
    try:
        w = float(re.sub(r"px$", "", (root.get("width") or "").strip()))
        h = float(re.sub(r"px$", "", (root.get("height") or "").strip()))
    except ValueError:
        return None
    return (w, h) if w > 0 and h > 0 else None


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


def _split_groups(
    roots: list[SvgElement],
) -> tuple[list[SvgElement], list[SvgElement]]:
    """Return (content groups, defs children) for a root-first list of SVG trees.

    One ``<g>`` per tree, in the order given, so the caller only has to decide where
    the groups land relative to the slide's own content.

    Takes parsed trees rather than paths because the merge destroys provenance: a
    tree's own directory is only meaningful before this point, so whoever reads the
    file is also who resolves anything written relative to it.
    """
    groups: list[SvgElement] = []
    merged_defs: list[SvgElement] = []

    for root in roots:
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


def compose_with_ancestors(
    slide_root: SvgElement, ancestors: list[SvgElement]
) -> SvgElement:
    """Prepend ancestor SVG content below the slide's own, mutating slide_root.

    ``ancestors`` is the resolved chain, root-first, already parsed by the caller.
    """
    strip_preview_layers(slide_root)

    ancestor_groups, merged_defs = _split_groups(ancestors)

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
    slide_root: SvgElement, overlay_stacks: list[list[SvgElement]]
) -> SvgElement:
    """Append overlay content on top of the slide's own, mutating slide_root.

    Each entry of ``overlay_stacks`` is one overlay as a root-first list of parsed
    trees, ``[*ancestors, overlay]``. An overlay's own ancestors paint behind it
    inside the overlay's own stack, while every overlay still lands above the whole
    slide.

    Overlay ``<defs>`` are appended after the slide's, so a slide's own definition
    wins an id collision. Overlays are decoration and must not shadow the slide.
    """
    all_groups: list[SvgElement] = []
    all_defs: list[SvgElement] = []
    for stack in overlay_stacks:
        groups, defs = _split_groups(stack)
        all_groups.extend(groups)
        all_defs.extend(defs)

    if all_defs:
        slide_defs = _slide_defs(slide_root)
        slide_defs.extend(all_defs)

    slide_root.extend(all_groups)
    return slide_root


_XLINK_HREF = f"{{{ns.XLINK}}}href"


def resolve_links(root: SvgElement) -> SvgElement:
    """Make the slide's SVG links work in the presentation.

    ``slide:<id>`` (the Markdown link scheme) becomes ``data-inkflow-slide``, which
    the presenter follows; a web link opens in a new tab, so following it never
    navigates the presentation itself away.
    """
    for a in root.iter(f"{{{ns.SVG}}}a"):
        href = a.get("href") or a.get(_XLINK_HREF) or ""
        if href.startswith("slide:"):
            a.set("data-inkflow-slide", href[len("slide:") :])
            for name in ("href", _XLINK_HREF):
                if name in a.attrib:
                    del a.attrib[name]
        elif href.startswith(("http:", "https:", "mailto:")) and not a.get("target"):
            a.set("target", "_blank")
    return root


# ── Generic font families ─────────────────────────────────────────────────────

_GENERIC_FONT_TOKENS = {
    "sans-serif": "var(--inkflow-body-font)",
    "sans": "var(--inkflow-body-font)",
    "monospace": "var(--inkflow-mono-font)",
}
"""A generic family in a slide → the deck's own font. ``Sans`` is Inkscape's
(fontconfig's) name for the default sans."""

_STYLE_FONT_FAMILY_RE = re.compile(r"(?<![\w-])(font-family\s*:\s*)([^;]+)", re.I)


def _themed_family_list(value: str) -> str:
    parts = [p.strip() for p in value.split(",")]
    themed = [_GENERIC_FONT_TOKENS.get(p.strip("'\"").lower(), p) for p in parts]
    if themed == parts:
        return value
    return ", ".join(themed)


def theme_generic_fonts(root: SvgElement) -> SvgElement:
    """Point ``font-family: sans-serif`` (or ``monospace``) in an inline
    ``style`` at the deck's fonts.

    A generic family is whatever sans the computer showing the slide has
    (DejaVu, Helvetica, Arial…), so the same slide would look different on
    every machine; the deck's body and code fonts are embedded and the same
    everywhere. Inkscape writes its default text this way. The attribute form
    (``font-family="sans-serif"``, as in the built-in layouts) is mapped by
    contract.css instead, which keeps it below any stylesheet rule as an
    attribute is; an inline style is already above them, so rewriting it in
    place changes nothing but the family. The files on disk are untouched.
    """
    for el in root.iter():
        style = el.get("style")
        if not style or "font-family" not in style:
            continue
        themed = _STYLE_FONT_FAMILY_RE.sub(
            lambda m: m.group(1) + _themed_family_list(m.group(2)), style
        )
        if themed != style:
            el.set("style", themed)
    return root
