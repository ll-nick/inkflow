"""Where a deck's fonts come from, and bringing the machine's into the deck.

A build embeds every font it finds (``fonts.py``), searching the project's
``fonts/``, the theme's fonts, then this computer's user and system font
folders. Only the first two travel with a ``git clone``: the project's fonts
are committed, the theme's ship with the inkflow (or theme) version the deck
pins. A font found only among this computer's fonts makes the deck look
different everywhere else, and a stack that starts with a generic family
(``sans-serif``) is whatever the viewing machine picks.

`font_report` answers, per family the deck names, where it resolves:

- ``project``: the project's ``fonts/`` (committed with the deck);
- ``theme``: the active theme's or inkflow's own fonts (pinned with it);
- ``machine``: a user or system font folder of this computer only;
- ``missing``: nowhere (the browser falls back to something);
- ``generic``: a generic family first in the stack (the OS decides).

Families come from the theme's font tokens as the cascade leaves them (the
last ``--inkflow-body-font`` etc. wins, so a project override replaces the
theme's choice), other ``font-family`` declarations in the deck's styles, and
every ``font-family`` attribute, inline style and ``<style>`` block in the
built slides (SVG text, Markdown HTML, charts, drawn-in diagrams). Each
family lists the faces (weight, italic) the deck uses; zone text adds bold and
italic body faces where its HTML has ``<strong>``/``<em>``.

`plan_bundle` copies the ``machine`` fonts' files for the faces used (or all
of them) into ``fonts/<family>/`` with the licence files found beside them,
and lists each family in ``fonts/README.md``. Licences are read from those
files and the font's own name table; a font whose licence forbids sharing, or
says nothing, is bundled with a warning rather than refused, since the author
may only want it on their own machines.
"""

from __future__ import annotations

import contextlib
import re
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING

from inkflow import fonts
from inkflow.layout import builtin_theme_dir
from inkflow.ns import XHTML

if TYPE_CHECKING:
    from inkflow.manifest import Deck
    from inkflow.pipeline import SlideData
    from inkflow.svgio import SvgElement


class Where(StrEnum):
    PROJECT = "project"
    THEME = "theme"
    MACHINE = "machine"
    MISSING = "missing"
    GENERIC = "generic"


FONT_SUFFIXES = frozenset({".ttf", ".otf", ".woff", ".woff2", ".ttc"})

PORTABLE = frozenset({Where.PROJECT, Where.THEME})

_MAPPED_GENERICS = frozenset({"sans-serif", "sans", "monospace"})
"""Generic families a slide may name that the build points at the deck's own
fonts (contract.css for the attribute, svg.theme_generic_fonts inline)."""

ROLES = ("body", "heading", "mono")
"""The theme's font tokens: ``--inkflow-<role>-font``."""

GENERIC_OF_ROLE = {"body": "sans-serif", "heading": "sans-serif", "mono": "monospace"}

_CSS_GENERICS = frozenset(
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
        "-apple-system",
        "blinkmacsystemfont",
    }
)
_NOT_FAMILIES = frozenset({"inherit", "initial", "unset", "revert", "revert-layer"})


@dataclass(frozen=True, order=True)
class Face:
    """One weight/style of a family the deck uses."""

    weight: int = 400
    italic: bool = False

    @property
    def label(self) -> str:
        return f"{self.weight}{' italic' if self.italic else ''}"


@dataclass(frozen=True)
class Licence:
    status: str
    """``open``, ``restricted`` (sharing not allowed) or ``unknown``."""
    name: str
    """The licence as recognised (``SIL Open Font License``), or ``""``."""
    files: tuple[Path, ...] = ()
    """Licence and README files found beside the font."""


@dataclass
class FontFile:
    path: Path
    where: Where
    weight: int
    italic: bool


