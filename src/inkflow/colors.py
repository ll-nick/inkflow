from __future__ import annotations

import importlib.resources
import re

# ── Token registry ────────────────────────────────────────────────────────────

# All --inkflow-* variable names that get SVG utility classes (fill + stroke).
SVG_TOKENS: list[str] = [
    "bg",
    "surface",
    "border",
    "text",
    "text-muted",
    "accent",
    "accent-fg",
    "code-bg",
    "code-text",
    "red",
    "green",
    "blue",
    "yellow",
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


def build_gpl(tokens: dict[str, str], palette_name: str) -> str:
    """Generate Inkscape GPL palette content from a token→hex mapping."""
    lines = [
        "GIMP Palette",
        f"Name: {palette_name}",
        "#",
    ]
    for token in SVG_TOKENS:
        hex_val = tokens.get(token)
        if not hex_val:
            continue
        try:
            r, g, b = _hex_to_rgb(hex_val)
        except (ValueError, IndexError):
            continue
        lines.append(f"{r:3d} {g:3d} {b:3d}\t{token}")
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


# ── Default dark-mode token helper ────────────────────────────────────────────


def builtin_tokens(dark_mode: bool = True) -> dict[str, str]:
    """Return tokens extracted from the built-in theme CSS only."""
    pkg = importlib.resources.files("inkflow")
    css = pkg.joinpath("theme", "styles.css").read_text(encoding="utf-8")
    return extract_tokens(css, dark_mode)
