from __future__ import annotations

import base64
import importlib.resources
import os
import re
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from html import escape as escape_html
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast

from typing_extensions import override

from inkflow import ns
from inkflow.assets import (
    MIME_TYPES,
    REFERENCE_PATTERNS,
    AssetRoots,
    is_local_ref,
    rewrite_references,
)
from inkflow.cdp import chromium_said
from inkflow.enums import ColorMode
from inkflow.fonts import embed_fonts_css_subsetted, ui_fonts_css
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import logger
from inkflow.manifest import Deck
from inkflow.pdfboxes import PageBoxes, set_page_boxes
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.server import State, build_html, load_deck
from inkflow.sizes import PageSize, parse_view_box, physical_length_pt
from inkflow.svg import canvas_size
from inkflow.svgio import SvgElement, parse_svg, serialize_svg
from inkflow.titles import resolve_deck_title

# ── build ─────────────────────────────────────────────────────────────────────


def asset_roots(deck: Deck, project_dir: Path) -> AssetRoots:
    return AssetRoots(project_dir, deck.theme.asset_dir())


def build_static_html(
    deck_path: Path, out_dir: Path, inline_assets: bool = True
) -> None:
    """Write the deck as ``out_dir/index.html``, viewable with no server.

    By default the page is self-contained: every picture, video and font is
    inside it (data URIs), so it opens offline from anywhere and makes no
    request at all. ``inline_assets=False`` (``inkflow build
    --assets-folder``) copies the pictures and videos beside it instead, the
    better shape for a large deck on a web host; fonts stay inside either way.
    """
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir, deck_path)
    transitions = resolve_transitions(deck)
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(
            slides, project_dir, deck.theme.fonts_dir, styles_css=styles_css
        )
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()
    scripts_js = load_deck_scripts(deck, project_dir)

    # After font subsetting: inlining stuffs base64 into the same slide strings the
    # subsetter scans for used characters, and every one of them would be kept.
    roots = asset_roots(deck, project_dir)
    inlined: dict[str, int] = {}
    if inline_assets:
        inlined = _inline_assets(slides, roots, out_dir)
        styles_css = _inline_css_urls(styles_css, roots, inlined)
        _warn_remote(slides)
    else:
        copy_assets(slides, roots, out_dir)
        _copy_css_urls(styles_css, roots, out_dir)

    state: State = {
        "slides": slides,
        "transitions": transitions,
        "styles_css": styles_css,
        "scripts_js": scripts_js,
        "mode": deck.effective_mode,
        "ws_clients": set(),
        "error": None,
        "position": {"slideIndex": 0, "step": 0},
        "logs": [],
        "title": resolve_deck_title(deck, project_dir),
        "theme_dir": deck.theme.asset_dir(),
    }
    ui_fonts = ui_fonts_css(_interface_text(state)) if deck.embed_fonts else ""
    html = build_html(state, ws_port=None, ui_fonts=ui_fonts)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_bytes(html)
    if inline_assets and len(html) > SINGLE_FILE_WARN_BYTES:
        _warn_large(len(html), inlined)


SINGLE_FILE_WARN_BYTES = 50_000_000
"""Past this, a single-file build is worth a word: the whole file loads before
the first slide shows, and some hosts and mail servers refuse it."""


def _warn_large(size: int, inlined: dict[str, int]) -> None:
    biggest = sorted(inlined.items(), key=lambda kv: kv[1], reverse=True)[:3]
    named = ", ".join(f"{ref} ({n / 1_000_000:.1f} MB)" for ref, n in biggest)
    logger.warning(
        f"index.html is {size / 1_000_000:.0f} MB, all of it loaded before the "
        + "first slide shows"
        + (f"; the largest assets: {named}" if named else "")
        + ". `inkflow build --assets-folder` keeps them beside it as files."
    )


_JS_ESCAPE_RE = re.compile(r"\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})")


