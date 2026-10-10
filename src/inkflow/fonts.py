from __future__ import annotations

import base64
import functools
import hashlib
import io
import os
import re
import sys
import unicodedata
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
        "math",
        "emoji",
        "fangsong",
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
    weight_range: tuple[int, int] | None = None
    """A variable font's ``wght`` axis: every weight in it is this one file."""
    is_color: bool = False
    """A colour font (emoji): drawn as it is at any weight, never made bolder."""


@dataclass(frozen=True)
class _FontSpec:
    family: str
    weight_class: int
    is_italic: bool
    need: str = "always"
    """When a subset build embeds it: ``always``; ``fallback``, a later family
    of a token's list, only for characters the families before it lack (emoji);
    ``math``, the maths font, only for a deck with formulas."""


# ── Font directory discovery ──────────────────────────────────────────────────


SHIPPED_FONTS_DIR: Path = Path(__file__).resolve().parent / "theme" / "fonts"
"""The fonts inkflow ships (the built-in theme's ``fonts/``): Inter, JetBrains
Mono, STIX Two Math and Twemoji. Searched after the project's and the active
theme's own fonts and before any font of this computer, so a deck that names
them looks the same everywhere, whatever its theme."""


def is_shipped(path: Path) -> bool:
    """Whether a font file is one inkflow ships (and so every machine has it)."""
    try:
        return path.resolve().is_relative_to(SHIPPED_FONTS_DIR)
    except OSError:
        return False


