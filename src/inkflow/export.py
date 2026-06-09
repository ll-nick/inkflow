from __future__ import annotations

import importlib.resources
import shutil
import subprocess
import tempfile
from pathlib import Path

from inkflow.manifest import Deck, MarkdownSlide, Media, Slide
from inkflow.pipeline import process_deck, resolve_transitions
from inkflow.server import State, build_html, load_deck, load_scripts, load_styles

_VIDEO_SUFFIXES = {".mp4", ".webm", ".ogg", ".mov"}


# ── build ─────────────────────────────────────────────────────────────────────


def build_static_html(deck_path: Path, out_dir: Path) -> None:
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir)
    transitions = resolve_transitions(deck)
    styles_css = load_styles(deck, project_dir)
    scripts_js = load_scripts(deck, project_dir)

    _copy_videos(_collect_video_paths(deck), project_dir, out_dir)

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


def _collect_video_paths(deck: Deck) -> list[str]:
    paths: list[str] = []
    for slide in deck.slides:
        items = slide.content if isinstance(slide, Slide) else []
        for item in items:
            if (
                isinstance(item, Media)
                and Path(item.src).suffix.lower() in _VIDEO_SUFFIXES
            ):
                paths.append(item.src)
        if isinstance(slide, MarkdownSlide):
            for val in slide.extra.values():
                src = val.src if isinstance(val, Media) else val
                if Path(src).suffix.lower() in _VIDEO_SUFFIXES:
                    paths.append(src)
    return paths


def _copy_videos(paths: list[str], project_dir: Path, out_dir: Path) -> None:
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
    styles_css = load_styles(deck, project_dir)

    pkg = importlib.resources.files("inkflow")
    template = pkg.joinpath("pdf.html").read_text(encoding="utf-8")
    data_theme = "" if deck.dark_mode else "light"
    slides_html = "\n".join(f'<div class="slide">{s["svg"]}</div>' for s in slides)
    html = (
        template.replace("__STYLES__", styles_css)
        .replace("__DATA_THEME__", data_theme)
        .replace("__SLIDES__", slides_html)
    )

    with tempfile.TemporaryDirectory() as tmp:
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
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
    ):
        if found := shutil.which(name):
            return found
    return None
