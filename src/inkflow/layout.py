from __future__ import annotations

import hashlib
import importlib.resources
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

from lxml import etree

from inkflow import ns
from inkflow.clean import (
    clean_inkscape_tree,
    is_preview_layer,
    strip_preview_layers,
)
from inkflow.ns import (
    INKFLOW_DEFAULT_ZONE,
    INKFLOW_LAYOUT_HASH,
    INKFLOW_LAYOUT_SRC,
    INKFLOW_OVERLAY_HASH,
    INKFLOW_OVERLAY_SRC,
    INKFLOW_PARENT,
)
from inkflow.svg import compose_with_ancestors, ensure_defs, with_namespaces
from inkflow.svgio import SvgElement, parse_svg_file

if TYPE_CHECKING:
    from inkflow.themes import Theme

# ── Zone routing constants ────────────────────────────────────────────────────

_FIXED_ROUTING_ZONES: frozenset[str] = frozenset(
    {"zone-slide-number", "zone-slide-total", "zone-title", "zone-subtitle"}
)


# ── Asset kinds ───────────────────────────────────────────────────────────────


class AssetKind(StrEnum):
    """A composable SVG asset kind, and the directory it is searched in.

    Layouts and overlays share one resolution grammar but live in separate
    namespaces, so a bare name always means one or the other and never both.
    """

    LAYOUT = "layouts"
    OVERLAY = "overlays"

    @property
    def singular(self) -> str:
        """The kind as a singular noun, for user-facing messages."""
        return self.value.removesuffix("s")


# ── Built-in theme ───────────────────────────────────────────────────────────


def builtin_theme_dir() -> Path:
    return Path(str(importlib.resources.files("inkflow").joinpath("theme")))


# ── Parent attribute ──────────────────────────────────────────────────────────


def _read_parent_attr(svg_path: Path) -> str | None:
    return parse_svg_file(svg_path).get(INKFLOW_PARENT)


# ── Path resolution ───────────────────────────────────────────────────────────


def resolve_parent_path(
    parent_str: str,
    base_dir: Path,
    project_root: Path | None,
    theme: Theme | None,
    kind: AssetKind = AssetKind.LAYOUT,
) -> Path:
    """Resolve an inkflow:parent string to an absolute Path.

    ``kind`` selects the searched subdirectory, so overlays get the identical
    grammar against ``overlays/`` instead of ``layouts/``. Keeping the namespaces
    separate is what makes a bare name on an overlay fail loudly rather than
    silently resolving to a layout, whose full-bleed background would paint over
    the whole slide.

    Prefix syntaxes (bypass the search), shown for the layout kind:
      local:foo      →  {project_root}/layouts/foo.svg   (requires project_root)
      theme:foo      →  {theme_dir}/layouts/foo.svg      (requires theme)
      builtin:foo    →  {builtin_theme_dir}/layouts/foo.svg
      ./foo, ../foo  →  relative to base_dir
      /absolute      →  literal filesystem path (OS-native: also ``C:\\...``,
                         ``C:/...``, ``\\\\server\\share\\...`` on Windows)

    Bare single-part name (no prefix, no separator):
      Three-level search: project → theme → built-in.
      Levels are skipped when project_root or theme is None.
    Multi-part relative path (has /, no prefix):
      Relative to base_dir.
    """

    def _with_svg(p: Path) -> Path:
        return p if p.suffix else p.with_suffix(".svg")

    if parent_str.startswith("local:"):
        name = parent_str[len("local:") :]
        if project_root is None:
            raise ValueError(
                f"local:{name} requires a project root. "
                + "Use --deck to point to a project."
            )
        resolved = _with_svg(project_root / kind / name)
        if not resolved.exists():
            raise ValueError(f"local:{name} not found at {resolved}")
        return resolved

    if parent_str.startswith("theme:"):
        name = parent_str[len("theme:") :]
        if theme is None:
            raise ValueError(f"theme:{name} requires Deck(theme=...) to be set.")
        resolved = _with_svg(theme.asset_dir() / kind / name)
        if not resolved.exists():
            raise ValueError(f"theme:{name} not found at {resolved}")
        return resolved

    if parent_str.startswith("builtin:"):
        name = parent_str[len("builtin:") :]
        resolved = _with_svg(builtin_theme_dir() / kind / name)
        if not resolved.exists():
            raise ValueError(
                f"builtin:{name} not found — no built-in {kind.singular} named '{name}'"
            )
        return resolved

    if parent_str.startswith(("./", "../")):
        return _with_svg((base_dir / parent_str).resolve())

    if Path(parent_str).is_absolute():
        return _with_svg(Path(parent_str))

    # Multi-part relative path (has /) — relative to base_dir
    if "/" in parent_str:
        return _with_svg((base_dir / parent_str).resolve())

    # Bare single-part name — three-level search; levels skipped when context is absent
    name = parent_str
    candidates: list[Path] = []
    if project_root is not None:
        candidates.append(_with_svg(project_root / kind / name))
    if theme is not None:
        candidates.append(_with_svg(theme.asset_dir() / kind / name))
    candidates.append(_with_svg(builtin_theme_dir() / kind / name))

    for candidate in candidates:
        if candidate.exists():
            return candidate

    searched = "\n".join(f"  {c}" for c in candidates)
    raise ValueError(
        f"{kind.singular.capitalize()} '{name}' not found. Searched:\n{searched}"
    )


