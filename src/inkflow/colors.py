from __future__ import annotations

import importlib.resources
import re

from lxml import etree

from inkflow.svgio import SvgElement, parse_svg

# ── Token registry ────────────────────────────────────────────────────────────

# All --inkflow-* variable names that get SVG utility classes (fill + stroke).
SVG_TOKENS: list[str] = [
    # semantic
    "bg",
    "surface",
    "border",
    "text",
    "text-muted",
    "accent",
    "accent-fg",
    "code-bg",
    "code-text",
    # raw palette — chromatic
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    # raw palette — neutral
    "grey",
]

# ── Token extraction ──────────────────────────────────────────────────────────

# Matches a CSS custom property declaration for an inkflow variable.
_DECL_RE = re.compile(
    r"--inkflow-([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;",
)

# Identifies the start of a block that selects light mode.
_LIGHT_BLOCK_RE = re.compile(r'\[data-theme\s*=\s*["\']light["\']\]')


def _split_blocks(css: str) -> list[tuple[bool, str]]:
    """Split CSS into (is_light_mode_block, block_text) pairs.

    Walks the token stream character-by-character to handle nested braces.
    Returns a list of (is_light, text) pairs for each top-level { } block,
    plus a sentinel entry for content outside any block.
    """
    blocks: list[tuple[bool, str]] = []
    pos = 0
    length = len(css)

    while pos < length:
        brace = css.find("{", pos)
        if brace == -1:
            break
        selector = css[pos:brace]
        is_light = bool(_LIGHT_BLOCK_RE.search(selector))

        # Find the matching closing brace (handle nesting).
        depth = 1
        i = brace + 1
        while i < length and depth > 0:
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        blocks.append((is_light, css[brace + 1 : i - 1]))
        pos = i

    return blocks


def extract_tokens(css: str, dark_mode: bool) -> dict[str, str]:
    """Parse concatenated CSS and return {token_name: hex_value} for the given mode.

    Only extracts ``--inkflow-*`` variables with plain hex values.
    Parses forward; later declarations override earlier ones (correct cascade order).
    Light mode: starts from :root values, then overlays [data-theme="light"] values.
    Dark mode: uses only :root (non-light) blocks.
    """
    dark_values: dict[str, str] = {}
    light_values: dict[str, str] = {}

    for is_light, block_text in _split_blocks(css):
        target = light_values if is_light else dark_values
        for m in _DECL_RE.finditer(block_text):
            target[m.group(1)] = m.group(2).lower()

    if dark_mode:
        return dict(dark_values)

    # Light mode: dark as base, light overrides.
    merged = dict(dark_values)
    merged.update(light_values)
    return merged


# ── Preview style generation ──────────────────────────────────────────────────


def build_preview_style(tokens: dict[str, str]) -> str:
    """Generate the inkflow-preview CSS block from a token→hex mapping.

    Only emits rules for tokens that have a hex value in the mapping.
    """
    lines: list[str] = []
    for token in SVG_TOKENS:
        hex_val = tokens.get(token)
        if not hex_val:
            continue
        lines.append(f".inkflow-fill-{token} {{ fill: {hex_val}; }}")
        lines.append(f".inkflow-stroke-{token} {{ stroke: {hex_val}; }}")
    return "\n".join(lines)


# ── GPL palette generation ────────────────────────────────────────────────────


def _hex_to_rgb(hex_val: str) -> tuple[int, int, int]:
    h = hex_val.lstrip("#")
    if len(h) == 3:
        h = h[0] * 2 + h[1] * 2 + h[2] * 2
    r = int(h[0:2], 16)
    g = int(h[2:4], 16)
    b = int(h[4:6], 16)
    return r, g, b


def _hex_to_hsl(hex_val: str) -> tuple[float, float, float]:
    r, g, b = _hex_to_rgb(hex_val)
    red, green, blue = r / 255, g / 255, b / 255
    cmax, cmin = max(red, green, blue), min(red, green, blue)
    delta = cmax - cmin
    lightness = (cmax + cmin) / 2
    saturation = 0.0 if delta == 0 else delta / (1 - abs(2 * lightness - 1))
    if delta == 0:
        hue = 0.0
    elif cmax == red:
        hue = 60 * (((green - blue) / delta) % 6)
    elif cmax == green:
        hue = 60 * ((blue - red) / delta + 2)
    else:
        hue = 60 * ((red - green) / delta + 4)
    return hue, saturation, lightness


# Tokens sorted by lightness in the palette neutral ramp.
_NEUTRAL_TOKENS: frozenset[str] = frozenset(
    [
        "bg",
        "surface",
        "border",
        "text",
        "text-muted",
        "accent-fg",
        "code-bg",
        "code-text",
        "grey",
    ]
)
# Tokens sorted by hue in the palette chromatic strip.
_CHROMATIC_TOKENS: frozenset[str] = frozenset(
    ["accent", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]
)


