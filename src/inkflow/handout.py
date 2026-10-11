"""Handouts: the slides with their speaker notes, for reading or printing.

One page builder serves both ways of getting one: the server's ``/handout``
view (the served slides and stylesheet, a bar to pick the layout and paper
and to print; editors only, since it shows the notes) and the PDF export
(``inkflow export --handout``, the editor's Export dialog), which prints the
same page with Chromium as `export.build_pdf` prints the slides.

Layouts: ``notes``, one slide per page with its notes under it; ``compact``,
three slides per page, each with its notes beside it. Every build step is
shown, and text is shrunk to fit its box (fit.js) as every page that shows
a slide does.
"""

from __future__ import annotations

import importlib.resources
from html import escape as escape_html

from inkflow.pipeline import SlideData

LAYOUTS = ("notes", "compact")
PAPERS: dict[str, tuple[str, str]] = {
    "a4": ("A4", "210mm 297mm"),
    "letter": ("Letter", "8.5in 11in"),
}

_CSS = """
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: #1d1d1f; }
body { font: 11pt/1.45 "Inkflow UI", Inter, system-ui, sans-serif; }
@page { size: __PAPER__; margin: 14mm 14mm 16mm; }
.h-bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 12px;
  align-items: center; padding: 10px 16px; background: #f2f2f4;
  border-bottom: 1px solid #ddd; font-size: 13px; }
.h-bar .h-title { font-weight: 600; margin-right: auto; }
.h-bar select, .h-bar button { font: inherit; padding: 4px 8px; }
.h-pages { max-width: 210mm; margin: 0 auto; padding: 16px; }
.h-item { break-inside: avoid; margin: 0 0 10mm; }
.h-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 3mm;
  font-weight: 600; }
.h-num { color: #888; font-variant-numeric: tabular-nums; }
.h-pic, .h-pic .trim { overflow: hidden; }
.h-pic { border: 1px solid #ccc; }
.h-pic .trim > svg { display: block; width: 100%; height: auto; overflow: hidden; }
.h-notes { margin-top: 4mm; overflow-wrap: anywhere; }
.h-notes img, .h-notes video, .h-notes svg { max-width: 100%; max-height: 80mm;
  height: auto; }
.h-notes pre { white-space: pre-wrap; }
.h-notes :first-child { margin-top: 0; }
.h-notes.empty { color: #999; font-style: italic; }
.layout-notes .h-item { break-after: page; }
.layout-notes .h-item:last-child { break-after: auto; }
.layout-compact .h-item { display: grid; grid-template-columns: 55% 1fr;
  gap: 6mm; margin-bottom: 8mm; }
.layout-compact .h-head { grid-column: 1 / -1; margin-bottom: 0; }
.layout-compact .h-notes { margin-top: 0; font-size: 9.5pt; }
[data-step] { opacity: 1 !important; transform: none !important; }
video::-webkit-media-controls { display: none !important; }
@media print { .h-bar { display: none; } .h-pages { max-width: none; padding: 0; } }
"""


def handout_body(slides: list[SlideData], layout: str = "notes") -> str:
    """Each shown slide (its number, title, picture) with its notes."""
    items: list[str] = []
    for n, slide in enumerate(slides, start=1):
        notes = slide.get("notes") or ""
        title = escape_html(str(slide.get("title") or slide.get("id") or ""))
        notes_html = (
            f'<div class="h-notes">{notes}</div>'
            if notes.strip()
            else '<div class="h-notes empty">No notes</div>'
        )
        items.append(
            "".join(
                [
                    '<section class="h-item">',
                    f'<div class="h-head"><span class="h-num">{n}</span>',
                    f"<span>{title}</span></div>",
                    f'<div class="h-pic"><div class="trim">{slide["svg"]}</div></div>',
                    notes_html,
                    "</section>",
                ]
            )
        )
    return f'<main class="h-pages layout-{layout}">{"".join(items)}</main>'


_LAYOUT_NAMES = {
    "notes": "One slide per page, notes below",
    "compact": "Three per page, notes beside",
}


def _select(name: str, values: dict[str, str], chosen: str) -> str:
    options = "".join(
        f'<option value="{k}"{" selected" if k == chosen else ""}>{v}</option>'
        for k, v in values.items()
    )
    return f'<select name="{name}" onchange="this.form.submit()">{options}</select>'


def _bar(title: str, layout: str, paper: str) -> str:
    papers = {k: v[0] for k, v in PAPERS.items()}
    return "".join(
        [
            '<form class="h-bar" method="get">',
            f'<span class="h-title">Handout · {escape_html(title)}</span>',
            _select("layout", _LAYOUT_NAMES, layout),
            _select("paper", papers, paper),
            '<button type="button" onclick="window.print()">',
            "Print or save as PDF…</button></form>",
        ]
    )


def handout_page(
    slides: list[SlideData],
    styles_css: str,
    *,
    title: str,
    data_theme: str,
    layout: str = "notes",
    paper: str = "a4",
    bar: bool = False,
) -> str:
    """The whole page. ``styles_css`` is the deck's (its fonts first);
    ``bar`` adds the view's controls (left out of print)."""
    layout = layout if layout in LAYOUTS else "notes"
    paper = paper if paper in PAPERS else "a4"
    fit = (
        importlib.resources.files("inkflow")
        .joinpath("bundles", "fit.js")
        .read_text(encoding="utf-8")
    )
    css = _CSS.replace("__PAPER__", PAPERS[paper][1])
    return (
        "<!DOCTYPE html>\n"
        f'<html lang="en" data-theme="{data_theme}"><head><meta charset="UTF-8">'
        f"<title>Handout · {escape_html(title)}</title>"
        f"<style>{styles_css}</style><style>{css}</style></head><body>"
        f"{_bar(title, layout, paper) if bar else ''}"
        f"{handout_body(slides, layout)}"
        f"<script>{fit}</script></body></html>"
    )
