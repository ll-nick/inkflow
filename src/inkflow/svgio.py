"""Low-level SVG (de)serialization primitives.

The single place inkflow parses and serializes SVG. Every parse routes through one
hardened parser config (no entity resolution, no network, no DTD loading, size guards
on) so author-supplied SVGs cannot trigger XXE/billion-laughs and a stray entity
reference degrades to an inert node instead of crashing the rebuild.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TypeAlias

from lxml import etree

# The lxml element type. Its leading underscore is lxml's Cython convention, not a
# private-API signal: there is no public ``Element`` *class* (``etree.Element`` is a
# factory function), and the lxml stubs annotate with ``_Element``. Aliasing it here
# gives us one name to use across the pipeline and one place to suppress the warning.
SvgElement: TypeAlias = etree._Element  # pyright: ignore[reportPrivateUsage]


def svg_parser() -> etree.XMLParser:
    """A hardened lxml parser.

    Constructed per call on purpose: lxml parsers are not thread-safe

    ``resolve_entities=False`` keeps a declared entity reference as an inert node (no
    expansion, no file/network read) rather than raising;
    ``no_network`` and ``load_dtd=False`` refuse remote/DTD fetches;
    ``huge_tree=False``keeps the size guards on.
    """
    return etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        huge_tree=False,
    )


def parse_svg(text: str | bytes) -> SvgElement:
    """Parse an SVG string/bytes into its root element with the hardened parser."""
    data = text.encode() if isinstance(text, str) else text
    return etree.fromstring(data, parser=svg_parser())


def parse_svg_file(path: Path) -> SvgElement:
    """Parse an SVG file into its root element with the hardened parser.

    A malformed file raises ``ValueError`` naming the path, so callers surface a clean
    message instead of a bare ``XMLSyntaxError`` traceback.
    """
    try:
        return etree.parse(os.fspath(path), svg_parser()).getroot()
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"invalid SVG {path}: {exc}") from exc


def serialize_svg(root: SvgElement) -> str:
    """Serialize an element tree back to an SVG string."""
    return etree.tostring(root, encoding="unicode")