# ── Chain resolution ──────────────────────────────────────────────────────────


def resolve_chain(
    svg_path: Path,
    project_root: Path | None,
    theme: Theme | None,
    kind: AssetKind = AssetKind.LAYOUT,
) -> list[Path]:
    """Return the ancestor chain for svg_path, root-first, excluding svg_path itself.

    Returns an empty list if the file has no inkflow:parent.
    Raises ValueError on circular chains or when a parent string requires context
    (project_root for local:, theme for theme:) that is not available.

    ``kind`` is the namespace bare-name parents resolve in: an overlay inherits from
    another overlay, never from a layout.
    """
    chain: list[Path] = []
    current = svg_path.resolve()
    visited: set[Path] = {current}

    while True:
        parent_str = _read_parent_attr(current)
        if parent_str is None:
            break
        parent_path = resolve_parent_path(
            parent_str, current.parent, project_root, theme, kind
        )
        if parent_path in visited:
            raise ValueError(f"Circular inkflow:parent chain detected at {parent_path}")
        visited.add(parent_path)
        chain.insert(0, parent_path)
        current = parent_path

    return chain


# ── Layout layer stripping ────────────────────────────────────────────────────


def strip_parent(svg_path: Path) -> bool:
    """Remove inkflow:parent and injected preview layers from svg_path in place.

    Returns True if the file had an inkflow:parent attribute.
    """
    root = parse_svg_file(svg_path)
    had_parent = INKFLOW_PARENT in root.attrib
    if had_parent:
        del root.attrib[INKFLOW_PARENT]
    strip_preview_layers(root)
    svg_path.write_text(
        etree.tostring(root, encoding="unicode", xml_declaration=False),
        encoding="utf-8",
    )
    return had_parent


# ── Preview layers ────────────────────────────────────────────────────────────


class PreviewLayer(NamedTuple):
    """One SVG to inline as a locked editor layer, and the string that named it.

    ``ref`` is recorded in the marker attribute and compared on the next sync, so
    it has to be the authored reference (an ``inkflow:parent`` value, an
    ``inkflow:preview`` backdrop, or an ``Overlay.src``) rather than a path.
    """

    path: Path
    ref: str