def _interface_text(state: State) -> str:
    """Every character the presenter's interface can show for this deck: its
    own words (template and bundles, whose non-ASCII text esbuild writes as
    ``\\u`` escapes), slide titles, the deck title and the speaker notes."""
    pkg = importlib.resources.files("inkflow")
    parts = [
        pkg.joinpath("presenter.html").read_text(encoding="utf-8"),
        pkg.joinpath("bundles", "presenter.css").read_text(encoding="utf-8"),
    ]
    js = pkg.joinpath("bundles", "presenter.js").read_text(encoding="utf-8")
    parts.append(js)
    parts += [
        chr(int(m.group(1) or m.group(2), 16)) for m in _JS_ESCAPE_RE.finditer(js)
    ]
    parts.append(state["title"])
    for slide in state["slides"]:
        parts.append(slide["title"])
        parts.append(re.sub(r"<[^>]*>", "", slide["notes"]))
    return "".join(parts)


_CSS_URL_RE = re.compile(r"""url\(\s*(["']?)([^"')]+)\1\s*\)""")


def _css_refs(css: str) -> list[str]:
    """Local files a stylesheet names with ``url()``, relative to the page (the
    project root, where the served page lives)."""
    refs: list[str] = []
    for m in _CSS_URL_RE.finditer(css):
        ref = m.group(2).strip().split("?", 1)[0].split("#", 1)[0]
        if ref and is_local_ref(ref) and not ref.startswith(("#", "/")):
            refs.append(ref)
    return refs


def _inline_css_urls(css: str, roots: AssetRoots, inlined: dict[str, int]) -> str:
    """The deck's stylesheet with every local ``url()`` (a background picture,
    a font named by path) as a data URI."""
    uris: dict[str, str] = {}
    for ref in set(_css_refs(css)):
        src = roots.locate(ref)
        mime = _url_mime(src)
        if src is None or mime is None or not src.is_file():
            logger.warning(f"styles: url({ref}) not found, not inlined")
            continue
        uris[ref] = _data_uri(src, mime)
        inlined[ref] = src.stat().st_size

    def substitute(m: re.Match[str]) -> str:
        ref = m.group(2).strip().split("?", 1)[0].split("#", 1)[0]
        uri = uris.get(ref)
        return f'url("{uri}")' if uri is not None else m.group(0)

    return _CSS_URL_RE.sub(substitute, css) if uris else css


def _copy_css_urls(css: str, roots: AssetRoots, out_dir: Path) -> None:
    for ref in set(_css_refs(css)):
        src = roots.locate(ref)
        if src is not None and src.is_file():
            _copy_asset(src, out_dir / ref)


_FONT_MIME_TYPES = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


def _url_mime(src: Path | None) -> str | None:
    if src is None:
        return None
    suffix = src.suffix.lower()
    return MIME_TYPES.get(suffix) or _FONT_MIME_TYPES.get(suffix)


def _warn_remote(slides: list[SlideData]) -> None:
    """Pictures on the web stay links: the single file needs a network for
    them. Named once each, so the author can download them into the deck."""
    remote: dict[str, str] = {}
    for slide in slides:
        for pattern in REFERENCE_PATTERNS:
            for ref in cast(list[str], pattern.findall(slide["svg"] + slide["notes"])):
                if ref.startswith(("http://", "https://", "//")):
                    remote.setdefault(ref, slide["id"])
    for ref, label in remote.items():
        logger.warning(
            f"{label}: {ref} is on the web, not in the deck: the page loads it "
            + "from there and shows nothing offline"
        )


def _local_refs(text: str) -> list[str]:
    """Copyable asset references in one produced SVG or notes fragment.

    Each pattern scans the whole text on its own rather than being folded into one
    alternation, because a `<video>` carries both a `src` and a `poster` and a
    single scan would resume past the first of them.
    """
    refs: list[str] = []
    for pattern in REFERENCE_PATTERNS:
        for ref in cast(list[str], pattern.findall(text)):
            if is_local_ref(ref):
                refs.append(ref)
    return refs