@dataclass
class FamilyReport:
    family: str
    where: Where
    faces: list[Face] = field(default_factory=list)
    used_by: list[str] = field(default_factory=list)
    stack: str = ""
    files: list[FontFile] = field(default_factory=list)
    """The files a build embeds for the faces used."""
    licence: Licence | None = None
    system: str | None = None
    """Whose system font it is (``Microsoft``), for a well-known one."""
    alternative: str | None = None
    """An open font to use instead of a system one."""

    @property
    def portable(self) -> bool:
        return self.where in PORTABLE

    def message(self) -> str:
        """One line saying what is not portable about it, and what to do."""
        if self.where is Where.GENERIC:
            what = (
                f"the generic font {self.family}"
                if self.stack.strip().lower() == self.family.lower()
                else f'"{self.stack}", starting with the generic {self.family},'
            )
            return (
                f"text set in {what} looks different on each machine (used by "
                + f"{', '.join(self.used_by[:2])}"
                + (" …" if len(self.used_by) > 2 else "")
                + "): name a font first (inkflow fonts set, or the Theme dialog)"
            )
        if self.where is Where.MISSING:
            hint = f", e.g. {self.alternative}" if self.alternative else ""
            return (
                f'font "{self.family}" is not installed here: install it or put '
                + f"its files in fonts/, or pick an open font{hint}"
            )
        if self.where is Where.MACHINE:
            paths = sorted(
                {str(f.path) for f in self.files if f.where is Where.MACHINE}
            )
            where = f" ({paths[0]}{' …' if len(paths) > 1 else ''})" if paths else ""
            if self.system:
                return (
                    f'font "{self.family}" comes from this machine{where}, a '
                    + f"{self.system} system font others may not have or share: "
                    + f"pick an open font such as {self.alternative or 'Inter'}"
                )
            return (
                f'font "{self.family}" comes from this machine{where}: '
                + "inkflow fonts bundle, or pick an open font"
            )
        return ""

    def json(self, project_dir: Path) -> dict[str, object]:
        def show(path: Path) -> str:
            try:
                return path.relative_to(project_dir).as_posix()
            except ValueError:
                return str(path)

        return {
            "family": self.family,
            "where": self.where.value,
            "faces": [f.label for f in self.faces],
            "usedBy": self.used_by,
            "stack": self.stack,
            "files": [
                {
                    "path": show(f.path),
                    "where": f.where.value,
                    "face": Face(f.weight, f.italic).label,
                }
                for f in self.files
            ],
            "licence": (
                {
                    "status": self.licence.status,
                    "name": self.licence.name,
                    "files": [show(p) for p in self.licence.files],
                }
                if self.licence
                else None
            ),
            "system": self.system,
            "alternative": self.alternative,
            "message": self.message(),
        }


# ── Well-known system fonts ──

_SYSTEM_FONTS: dict[str, tuple[str, str]] = {
    "arial": ("Microsoft/Monotype", "Arimo (same metrics) or Inter"),
    "arial black": ("Microsoft/Monotype", "Archivo Black"),
    "helvetica": ("Apple/Monotype", "Arimo (same metrics) or Inter"),
    "helvetica neue": ("Apple/Monotype", "Inter"),
    "segoe ui": ("Microsoft", "Inter or Noto Sans"),
    "segoe ui emoji": ("Microsoft", "Noto Color Emoji"),
    "sf pro": ("Apple", "Inter"),
    "sf pro display": ("Apple", "Inter"),
    "sf pro text": ("Apple", "Inter"),
    "sf mono": ("Apple", "JetBrains Mono"),
    "san francisco": ("Apple", "Inter"),
    "new york": ("Apple", "Source Serif 4"),
    "apple color emoji": ("Apple", "Noto Color Emoji"),
    "calibri": ("Microsoft", "Carlito (same metrics)"),
    "cambria": ("Microsoft", "Caladea (same metrics)"),
    "candara": ("Microsoft", "Open Sans"),
    "consolas": ("Microsoft", "JetBrains Mono or Inconsolata"),
    "constantia": ("Microsoft", "Source Serif 4"),
    "corbel": ("Microsoft", "Open Sans"),
    "aptos": ("Microsoft", "Inter"),
    "times new roman": ("Microsoft/Monotype", "Tinos (same metrics)"),
    "times": ("Apple/Linotype", "Tinos (same metrics)"),
    "courier new": ("Microsoft/Monotype", "Cousine (same metrics)"),
    "verdana": ("Microsoft", "DejaVu Sans"),
    "tahoma": ("Microsoft", "DejaVu Sans"),
    "trebuchet ms": ("Microsoft", "Fira Sans"),
    "georgia": ("Microsoft", "Gelasio (same metrics)"),
    "comic sans ms": ("Microsoft", "Comic Neue"),
    "impact": ("Microsoft", "Anton"),
    "garamond": ("Monotype", "EB Garamond"),
    "book antiqua": ("Monotype", "TeX Gyre Pagella"),
    "palatino": ("Linotype", "TeX Gyre Pagella"),
    "palatino linotype": ("Linotype", "TeX Gyre Pagella"),
    "century gothic": ("Monotype", "Questrial"),
    "franklin gothic medium": ("Microsoft", "Libre Franklin"),
    "lucida grande": ("Apple", "Inter"),
    "lucida console": ("Microsoft", "JetBrains Mono"),
    "menlo": ("Apple", "JetBrains Mono or DejaVu Sans Mono"),
    "monaco": ("Apple", "JetBrains Mono"),
    "avenir": ("Linotype", "Nunito Sans"),
    "avenir next": ("Linotype", "Nunito Sans"),
    "futura": ("Bauer", "Jost"),
    "gill sans": ("Monotype", "Cabin"),
    "optima": ("Linotype", "Marcellus"),
    "myriad pro": ("Adobe", "Source Sans 3"),
    "minion pro": ("Adobe", "Crimson Pro"),
}