@dataclass(frozen=True)
class PreviewLayers:
    """Everything injected into one file for editor preview.

    ``behind`` is painted below the file's own content (a backdrop plus the
    ancestor chain, root first), ``overlays`` above it, one inner list per overlay
    holding ``[*ancestors, overlay]``. Both classes are marked, locked, and
    stripped again by the serve/build pipeline.
    """

    behind: Sequence[PreviewLayer] = ()
    overlays: Sequence[Sequence[PreviewLayer]] = ()
    preview_css: str = ""

    def flat_overlays(self) -> list[PreviewLayer]:
        """Overlay layers in paint order, ancestors before the overlay itself."""
        return [layer for chain in self.overlays for layer in chain]


class _LayerClass(NamedTuple):
    """The marker attributes and label prefix distinguishing a layer class."""

    src_attr: str
    hash_attr: str
    label: str


_BEHIND = _LayerClass(INKFLOW_LAYOUT_SRC, INKFLOW_LAYOUT_HASH, "layout")
_OVERLAY = _LayerClass(INKFLOW_OVERLAY_SRC, INKFLOW_OVERLAY_HASH, "overlay")


def _layer_hashes(layers: Sequence[PreviewLayer]) -> dict[str, str]:
    """Digest each layer source by its cleaned, canonical content.

    Canonical rather than serialized: injecting layers into a file rewrites it
    without the original indentation, so a formatting-sensitive digest would flag
    every file whose ancestor or overlay has itself been synced as stale forever.
    """
    hashes: dict[str, str] = {}
    for layer in layers:
        cleaned = etree.tostring(clean_inkscape_tree(layer.path), encoding="unicode")
        canonical: str = etree.canonicalize(cleaned, strip_text=True)  # pyright: ignore[reportAny]
        digest = hashlib.sha1(canonical.encode()).hexdigest()
        hashes[str(layer.path.resolve())] = digest[:8]
    return hashes


def chain_layers(svg_path: Path, chain: list[Path]) -> list[PreviewLayer]:
    """Pair each ancestor with the inkflow:parent value that named it.

    The ref for chain[i] is the inkflow:parent value on its child — chain[i+1]
    for all but the last entry, svg_path for the last.
    """
    if not chain:
        return []
    children = [*chain[1:], svg_path]
    return [
        PreviewLayer(path, _read_parent_attr(child) or "")
        for path, child in zip(chain, children, strict=True)
    ]


_LAYER_ATTRS: dict[str, str] = {
    f"{{{ns.INKSCAPE}}}groupmode": "layer",
    f"{{{ns.SODIPODI}}}insensitive": "true",
}


def _layers_match(
    root: SvgElement, expected: Sequence[PreviewLayer], layer_class: _LayerClass
) -> bool:
    existing = [el for el in root if el.get(layer_class.src_attr) is not None]
    if len(existing) != len(expected):
        return False
    hashes = _layer_hashes(expected)
    for el, layer in zip(existing, expected, strict=True):
        if el.get(layer_class.src_attr) != layer.ref:
            return False
        if el.get(layer_class.hash_attr) != hashes[str(layer.path.resolve())]:
            return False
        if any(el.get(attr) != val for attr, val in _LAYER_ATTRS.items()):
            return False
    return True


def are_preview_layers_current(svg_path: Path, layers: PreviewLayers) -> bool:
    """Return True if svg_path already carries exactly these layers and style."""
    root = parse_svg_file(svg_path)
    if not _layers_match(root, layers.behind, _BEHIND):
        return False
    if not _layers_match(root, layers.flat_overlays(), _OVERLAY):
        return False
    if layers.preview_css:
        style_el = root.find(f'.//{{{ns.SVG}}}style[@id="inkflow-preview"]')
        if (
            style_el is None
            or (style_el.text or "").strip() != layers.preview_css.strip()
        ):
            return False
    return True


