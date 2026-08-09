from __future__ import annotations

import base64
import io
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

import platformdirs

from inkflow import ns
from inkflow.logging import logger
from inkflow.pipeline import SlideData
from inkflow.svgio import SvgElement, parse_svg

# ── Constants ─────────────────────────────────────────────────────────────────

_GENERIC_FAMILIES: frozenset[str] = frozenset(
    {
        "sans-serif",
        "serif",
        "monospace",
        "cursive",
        "fantasy",
        "system-ui",
        "ui-sans-serif",
        "ui-serif",
        "ui-monospace",
        "ui-rounded",
        "inherit",
        "initial",
        "unset",
    }
)

_FONT_SUFFIXES: frozenset[str] = frozenset({".ttf", ".otf", ".woff", ".woff2"})

_FONT_MIME: dict[str, str] = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}

_FONT_FORMAT: dict[str, str] = {
    ".woff2": "woff2",
    ".woff": "woff",
    ".ttf": "truetype",
    ".otf": "opentype",
}

# CSS font-weight keyword → integer
_WEIGHT_KEYWORDS: dict[str, int] = {
    "thin": 100,
    "extralight": 200,
    "extra-light": 200,
    "ultralight": 200,
    "ultra-light": 200,
    "light": 300,
    "normal": 400,
    "regular": 400,
    "medium": 500,
    "semibold": 600,
    "semi-bold": 600,
    "demibold": 600,
    "demi-bold": 600,
    "bold": 700,
    "extrabold": 800,
    "extra-bold": 800,
    "ultrabold": 800,
    "ultra-bold": 800,
    "black": 900,
    "heavy": 900,
}

# ── Internal types ────────────────────────────────────────────────────────────


@dataclass
class _FontRecord:
    path: Path
    family: str
    weight_class: int  # 100-900
    is_italic: bool


@dataclass(frozen=True)
class _FontSpec:
    family: str
    weight_class: int
    is_italic: bool


# ── Font directory discovery ──────────────────────────────────────────────────


def _font_dirs(project_dir: Path, theme_fonts_dir: Path | None) -> list[Path]:
    # Project fonts, then the theme's bundled fonts, then the per-user font dir (via
    # platformdirs), then the OS-wide system dirs. Project wins over theme wins over
    # system. platformdirs models the user dir on every platform but has no concept
    # of system fonts, so those stay explicit.
    dirs: list[Path] = [project_dir / "fonts"]
    if theme_fonts_dir is not None:
        dirs.append(theme_fonts_dir)
    dirs.append(Path(platformdirs.user_fonts_dir()))

    if sys.platform == "win32":
        dirs.append(Path(r"C:\Windows\Fonts"))
    elif sys.platform == "darwin":
        dirs += [Path("/Library/Fonts"), Path("/System/Library/Fonts")]
    else:
        dirs += [Path("/usr/local/share/fonts"), Path("/usr/share/fonts")]

    return [d for d in dirs if d.exists()]


# ── Font file reading ─────────────────────────────────────────────────────────


def _read_font_record(path: Path) -> _FontRecord | None:
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(path, lazy=True)
        try:
            name_table = font["name"]
            family = (
                name_table.getDebugName(16) or name_table.getDebugName(1) or ""
            ).strip()
            if not family:
                return None
            os2 = font.get("OS/2")
            # OS/2 table uses a dynamically-named class; attributes aren't in stubs
            weight_class = int(os2.usWeightClass) if os2 else 400  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownArgumentType]
            is_italic = bool(os2.fsSelection & 0x01) if os2 else False  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownArgumentType]
        finally:
            font.close()
        return _FontRecord(
            path=path, family=family, weight_class=weight_class, is_italic=is_italic
        )
    except Exception:
        return None


# ── Index building (with module-level cache) ──────────────────────────────────


class _FontIndexKey(NamedTuple):
    """Cache key: one scan per project + theme, so a theme swap doesn't go stale."""

    project_dir: Path
    theme_fonts_dir: Path | None


_index_cache: dict[_FontIndexKey, dict[str, list[_FontRecord]]] = {}


def _build_index(
    project_dir: Path, theme_fonts_dir: Path | None = None, *, force: bool = False
) -> dict[str, list[_FontRecord]]:
    key = _FontIndexKey(project_dir, theme_fonts_dir)
    if not force and key in _index_cache:
        return _index_cache[key]

    index: dict[str, list[_FontRecord]] = {}
    for font_dir in _font_dirs(project_dir, theme_fonts_dir):
        for path in sorted(font_dir.rglob("*")):
            if path.suffix.lower() in _FONT_SUFFIXES:
                record = _read_font_record(path)
                if record:
                    index.setdefault(record.family.lower(), []).append(record)

    _index_cache[key] = index
    return index


