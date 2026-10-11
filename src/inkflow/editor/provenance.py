"""Source locators stamped on the composed slide SVG, and their inverse.

A rendered slide is a composition: the slide's own SVG, its layout chain and its
overlays merged into one tree, cleaned of editor metadata. To write an edit back,
the editor has to know which file an element came from and where in that file it
sits. Every element read from a source file is stamped with

    data-ink="<source index>:<child path>"

where the source index points into the slide's own ``sources`` list and the child
path is the chain of child indices from the file's root, counted on the tree
*as parsed from disk* (before cleaning removes anything). ``locate`` walks the same
path in a freshly parsed copy, so a locator stays valid until the file's structure
changes, which the file hash in the editor model guards.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import cast

from inkflow import ns
from inkflow.svgio import SvgElement

INK = "data-ink"
"""``<source index>:<child path>`` on every element read from a source file."""
INK_TOP = "data-ink-top"
"""Marks a selectable object: an element directly under the root or a layer."""
INK_LAYER = "data-ink-layer"
"""Marks an Inkscape layer group (selection passes through it)."""
INK_LOCKED = "data-ink-locked"
"""Marks a locked layer or object (``inkflow:locked``, or a layer Inkscape has
locked); it and everything in it is not selectable."""

INK_TAG = "data-ink-tag"
"""On an element that replaced another (a filled zone): the source element's tag,
so the editor knows whether ``x``/``y``/``width``/``height`` exist in the file."""

PROVENANCE_ATTRS = (INK, INK_TOP, INK_LAYER, INK_LOCKED, INK_TAG)

_GROUPMODE = f"{{{ns.INKSCAPE}}}groupmode"
_INSENSITIVE = f"{{{ns.SODIPODI}}}insensitive"

# Elements that never paint anything themselves, so they are never objects.
_NON_GRAPHICAL = frozenset(
    f"{{{ns.SVG}}}{tag}"
    for tag in (
        "defs",
        "style",
        "metadata",
        "title",
        "desc",
        "script",
        "linearGradient",
        "radialGradient",
        "pattern",
        "clipPath",
        "mask",
        "marker",
        "symbol",
        "filter",
    )
)


def is_element(el: SvgElement) -> bool:
    """False for comments and processing instructions, whose ``tag`` is not a str."""
    return isinstance(cast("object", el.tag), str)


def is_layer(el: SvgElement) -> bool:
    return el.tag == f"{{{ns.SVG}}}g" and el.get(_GROUPMODE) == "layer"


def graphical_children(el: SvgElement) -> list[SvgElement]:
    return [c for c in el if is_element(c) and c.tag not in _NON_GRAPHICAL]


def is_link_wrapper(el: SvgElement) -> bool:
    """An ``<a>`` around exactly one object: the editor's link on that object.

    It is transparent to selection: the object inside is what gets selected,
    moved and styled, and the link is one of its properties.
    """
    return el.tag == f"{{{ns.SVG}}}a" and len(graphical_children(el)) == 1


def _at_object_level(el: SvgElement) -> bool:
    parent = el.getparent()
    return parent is not None and (parent.getparent() is None or is_layer(parent))


def child_path(el: SvgElement) -> str:
    """Dot-joined child indices from the root down to ``el`` ("" for the root)."""
    indices: list[str] = []
    node = el
    parent = node.getparent()
    while parent is not None:
        indices.append(str(parent.index(node)))
        node = parent
        parent = node.getparent()
    return ".".join(reversed(indices))


def _is_object(el: SvgElement) -> bool:
    parent = el.getparent()
    if parent is None or el.tag in _NON_GRAPHICAL or is_layer(el):
        return False
    if not is_element(el) or not el.tag.startswith(f"{{{ns.SVG}}}"):
        return False
    if is_link_wrapper(el):
        return False
    if is_link_wrapper(parent):
        return _at_object_level(parent)
    return _at_object_level(el)


def stamper(key: int) -> Callable[[SvgElement], None]:
    """A ``before_clean`` hook that stamps every element with source ``key``."""

    def stamp(root: SvgElement) -> None:
        # Paths are computed before any attribute is set, but setting attributes
        # never moves a node, so one pass is enough.
        for el in root.iter():
            if el is root or not is_element(el):
                continue
            el.set(INK, f"{key}:{child_path(el)}")
            if el.get(ns.INKFLOW_LOCKED) == "true":
                el.set(INK_LOCKED, "")
            if is_layer(el):
                el.set(INK_LAYER, "")
                if el.get(_INSENSITIVE) == "true":
                    el.set(INK_LOCKED, "")
            elif _is_object(el):
                parent = el.getparent()
                if parent is not None and parent.get(_INSENSITIVE) == "true":
                    continue
                el.set(INK_TOP, "")

    return stamp


def parse_locator(locator: str) -> tuple[int, str]:
    """Split ``"<key>:<path>"``; raises ``ValueError`` on a malformed locator."""
    key, sep, path = locator.partition(":")
    if not sep or not key.isdigit():
        raise ValueError(f"malformed locator: {locator!r}")
    if path and not all(part.isdigit() for part in path.split(".")):
        raise ValueError(f"malformed locator path: {locator!r}")
    return int(key), path


def locate(root: SvgElement, path: str) -> SvgElement:
    """The element at ``path`` under ``root``; raises ``LookupError`` when gone."""
    node = root
    if not path:
        return node
    for part in path.split("."):
        index = int(part)
        if index >= len(node):
            raise LookupError(f"no element at {path!r}")
        node = node[index]
    if not is_element(node):
        raise LookupError(f"no element at {path!r}")
    return node


def copy_provenance(source: SvgElement, target: SvgElement) -> None:
    """Carry the locator onto an element that replaces ``source`` (a filled zone)."""
    for attr in PROVENANCE_ATTRS:
        value = source.get(attr)
        if value is not None:
            target.set(attr, value)
    if source.get(INK) is not None and INK_TAG not in source.attrib:
        target.set(INK_TAG, str(source.tag).split("}")[-1])


def strip_provenance(root: SvgElement) -> None:
    for el in root.iter():
        if is_element(el):
            for attr in PROVENANCE_ATTRS:
                if attr in el.attrib:
                    del el.attrib[attr]