def system_font(family: str) -> tuple[str, str] | None:
    """(whose, an open alternative) for a well-known proprietary system font."""
    return _SYSTEM_FONTS.get(family.strip().lower())


# ── Licences ──

_LICENCE_NAMES = re.compile(
    r"^(ofl|licen[cs]e|copying|copyright|readme|fontlog|ufl|apache)", re.I
)
_OPEN = [
    (
        re.compile(r"open font licen[cs]e|\bOFL\b|scripts\.sil\.org/OFL", re.I),
        "SIL Open Font License",
    ),
    (re.compile(r"apache licen[cs]e|apache\.org/licenses", re.I), "Apache License"),
    (re.compile(r"ubuntu font licen[cs]e", re.I), "Ubuntu Font Licence"),
    (re.compile(r"bitstream vera|dejavu", re.I), "Bitstream Vera / DejaVu licence"),
    (re.compile(r"GUST Font Licen[cs]e", re.I), "GUST Font License"),
    (re.compile(r"GNU General Public Licen[cs]e|\bGPL\b", re.I), "GNU GPL"),
    (re.compile(r"\bMIT Licen[cs]e\b", re.I), "MIT License"),
    (re.compile(r"IPA Font Licen[cs]e", re.I), "IPA Font License"),
    (re.compile(r"LaTeX Project Public Licen[cs]e|\bLPPL\b", re.I), "LPPL"),
    (
        re.compile(r"public domain|creativecommons\.org/publicdomain", re.I),
        "public domain",
    ),
]
_RESTRICTED = re.compile(
    r"may not be (?:re)?distributed|not be redistributed|shall not (?:re)?distribute"
    + r"|\bEULA\b|end[- ]user licen[cs]e agreement|as permitted by the EULA"
    + r"|all rights reserved\.? *(?:no part|you may not)",
    re.I,
)
_MAX_LICENCE_TEXT = 64 * 1024


def _licence_files(font: Path, roots: list[Path]) -> list[Path]:
    """Licence/README files beside the font, or in its family's folder (one
    or two levels up, never a font root such as /usr/share/fonts)."""
    found: list[Path] = []
    folder = font.parent
    for _ in range(3):
        if any(folder == r for r in roots) or folder == folder.parent:
            break
        try:
            here = sorted(
                p
                for p in folder.iterdir()
                if p.is_file() and _LICENCE_NAMES.match(p.name)
            )
        except OSError:
            here = []
        if here:
            found = here
            break
        folder = folder.parent
    return found


def _name_table(path: Path) -> tuple[str, int]:
    """The font's licence text (name IDs 13, 14 and 0) and its OS/2 fsType."""
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(path, lazy=True, fontNumber=0)
        try:
            name = font["name"]
            parts = [name.getDebugName(i) or "" for i in (13, 14, 0)]
            os2 = font.get("OS/2")
            fs_type = int(os2.fsType) if os2 is not None else 0  # pyright: ignore[reportAttributeAccessIssue, reportUnknownArgumentType, reportUnknownMemberType]
        finally:
            font.close()
    except Exception:
        return "", 0
    return "\n".join(p for p in parts if p), fs_type


def is_variable(path: Path) -> bool:
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(path, lazy=True, fontNumber=0)
        try:
            return "fvar" in font
        finally:
            font.close()
    except Exception:
        return False


