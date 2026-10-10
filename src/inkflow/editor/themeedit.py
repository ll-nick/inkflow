"""The editor's Theme panel: token overrides kept in the project's styles.css.

``styles.css`` loads last in the deck's cascade (see ``loaders.load_deck_styles``),
so a ``:root`` block there overrides the active theme's tokens without touching
the theme itself. The panel owns one marked block and leaves every other byte of
the file alone::

    /* inkflow:theme (written by the editor's Theme panel; edit freely) */
    :root { --inkflow-accent: #ff8800; }
    :root[data-theme="light"] { --inkflow-accent: #cc5500; }
    /* /inkflow:theme */

Values are validated before they are written: a theme value is a colour, a
font-family list or a number, never arbitrary CSS.
"""

from __future__ import annotations

import re
from dataclasses import fields
from typing import cast

from inkflow.themes import Palette, Theme, Typography

BEGIN = "/* inkflow:theme (written by the editor's Theme panel; edit freely) */"
END = "/* /inkflow:theme */"
_BLOCK = re.compile(
    r"/\* inkflow:theme\b.*?\*/(?P<body>.*?)/\* /inkflow:theme \*/\n?", re.S
)
_RULE = re.compile(
    r"(?P<sel>:root(?:\[data-theme=\"light\"\])?)\s*\{(?P<decls>[^}]*)\}"
)
_DECL = re.compile(r"--inkflow-(?P<name>[\w-]+)\s*:\s*(?P<value>[^;]+);")

_COLOR = re.compile(
    r"^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([\d\s.,%/+-]+\)|[a-zA-Z]+)$"
)
_FONT = re.compile(r"^[\w\s,'\"-]+$")
_NUMBER = re.compile(r"^\d+(\.\d+)?$")

PALETTE_TOKENS = [f.name for f in fields(Palette)]
TYPOGRAPHY_TOKENS = [f.name for f in fields(Typography)]


class ThemeEditError(ValueError):
    pass


def _token(name: str) -> str:
    return name.replace("_", "-")


def _field(token: str) -> str:
    return token.replace("-", "_")


Overrides = dict[str, dict[str, str]]
"""``{"dark": {...}, "light": {...}, "typography": {...}}``, field names → CSS."""


def read_overrides(css: str) -> Overrides:
    """The panel's overrides as written in ``styles.css`` (empty if none)."""
    out: Overrides = {"dark": {}, "light": {}, "typography": {}}
    m = _BLOCK.search(css)
    if not m:
        return out
    for rule in _RULE.finditer(m.group("body")):
        light = "light" in rule.group("sel")
        for decl in _DECL.finditer(rule.group("decls")):
            name = _field(decl.group("name"))
            value = decl.group("value").strip()
            if light and name in PALETTE_TOKENS:
                out["light"][name] = value
            elif name in PALETTE_TOKENS:
                out["dark"][name] = value
            elif name in TYPOGRAPHY_TOKENS:
                out["typography"][name] = value
    return out


def _check(name: str, value: str) -> str:
    value = value.strip()
    if name in PALETTE_TOKENS:
        ok = bool(_COLOR.match(value))
    elif name in ("body_font", "heading_font", "mono_font", "math_font"):
        ok = bool(_FONT.match(value))
    elif name in TYPOGRAPHY_TOKENS:
        ok = bool(_NUMBER.match(value))
    else:
        raise ThemeEditError(f"unknown theme token {name!r}")
    if not ok:
        raise ThemeEditError(f"{value!r} is not a valid value for {_token(name)}")
    return value


def write_overrides(css: str, overrides: Overrides) -> str:
    """``css`` with the panel's block replaced (or added, or removed if empty)."""
    dark = {**overrides.get("dark", {}), **overrides.get("typography", {})}
    light = overrides.get("light", {})
    lines: list[str] = []
    if dark:
        lines.append(":root {")
        lines += [
            f"    --inkflow-{_token(k)}: {_check(k, v)};" for k, v in dark.items()
        ]
        lines.append("}")
    if light:
        lines.append(':root[data-theme="light"] {')
        lines += [
            f"    --inkflow-{_token(k)}: {_check(k, v)};" for k, v in light.items()
        ]
        lines.append("}")
    block = f"{BEGIN}\n" + "\n".join(lines) + f"\n{END}\n" if lines else ""
    if _BLOCK.search(css):
        return _BLOCK.sub(lambda _: block, css, count=1)
    if not block:
        return css
    if not css.strip():
        return block
    return css.rstrip("\n") + "\n\n" + block


def merge(current: Overrides, changes: dict[str, dict[str, str | None]]) -> Overrides:
    """Apply the panel's changes (``None`` resets a token to the theme's value)."""
    out: Overrides = {k: dict(v) for k, v in current.items()}
    for group in ("dark", "light", "typography"):
        for name, value in (changes.get(group) or {}).items():
            target = out.setdefault(group, {})
            if value is None or not str(value).strip():
                target.pop(name, None)
            else:
                target[name] = _check(name, str(value))
    return out


def theme_values(theme: Theme) -> dict[str, dict[str, str]]:
    """The active theme's own token values, as the panel shows them."""

    def values(obj: object, names: list[str]) -> dict[str, str]:
        return {n: str(cast("object", getattr(obj, n))) for n in names}

    return {
        "dark": values(theme.dark, PALETTE_TOKENS),
        "light": values(theme.light, PALETTE_TOKENS),
        "typography": values(theme.typography, TYPOGRAPHY_TOKENS),
    }