def _slide_refs(slide: SlideData) -> list[str]:
    """Every copyable asset reference one produced slide carries."""
    return _local_refs(slide["svg"]) + _local_refs(slide["notes"])


def _referenced_assets(slides: list[SlideData]) -> dict[str, str]:
    """``{ref: slide id}`` for every copyable asset the produced slides reference.

    Reading the emitted SVG and notes rather than walking the deck keeps the copy
    step honest: what a slide actually carries is what lands in the output, so a
    zone that was pruned takes its asset with it. Every reference here has been
    canonicalised by the pipeline, so it is already project-root relative.

    Deduped on the ref, since a layout's or an overlay's image is referenced once
    per slide. The id is only there to name a slide in a warning, so the first one
    to reach an asset keeps it: for a ref every slide shares, that is the earliest
    slide in deck order rather than an arbitrary one.
    """
    by_ref: dict[str, str] = {}
    for slide in slides:
        for ref in _slide_refs(slide):
            by_ref.setdefault(ref, slide["id"])
    return by_ref


def copy_assets(slides: list[SlideData], roots: AssetRoots, out_dir: Path) -> None:
    """Copy every asset the slides reference into `out_dir`, mirroring the source tree.

    A canonical ref is relative and free of ``..`` by construction, so `out_dir /
    ref` always lands inside the output and the reference keeps working there
    unchanged. A ref that could not be canonicalised was already reported when it
    was resolved, and `locate` refuses it here.
    """
    for ref, label in _referenced_assets(slides).items():
        src = roots.locate(ref)
        if src is None:
            continue
        if not src.is_file():
            logger.warning(
                f"{label}: asset not found, not copied into the build: {ref}"
            )
            continue
        _copy_asset(src, out_dir / ref)