def licence_of(family: str, path: Path, roots: list[Path]) -> Licence:
    """What the files beside ``path`` and its name table say about sharing it."""
    files = _licence_files(path, roots)
    texts: list[str] = []
    for file in files:
        try:
            with file.open("rb") as f:
                texts.append(f.read(_MAX_LICENCE_TEXT).decode("utf-8", "replace"))
        except OSError:
            continue
    embedded, fs_type = _name_table(path)
    texts.append(embedded)
    text = "\n".join(texts)
    system = system_font(family)
    if system is not None:
        return Licence("restricted", f"{system[0]} system font", tuple(files))
    if fs_type & 0x0002:
        return Licence("restricted", "no embedding allowed (fsType)", tuple(files))
    for pattern, name in _OPEN:
        if pattern.search(text):
            return Licence("open", name, tuple(files))
    if _RESTRICTED.search(text):
        return Licence("restricted", "proprietary licence", tuple(files))
    return Licence("unknown", "", tuple(files))


# ── The fonts a deck uses ──

_TOKEN_RE = re.compile(
    r"--inkflow-(?P<role>body|heading|mono)-font\s*:\s*(?P<value>[^;}\n]+)", re.I
)
_HEADING_WEIGHT_RE = re.compile(r"--inkflow-heading-weight\s*:\s*(\d+)")
_FAMILY_RE = re.compile(r"font-family\s*:\s*([^;}\n]+)", re.I)
_WEIGHT_RE = re.compile(r"font-weight\s*:\s*([^;}\n]+)", re.I)
_STYLE_RE = re.compile(r"font-style\s*:\s*([^;}\n]+)", re.I)


def stack(value: str) -> list[str]:
    """A ``font-family`` value as its family names, quotes removed."""
    names = [p.strip().strip("'\"").strip() for p in value.split(",")]
    return [n for n in names if n]


def first_family(value: str) -> tuple[str, bool] | None:
    """The family a ``font-family`` value asks for first, and whether that is a
    generic one; None for ``inherit``, a ``var()`` or nothing."""
    names = stack(value.replace("!important", ""))
    if not names:
        return None
    first = names[0]
    if first.lower().startswith("var(") or first.lower() in _NOT_FAMILIES:
        return None
    return first, first.lower() in _CSS_GENERICS


def effective_tokens(styles_css: str) -> dict[str, str]:
    """The font tokens as the cascade leaves them: the last declaration of each
    (the project's styles.css loads last and overrides the theme)."""
    out: dict[str, str] = {}
    for m in _TOKEN_RE.finditer(styles_css):
        out[m.group("role").lower()] = m.group("value").strip()
    return out


def _heading_weight(styles_css: str) -> int:
    found = [int(m.group(1)) for m in _HEADING_WEIGHT_RE.finditer(styles_css)]
    return found[-1] if found else 600


def _weight(value: str | None) -> int:
    if not value:
        return 400
    return fonts._css_weight_to_int(value.strip()) or 400  # pyright: ignore[reportPrivateUsage]


def _italic(value: str | None) -> bool:
    return value is not None and value.strip().lower() in ("italic", "oblique")


@dataclass
class _Usage:
    family: str
    stack: str
    generic: bool
    faces: set[Face] = field(default_factory=set)
    used_by: list[str] = field(default_factory=list)


@dataclass
class _Collector:
    found: dict[str, _Usage] = field(default_factory=dict)
    own: set[str] = field(default_factory=set)
    """Families a slide defines itself (``@font-face`` in its SVG): they travel
    inside the slide, nothing to look up."""

    def add(self, value: str, face: Face, where: str) -> None:
        first = first_family(value)
        if first is None:
            return
        family, generic = first
        if family_key(family) in self.own:
            return
        key = family.lower()
        usage = self.found.get(key)
        if usage is None:
            usage = self.found[key] = _Usage(family, value.strip(), generic)
        usage.faces.add(face)
        if where not in usage.used_by:
            usage.used_by.append(where)

    def css(self, css: str, where: str) -> None:
        for m in _FAMILY_RE.finditer(css):
            context = css[max(0, m.start() - 200) : m.end() + 200]
            weight = _WEIGHT_RE.search(context)
            style = _STYLE_RE.search(context)
            self.add(
                m.group(1),
                Face(
                    _weight(weight.group(1) if weight else None),
                    _italic(style.group(1) if style else None),
                ),
                where,
            )

    def svg(self, root: SvgElement, where: str) -> set[str]:
        """Font declarations in one built slide; returns the HTML text tags it
        uses (strong, em, h1…, code) for the token faces."""
        tags: set[str] = set()
        for el in root.iter():
            tag = str(el.tag)  # a comment's tag is a function: no "}" in it
            local = tag.rpartition("}")[2].lower()
            if tag.startswith(f"{{{XHTML}}}") or local in ("strong", "em"):
                tags.add(local)
            if local == "style" and el.text and "font-family" in el.text:
                self.css(el.text, where)
                continue
            family = el.get("font-family")
            # contract.css maps a generic attribute to the deck's own fonts
            # (and svg.theme_generic_fonts an inline style): the token's
            # family is what is drawn, reported under its role.
            if family and family.strip().strip("'\"").lower() not in _MAPPED_GENERICS:
                self.add(
                    family,
                    Face(_weight(el.get("font-weight")), _italic(el.get("font-style"))),
                    where,
                )
            style = el.get("style") or ""
            if "font-family" in style:
                self.css(style, where)
        return tags