def _font_dirs(project_dir: Path, theme_fonts_dir: Path | None) -> list[Path]:
    # Project fonts, then the theme's bundled fonts, then the fonts inkflow ships,
    # then the per-user font dir (via platformdirs), then the OS-wide system dirs.
    # Project wins over theme wins over inkflow wins over system. platformdirs
    # models the user dir on every platform but has no concept of system fonts,
    # so those stay explicit.
    dirs: list[Path] = [project_dir / "fonts"]
    if theme_fonts_dir is not None:
        dirs.append(theme_fonts_dir)
    if theme_fonts_dir is None or theme_fonts_dir.resolve() != SHIPPED_FONTS_DIR:
        dirs.append(SHIPPED_FONTS_DIR)
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
            weight_range: tuple[int, int] | None = None
            if "fvar" in font:
                for axis in font["fvar"].axes:  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
                    if axis.axisTag == "wght":  # pyright: ignore[reportUnknownMemberType]
                        weight_range = (int(axis.minValue), int(axis.maxValue))  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
                # "Inter Variable" is Inter: a variable font answers to the
                # family's own name too.
                family = re.sub(r"\s+Variable$", "", family, flags=re.IGNORECASE)
            is_color = any(t in font for t in ("COLR", "CBDT", "sbix", "SVG "))
        finally:
            font.close()
        return _FontRecord(
            path=path,
            family=family,
            weight_class=weight_class,
            is_italic=is_italic,
            weight_range=weight_range,
            is_color=is_color,
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
                    index.setdefault(_family_key(record.family), []).append(record)

    _index_cache[key] = index
    return index


def _family_key(family: str) -> str:
    """How a family is looked up: case-insensitive, and a variable font's
    "X Variable" is X."""
    return re.sub(r"\s+variable$", "", family.strip().lower())


def _lookup(index: dict[str, list[_FontRecord]], family: str) -> list[_FontRecord]:
    return index.get(_family_key(family)) or index.get(family.lower()) or []


def font_index(
    project_dir: Path, theme_fonts_dir: Path | None = None
) -> list[list[_FontRecord]]:
    """Every font family that can be embedded, each as its font files."""
    return list(_build_index(project_dir, theme_fonts_dir).values())


def _weight_distance(record: _FontRecord, weight_class: int) -> int:
    if record.weight_range is not None:
        lo, hi = record.weight_range
        return max(0, lo - weight_class, weight_class - hi)
    return abs(record.weight_class - weight_class)


def _best_match(
    records: list[_FontRecord], weight_class: int, is_italic: bool
) -> _FontRecord:
    italic_matches = [r for r in records if r.is_italic == is_italic]
    pool = italic_matches if italic_matches else records
    return min(pool, key=lambda r: _weight_distance(r, weight_class))


# ── SVG analysis ──────────────────────────────────────────────────────────────


def _first_named_family(value: str) -> str | None:
    for part in value.split(","):
        name = part.strip().strip("'\"")
        if name.startswith("var("):
            # A theme token (a drawn-in diagram's text): the deck's own font,
            # embedded from the styles that define it.
            return None
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


_FONT_FACE_BLOCK_RE = re.compile(r"@font-face\s*\{[^{}]*\}", re.IGNORECASE)


def _self_defined_families(css: str) -> set[str]:
    """Families a stylesheet defines itself with ``@font-face`` (an SVG that
    carries its own font): nothing to look up or embed for those."""
    out: set[str] = set()
    for face in _FONT_FACE_BLOCK_RE.finditer(css):
        m = _STYLE_FAMILY_RE.search(face.group(0))
        if m:
            name = m.group(1).strip().strip("'\"")
            if name:
                out.add(_family_key(name))
    return out


def _collect_specs(
    root: SvgElement,
    add: Callable[[_FontSpec], None],
    defined: set[str] | None = None,
) -> None:
    """Feed `add` every font spec referenced in one slide SVG root.

    Families the slide defines itself (an ``@font-face`` in one of its
    ``<style>`` blocks) go into `defined` instead of being looked up."""
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
        text = style_el.text
        if text and "font-family" in text:
            if defined is not None:
                defined |= _self_defined_families(text)
            for spec in _specs_from_css_text(_FONT_FACE_BLOCK_RE.sub("", text)):
                add(spec)


def _collect_codepoints(
    root: SvgElement, codepoints: set[int], math: set[int] | None = None
) -> None:
    """Add every character codepoint in the text/tail of one slide SVG root,
    and those inside MathML to `math` (they are drawn in other glyphs too)."""
    for el in root.iter():
        if el.text:
            codepoints.update(ord(c) for c in el.text)
        if el.tail:
            codepoints.update(ord(c) for c in el.tail)
    if math is None:
        return
    for el in root.iter("{*}math"):  # MathML, in whatever namespace it came
        for text in el.itertext():
            math.update(ord(c) for c in str(text))
        math.add(0x221A)  # a root sign is drawn with no √ in the text


_TOKEN_FONT_RE = re.compile(
    r"--inkflow-(?:body|heading|mono|math)-font\s*:\s*([^;}\n]+)", re.IGNORECASE
)


def _named_families(value: str) -> list[str]:
    """Every family a ``font-family`` list names (generics and tokens left out)."""
    out: list[str] = []
    for part in value.split(","):
        name = part.strip().strip("'\"")
        if (
            name
            and not name.startswith("var(")
            and name.lower() not in _GENERIC_FAMILIES
        ):
            out.append(name)
    return out


def _specs_from_tokens(styles_css: str, add: Callable[[_FontSpec], None]) -> None:
    """The theme's font tokens (``--inkflow-body-font: Inter, sans-serif``).

    Zone text reaches its font through ``var(--inkflow-body-font)``, which the
    slide scan cannot resolve, so the families named by the deck's token
    declarations are embedded too: every family of the list (a later one is a
    fallback for what the first lacks, such as emoji), upright and italic,
    regular and bold, the faces body text and headings use. A face a family
    has no file for is not embedded twice: the browser derives it.
    """
    for m in _TOKEN_FONT_RE.finditer(styles_css):
        is_math = m.group(0).lower().startswith("--inkflow-math")
        for i, family in enumerate(_named_families(m.group(1))):
            need = "math" if is_math else "fallback" if i else "always"
            for italic in (False, True):
                for weight in (400, 700):
                    add(_FontSpec(family, weight, italic, need))


def extract_font_specs(slides: list[SlideData]) -> list[_FontSpec]:
    result, add = _spec_collector()
    defined: set[str] = set()
    for slide in slides:
        _collect_specs(parse_svg(slide["svg"]), add, defined)
    return [s for s in result if _family_key(s.family) not in defined]


def extract_font_specs_and_codepoints(
    slides: list[SlideData],
) -> tuple[list[_FontSpec], set[int]]:
    """Font specs and codepoints in a single parse per slide (build/export path)."""
    specs, codepoints, _ = _extract_usage(slides)
    return specs, codepoints


def _extract_usage(
    slides: list[SlideData],
) -> tuple[list[_FontSpec], set[int], set[int]]:
    """Specs, every codepoint, and the codepoints inside MathML."""
    result, add = _spec_collector()
    codepoints: set[int] = set()
    math: set[int] = set()
    defined: set[str] = set()
    for slide in slides:
        root = parse_svg(slide["svg"])
        _collect_specs(root, add, defined)
        _collect_codepoints(root, codepoints, math)
    specs = [s for s in result if _family_key(s.family) not in defined]
    return specs, codepoints, math


# ── Codepoints a subset keeps ─────────────────────────────────────────────────

# Printable ASCII, always: list numbers, a slide number filled in later, CSS
# `content`, text the browser makes up (an ellipsis) all draw in the deck's
# font, and ~100 glyphs cost a few KB.
_BASE_CODEPOINTS: frozenset[int] = frozenset(
    [*range(0x20, 0x7F), 0xA0, 0x2022, 0x2026, 0x2013, 0x2014, 0x2212]
)

# What the browser draws a formula with besides its text: stretched fences,
# radicals, over/under braces and accents.
_MATH_BASE: frozenset[int] = frozenset(
    [
        *range(0x20, 0x7F),
        0x2016, 0x2032, 0x2033, 0x2212, 0x2215, 0x2216, 0x221A, 0x221B, 0x221C,
        0x2223, 0x2225, 0x2308, 0x2309, 0x230A, 0x230B, 0x23B4, 0x23B5,
        0x23DC, 0x23DD, 0x23DE, 0x23DF, 0x23E0, 0x23E1, 0x27E8, 0x27E9,
        0x27EE, 0x27EF, 0x00AF, 0x203E, 0x02C6, 0x02DC, 0x0302, 0x0303,
        0x2190, 0x2192, 0x2194, 0x21D0, 0x21D2, 0x21D4,
    ]
)  # fmt: skip


@functools.cache
def _math_alphanumerics() -> dict[int, frozenset[int]]:
    """Each letter or digit → its styled forms (italic, bold, script, double-struck x…).

    A browser draws a single-letter ``<mi>x</mi>`` as MATHEMATICAL ITALIC x,
    and ``mathvariant`` picks the other styles, so a formula's glyphs are not
    the codepoints written in it."""
    out: dict[int, set[int]] = {}
    styled = [
        *range(0x1D400, 0x1D800),
        *range(0x2100, 0x2150),  # the letterlike holes (planck h, double-struck R…)
    ]
    for cp in styled:
        try:
            name = unicodedata.name(chr(cp))
        except ValueError:
            continue
        base = _math_base_char(name)
        if base is not None:
            out.setdefault(ord(base), set()).add(cp)
    return {k: frozenset(v) for k, v in out.items()}


_STYLED_NAME_RE = re.compile(
    r"""^(?:MATHEMATICAL|DOUBLE-STRUCK|SCRIPT|BLACK-LETTER|ITALIC)\b.*?
    (?:(CAPITAL|SMALL)\ (?:LETTER\ )?(\w+)|DIGIT\ (\w+)|(\w+)\ SYMBOL
    |(NABLA|PARTIAL\ DIFFERENTIAL))$""",
    re.VERBOSE,
)

_SYMBOL_BASES = {
    "EPSILON": "\u03f5",
    "THETA": "\u03d1",
    "KAPPA": "\u03f0",
    "PHI": "\u03d5",
    "RHO": "\u03f1",
    "PI": "\u03d6",
}
_OPERATOR_BASES = {"NABLA": "\u2207", "PARTIAL DIFFERENTIAL": "\u2202"}


def _math_base_char(name: str) -> str | None:
    """The plain character a styled one is drawn for (MATHEMATICAL ITALIC
    SMALL X is x), from its Unicode name."""
    if name == "PLANCK CONSTANT":
        return "h"
    m = _STYLED_NAME_RE.match(name)
    if m is None:
        return None
    case, letter, digit, symbol, operator = m.groups()
    try:
        if digit:
            return unicodedata.lookup(f"DIGIT {digit}")
        if symbol:
            return _SYMBOL_BASES.get(symbol)
        if operator:
            return _OPERATOR_BASES[operator]
        if len(letter) == 1:
            return letter if case == "CAPITAL" else letter.lower()
        return unicodedata.lookup(f"GREEK {case} LETTER {letter}")
    except KeyError:
        return None


def _with_math(codepoints: set[int], math: set[int]) -> set[int]:
    """`codepoints`, and for a deck with formulas what its math font draws them
    with (`_MATH_BASE`, every styled form of each letter in a formula)."""
    if not math:
        return codepoints
    out = codepoints | _MATH_BASE
    styled = _math_alphanumerics()
    for cp in math:
        out |= styled.get(cp, frozenset())
    out.update((0x131, 0x237, 0x1D6A4, 0x1D6A5))  # dotless i/j, for accents
    return out


_CSS_CONTENT_RE = re.compile(r"""content\s*:\s*(["'])(.*?)\1""")


def _css_codepoints(css: str) -> set[int]:
    """Characters a stylesheet draws itself (``content: "✓"``)."""
    out: set[int] = set()
    for m in _CSS_CONTENT_RE.finditer(css):
        text = re.sub(
            r"\\([0-9a-fA-F]{1,6})\s?", lambda e: chr(int(e.group(1), 16)), m.group(2)
        )
        out.update(ord(c) for c in text)
    return out


# ── Font subsetting ───────────────────────────────────────────────────────────

# Private tables to drop up front, added to fontTools' own defaults. FontForge stamps
# a timestamp table into every font it builds (DejaVu, and most libre families);
# fontTools has no subsetter for it, so left to itself it drops the table and warns.
# Naming it here makes the drop our decision and keeps any other fontTools warning at
# full severity.
_DROP_TABLES: tuple[str, ...] = ("FFTM",)


def _subset_font(font_path: Path, codepoints: frozenset[int]) -> tuple[bytes, str, str]:
    from fontTools import subset
    from fontTools.ttLib import TTFont

    font = TTFont(font_path)
    options = subset.Options()
    options.drop_tables += list(_DROP_TABLES)
    # Every OpenType feature, not fontTools' short default list: tabular
    # figures (charts), a math font's script-size forms (ssty), small caps…
    # look the same in a build as when served.
    options.layout_features = ["*"]
    # The whole name table: a font's copyright and licence travel with it.
    options.name_IDs = ["*"]  # pyright: ignore[reportAttributeAccessIssue]
    options.name_languages = ["*"]  # pyright: ignore[reportAttributeAccessIssue]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=list(codepoints))  # pyright: ignore[reportUnknownMemberType]
    subsetter.subset(font)  # pyright: ignore[reportUnknownMemberType]
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue(), "font/woff2", "woff2"


# Bumped whenever `_subset_font` changes what it writes.
_SUBSET_VERSION = b"inkflow-subset-1"


def _subset_cache_dir() -> Path:
    """``$INKFLOW_CACHE_DIR/fonts``, else the user's cache directory."""
    base = os.environ.get("INKFLOW_CACHE_DIR") or platformdirs.user_cache_dir("inkflow")
    return Path(base) / "fonts"


def _subset_cached(
    font_path: Path, codepoints: frozenset[int]
) -> tuple[bytes, str, str]:
    """`_subset_font`, remembered in the user's cache directory by the font's
    content and the characters kept: subsetting a large font takes a second
    or two, and a deck is built, rendered and exported many times over with
    the same text."""
    data = font_path.read_bytes()
    key = hashlib.sha256(
        _SUBSET_VERSION
        + hashlib.sha256(data).digest()
        + ",".join(map(str, sorted(codepoints))).encode()
    ).hexdigest()
    cached = _subset_cache_dir() / f"{key}.woff2"
    try:
        return cached.read_bytes(), "font/woff2", "woff2"
    except OSError:
        pass
    result = _subset_font(font_path, codepoints)
    try:
        cached.parent.mkdir(parents=True, exist_ok=True)
        partial = cached.with_name(f".{key}.{os.getpid()}.tmp")
        partial.write_bytes(result[0])
        os.replace(partial, cached)
    except OSError:
        pass  # a read-only home: subset again next time
    return result


@functools.lru_cache(maxsize=64)
def _coverage_of(path: Path, _stamp: tuple[int, int]) -> frozenset[int]:
    from fontTools.ttLib import TTFont

    try:
        font = TTFont(path, lazy=True)
        try:
            return frozenset(font.getBestCmap() or {})
        finally:
            font.close()
    except Exception:
        return frozenset()


def _coverage(path: Path) -> frozenset[int]:
    """The characters a font file has glyphs for."""
    try:
        st = path.stat()
    except OSError:
        return frozenset()
    return _coverage_of(path, (st.st_size, st.st_mtime_ns))


def _full_font(record: _FontRecord) -> tuple[bytes, str, str]:
    suffix = record.path.suffix.lower()
    return (
        record.path.read_bytes(),
        _FONT_MIME.get(suffix, "font/ttf"),
        _FONT_FORMAT.get(suffix, "truetype"),
    )


# ── @font-face rule generation ────────────────────────────────────────────────


def _face_descriptors(record: _FontRecord) -> tuple[str, str]:
    """``font-weight`` and ``font-style`` describing what the file is, so the
    browser derives (synthesises) a face only when no file has it."""
    if record.is_color:
        # One drawing at every weight: never thickened into a smudge.
        weight = "1 1000"
    elif record.weight_range is not None:
        weight = f"{record.weight_range[0]} {record.weight_range[1]}"
    else:
        # Round weight_class to nearest 100, clamp to 100-900
        weight = str(max(100, min(900, round(record.weight_class / 100) * 100)))
    return weight, "italic" if record.is_italic else "normal"


def _font_face_rule(family: str, record: _FontRecord, src: str) -> str:
    weight, style = _face_descriptors(record)
    return (
        f"@font-face {{\n"
        f'  font-family: "{family}";\n'
        f"  src: {src};\n"
        f"  font-weight: {weight};\n"
        f"  font-style: {style};\n"
        f"}}"
    )


def _data_src(font_bytes: bytes, mime: str, fmt: str) -> str:
    b64 = base64.b64encode(font_bytes).decode()
    return f'url("data:{mime};base64,{b64}") format("{fmt}")'


class _Match(NamedTuple):
    family: str
    record: _FontRecord
    need: str


def _matches(
    specs: list[_FontSpec], index: dict[str, list[_FontRecord]]
) -> list[_Match]:
    """(family, file, need) for each spec, one per file and family (the most
    needed: a family named first anywhere is always embedded), warning once
    for every family no font directory has."""
    out: dict[tuple[str, Path], _Match] = {}
    missing: set[str] = set()
    rank = {"always": 0, "math": 1, "fallback": 2}
    for spec in specs:
        records = _lookup(index, spec.family)
        if not records:
            if spec.family.lower() not in missing:
                missing.add(spec.family.lower())
                logger.warning(f'font "{spec.family}" not found in any font directory')
            continue
        record = _best_match(records, spec.weight_class, spec.is_italic)
        key = (spec.family.lower(), record.path)
        known = out.get(key)
        if known is None or rank[spec.need] < rank[known.need]:
            out[key] = _Match(known.family if known else spec.family, record, spec.need)
    return list(out.values())


def _embed_common(
    specs: list[_FontSpec],
    index: dict[str, list[_FontRecord]],
    get_src: Callable[[_FontRecord], str],
) -> str:
    rules: list[str] = []
    for family, record, _ in _matches(specs, index):
        try:
            src = get_src(record)
        except Exception as exc:
            logger.warning(f'could not read font "{family}" from {record.path}: {exc}')
            continue
        rules.append(_font_face_rule(family, record, src))
        logger.debug(f'embedded "{family}" from {record.path}')

    if rules:
        logger.info(f"embedded {len(rules)} font face(s)")
    return "\n\n".join(rules)


# ── Public entry points ───────────────────────────────────────────────────────

SHIPPED_URL_PREFIX = "/_inkflow/fonts/"
"""Where ``inkflow serve`` serves the fonts inkflow ships (`shipped_font_url`)."""


def shipped_font_url(path: Path) -> str | None:
    """A shipped font's URL on the server (``/_inkflow/fonts/InterVariable.woff2``),
    None for any other file. A served page loads these once and caches them,
    instead of carrying megabytes of base64 in every page and style update."""
    if not is_shipped(path):
        return None
    return SHIPPED_URL_PREFIX + path.resolve().relative_to(SHIPPED_FONTS_DIR).as_posix()


def shipped_font_file(request_path: str) -> Path | None:
    """The file behind a `shipped_font_url`, None for anything else (no
    other file can be reached through it)."""
    path = request_path.split("?", 1)[0].split("#", 1)[0]
    if not path.startswith(SHIPPED_URL_PREFIX):
        return None
    name = path.removeprefix(SHIPPED_URL_PREFIX)
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    found = SHIPPED_FONTS_DIR / name
    if found.suffix.lower() not in _FONT_SUFFIXES or not found.is_file():
        return None
    return found


def font_mime(path: Path) -> str:
    return _FONT_MIME.get(path.suffix.lower(), "font/ttf")


def embed_fonts_css(
    slides: list[SlideData],
    project_dir: Path,
    theme_fonts_dir: Path | None = None,
    *,
    styles_css: str = "",
    font_url: Callable[[Path], str | None] | None = None,
) -> str:
    """Embed full (unsubsetted) fonts — for ``inkflow serve``.

    ``font_url`` names a file the page can load by URL instead (the server
    passes `shipped_font_url`); every other font is a data URI. Font index is
    cached in-process; subsequent rebuilds pay only the file-read cost.
    Unresolvable fonts are reported via ``inkflow.logging``.
    """
    specs, add = _spec_collector()
    for spec in extract_font_specs(slides):
        add(spec)
    _specs_from_tokens(styles_css, add)
    if not specs:
        return ""
    index = _build_index(project_dir, theme_fonts_dir)

    def _src(record: _FontRecord) -> str:
        url = font_url(record.path) if font_url is not None else None
        if url is not None:
            fmt = _FONT_FORMAT.get(record.path.suffix.lower(), "truetype")
            return f'url("{url}") format("{fmt}")'
        return _data_src(*_full_font(record))

    return _embed_common(specs, index, _src)


def font_sources(
    slides: list[SlideData],
    project_dir: Path,
    theme_fonts_dir: Path | None = None,
    *,
    styles_css: str = "",
) -> list[tuple[str, Path | None]]:
    """Each font face the deck uses as (family, the file a build embeds for
    it), the file None when no font directory has the family. Publishing reads
    it to warn about fonts that only this computer has (a CI runner has none
    of the author's fonts); `is_shipped` tells a file every inkflow has."""
    specs, add = _spec_collector()
    for spec in extract_font_specs(slides):
        add(spec)
    _specs_from_tokens(styles_css, add)
    index = _build_index(project_dir, theme_fonts_dir)
    out: list[tuple[str, Path | None]] = []
    for spec in specs:
        records = _lookup(index, spec.family)
        match = (
            _best_match(records, spec.weight_class, spec.is_italic) if records else None
        )
        out.append((spec.family, match.path if match else None))
    return out


def embed_fonts_css_subsetted(
    slides: list[SlideData],
    project_dir: Path,
    theme_fonts_dir: Path | None = None,
    *,
    styles_css: str = "",
) -> str:
    """Embed subsetted fonts — for ``inkflow build`` and PDF export.

    Subsets each font to the codepoints the slides use (plus printable ASCII,
    the characters the stylesheets draw, and for formulas the glyphs a math
    font draws them with), then encodes as WOFF2. Falls back to the full font
    file if subsetting fails. Unresolvable fonts and subsetting fallbacks are
    reported via ``inkflow.logging``.
    """
    found, codepoint_set, math = _extract_usage(slides)
    specs, add = _spec_collector()
    for spec in found:
        add(spec)
    _specs_from_tokens(styles_css, add)
    if not specs:
        return ""
    codepoints = frozenset(
        _with_math(codepoint_set | _BASE_CODEPOINTS | _css_codepoints(styles_css), math)
    )
    index = _build_index(project_dir, theme_fonts_dir)
    rules: list[str] = []
    matches = _matches(specs, index)
    # What the first family of each list draws: a fallback (emoji) is only
    # carried for the characters none of those has.
    covered: set[int] = set()
    for m in matches:
        if m.need == "always":
            covered |= _coverage(m.record.path)
    uncovered = codepoints - covered

    for family, record, need in matches:
        if need == "math" and not math:
            continue
        if need == "fallback" and not uncovered & _coverage(record.path):
            continue
        try:
            font_bytes, mime, fmt = _subset_cached(record.path, codepoints)
        except Exception as exc:
            logger.warning(
                f'subsetting failed for "{family}" ({exc}), embedding full font'
            )
            try:
                font_bytes, mime, fmt = _full_font(record)
            except OSError as err:
                logger.warning(
                    f'could not read font "{family}" from {record.path}: {err}'
                )
                continue
        rules.append(_font_face_rule(family, record, _data_src(font_bytes, mime, fmt)))
        logger.debug(f'subsetted "{family}" to {len(font_bytes)} bytes')

    if rules:
        logger.info(f"embedded {len(rules)} subsetted font face(s)")
    return "\n\n".join(rules)


# ── The interface's own fonts ─────────────────────────────────────────────────

UI_FAMILY = "Inkflow UI"
"""The editor's and presenter's interface text: Inter, under a name of its own
so it never mixes with a deck that embeds Inter subset to its slides."""
UI_MONO_FAMILY = "Inkflow UI Mono"
"""The presenter's status bar and panels, and the editor's code fields:
JetBrains Mono."""
UI_SYMBOLS_FAMILY = "Inkflow UI Symbols"
"""Arrows and shapes neither of those has (the editor's ⇄ ▦ ⤒): STIX Two Math."""
UI_EMOJI_FAMILY = "Inkflow UI Emoji"
"""Pictographs in menus (the editor's folder and link icons): Twemoji."""

_UI_FILES: tuple[tuple[str, str], ...] = (
    (UI_FAMILY, "InterVariable.woff2"),
    (UI_MONO_FAMILY, "JetBrainsMono-Variable.woff2"),
    (UI_SYMBOLS_FAMILY, "STIXTwoMath-Regular.woff2"),
    (UI_EMOJI_FAMILY, "TwemojiMozilla.woff2"),
)
_UI_PRIMARY = 2
"""The first two always come; the others are fallbacks, carried by a build
only for characters the first two lack."""


def ui_fonts_css(text: str | None = None) -> str:
    """``@font-face`` rules for the interface fonts, so the editor and the
    presenter look the same on every computer.

    With no ``text`` (a served page) they point at `shipped_font_url` (the
    browser fetches a fallback only when a character needs it); with the
    ``text`` an exported page shows (its interface, titles, notes), each is a
    data URI subset to those characters, so a static build carries them."""
    rules: list[str] = []
    codepoints = (
        frozenset(_BASE_CODEPOINTS | {ord(c) for c in text})
        if text is not None
        else None
    )
    uncovered = set(codepoints or ())
    for i, (family, name) in enumerate(_UI_FILES):
        path = SHIPPED_FONTS_DIR / name
        record = _read_font_record(path)
        if record is None:
            continue
        if codepoints is None:
            src = f'url("{SHIPPED_URL_PREFIX}{name}") format("woff2")'
        else:
            coverage = _coverage(path)
            if i >= _UI_PRIMARY and not uncovered & coverage:
                continue
            uncovered -= coverage
            try:
                src = _data_src(*_subset_cached(path, codepoints))
            except Exception as exc:
                logger.warning(f"could not subset the interface font {name}: {exc}")
                continue
        rules.append(_font_face_rule(family, record, src))
    return "\n".join(rules)