def _copy_asset(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _data_uri(src: Path, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(src.read_bytes()).decode('ascii')}"


# Below this, inlining a video is unremarkable: the deck still parses quickly and
# browsers hold the blob without fuss. Past it the base64 payload dominates
# `index.html` and blanks the screen while the document loads, which is worth a word.
_INLINE_VIDEO_WARN_BYTES = 20_000_000


def _inline_assets(
    slides: list[SlideData], roots: AssetRoots, out_dir: Path
) -> dict[str, int]:
    """Replace every asset reference with a data URI, leaving `index.html` alone.

    Each reference is inlined where it stands, so an asset several slides share is
    carried once per use and the output grows accordingly. Returns each inlined
    asset's size in bytes.

    An asset whose suffix names no media type is copied out as usual and reported.
    """
    uris: dict[str, str] = {}
    sizes: dict[str, int] = {}
    for ref, label in _referenced_assets(slides).items():
        src = roots.locate(ref)
        if src is None:
            continue
        if not src.is_file():
            logger.warning(
                f"{label}: asset not found, not inlined into the build: {ref}"
            )
            continue
        mime = MIME_TYPES.get(src.suffix.lower())
        if mime is None:
            logger.warning(
                f"{label}: unknown media type, copied beside index.html "
                + f"rather than inlined: {ref}"
            )
            _copy_asset(src, out_dir / ref)
            continue
        if mime.startswith("video/") and src.stat().st_size >= _INLINE_VIDEO_WARN_BYTES:
            size = src.stat().st_size / 1_000_000
            logger.warning(
                f"{label}: inlining a {size:.1f} MB video, whose bytes then travel "
                + f"in index.html and load before the deck renders: {ref} "
                + "(`inkflow build --assets-folder` keeps it beside index.html)"
            )
        uris[ref] = _data_uri(src, mime)
        sizes[ref] = src.stat().st_size

    for slide in slides:
        slide["svg"] = rewrite_references(slide["svg"], uris.get)
        slide["notes"] = rewrite_references(slide["notes"], uris.get)
    return sizes


# ── export (PDF) ──────────────────────────────────────────────────────────────


def slide_dimensions(svg_str: str) -> tuple[int, int]:
    """Extract slide width and height from an SVG viewBox, falling back to 1920x1080."""
    m = re.search(r'viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"', svg_str)
    if m:
        return int(float(m.group(1))), int(float(m.group(2)))
    return 1920, 1080


MM_PT = 72 / 25.4


@dataclass(frozen=True)
class PdfPage:
    """One page of a PDF export: the trimmed page (the finished sheet) in
    points, the slide's canvas drawn onto it, and the bleed around it."""

    width: float
    """Trimmed page width, in points."""
    height: float
    canvas: tuple[float, float]
    """The slide's ``viewBox`` width and height, fitted onto the page."""
    bleed: float = 0.0
    """Printed past each trimmed edge, in points (the background carries on)."""
    marks: bool = False
    """Crop marks in a margin outside the bleed."""

    @property
    def margin(self) -> float:
        """From the paper's edge to the trimmed page, in points."""
        return self.bleed + (_mark_gap(self.bleed) + _MARK_LEN if self.marks else 0)

    @property
    def paper(self) -> tuple[float, float]:
        """The whole sheet Chromium prints, in points."""
        return self.width + 2 * self.margin, self.height + 2 * self.margin

    @property
    def key(self) -> tuple[float, ...]:
        return (
            round(self.width, 2),
            round(self.height, 2),
            round(self.bleed, 2),
            float(self.marks),
        )


_MARK_LEN = 14.17  # 5 mm: how long a crop mark is
_MARK_WIDTH = 0.5  # pt


def _mark_gap(bleed: float) -> float:
    """Crop marks start this far from the trimmed edge: past the bleed, so a
    cut a little off the line never shows them (at least 3 mm)."""
    return max(bleed, 3 * MM_PT)


def parse_bleed(value: str | float | None) -> float:
    """A bleed as given (``3mm``, ``0.125in``, ``9pt``, or a number of mm), in
    points."""
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        points = float(value) * MM_PT
    else:
        text = value.strip().lower()
        if re.fullmatch(r"\d+(\.\d+)?", text):
            text += "mm"
        found = physical_length_pt(text)
        if found is None:
            raise ValueError(
                f"bleed must be a length such as 3mm or 0.125in, not {value!r}"
            )
        points = found
    if not 0 <= points <= 72:
        raise ValueError("bleed must be between 0 and 1 inch (25.4 mm)")
    return points


def pdf_pages(
    slides: list[SlideData],
    deck: Deck,
    size: PageSize | None = None,
    bleed: float = 0.0,
    marks: bool = False,
) -> list[PdfPage]:
    """The page each slide prints on.

    ``size`` (``inkflow export --size``) or else the deck's own size gives
    every page that sheet, each slide fitted onto it (a slide of another shape
    is letterboxed). A deck without a size prints each slide at its own: the
    ``width``/``height`` of its SVG when given in a unit of length (``841mm``,
    as Inkscape writes an A0 page), else its viewBox at 1 unit = 1 CSS px.
    """
    sheet = size if size is not None else deck.size
    pages: list[PdfPage] = []
    for slide in slides:
        canvas = _canvas(slide["svg"])
        if sheet is not None:
            w, h = PageSize(sheet).page_pt
        else:
            w, h = _own_page(slide["svg"], canvas)
        pages.append(PdfPage(w, h, canvas, bleed, marks))
    return pages


def _root_attrs(svg: str) -> dict[str, str]:
    head = re.match(r"\s*(?:<\?xml[^>]*\?>\s*)?<svg\b([^>]*)>", svg)
    if head is None:
        return {}
    return {
        m.group(1): m.group(3)
        for m in re.finditer(r'([\w:-]+)\s*=\s*(["\'])(.*?)\2', head.group(1))
    }


def _canvas(svg: str) -> tuple[float, float]:
    attrs = _root_attrs(svg)
    box = parse_view_box(attrs.get("viewBox"))
    if box is not None:
        return box[2], box[3]
    w, h = slide_dimensions(svg)
    return float(w), float(h)


def is_paper_svg(svg: str) -> bool:
    """Whether an SVG is drawn on paper: its ``width`` or ``height`` is a
    length in mm, cm, in, pt or pc (an Inkscape A0 page)."""
    attrs = _root_attrs(svg)
    return any(
        physical_length_pt(attrs.get(a)) is not None for a in ("width", "height")
    )


def _own_page(svg: str, canvas: tuple[float, float]) -> tuple[float, float]:
    """A slide's page from its own SVG: physical width/height, else its canvas
    in CSS px."""
    attrs = _root_attrs(svg)
    w = physical_length_pt(attrs.get("width"))
    h = physical_length_pt(attrs.get("height"))
    if w is not None and h is not None:
        return w, h
    if w is not None:  # one length given: the other from the canvas's shape
        return w, w * canvas[1] / canvas[0]
    if h is not None:
        return h * canvas[0] / canvas[1], h
    return canvas[0] * 0.75, canvas[1] * 0.75


def _pt(value: float) -> str:
    return f"{round(value, 3):g}pt"


def _size(width: float, height: float) -> str:
    return f"width: {_pt(width)}; height: {_pt(height)};"


def _box(offset: float, width: float, height: float) -> str:
    return f"left: {_pt(offset)}; top: {_pt(offset)}; {_size(width, height)}"


def _page_css(pages: list[PdfPage]) -> tuple[str, list[str]]:
    """The CSS for every distinct page size, and each slide's page class.

    Every size is a named ``@page`` and each slide's box names it with
    ``page:``, which Chromium honours page by page, so a deck of mixed sizes
    prints each slide on its own sheet."""
    names: dict[tuple[float, ...], str] = {}
    css: list[str] = ["@page { margin: 0; }"]
    classes: list[str] = []
    for page in pages:
        name = names.get(page.key)
        if name is None:
            name = f"p{len(names)}"
            names[page.key] = name
            pw, ph = page.paper
            m, b = page.margin, page.bleed
            box = _box(m - b, page.width + 2 * b, page.height + 2 * b)
            css += [
                f"@page {name} {{ size: {_pt(pw)} {_pt(ph)}; margin: 0; }}",
                f".slide.{name} {{ page: {name}; {_size(pw, ph)} }}",
                f".slide.{name} > .bleed {{ {box} }}",
                f".slide.{name} .trim {{ {_box(b, page.width, page.height)} }}",
            ]
        classes.append(name)
    return "\n".join(css), classes


def _crop_marks(page: PdfPage) -> str:
    """Crop marks at the trimmed page's corners, in the margin past the bleed."""
    pw, ph = page.paper
    m = page.margin
    gap, length = _mark_gap(page.bleed), _MARK_LEN
    lines: list[str] = []

    def line(x1: float, y1: float, x2: float, y2: float) -> str:
        return f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}"/>'

    for x in (m, m + page.width):
        for y in (m, m + page.height):
            sx = -1 if x == m else 1
            sy = -1 if y == m else 1
            # Beside the corner along each edge, never inside the bleed.
            lines.append(line(x + sx * gap, y, x + sx * (gap + length), y))
            lines.append(line(x, y + sy * gap, x, y + sy * (gap + length)))
    attrs = " ".join(
        [
            'class="marks"',
            'xmlns="http://www.w3.org/2000/svg"',
            f'viewBox="0 0 {pw:.3f} {ph:.3f}"',
            'stroke="#000"',
            f'stroke-width="{_MARK_WIDTH}"',
        ]
    )
    return f"<svg {attrs}>{''.join(lines)}</svg>"