def _token_faces(role: str, tags: set[str], heading_weight: int) -> set[Face]:
    """The faces of a role's font the slides' text uses; a role nothing uses
    yet gets its plain face (the next heading or code block will)."""
    if role == "heading":
        return {Face(heading_weight)}
    if role == "mono":
        faces = {Face(400)}
        if tags & {"code", "pre"} and tags & {"strong", "b"}:
            faces.add(Face(700))
        return faces
    faces = {Face(400)}
    bold = bool(tags & {"strong", "b", "th"})
    italic = bool(tags & {"em", "i", "cite"})
    if bold:
        faces.add(Face(700))
    if italic:
        faces.add(Face(400, True))
    if bold and italic:
        faces.add(Face(700, True))
    return faces


# ── Where the files are ──


@dataclass(frozen=True)
class FontDirs:
    project: Path
    theme: list[Path]
    machine: list[Path]

    @classmethod
    def for_deck(cls, deck: Deck, project_dir: Path) -> FontDirs:
        theme_dirs = [deck.theme.fonts_dir, builtin_theme_dir() / "fonts"]
        searched = fonts._font_dirs(project_dir, deck.theme.fonts_dir)  # pyright: ignore[reportPrivateUsage]
        theme = [d for d in dict.fromkeys(theme_dirs)]
        project = project_dir / "fonts"
        machine = [
            d
            for d in searched
            if d != project and d not in theme and not _inside(d, [project, *theme])
        ]
        return cls(project, theme, machine)

    @property
    def all(self) -> list[Path]:
        return [d for d in [self.project, *self.theme, *self.machine] if d.is_dir()]

    def where(self, path: Path) -> Where:
        if _inside(path, [self.project]):
            return Where.PROJECT
        if _inside(path, self.theme):
            return Where.THEME
        return Where.MACHINE


def _inside(path: Path, dirs: list[Path]) -> bool:
    try:
        real = path.resolve()
    except OSError:
        real = path
    return any(real.is_relative_to(d.resolve()) or path.is_relative_to(d) for d in dirs)


@dataclass(frozen=True)
class _Record:
    path: Path
    family: str
    weight: int
    italic: bool
    weight_range: tuple[int, int] | None = None
    """A variable font's weight axis: every weight in it is this one file."""

    def distance(self, weight: int) -> int:
        """How far this file is from a weight, as the build measures it
        (``fonts._weight_distance``)."""
        if self.weight_range is not None:
            lo, hi = self.weight_range
            return max(0, lo - weight, weight - hi)
        return abs(self.weight - weight)


def build_index(dirs: FontDirs) -> dict[str, list[_Record]]:
    """Every font file in the deck's font folders by family (read afresh: a
    bundle just copied may be among them)."""
    index: dict[str, list[_Record]] = {}
    for folder in dirs.all:
        for path in sorted(folder.rglob("*")):
            if path.suffix.lower() not in FONT_SUFFIXES:
                continue
            record = fonts._read_font_record(path)  # pyright: ignore[reportPrivateUsage]
            if record is not None:
                index.setdefault(family_key(record.family), []).append(
                    _Record(
                        path,
                        record.family,
                        record.weight_class,
                        record.is_italic,
                        record.weight_range,
                    )
                )
    return index


def family_key(family: str) -> str:
    """How the build looks a family up: any case, "X Variable" is X."""
    return fonts._family_key(family)  # pyright: ignore[reportPrivateUsage]


