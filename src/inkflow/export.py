from __future__ import annotations

import base64
import importlib.resources
import re
import shutil
import subprocess
import tempfile
from html import escape as escape_html
from pathlib import Path
from typing import cast

from inkflow.assets import (
    MIME_TYPES,
    REFERENCE_PATTERNS,
    AssetRoots,
    is_local_ref,
    rewrite_references,
)
from inkflow.enums import ColorMode
from inkflow.fonts import embed_fonts_css_subsetted
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import logger
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.server import State, build_html, load_deck
from inkflow.titles import resolve_deck_title

# ── build ─────────────────────────────────────────────────────────────────────


def _asset_roots(deck: Deck, project_dir: Path) -> AssetRoots:
    return AssetRoots(project_dir, deck.theme.asset_dir())


def build_static_html(
    deck_path: Path, out_dir: Path, inline_assets: bool = False
) -> None:
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir)
    transitions = resolve_transitions(deck)
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(slides, project_dir, deck.theme.fonts_dir)
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()
    scripts_js = load_deck_scripts(deck, project_dir)

    # After font subsetting: inlining stuffs base64 into the same slide strings the
    # subsetter scans for used characters, and every one of them would be kept.
    roots = _asset_roots(deck, project_dir)
    if inline_assets:
        _inline_assets(slides, roots, out_dir)
    else:
        _copy_assets(slides, roots, out_dir)

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
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_bytes(build_html(state, ws_port=None))


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


def _copy_assets(slides: list[SlideData], roots: AssetRoots, out_dir: Path) -> None:
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


def _inline_assets(slides: list[SlideData], roots: AssetRoots, out_dir: Path) -> None:
    """Replace every asset reference with a data URI, leaving `index.html` alone.

    Each reference is inlined where it stands, so an asset several slides share is
    carried once per use and the output grows accordingly.

    An asset whose suffix names no media type is copied out as usual and reported.
    """
    uris: dict[str, str] = {}
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
                + f"in index.html and load before the deck renders: {ref}"
            )
        uris[ref] = _data_uri(src, mime)

    for slide in slides:
        slide["svg"] = rewrite_references(slide["svg"], uris.get)
        slide["notes"] = rewrite_references(slide["notes"], uris.get)


# ── export (PDF) ──────────────────────────────────────────────────────────────


def _slide_dimensions(svg_str: str) -> tuple[int, int]:
    """Extract slide width and height from an SVG viewBox, falling back to 1920x1080."""
    m = re.search(r'viewBox="[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)"', svg_str)
    if m:
        return int(float(m.group(1))), int(float(m.group(2)))
    return 1920, 1080


def build_pdf(
    deck_path: Path,
    output: Path,
    chromium: str | None = None,
    no_sandbox: bool = False,
    size: tuple[int, int] | None = None,
) -> None:
    exe = chromium or _find_chromium()
    if exe is None:
        raise RuntimeError(
            "Chromium not found. Install chromium or google-chrome,"
            + " or pass --chromium PATH."
        )

    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir)
    if not slides:
        raise RuntimeError("Cannot export a PDF: the deck has no visible slides.")
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(slides, project_dir, deck.theme.fonts_dir)
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()

    w, h = size if size is not None else _slide_dimensions(slides[0]["svg"])
    dim_css = (
        f"@page {{ size: {w}px {h}px; margin: 0; }}\n"
        f".slide {{ width: {w}px; height: {h}px; }}"
    )
    styles_css = f"{dim_css}\n{styles_css}".strip()

    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("pdf.html").read_text(encoding="utf-8")
    data_theme = "" if deck.effective_mode == ColorMode.DARK else "light"
    title = resolve_deck_title(deck, project_dir)

    with tempfile.TemporaryDirectory() as tmp:
        _copy_assets(slides, _asset_roots(deck, project_dir), Path(tmp))
        slides_html = "\n".join(f'<div class="slide">{s["svg"]}</div>' for s in slides)
        html = (
            template.replace("/* __STYLES__ */", styles_css)
            .replace("__DATA_THEME__", data_theme)
            .replace("__SLIDES__", slides_html)
            .replace("__TITLE__", escape_html(title))
        )
        html_path = Path(tmp) / "slides.html"
        html_path.write_text(html, encoding="utf-8")
        cmd = [
            exe,
            "--headless",
            "--disable-gpu",
            "--print-to-pdf-no-header",
            f"--print-to-pdf={output.resolve()}",
            html_path.as_uri(),
        ]
        if no_sandbox:
            cmd.insert(1, "--no-sandbox")
        subprocess.run(cmd, check=True)


def _find_chromium() -> str | None:
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
    return None
