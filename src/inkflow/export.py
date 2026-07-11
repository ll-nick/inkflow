from __future__ import annotations

import importlib.resources
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import cast

from inkflow.enums import ColorMode
from inkflow.fonts import embed_fonts_css_subsetted
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.manifest import Deck, Media
from inkflow.pipeline import SlideData, process_deck, resolve_transitions
from inkflow.server import State, build_html, load_deck

# ── build ─────────────────────────────────────────────────────────────────────


def build_static_html(deck_path: Path, out_dir: Path) -> None:
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir)
    transitions = resolve_transitions(deck)
    styles_css = load_deck_styles(deck, project_dir)
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(slides, project_dir)
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()
    scripts_js = load_deck_scripts(deck, project_dir)

    _copy_assets(_all_asset_paths(deck, slides), project_dir, out_dir)

    state: State = {
        "slides": slides,
        "transitions": transitions,
        "styles_css": styles_css,
        "scripts_js": scripts_js,
        "mode": deck.mode,
        "ws_clients": set(),
        "error": None,
        "position": {"slideIndex": 0, "step": 0},
        "logs": [],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_bytes(build_html(state, ws_port=None))


def _is_local_ref(src: str) -> bool:
    """True for a copyable local path (not a URL, protocol-relative, or data URI)."""
    return bool(src) and not src.startswith(("http://", "https://", "//", "data:"))


def _collect_local_media_paths(deck: Deck) -> list[str]:
    paths: list[str] = []
    for slide in deck.slides:
        for val in slide.zones.values():
            if not isinstance(val, Media):
                continue
            paths.extend(
                src for src in [val.src, val.alt_src] if src and _is_local_ref(src)
            )
    return paths


# Matches HTML <img src> (markdown-injected) and SVG <image href>/<image xlink:href>
# references in a produced slide SVG string, capturing the path.
_IMG_SRC_RE = re.compile(r'<img\b[^>]*?\bsrc="([^"]*)"', re.IGNORECASE)
_IMAGE_HREF_RE = re.compile(r'<image\b[^>]*?\b(?:xlink:)?href="([^"]*)"', re.IGNORECASE)


def _collect_slide_asset_paths(slides: list[SlideData]) -> list[str]:
    """Local paths referenced from the produced slide SVGs (markdown + SVG images)."""
    paths: list[str] = []
    for slide in slides:
        for pattern in (_IMG_SRC_RE, _IMAGE_HREF_RE):
            refs = cast(list[str], pattern.findall(slide["svg"]))
            paths.extend(ref for ref in refs if _is_local_ref(ref))
    return paths


def _all_asset_paths(deck: Deck, slides: list[SlideData]) -> list[str]:
    """Media-zone assets plus markdown- and SVG-referenced assets, deduped in order."""
    paths = _collect_local_media_paths(deck) + _collect_slide_asset_paths(slides)
    return list(dict.fromkeys(paths))


def _copy_assets(paths: list[str], project_dir: Path, out_dir: Path) -> None:
    for rel in paths:
        src = project_dir / rel
        dst = out_dir / rel
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


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
        font_css = embed_fonts_css_subsetted(slides, project_dir)
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
    data_theme = "" if deck.mode == ColorMode.DARK else "light"
    slides_html = "\n".join(f'<div class="slide">{s["svg"]}</div>' for s in slides)
    html = (
        template.replace("/* __STYLES__ */", styles_css)
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES__", slides_html)
    )

    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "slides.html"
        html_path.write_text(html, encoding="utf-8")
        _copy_assets(_all_asset_paths(deck, slides), project_dir, Path(tmp))
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
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
    ):
        if found := shutil.which(name):
            return found
    return None