def _best(records: list[_Record], face: Face) -> _Record:
    """The file the build embeds for a face (``fonts._best_match``): the
    closest weight, a variable font matching every weight on its axis; the
    project's files win a tie, then the theme's and inkflow's, then this
    machine's, in the order the build searches them."""
    same = [r for r in records if r.italic == face.italic] or records
    return min(same, key=lambda r: r.distance(face.weight))


# ── The report ──


@dataclass
class FontReport:
    families: list[FamilyReport]
    tokens: dict[str, str]
    """The font token values as the cascade leaves them."""
    dirs: FontDirs

    def by_family(self, family: str) -> FamilyReport | None:
        key = family.lower()
        return next((f for f in self.families if f.family.lower() == key), None)

    @property
    def problems(self) -> list[FamilyReport]:
        return [f for f in self.families if not f.portable]

    def json(self, project_dir: Path) -> dict[str, object]:
        return {
            "families": [f.json(project_dir) for f in self.families],
            "tokens": self.tokens,
            "fontsDir": "fonts",
        }


def font_report(
    deck: Deck,
    project_dir: Path,
    slides: list[SlideData] | None = None,
    *,
    index: dict[str, list[_Record]] | None = None,
) -> FontReport:
    """Every family the deck uses and where it comes from (see the module)."""
    from inkflow.loaders import load_deck_styles, load_style
    from inkflow.pipeline import process_deck
    from inkflow.svgio import parse_svg

    if slides is None:
        slides = process_deck(deck, project_dir, project_dir / "deck.py")
    styles = load_deck_styles(deck, project_dir)
    tokens = effective_tokens(styles)
    heading_weight = _heading_weight(styles)
    collector = _Collector()
    for slide in slides:
        collector.own |= fonts._self_defined_families(slide["svg"])  # pyright: ignore[reportPrivateUsage]
    tags: set[str] = set()
    for slide in slides:
        label = f"slide {slide['id']}" if slide.get("id") else "a slide"
        tags |= collector.svg(parse_svg(slide["svg"]), label)
    for role in ROLES:
        value = tokens.get(role)
        if value is None:
            continue
        faces = _token_faces(role, tags, heading_weight)
        for face in sorted(faces):
            collector.add(value, face, f"{role} font")
    # Other font-family declarations in the deck's own styles (not the tokens'
    # var() uses in contract.css).
    project_styles = project_dir / "styles.css"
    if project_styles.is_file():
        collector.css(project_styles.read_text(encoding="utf-8"), "styles.css")
    theme_css = deck.theme.styles_css()
    if theme_css:
        collector.css(theme_css, "theme styles.css")
    if deck.style is not None:
        with contextlib.suppress(OSError):
            collector.css(load_style(deck.style, project_dir), "Deck(style=)")

    dirs = FontDirs.for_deck(deck, project_dir)
    if index is None:
        index = build_index(dirs)
    families: list[FamilyReport] = []
    for key, usage in collector.found.items():
        family = usage.family
        faces = sorted(usage.faces)
        report = FamilyReport(family, Where.GENERIC, faces, usage.used_by, usage.stack)
        if usage.generic:
            families.append(report)
            continue
        if (known := system_font(family)) is not None:
            report.system, report.alternative = known
        records = index.get(family_key(key))
        if not records:
            report.where = Where.MISSING
            families.append(report)
            continue
        report.family = records[0].family
        chosen: dict[Path, FontFile] = {}
        for face in faces:
            record = _best(_ordered(records, dirs), face)
            if record.path not in chosen:
                chosen[record.path] = FontFile(
                    record.path, dirs.where(record.path), record.weight, record.italic
                )
        report.files = list(chosen.values())
        places = {f.where for f in report.files}
        report.where = (
            Where.MACHINE
            if Where.MACHINE in places
            else Where.THEME
            if Where.THEME in places
            else Where.PROJECT
        )
        first = report.files[0].path
        report.licence = licence_of(report.family, first, dirs.all)
        families.append(report)
    order = {w: i for i, w in enumerate(Where)}
    families.sort(key=lambda f: (-order[f.where], f.family.lower()))
    return FontReport(families, tokens, dirs)


def _ordered(records: list[_Record], dirs: FontDirs) -> list[_Record]:
    """Project files first, then the theme's, then this machine's: ``min``
    keeps the first of equally good matches."""
    rank = {Where.PROJECT: 0, Where.THEME: 1, Where.MACHINE: 2}
    return sorted(records, key=lambda r: rank[dirs.where(r.path)])