def _build_layer_group(
    layer: PreviewLayer, hashes: dict[str, str], layer_class: _LayerClass
) -> SvgElement:
    anc_root = parse_svg_file(layer.path)
    strip_preview_layers(anc_root)

    g = etree.Element(
        f"{{{ns.SVG}}}g",
        {
            f"{{{ns.INKSCAPE}}}groupmode": "layer",
            f"{{{ns.INKSCAPE}}}label": (
                f"__inkflow:{layer_class.label}:{layer.path.stem}__"
            ),
            f"{{{ns.SODIPODI}}}insensitive": "true",
            layer_class.src_attr: layer.ref,
            layer_class.hash_attr: hashes[str(layer.path.resolve())],
        },
    )

    defs_children: list[SvgElement] = []
    for defs_el in anc_root.findall(f"{{{ns.SVG}}}defs"):
        defs_children.extend(list(defs_el))
    if defs_children:
        g_defs = etree.SubElement(g, f"{{{ns.SVG}}}defs")
        for def_el in defs_children:
            g_defs.append(deepcopy(def_el))

    for child in anc_root:
        if child.tag != f"{{{ns.SVG}}}defs":
            g.append(deepcopy(child))

    return g


def create_slide(
    parent_str: str | None,
    output_path: Path,
    project_dir: Path | None,
    theme: Theme | None,
) -> None:
    """Create a minimal slide SVG, optionally wired to a layout parent.

    With ``parent_str`` set, resolves the parent, records ``inkflow:parent``, and
    injects ancestor layout layers for editor preview. With ``parent_str`` None,
    writes a blank slide carrying no parent.

    Raises ValueError if a given parent string cannot be resolved.
    """
    if parent_str is None:
        blank = (
            f'<svg xmlns="{ns.SVG}"\n'
            f'     viewBox="0 0 1920 1080" width="1920" height="1080">\n'
            f"</svg>\n"
        )
        output_path.write_text(blank, encoding="utf-8")
        return

    parent_abs = resolve_parent_path(parent_str, output_path.parent, project_dir, theme)

    view_box, width, height = "0 0 1920 1080", "1920", "1080"
    if parent_abs.exists():
        root = parse_svg_file(parent_abs)
        view_box = root.get("viewBox", view_box)
        width = root.get("width", width)
        height = root.get("height", height)

    svg_content = (
        f'<svg xmlns="{ns.SVG}"\n'
        f'     xmlns:inkflow="{ns.INKFLOW}"\n'
        f'     inkflow:parent="{parent_str}"\n'
        f'     viewBox="{view_box}" width="{width}" height="{height}">\n'
        f"</svg>\n"
    )
    output_path.write_text(svg_content, encoding="utf-8")

    # Layout layers only: the new slide is not in deck.py yet, so there is nothing
    # to resolve overlays from. `inkflow sync` adds the chrome once it is.
    chain = resolve_chain(output_path, project_dir, theme)
    if chain:
        inject_preview_layers(
            output_path, PreviewLayers(behind=chain_layers(output_path, chain))
        )


def _update_preview_style(
    root: SvgElement,
    preview_css: str,
) -> None:
    for el in root.findall(f'.//{{{ns.SVG}}}style[@id="inkflow-preview"]'):
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)
    if not preview_css:
        return
    defs = ensure_defs(root)
    style_el = etree.SubElement(defs, f"{{{ns.SVG}}}style")
    style_el.set("id", "inkflow-preview")
    style_el.text = preview_css


