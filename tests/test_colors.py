from __future__ import annotations

import textwrap

from inkflow.colors import (
    SVG_TOKENS,
    build_gpl,
    build_preview_style,
    builtin_tokens,
    colorize_svg,
    extract_tokens,
    hex_to_class_map,
)

# ── extract_tokens ────────────────────────────────────────────────────────────


def test_extract_tokens_dark_returns_root_values() -> None:
    css = textwrap.dedent("""
        :root { --inkflow-bg: #1e1e2e; }
        [data-theme="light"] { --inkflow-bg: #eff1f5; }
    """)
    tokens = extract_tokens(css, dark_mode=True)
    assert tokens["bg"] == "#1e1e2e"


def test_extract_tokens_light_overlays_root() -> None:
    css = textwrap.dedent("""
        :root { --inkflow-bg: #1e1e2e; --inkflow-text: #cdd6f4; }
        [data-theme="light"] { --inkflow-bg: #eff1f5; }
    """)
    tokens = extract_tokens(css, dark_mode=False)
    assert tokens["bg"] == "#eff1f5"
    assert tokens["text"] == "#cdd6f4"  # falls back to :root


def test_extract_tokens_later_declaration_wins() -> None:
    css = ":root { --inkflow-bg: #111111; --inkflow-bg: #222222; }"
    tokens = extract_tokens(css, dark_mode=True)
    assert tokens["bg"] == "#222222"


def test_extract_tokens_skips_non_hex_values() -> None:
    css = ":root { --inkflow-bg: var(--some-other); --inkflow-text: #cdd6f4; }"
    tokens = extract_tokens(css, dark_mode=True)
    assert "bg" not in tokens
    assert tokens["text"] == "#cdd6f4"


# ── builtin_tokens ────────────────────────────────────────────────────────────


def test_builtin_tokens_dark_non_empty() -> None:
    tokens = builtin_tokens(dark_mode=True)
    assert tokens
    assert "bg" in tokens
    assert "accent" in tokens


def test_builtin_tokens_dark_and_light_differ() -> None:
    dark = builtin_tokens(dark_mode=True)
    light = builtin_tokens(dark_mode=False)
    assert dark != light
    assert dark.get("bg") != light.get("bg")


def test_builtin_tokens_contains_all_svg_tokens() -> None:
    tokens = builtin_tokens(dark_mode=True)
    for name in SVG_TOKENS:
        assert name in tokens, f"missing token: {name}"


# ── build_preview_style ───────────────────────────────────────────────────────


def test_build_preview_style_emits_fill_and_stroke() -> None:
    tokens = {"accent": "#cba6f7"}
    css = build_preview_style(tokens)
    assert "inkflow-fill-accent" in css
    assert "inkflow-stroke-accent" in css
    assert "#cba6f7" in css


def test_build_preview_style_skips_missing_tokens() -> None:
    css = build_preview_style({})
    assert css == ""


def test_build_preview_style_builtin_dark_non_empty() -> None:
    css = build_preview_style(builtin_tokens(dark_mode=True))
    assert css


# ── build_gpl ─────────────────────────────────────────────────────────────────


def test_build_gpl_header() -> None:
    gpl = build_gpl({}, "My Theme")
    assert gpl.startswith("GIMP Palette\n")
    assert "Name: My Theme" in gpl


def test_build_gpl_contains_token_rgb() -> None:
    gpl = build_gpl({"accent": "#cba6f7"}, "test")
    assert "accent" in gpl
    assert "203" in gpl  # R channel of #cba6f7


def test_build_gpl_skips_missing_tokens() -> None:
    gpl = build_gpl({}, "empty")
    lines = gpl.strip().splitlines()
    assert len(lines) == 3  # header, name, #


# ── hex_to_class_map ──────────────────────────────────────────────────────────


def test_hex_to_class_map_fill_and_stroke_entries() -> None:
    mapping = hex_to_class_map({"accent": "#cba6f7"})
    assert "#cba6f7" in mapping
    classes = {cls for cls, _ in mapping["#cba6f7"]}
    assert "inkflow-fill-accent" in classes
    assert "inkflow-stroke-accent" in classes


def test_hex_to_class_map_shared_hex_collects_all() -> None:
    tokens = {"text": "#cdd6f4", "code-text": "#cdd6f4"}
    mapping = hex_to_class_map(tokens)
    classes = {cls for cls, _ in mapping["#cdd6f4"]}
    assert "inkflow-fill-text" in classes
    assert "inkflow-fill-code-text" in classes


# ── colorize_svg ──────────────────────────────────────────────────────────────

_HEX_MAP = hex_to_class_map({"accent": "#cba6f7", "text": "#cdd6f4"})

_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#cba6f7"/></svg>'


def test_colorize_svg_replaces_fill_attribute() -> None:
    result, changed = colorize_svg(_SVG, _HEX_MAP)
    assert changed
    assert 'fill="#cba6f7"' not in result
    assert "inkflow-fill-accent" in result


def test_colorize_svg_no_match_returns_unchanged() -> None:
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#123456"/></svg>'
    result, changed = colorize_svg(svg, _HEX_MAP)
    assert not changed
    assert result == svg


def test_colorize_svg_preserves_existing_classes() -> None:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<rect class="my-class" fill="#cba6f7"/></svg>'
    )
    result, changed = colorize_svg(svg, _HEX_MAP)
    assert changed
    assert "my-class" in result
    assert "inkflow-fill-accent" in result


def test_colorize_svg_replaces_stroke_attribute() -> None:
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect stroke="#cba6f7"/></svg>'
    result, changed = colorize_svg(svg, _HEX_MAP)
    assert changed
    assert "inkflow-stroke-accent" in result
    assert 'stroke="#cba6f7"' not in result


def test_colorize_svg_replaces_inline_style_fill() -> None:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg">'
        '<rect style="fill:#cba6f7;opacity:0.5"/></svg>'
    )
    result, changed = colorize_svg(svg, _HEX_MAP)
    assert changed
    assert "inkflow-fill-accent" in result
    assert "opacity" in result  # non-color declarations survive


def test_colorize_svg_skips_fill_none() -> None:
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="none"/></svg>'
    _, changed = colorize_svg(svg, _HEX_MAP)
    assert not changed


def test_colorize_svg_handles_uppercase_hex() -> None:
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#CBA6F7"/></svg>'
    result, changed = colorize_svg(svg, _HEX_MAP)
    assert changed
    assert "inkflow-fill-accent" in result