# ── Bundling ──


@dataclass(frozen=True)
class Copy:
    src: Path
    dst: Path
    """Absolute, inside the project's fonts/."""


@dataclass
class BundlePlan:
    copies: list[Copy] = field(default_factory=list)
    readme: str | None = None
    """New text of fonts/README.md (None: unchanged)."""
    texts: dict[Path, str] = field(default_factory=dict)
    """Licence text read from a font's name table, for a family whose folder
    holds no licence file (``fonts/<family>/LICENSE-from-font.txt``)."""
    families: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)

    def json(self, project_dir: Path) -> dict[str, object]:
        return {
            "copies": [
                {"from": str(c.src), "to": c.dst.relative_to(project_dir).as_posix()}
                for c in self.copies
            ],
            "written": [p.relative_to(project_dir).as_posix() for p in self.texts],
            "families": self.families,
            "warnings": self.warnings,
            "missing": self.missing,
        }


README_BEGIN = "<!-- inkflow:fonts (written by `inkflow fonts bundle`) -->"
README_END = "<!-- /inkflow:fonts -->"
_README_HEAD = """\
# Fonts

The fonts this deck uses, committed so it looks the same on every machine
(`inkflow build` embeds them from here). Keep each font's licence beside it.

"""
_ROW = re.compile(r"^\| (?P<family>[^|]+?) \|")