def build_gpl(tokens: dict[str, str], palette_name: str) -> str:
    """Generate Inkscape GPL palette content from a token→hex mapping.

    Deduplicates by hex value (first occurrence in SVG_TOKENS order wins),
    then outputs a neutral ramp sorted dark→light followed by chromatic
    colors sorted by hue.
    """
    seen: set[str] = set()
    neutrals: list[tuple[float, int, int, int, str]] = []  # (lightness, r, g, b, name)
    chromatic: list[tuple[float, int, int, int, str]] = []  # (hue, r, g, b, name)

    for token in SVG_TOKENS:
        hex_val = tokens.get(token)
        if not hex_val:
            continue
        key = hex_val.lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            r, g, b = _hex_to_rgb(key)
            hue, _saturation, lightness = _hex_to_hsl(key)
        except (ValueError, IndexError):
            continue
        if token in _NEUTRAL_TOKENS:
            neutrals.append((lightness, r, g, b, token))
        elif token in _CHROMATIC_TOKENS:
            chromatic.append((hue, r, g, b, token))

    neutrals.sort(key=lambda e: e[0])
    chromatic.sort(key=lambda e: e[0])

    lines = ["GIMP Palette", f"Name: {palette_name}", "#"]
    for _, r, g, b, name in neutrals:
        lines.append(f"{r:3d} {g:3d} {b:3d}\t{name}")
    for _, r, g, b, name in chromatic:
        lines.append(f"{r:3d} {g:3d} {b:3d}\t{name}")
    return "\n".join(lines) + "\n"


# ── Colorize helpers ──────────────────────────────────────────────────────────


def hex_to_class_map(tokens: dict[str, str]) -> dict[str, list[tuple[str, str]]]:
    """Return {lowercase_hex: [(class_name, prop), ...]} for fill and stroke.

    ``prop`` is ``"fill"`` or ``"stroke"``.
    Multiple tokens may share the same hex; all are included.
    """
    result: dict[str, list[tuple[str, str]]] = {}
    for token in SVG_TOKENS:
        hex_val = tokens.get(token)
        if not hex_val:
            continue
        key = hex_val.lower()
        result.setdefault(key, [])
        result[key].append((f"inkflow-fill-{token}", "fill"))
        result[key].append((f"inkflow-stroke-{token}", "stroke"))
    return result


# ── Inline-style parser ───────────────────────────────────────────────────────

_STYLE_DECL_RE = re.compile(r"([\w-]+)\s*:\s*([^;]+?)(?:\s*;|$)")


def parse_style(style: str) -> list[tuple[str, str]]:
    """Parse an inline ``style`` attribute into [(prop, value), ...] pairs."""
    return [
        (m.group(1).strip(), m.group(2).strip()) for m in _STYLE_DECL_RE.finditer(style)
    ]


def serialize_style(decls: list[tuple[str, str]]) -> str:
    return "; ".join(f"{p}: {v}" for p, v in decls)


# ── SVG colorize ─────────────────────────────────────────────────────────────


def colorize_element(
    el: SvgElement,
    hex_map: dict[str, list[tuple[str, str]]],
) -> bool:
    """Replace fill/stroke attributes on one element with semantic CSS classes.

    Handles direct attributes (``fill="#..."`` / ``stroke="#..."``) and the
    same properties inside an inline ``style`` attribute.  Modifies in place;
    returns True if any change was made.
    """
    changed = False
    existing_classes: list[str] = str(el.get("class") or "").split()

    for prop in ("fill", "stroke"):
        val = str(el.get(prop) or "").lower().strip()
        if not val or val in ("none", "inherit", "currentcolor"):
            continue
        cls_matches = [cls for cls, p in hex_map.get(val, []) if p == prop]
        if not cls_matches:
            continue
        existing_classes = [c for c in existing_classes if c not in cls_matches]
        existing_classes.extend(cls_matches)
        del el.attrib[prop]
        changed = True

    style_attr = str(el.get("style") or "")
    if style_attr:
        decls = parse_style(style_attr)
        remaining: list[tuple[str, str]] = []
        for prop, val in decls:
            if prop in ("fill", "stroke"):
                cls_matches = [
                    cls for cls, p in hex_map.get(val.lower().strip(), []) if p == prop
                ]
                if cls_matches:
                    existing_classes = [
                        c for c in existing_classes if c not in cls_matches
                    ]
                    existing_classes.extend(cls_matches)
                    changed = True
                    continue
            remaining.append((prop, val))
        if changed:
            if remaining:
                el.set("style", serialize_style(remaining))
            elif "style" in el.attrib:
                del el.attrib["style"]

    if changed:
        el.set("class", " ".join(existing_classes))

    return changed


def colorize_svg(
    svg_str: str,
    hex_map: dict[str, list[tuple[str, str]]],
) -> tuple[str, bool]:
    """Apply ``colorize_element`` to every element in an SVG string.

    Returns ``(result_svg, was_changed)``.  When nothing changed the original
    string is returned unchanged so the caller can skip the write.
    """
    root = parse_svg(svg_str)
    changed = False
    for el in root.iter():
        if colorize_element(el, hex_map):
            changed = True
    if not changed:
        return svg_str, False
    return etree.tostring(root, encoding="unicode", xml_declaration=False), True


# ── Default dark-mode token helper ────────────────────────────────────────────


def builtin_tokens(dark_mode: bool = True) -> dict[str, str]:
    """Return tokens extracted from the built-in theme CSS only."""
    pkg = importlib.resources.files("inkflow")
    css = pkg.joinpath("theme", "styles.css").read_text(encoding="utf-8")
    return extract_tokens(css, dark_mode)
