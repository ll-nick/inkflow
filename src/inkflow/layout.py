from __future__ import annotations

import hashlib
import importlib.resources
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from lxml import etree

from inkflow import ns
from inkflow.clean import clean_inkscape_svg, clean_inkscape_tree, strip_layout_layers
from inkflow.ns import (
    INKFLOW_DEFAULT_ZONE,
    INKFLOW_LAYOUT_HASH,
    INKFLOW_LAYOUT_SRC,
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
) -> Path:
    """Resolve an inkflow:parent string to an absolute Path.

    Prefix syntaxes (bypass the search):
      local:foo      →  {project_root}/layouts/foo.svg   (requires project_root)
      theme:foo      →  {theme_dir}/layouts/foo.svg      (requires theme)
      builtin:foo    →  {builtin_theme_dir}/layouts/foo.svg
      ./foo, ../foo  →  relative to base_dir
      /absolute      →  literal filesystem path

    Bare single-part name (no prefix, no separator):
      Three-level search: project layouts/ → theme layouts/ → built-in layouts/
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
        resolved = _with_svg(project_root / "layouts" / name)
        if not resolved.exists():
            raise ValueError(f"local:{name} not found at {resolved}")
        return resolved

    if parent_str.startswith("theme:"):
        name = parent_str[len("theme:") :]
        if theme is None:
            raise ValueError(f"theme:{name} requires Deck(theme=...) to be set.")
        resolved = _with_svg(theme.layouts_dir / name)
        if not resolved.exists():
            raise ValueError(f"theme:{name} not found at {resolved}")
        return resolved

    if parent_str.startswith("builtin:"):
        name = parent_str[len("builtin:") :]
        resolved = _with_svg(builtin_theme_dir() / "layouts" / name)
        if not resolved.exists():
            raise ValueError(
                f"builtin:{name} not found — no built-in layout named '{name}'"
            )
        return resolved

    if parent_str.startswith(("./", "../")):
        return _with_svg((base_dir / parent_str).resolve())

    if parent_str.startswith("/"):
        return _with_svg(Path(parent_str))

    # Multi-part relative path (has /) — relative to base_dir
    if "/" in parent_str:
        return _with_svg((base_dir / parent_str).resolve())

    # Bare single-part name — three-level search; levels skipped when context is absent
    name = parent_str
    candidates: list[Path] = []
    if project_root is not None:
        candidates.append(_with_svg(project_root / "layouts" / name))
    if theme is not None:
        candidates.append(_with_svg(theme.layouts_dir / name))
    candidates.append(_with_svg(builtin_theme_dir() / "layouts" / name))

    for candidate in candidates:
        if candidate.exists():
            return candidate

    searched = "\n".join(f"  {c}" for c in candidates)
    raise ValueError(f"Layout '{name}' not found. Searched:\n{searched}")


# ── Chain resolution ──────────────────────────────────────────────────────────


def resolve_chain(
    svg_path: Path,
    project_root: Path | None,
    theme: Theme | None,
) -> list[Path]:
    """Return the ancestor chain for svg_path, root-first, excluding svg_path itself.

    Returns an empty list if the file has no inkflow:parent.
    Raises ValueError on circular chains or when a parent string requires context
    (project_root for local:, theme for theme:) that is not available.
    """
    chain: list[Path] = []
    current = svg_path.resolve()
    visited: set[Path] = {current}

    while True:
        parent_str = _read_parent_attr(current)
        if parent_str is None:
            break
        parent_path = resolve_parent_path(
            parent_str, current.parent, project_root, theme
        )
        if parent_path in visited:
            raise ValueError(f"Circular inkflow:parent chain detected at {parent_path}")
        visited.add(parent_path)
        chain.insert(0, parent_path)
        current = parent_path

    return chain


# ── Layout layer stripping ────────────────────────────────────────────────────


def strip_parent(svg_path: Path) -> bool:
    """Remove inkflow:parent and injected layout layers from svg_path in place.

    Returns True if the file had an inkflow:parent attribute.
    """
    root = parse_svg_file(svg_path)
    had_parent = INKFLOW_PARENT in root.attrib
    if had_parent:
        del root.attrib[INKFLOW_PARENT]
    strip_layout_layers(root)
    svg_path.write_text(
        etree.tostring(root, encoding="unicode", xml_declaration=False),
        encoding="utf-8",
    )
    return had_parent


# ── inject_layout_layers ──────────────────────────────────────────────────────


def _layer_hashes(chain: list[Path]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for p in chain:
        cleaned = clean_inkscape_svg(p).encode()
        hashes[str(p.resolve())] = hashlib.sha1(cleaned).hexdigest()[:8]
    return hashes


def _chain_refs(svg_path: Path, chain: list[Path]) -> list[str]:
    """Return the inkflow:parent ref string for each ancestor in the chain.

    The ref for chain[i] is the inkflow:parent value on its child — chain[i+1]
    for all but the last entry, svg_path for the last.
    """
    if not chain:
        return []
    children = [*chain[1:], svg_path]
    return [_read_parent_attr(child) or "" for child in children]


_LAYER_ATTRS: dict[str, str] = {
    f"{{{ns.INKSCAPE}}}groupmode": "layer",
    f"{{{ns.SODIPODI}}}insensitive": "true",
}


def is_layout_current(svg_path: Path, chain: list[Path], preview_css: str = "") -> bool:
    """Return True if svg_path has up-to-date layout layers and preview style."""
    root = parse_svg_file(svg_path)
    existing = [el for el in root if el.get(INKFLOW_LAYOUT_SRC) is not None]
    if len(existing) != len(chain):
        return False
    new_hashes = _layer_hashes(chain)
    refs = _chain_refs(svg_path, chain)
    for el, p, ref in zip(existing, chain, refs, strict=True):
        if el.get(INKFLOW_LAYOUT_SRC) != ref:
            return False
        if el.get(INKFLOW_LAYOUT_HASH) != new_hashes[str(p.resolve())]:
            return False
        if any(el.get(attr) != val for attr, val in _LAYER_ATTRS.items()):
            return False
    if preview_css:
        style_el = root.find(f'.//{{{ns.SVG}}}style[@id="inkflow-preview"]')
        if style_el is None or (style_el.text or "").strip() != preview_css.strip():
            return False
    return True


def _build_layer_group(
    ancestor_path: Path, ref: str, hashes: dict[str, str]
) -> SvgElement:
    anc_root = parse_svg_file(ancestor_path)
    strip_layout_layers(anc_root)

    g = etree.Element(
        f"{{{ns.SVG}}}g",
        {
            f"{{{ns.INKSCAPE}}}groupmode": "layer",
            f"{{{ns.INKSCAPE}}}label": f"__inkflow:layout:{ancestor_path.stem}__",
            f"{{{ns.SODIPODI}}}insensitive": "true",
            INKFLOW_LAYOUT_SRC: ref,
            INKFLOW_LAYOUT_HASH: hashes[str(ancestor_path.resolve())],
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

    chain = resolve_chain(output_path, project_dir, theme)
    if chain:
        inject_layout_layers(output_path, chain)


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


def inject_layout_layers(
    svg_path: Path, chain: list[Path], preview_css: str = ""
) -> bool:
    """Inject ancestor SVGs as locked Inkscape layers into svg_path in place.

    Also writes a ``<style id="inkflow-preview">`` block when ``preview_css``
    is provided, so Inkscape renders semantic classes with the correct colors.
    Returns True if the file was modified, False if already up to date.
    """
    if is_layout_current(svg_path, chain, preview_css):
        return False

    root = parse_svg_file(svg_path)
    hashes = _layer_hashes(chain)

    for el in [el for el in root if el.get(INKFLOW_LAYOUT_SRC) is not None]:
        root.remove(el)

    refs = _chain_refs(svg_path, chain)
    for i, (ancestor_path, ref) in enumerate(zip(chain, refs, strict=True)):
        root.insert(i, _build_layer_group(ancestor_path, ref, hashes))

    _update_preview_style(root, preview_css)

    out = with_namespaces(root, {"inkscape": ns.INKSCAPE, "sodipodi": ns.SODIPODI})
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


def discover_layouts(
    project_dir: Path | None,
    theme: Theme | None,
) -> list[tuple[str, Path]]:
    """Return (source_label, layout_path) pairs from all available layout directories.

    Order: builtin → theme → local.
    """
    sources: list[tuple[str, Path]] = []

    for p in sorted((builtin_theme_dir() / "layouts").glob("*.svg")):
        sources.append(("builtin", p))

    if theme is not None:
        theme_layouts = theme.layouts_dir
        if theme_layouts.is_dir():
            for p in sorted(theme_layouts.glob("*.svg")):
                sources.append(("theme", p))

    if project_dir:
        local_layouts = project_dir / "layouts"
        if local_layouts.is_dir():
            for p in sorted(local_layouts.glob("*.svg")):
                sources.append(("local", p))

    return sources


def layout_zones(
    layout_path: Path,
    project_dir: Path | None,
    theme: Theme | None,
) -> LayoutInfo:
    """Return zone information for a layout after compositing ancestors.

    The returned ``LayoutInfo.zones`` contains sorted zone names with the
    ``zone-`` prefix stripped, excluding the slide-number and slide-total zones
    (those are indicated by ``numbered``).
    """
    root = clean_inkscape_tree(layout_path)
    chain = resolve_chain(layout_path, project_dir, theme)
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