def inject_preview_layers(svg_path: Path, layers: PreviewLayers) -> bool:
    """Inject preview layers as locked Inkscape layers into svg_path in place.

    Ancestors are inserted below the file's own content and overlays appended
    above it, so the Inkscape layer stack matches runtime paint order. Also writes
    a ``<style id="inkflow-preview">`` block when ``preview_css`` is provided, so
    Inkscape renders semantic classes with the correct colors.
    Returns True if the file was modified, False if already up to date.
    """
    if are_preview_layers_current(svg_path, layers):
        return False

    root = parse_svg_file(svg_path)
    overlay_layers = layers.flat_overlays()
    hashes = _layer_hashes([*layers.behind, *overlay_layers])

    for el in [el for el in root if is_preview_layer(el)]:
        root.remove(el)

    for i, layer in enumerate(layers.behind):
        root.insert(i, _build_layer_group(layer, hashes, _BEHIND))
    for layer in overlay_layers:
        root.append(_build_layer_group(layer, hashes, _OVERLAY))

    _update_preview_style(root, layers.preview_css)

    # inkflow among them: the marker attributes are the first use of that namespace
    # in a file with no inkflow:parent (an overlay), and without the declaration they
    # serialize under a generated ns0-style prefix that is unreadable in an editor.
    out = with_namespaces(
        root,
        {"inkflow": ns.INKFLOW, "inkscape": ns.INKSCAPE, "sodipodi": ns.SODIPODI},
    )
    svg_path.write_text(
        etree.tostring(out, encoding="unicode", xml_declaration=False),
        encoding="utf-8",
    )
    return True


# ── Layout discovery and inspection ──────────────────────────────────────────


@dataclass
class LayoutInfo:
    """Result of inspecting a layout SVG for available zones."""

    zones: list[str]
    numbered: bool
    default_zone: str


def resolve_default_zone(
    root: SvgElement,
    available_zone_ids: set[str] | None = None,
) -> str:
    """Return the effective default zone for a layout SVG.

    Checks inkflow:default-zone first; falls back to "content" when zone-content
    is present in the layout, so the 80% case requires no attribute at all.
    """
    declared = root.get(INKFLOW_DEFAULT_ZONE)
    if declared:
        return declared
    if available_zone_ids and "zone-content" in available_zone_ids:
        return "content"
    return ""


def discover_assets(
    kind: AssetKind,
    project_dir: Path | None,
    theme: Theme | None,
) -> list[tuple[str, Path]]:
    """Return (source_label, path) pairs from all available directories for a kind.

    Order: builtin → theme → local.
    """
    sources: list[tuple[str, Path]] = []

    for label, base in (
        ("builtin", builtin_theme_dir()),
        ("theme", theme.asset_dir() if theme is not None else None),
        ("local", project_dir),
    ):
        if base is None:
            continue
        directory = base / kind
        if directory.is_dir():
            sources.extend((label, p) for p in sorted(directory.glob("*.svg")))

    return sources


def discover_layouts(
    project_dir: Path | None,
    theme: Theme | None,
) -> list[tuple[str, Path]]:
    """Return (source_label, path) pairs from every available layout directory."""
    return discover_assets(AssetKind.LAYOUT, project_dir, theme)


def discover_overlays(
    project_dir: Path | None,
    theme: Theme | None,
) -> list[tuple[str, Path]]:
    """Return (source_label, path) pairs from every available overlay directory."""
    return discover_assets(AssetKind.OVERLAY, project_dir, theme)


def layout_zones(
    layout_path: Path,
    project_dir: Path | None,
    theme: Theme | None,
    kind: AssetKind = AssetKind.LAYOUT,
) -> LayoutInfo:
    """Return zone information for a layout after compositing ancestors.

    The returned ``LayoutInfo.zones`` contains sorted zone names with the
    ``zone-`` prefix stripped, excluding the slide-number and slide-total zones
    (those are indicated by ``numbered``).
    """
    root = clean_inkscape_tree(layout_path)
    chain = resolve_chain(layout_path, project_dir, theme, kind)
    if chain:
        root = compose_with_ancestors(root, chain)

    all_zone_ids: set[str] = set()
    for el in root.iter():
        eid = el.get("id")
        if eid and eid.startswith("zone-"):
            all_zone_ids.add(eid)

    numbered = bool({"zone-slide-number", "zone-slide-total"} & all_zone_ids)
    content_zones = sorted(
        z[len("zone-") :]
        for z in all_zone_ids
        if z not in {"zone-slide-number", "zone-slide-total"}
    )
    return LayoutInfo(
        zones=content_zones,
        numbered=numbered,
        default_zone=resolve_default_zone(root, all_zone_ids),
    )