def extend_backgrounds(svg: str, bleed_units: float) -> str:
    """The slide with each picture or rectangle that covers the whole canvas
    (a background) grown by ``bleed_units`` on every side, so it runs on into
    the bleed instead of stopping at the trimmed edge."""
    if bleed_units <= 0:
        return svg
    root = parse_svg(svg)
    canvas = canvas_size(root)
    box = parse_view_box(root.get("viewBox"))
    if canvas is None:
        return svg
    x0, y0 = (box[0], box[1]) if box is not None else (0.0, 0.0)
    w, h = canvas
    for el in root.iter(f"{{{ns.SVG}}}rect", f"{{{ns.SVG}}}image"):
        if _transformed(el, root):
            continue
        try:
            geo = [float(el.get(a, "0")) for a in ("x", "y", "width", "height")]
        except ValueError:
            continue
        if not (
            abs(geo[0] - x0) < 0.5
            and abs(geo[1] - y0) < 0.5
            and abs(geo[2] - w) < 0.5
            and abs(geo[3] - h) < 0.5
        ):
            continue
        el.set("x", f"{x0 - bleed_units:g}")
        el.set("y", f"{y0 - bleed_units:g}")
        el.set("width", f"{w + 2 * bleed_units:g}")
        el.set("height", f"{h + 2 * bleed_units:g}")
        if el.tag == f"{{{ns.SVG}}}image" and not el.get("preserveAspectRatio"):
            el.set("preserveAspectRatio", "xMidYMid slice")
    return serialize_svg(root)


