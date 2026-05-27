from __future__ import annotations

import hashlib
import importlib.resources
from copy import deepcopy
from pathlib import Path
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.ns import (
    INKFLOW_LAYOUT_HASH,
    INKFLOW_LAYOUT_SRC,
    INKFLOW_PARENT,
)

# ── Built-in theme ───────────────────────────────────────────────────────────


def _builtin_theme_dir() -> Path:
    return Path(str(importlib.resources.files("inkflow").joinpath("theme")))


def _resolve_theme_dir(theme: str, project_root: Path) -> Path:
    p = Path(theme)
    if p.is_absolute():
        return p
    if theme.startswith(("./", "../")):
        return (project_root / p).resolve()
    raise ValueError(
        f"Named theme '{theme}' is not yet supported. Use a path like './my-theme'."
    )


# ── Parent attribute ──────────────────────────────────────────────────────────


def _read_parent_attr(svg_path: Path) -> str | None:
    tree = etree.parse(svg_path)
    return tree.getroot().get(INKFLOW_PARENT)


# ── Path resolution ───────────────────────────────────────────────────────────


def resolve_parent_path(
    parent_str: str,
    svg_path: Path,
    project_root: Path,
    theme: str | None,
) -> Path:
    """Resolve an inkflow:parent string to an absolute Path.

    Prefix syntaxes (bypass the search):
      local:foo      →  {project_root}/layouts/foo.svg
      theme:foo      →  {theme_dir}/layouts/foo.svg
      builtin:foo    →  {builtin_theme_dir}/layouts/foo.svg
      ./foo, ../foo  →  relative to svg_path's directory
      /absolute      →  literal filesystem path

    Bare single-part name (no prefix, no separator):
      Three-level search: project layouts/ → theme layouts/ → built-in layouts/
    Multi-part relative path (has /, no prefix):
      Relative to svg_path's directory (backward-compatible with inkflow:parent).
    """

    def _with_svg(p: Path) -> Path:
        return p if p.suffix else p.with_suffix(".svg")

    if parent_str.startswith("local:"):
        name = parent_str[len("local:") :]
        resolved = _with_svg(project_root / "layouts" / name)
        if not resolved.exists():
            raise ValueError(f"local:{name} not found at {resolved}")
        return resolved

    if parent_str.startswith("theme:"):
        name = parent_str[len("theme:") :]
        if theme is None:
            raise ValueError(f"theme:{name} requires Deck(theme=...) to be set")
        theme_dir = _resolve_theme_dir(theme, project_root)
        resolved = _with_svg(theme_dir / "layouts" / name)
        if not resolved.exists():
            raise ValueError(f"theme:{name} not found at {resolved}")
        return resolved

    if parent_str.startswith("builtin:"):
        name = parent_str[len("builtin:") :]
        resolved = _with_svg(_builtin_theme_dir() / "layouts" / name)
        if not resolved.exists():
            raise ValueError(
                f"builtin:{name} not found — no built-in layout named '{name}'"
            )
        return resolved

    if parent_str.startswith(("./", "../")):
        return _with_svg((svg_path.parent / parent_str).resolve())

    if parent_str.startswith("/"):
        return _with_svg(Path(parent_str))

    # Multi-part relative path (has /) — relative to svg_path's parent
    if "/" in parent_str:
        return _with_svg((svg_path.parent / parent_str).resolve())

    # Bare single-part name — three-level search
    name = parent_str
    candidates: list[Path] = [_with_svg(project_root / "layouts" / name)]
    if theme is not None:
        candidates.append(
            _with_svg(_resolve_theme_dir(theme, project_root) / "layouts" / name)
        )
    candidates.append(_with_svg(_builtin_theme_dir() / "layouts" / name))

    for candidate in candidates:
        if candidate.exists():
            return candidate

    searched = "\n".join(f"  {c}" for c in candidates)
    raise ValueError(f"Layout '{name}' not found. Searched:\n{searched}")


# ── Chain resolution ──────────────────────────────────────────────────────────


def resolve_chain(
    svg_path: Path,
    project_root: Path,
    theme: str | None,
) -> list[Path]:
    """Return the ancestor chain for svg_path, root-first, excluding svg_path itself.

    Returns an empty list if the file has no inkflow:parent.
    Raises ValueError on circular chains.
    """
    chain: list[Path] = []
    current = svg_path.resolve()
    visited: set[Path] = {current}

    while True:
        parent_str = _read_parent_attr(current)
        if parent_str is None:
            break
        parent_path = resolve_parent_path(parent_str, current, project_root, theme)
        if parent_path in visited:
            raise ValueError(f"Circular inkflow:parent chain detected at {parent_path}")
        visited.add(parent_path)
        chain.insert(0, parent_path)
        current = parent_path

    return chain


# ── Layout layer stripping ────────────────────────────────────────────────────


def strip_layout_layers(root: etree._Element) -> None:  # pyright: ignore[reportPrivateUsage]
    """Remove direct-child <g> elements injected by inject_layout_layers."""
    to_remove = [el for el in root if el.get(INKFLOW_LAYOUT_SRC) is not None]
    for el in to_remove:
        root.remove(el)


# ── inject_layout_layers ──────────────────────────────────────────────────────


def _layer_hashes(chain: list[Path]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for p in chain:
        digest = hashlib.sha1(p.read_bytes()).hexdigest()[:8]
        hashes[str(p.resolve())] = digest
    return hashes


def _chain_refs(svg_path: Path, chain: list[Path]) -> list[str]:
    """Return the inkflow:parent ref string for each ancestor in the chain.

    The ref for chain[i] is the inkflow:parent value on its child — chain[i+1]
    for all but the last entry, svg_path for the last.
    """
    children = [*chain[1:], svg_path]
    return [_read_parent_attr(child) or "" for child in children]


def is_layout_current(svg_path: Path, chain: list[Path]) -> bool:
    """Return True if svg_path already has up-to-date inject-layout layers."""
    root = etree.parse(svg_path).getroot()
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
    return True


def _build_layer_group(
    ancestor_path: Path, ref: str, hashes: dict[str, str]
) -> etree._Element:  # pyright: ignore[reportPrivateUsage]
    anc_root = etree.parse(ancestor_path).getroot()
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

    defs_children: list[etree._Element] = []  # pyright: ignore[reportPrivateUsage]
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


def _with_namespaces(
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


def inject_layout_layers(svg_path: Path, chain: list[Path]) -> bool:
    """Inject ancestor SVGs as locked Inkscape layers into svg_path in place.

    Returns True if the file was modified, False if already up to date.
    """
    if is_layout_current(svg_path, chain):
        return False

    root = etree.parse(svg_path).getroot()
    hashes = _layer_hashes(chain)

    for el in [el for el in root if el.get(INKFLOW_LAYOUT_SRC) is not None]:
        root.remove(el)

    refs = _chain_refs(svg_path, chain)
    for i, (ancestor_path, ref) in enumerate(zip(chain, refs, strict=True)):
        root.insert(i, _build_layer_group(ancestor_path, ref, hashes))

    out = _with_namespaces(root, {"inkscape": ns.INKSCAPE, "sodipodi": ns.SODIPODI})
    svg_path.write_text(
        etree.tostring(out, encoding="unicode", xml_declaration=False),
        encoding="utf-8",
    )
    return True