def family_dir(family: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", family.lower()).strip("-") or "font"


def licence_warning(family: FamilyReport) -> str | None:
    licence = family.licence
    if family.system:
        return (
            f'"{family.family}" is a {family.system} system font: its licence '
            + "does not let you share it. Bundled for your own machines only; "
            + f"pick an open font such as {family.alternative} before sharing the deck"
        )
    if licence is None or licence.status == "unknown":
        return (
            f'"{family.family}": no licence found beside it or in the font; check '
            + "that you may share it before committing fonts/"
        )
    if licence.status == "restricted":
        return (
            f'"{family.family}" has a {licence.name}: it may not be shared. '
            + "Bundled for your own machines only; pick an open font before sharing"
        )
    return None


def plan_bundle(
    report: FontReport,
    project_dir: Path,
    *,
    families: list[str] | None = None,
    all_weights: bool = False,
    index: dict[str, list[_Record]] | None = None,
) -> BundlePlan:
    """The copies that bring every ``machine`` family (or only ``families``)
    into ``fonts/<family>/``, with their licences and the README."""
    plan = BundlePlan()
    wanted = {f.lower() for f in families} if families is not None else None
    fonts_dir = project_dir / "fonts"
    taken: set[Path] = set()
    rows: dict[str, str] = {}
    for family in report.families:
        if wanted is not None and family.family.lower() not in wanted:
            continue
        if family.where is Where.MISSING:
            plan.missing.append(family.message())
            continue
        if family.where is not Where.MACHINE:
            continue
        sources = [f.path for f in family.files if f.where is Where.MACHINE]
        if all_weights or any(is_variable(p) for p in sources):
            records = (index or build_index(report.dirs)).get(family.family.lower(), [])
            machine = [
                r.path for r in records if report.dirs.where(r.path) is Where.MACHINE
            ]
            variable = [p for p in machine if is_variable(p)]
            if variable and not all_weights:
                # A variable font is every weight in one file (two with italics).
                italic = any(f.italic for f in family.faces)
                sources = [
                    p for p in variable if italic or not _record_italic(records, p)
                ]
            elif all_weights:
                sources = machine
        folder = fonts_dir / family_dir(family.family)
        for src in dict.fromkeys(sources):
            _add_copy(plan, src, folder / src.name, taken)
        licence = family.licence or licence_of(
            family.family, sources[0], report.dirs.all
        )
        for src in licence.files:
            _add_copy(plan, src, folder / src.name, taken)
        if not licence.files and sources:
            embedded = _name_table(sources[0])[0]
            target = folder / "LICENSE-from-font.txt"
            if embedded and not target.exists():
                plan.texts[target] = (
                    f"{family.family}: licence as the font file states it "
                    + f"({sources[0].name}, name table)\n\n{embedded}\n"
                )
        plan.families.append(family.family)
        if (warning := licence_warning(family)) is not None:
            plan.warnings.append(warning)
        source = str(sources[0].parent) if sources else ""
        name = licence.name or ("none found" if licence.status == "unknown" else "")
        rows[family.family.lower()] = (
            f"| {family.family} | `{family_dir(family.family)}/` | {source} | {name} |"
        )
    if rows:
        plan.readme = _readme(fonts_dir / "README.md", rows)
    return plan


def _record_italic(records: list[_Record], path: Path) -> bool:
    return any(r.italic for r in records if r.path == path)


def _add_copy(plan: BundlePlan, src: Path, dst: Path, taken: set[Path]) -> None:
    if dst.exists():
        try:
            if dst.read_bytes() == src.read_bytes():
                return
        except OSError:
            return
        n = 2
        stem, suffix = dst.stem, dst.suffix
        while dst.exists() or dst in taken:
            dst = dst.with_name(f"{stem}-{n}{suffix}")
            n += 1
    if dst in taken:
        return
    taken.add(dst)
    plan.copies.append(Copy(src, dst))


def _readme(path: Path, rows: dict[str, str]) -> str:
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    start, end = text.find(README_BEGIN), text.find(README_END)
    existing: dict[str, str] = {}
    if start >= 0 and end > start:
        for line in text[start:end].splitlines():
            m = _ROW.match(line)
            if m and not line.startswith("| Family") and not line.startswith("|--"):
                existing[m.group("family").strip().lower()] = line
    existing.update(rows)
    table = "\n".join(
        [
            README_BEGIN,
            "| Family | Folder | Copied from | Licence |",
            "|--|--|--|--|",
            *[existing[k] for k in sorted(existing)],
            README_END,
        ]
    )
    if start >= 0 and end > start:
        return text[:start] + table + text[end + len(README_END) :]
    if not text:
        return _README_HEAD + table + "\n"
    return text.rstrip("\n") + "\n\n" + table + "\n"


# ── Setting a font ──


class FontSetError(ValueError):
    pass


_IDENT = re.compile(r"^-?[A-Za-z_][\w-]*$")


def token_value(role: str, family: str) -> str:
    """The token value ``inkflow fonts set ROLE FAMILY`` writes: the family
    (quoted when CSS needs it) with the role's generic fallback, or a whole
    stack as given. Refuses a generic family first."""
    if role not in ROLES:
        raise FontSetError(f"no font role {role!r}: body, heading or mono")
    family = family.strip()
    if not family:
        raise FontSetError("no font family given")
    first = first_family(family)
    if first is None:
        raise FontSetError(f"{family!r} names no font")
    name, generic = first
    if generic:
        raise FontSetError(
            f"{name} is a generic family: each machine shows its own font. Name a "
            + f"font first, e.g. inkflow fonts set {role} Inter (open, ships with "
            + f"most systems) - {name} is added as the fallback"
        )
    if "," in family:
        return family
    words = name.split()
    quoted = name if all(_IDENT.match(w) for w in words) else f'"{name}"'
    return f"{quoted}, {GENERIC_OF_ROLE[role]}"


def role_faces(report: FontReport, role: str) -> list[Face]:
    """The faces a role's font is used in now (bold body text…)."""
    value = report.tokens.get(role)
    first = first_family(value) if value else None
    if first is not None:
        current = report.by_family(first[0])
        if current is not None and current.faces:
            return current.faces
    return [Face(600)] if role == "heading" else [Face(400), Face(700)]


def family_report(
    family: str, faces: list[Face], dirs: FontDirs, index: dict[str, list[_Record]]
) -> FamilyReport:
    """Where one family would come from, used in ``faces``."""
    report = FamilyReport(family, Where.MISSING, faces, [], family)
    if (known := system_font(family)) is not None:
        report.system, report.alternative = known
    records = index.get(family.lower())
    if not records:
        return report
    report.family = records[0].family
    chosen: dict[Path, FontFile] = {}
    for face in faces:
        record = _best(_ordered(records, dirs), face)
        chosen.setdefault(
            record.path,
            FontFile(
                record.path, dirs.where(record.path), record.weight, record.italic
            ),
        )
    report.files = list(chosen.values())
    places = {f.where for f in report.files}
    report.where = (
        Where.MACHINE
        if Where.MACHINE in places
        else Where.THEME
        if Where.THEME in places
        else Where.PROJECT
    )
    report.licence = licence_of(report.family, report.files[0].path, dirs.all)
    return report