def _best_match(
    records: list[_FontRecord], weight_class: int, is_italic: bool
) -> _FontRecord:
    italic_matches = [r for r in records if r.is_italic == is_italic]
    pool = italic_matches if italic_matches else records
    return min(pool, key=lambda r: abs(r.weight_class - weight_class))


# ── SVG analysis ──────────────────────────────────────────────────────────────


def _first_named_family(value: str) -> str | None:
    for part in value.split(","):
        name = part.strip().strip("'\"")
        if name.lower() not in _GENERIC_FAMILIES:
            return name
    return None


def _css_weight_to_int(value: str) -> int | None:
    v = value.strip().lower()
    if v in _WEIGHT_KEYWORDS:
        return _WEIGHT_KEYWORDS[v]
    try:
        return int(v)
    except ValueError:
        return None


_STYLE_FAMILY_RE = re.compile(r"font-family\s*:\s*([^;}\n]+)", re.IGNORECASE)
_STYLE_WEIGHT_RE = re.compile(r"font-weight\s*:\s*([^;}\n]+)", re.IGNORECASE)
_STYLE_STYLE_RE = re.compile(r"font-style\s*:\s*([^;}\n]+)", re.IGNORECASE)


def _specs_from_css_text(css: str) -> list[_FontSpec]:
    specs: list[_FontSpec] = []
    for family_m in _STYLE_FAMILY_RE.finditer(css):
        family = _first_named_family(family_m.group(1))
        if family is None:
            continue
        # Look for weight/style in the same CSS rule (nearby context window)
        start = max(0, family_m.start() - 200)
        end = min(len(css), family_m.end() + 200)
        ctx = css[start:end]
        weight_m = _STYLE_WEIGHT_RE.search(ctx)
        style_m = _STYLE_STYLE_RE.search(ctx)
        weight_class = (
            _css_weight_to_int(weight_m.group(1).strip()) if weight_m else None
        ) or 400
        is_italic = (
            style_m.group(1).strip().lower() in ("italic", "oblique")
            if style_m
            else False
        )
        specs.append(
            _FontSpec(family=family, weight_class=weight_class, is_italic=is_italic)
        )
    return specs


def _spec_collector() -> tuple[list[_FontSpec], Callable[[_FontSpec], None]]:
    """A (result, add) pair accumulating unique specs in first-seen order."""
    seen: set[_FontSpec] = set()
    result: list[_FontSpec] = []

    def add(spec: _FontSpec) -> None:
        if spec not in seen:
            seen.add(spec)
            result.append(spec)

    return result, add


def _collect_specs(root: SvgElement, add: Callable[[_FontSpec], None]) -> None:
    """Feed `add` every font spec referenced in one slide SVG root."""
    # font-family attributes and inline styles on each element
    for el in root.iter():
        family_attr = el.get("font-family")
        if family_attr:
            family = _first_named_family(family_attr)
            if family:
                weight_raw = el.get("font-weight", "normal")
                style_raw = el.get("font-style", "normal")
                weight_class = _css_weight_to_int(weight_raw) or 400
                is_italic = style_raw.lower() in ("italic", "oblique")
                add(
                    _FontSpec(
                        family=family,
                        weight_class=weight_class,
                        is_italic=is_italic,
                    )
                )

        style_attr = el.get("style", "")
        if style_attr and "font-family" in style_attr:
            for spec in _specs_from_css_text(style_attr):
                add(spec)

    # <style> blocks
    for style_el in root.iter(f"{{{ns.SVG}}}style"):
        if style_el.text and "font-family" in style_el.text:
            for spec in _specs_from_css_text(style_el.text):
                add(spec)


def _collect_codepoints(root: SvgElement, codepoints: set[int]) -> None:
    """Add every character codepoint in the text/tail of one slide SVG root."""
    for el in root.iter():
        if el.text:
            codepoints.update(ord(c) for c in el.text)
        if el.tail:
            codepoints.update(ord(c) for c in el.tail)


def extract_font_specs(slides: list[SlideData]) -> list[_FontSpec]:
    result, add = _spec_collector()
    for slide in slides:
        _collect_specs(parse_svg(slide["svg"]), add)
    return result


def extract_font_specs_and_codepoints(
    slides: list[SlideData],
) -> tuple[list[_FontSpec], set[int]]:
    """Font specs and codepoints in a single parse per slide (build/export path)."""
    result, add = _spec_collector()
    codepoints: set[int] = set()
    for slide in slides:
        root = parse_svg(slide["svg"])
        _collect_specs(root, add)
        _collect_codepoints(root, codepoints)
    return result, codepoints


# ── Font subsetting ───────────────────────────────────────────────────────────


