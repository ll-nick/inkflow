from __future__ import annotations

import importlib.resources
import shutil
import subprocess
import tempfile
from pathlib import Path

from inkflow.fonts import embed_fonts_css_subsetted
from inkflow.loaders import load_scripts, load_styles
from inkflow.manifest import Deck, Media
from inkflow.pipeline import process_deck, resolve_transitions
from inkflow.server import State, build_html, load_deck

# ── build ─────────────────────────────────────────────────────────────────────


def build_static_html(deck_path: Path, out_dir: Path) -> list[str]:
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir)
    transitions = resolve_transitions(deck)
    styles_css = load_styles(deck, project_dir)
    warnings: list[str] = []
    if deck.embed_fonts:
        font_css, warnings = embed_fonts_css_subsetted(slides, project_dir)
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()
    scripts_js = load_scripts(deck, project_dir)

    _copy_assets(_collect_local_media_paths(deck), project_dir, out_dir)

    state: State = {
        "slides": slides,
        "transitions": transitions,
        "styles_css": styles_css,
        "scripts_js": scripts_js,
        "dark_mode": deck.dark_mode,
        "ws_clients": set(),
        "error": None,
        "position": {"slideIndex": 0, "step": 0},
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_bytes(build_html(state, ws_port=None))
    return warnings


def _collect_local_media_paths(deck: Deck) -> list[str]:
    paths: list[str] = []
    for slide in deck.slides:
        for val in slide.zones.values():
            if isinstance(val, Media) and not val.src.startswith(
                ("http://", "https://", "//")
            ):
                paths.append(val.src)
    return paths


def _copy_assets(paths: list[str], project_dir: Path, out_dir: Path) -> None:
    for rel in paths:
        src = project_dir / rel
        dst = out_dir / rel
        if src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


# ── export (PDF) ──────────────────────────────────────────────────────────────


def build_pdf(
    deck_path: Path,
    output: Path,
    chromium: str | None = None,
    no_sandbox: bool = False,
) -> list[str]:
    exe = chromium or _find_chromium()
    if exe is None:
        raise RuntimeError(
            "Chromium not found. Install chromium or google-chrome,"
            + " or pass --chromium PATH."
        )

    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir)
    styles_css = load_styles(deck, project_dir)
    warnings: list[str] = []
    if deck.embed_fonts:
        font_css, warnings = embed_fonts_css_subsetted(slides, project_dir)
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()

    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("pdf.html").read_text(encoding="utf-8")
    data_theme = "" if deck.dark_mode else "light"
    slides_html = "\n".join(f'<div class="slide">{s["svg"]}</div>' for s in slides)
    html = (
        template.replace("/* __STYLES__ */", styles_css)
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES__", slides_html)
    )

    with tempfile.TemporaryDirectory() as tmp:
        html_path = Path(tmp) / "slides.html"
        html_path.write_text(html, encoding="utf-8")
        _copy_assets(_collect_local_media_paths(deck), project_dir, Path(tmp))
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
    return warnings


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