def _transformed(el: SvgElement, root: SvgElement) -> bool:
    node: SvgElement | None = el
    while node is not None and node is not root:
        if node.get("transform") or node.tag == f"{{{ns.SVG}}}svg":
            return node is not el or bool(node.get("transform"))
        node = node.getparent()
    return False


def build_pdf(
    deck_path: Path,
    output: Path,
    chromium: str | None = None,
    no_sandbox: bool = False,
    size: PageSize | str | tuple[float, float] | None = None,
    bleed: str | float | None = None,
    crop_marks: bool = False,
) -> None:
    """Print the deck to a PDF, one page per slide (`pdf_pages` decides each
    page's size). ``size`` overrides the deck's (a `PageSize`, its name, or a
    ``(width, height)`` in px); ``bleed`` (``3mm``) prints the background past
    each trimmed edge and ``crop_marks`` marks the corners outside it."""
    exe = chromium or find_chromium()
    if exe is None:
        raise RuntimeError(
            "Chromium not found. Install chromium or google-chrome,"
            + " or pass --chromium PATH."
        )
    if isinstance(size, tuple):
        size = PageSize.px(*size)
    sheet = PageSize(size) if size is not None else None
    bleed_pt = parse_bleed(bleed)

    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir, deck_path)
    if not slides:
        raise RuntimeError("Cannot export a PDF: the deck has no visible slides.")
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(
            slides, project_dir, deck.theme.fonts_dir, styles_css=styles_css
        )
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()

    pages = pdf_pages(slides, deck, sheet, bleed_pt, crop_marks)
    page_css, classes = _page_css(pages)
    styles_css = f"{page_css}\n{styles_css}".strip()

    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("pdf.html").read_text(encoding="utf-8")
    data_theme = "" if deck.effective_mode == ColorMode.DARK else "light"
    title = resolve_deck_title(deck, project_dir)

    with tempfile.TemporaryDirectory() as tmp:
        copy_assets(slides, asset_roots(deck, project_dir), Path(tmp))
        slides_html = "\n".join(
            _slide_html(s["svg"], page, name)
            for s, page, name in zip(slides, pages, classes, strict=True)
        )
        html = (
            template.replace("/* __STYLES__ */", styles_css)
            .replace("__DATA_THEME__", data_theme)
            .replace("__SLIDES__", slides_html)
            .replace("__TITLE__", escape_html(title))
        )
        (Path(tmp) / "slides.html").write_text(html, encoding="utf-8")
        target = output.resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        # A file left from an earlier export must not pass for this one.
        target.unlink(missing_ok=True)
        with served(Path(tmp)) as url:
            cmd = [
                exe,
                "--headless",
                "--disable-gpu",
                "--print-to-pdf-no-header",
                f"--print-to-pdf={target}",
                f"{url}/slides.html",
            ]
            if no_sandbox:
                cmd.insert(1, "--no-sandbox")
            _run_chromium(cmd, target, b"%PDF")
    # Chromium writes page sizes on a grid of about 1/75 in: the exact sizes,
    # and the trim and bleed boxes when there is bleed.
    set_page_boxes(
        target, [PageBoxes(*page.paper, page.margin, page.bleed) for page in pages]
    )