def _subset_font(font_path: Path, codepoints: frozenset[int]) -> tuple[bytes, str, str]:
    from fontTools import subset
    from fontTools.ttLib import TTFont

    font = TTFont(font_path)
    subsetter = subset.Subsetter()
    subsetter.populate(unicodes=list(codepoints))  # pyright: ignore[reportUnknownMemberType]
    subsetter.subset(font)  # pyright: ignore[reportUnknownMemberType]
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue(), "font/woff2", "woff2"


# ── @font-face rule generation ────────────────────────────────────────────────


def _font_face_rule(
    family: str,
    weight_class: int,
    is_italic: bool,
    font_bytes: bytes,
    mime: str,
    fmt: str,
) -> str:
    b64 = base64.b64encode(font_bytes).decode()
    css_style = "italic" if is_italic else "normal"
    # Round weight_class to nearest 100, clamp to 100-900
    css_weight = str(max(100, min(900, round(weight_class / 100) * 100)))
    return (
        f"@font-face {{\n"
        f'  font-family: "{family}";\n'
        f'  src: url("data:{mime};base64,{b64}") format("{fmt}");\n'
        f"  font-weight: {css_weight};\n"
        f"  font-style: {css_style};\n"
        f"}}"
    )


def _embed_common(
    specs: list[_FontSpec],
    index: dict[str, list[_FontRecord]],
    get_font_bytes: Callable[[_FontRecord], tuple[bytes, str, str]],
) -> str:
    rules: list[str] = []

    for spec in specs:
        records = index.get(spec.family.lower())
        if not records:
            logger.warning(f'font "{spec.family}" not found in any font directory')
            continue
        record = _best_match(records, spec.weight_class, spec.is_italic)
        try:
            font_bytes, mime, fmt = get_font_bytes(record)
        except Exception as exc:
            logger.warning(
                f'could not read font "{spec.family}" from {record.path}: {exc}'
            )
            continue
        rules.append(
            _font_face_rule(
                spec.family, spec.weight_class, spec.is_italic, font_bytes, mime, fmt
            )
        )
        logger.debug(f'embedded "{spec.family}" from {record.path}')

    if rules:
        logger.info(f"embedded {len(rules)} font face(s)")
    return "\n\n".join(rules)


# ── Public entry points ───────────────────────────────────────────────────────


def embed_fonts_css(
    slides: list[SlideData], project_dir: Path, theme_fonts_dir: Path | None = None
) -> str:
    """Embed full (unsubsetted) fonts — for ``inkflow serve``.

    Font index is cached in-process; subsequent rebuilds pay only the file-read cost.
    Unresolvable fonts are reported via ``inkflow.logging``.
    """
    specs = extract_font_specs(slides)
    if not specs:
        return ""
    index = _build_index(project_dir, theme_fonts_dir)

    def _full(record: _FontRecord) -> tuple[bytes, str, str]:
        suffix = record.path.suffix.lower()
        return (
            record.path.read_bytes(),
            _FONT_MIME.get(suffix, "font/ttf"),
            _FONT_FORMAT.get(suffix, "truetype"),
        )

    return _embed_common(specs, index, _full)


def embed_fonts_css_subsetted(
    slides: list[SlideData], project_dir: Path, theme_fonts_dir: Path | None = None
) -> str:
    """Embed subsetted fonts — for ``inkflow build`` and PDF export.

    Subsets each font to only the codepoints present in the slides, then encodes
    as WOFF2. Falls back to the full font file if subsetting fails. Unresolvable
    fonts and subsetting fallbacks are reported via ``inkflow.logging``.
    """
    specs, codepoint_set = extract_font_specs_and_codepoints(slides)
    if not specs:
        return ""
    codepoints = frozenset(codepoint_set)
    index = _build_index(project_dir, theme_fonts_dir)
    rules: list[str] = []

    for spec in specs:
        records = index.get(spec.family.lower())
        if not records:
            logger.warning(f'font "{spec.family}" not found in any font directory')
            continue
        record = _best_match(records, spec.weight_class, spec.is_italic)
        try:
            font_bytes, mime, fmt = _subset_font(record.path, codepoints)
        except Exception as exc:
            logger.warning(
                f'subsetting failed for "{spec.family}" ({exc}), embedding full font'
            )
            suffix = record.path.suffix.lower()
            font_bytes = record.path.read_bytes()
            mime = _FONT_MIME.get(suffix, "font/ttf")
            fmt = _FONT_FORMAT.get(suffix, "truetype")
        rules.append(
            _font_face_rule(
                spec.family, spec.weight_class, spec.is_italic, font_bytes, mime, fmt
            )
        )
        logger.debug(f'subsetted "{spec.family}" to {len(font_bytes)} bytes')

    if rules:
        logger.info(f"embedded {len(rules)} subsetted font face(s)")
    return "\n\n".join(rules)