def _slide_html(svg: str, page: PdfPage, name: str) -> str:
    bleed_class = ""
    if page.bleed > 0:
        cw, ch = page.canvas
        scale = min(page.width / cw, page.height / ch)  # points per unit
        svg = extend_backgrounds(svg, page.bleed / scale)
        bleed_class = " bled"
    marks = _crop_marks(page) if page.marks else ""
    return (
        f'<div class="slide {name}{bleed_class}"><div class="bleed">'
        f'<div class="trim">{svg}</div></div>{marks}</div>'
    )


@contextmanager
def served(directory: Path) -> Generator[str]:
    """Serve ``directory`` on a loopback port for the length of the block.

    The page is handed to Chromium over HTTP rather than as a ``file://`` URL:
    a Chromium installed as a snap (Ubuntu's ``chromium``) or a Flatpak has its
    own private ``/tmp`` and cannot see the temporary directory the page is
    written to, so it would print its "file not found" page instead of the
    deck. Every confined browser can still reach localhost.
    """
    handler = partial(_QuietHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class _QuietHandler(SimpleHTTPRequestHandler):
    @override
    def log_message(self, format: str, *args: object) -> None:
        pass


def _run_chromium(cmd: list[str], target: Path, magic: bytes) -> None:
    """Run Chromium to write ``target`` and check that it did.

    Chromium reports most failures only on stderr, and a confined one (snap,
    Flatpak) that may not write where it was asked exits 0 without a file, so
    both the exit status and the file itself are checked, and either failure
    is raised with what Chromium said.
    """
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise RuntimeError(f"could not start {cmd[0]}: {exc}") from exc
    said = chromium_said(result.stderr)
    if result.returncode != 0:
        raise RuntimeError(
            f"{Path(cmd[0]).name} failed (exit status {result.returncode})" + said
        )
    try:
        with target.open("rb") as f:
            ok = f.read(len(magic)) == magic
    except OSError:
        ok = False
    if not ok:
        raise RuntimeError(
            f"{Path(cmd[0]).name} did not write {target}. A Chromium installed as"
            + " a snap or Flatpak may only write inside your home folder (not in"
            + " /tmp or a hidden folder): pick an output there, or pass"
            + " --chromium with another Chromium-based browser."
            + said
        )


def find_chromium() -> str | None:
    for name in (
        "chrome",
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "msedge",  # Chromium-based Edge, ships with Windows
    ):
        if found := shutil.which(name):
            return found
    return _playwright_chromium()


def _playwright_chromium() -> str | None:
    """A Chromium that Playwright downloaded, common on CI and agent machines."""
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH"),
        str(Path.home() / ".cache" / "ms-playwright"),
        str(Path.home() / "Library" / "Caches" / "ms-playwright"),
    ]
    patterns = (
        "chromium-*/chrome-linux*/chrome",
        "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
        "chromium-*/chrome-win*/chrome.exe",
    )
    for root in filter(None, roots):
        base = Path(root)
        for pattern in patterns:
            found = sorted(base.glob(pattern), reverse=True)
            if found:
                return str(found[0])
    return None
