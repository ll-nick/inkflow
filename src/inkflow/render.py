"""`inkflow render`: slides as PNG images, a contact sheet, and layout findings.

One headless Chromium (driven over the DevTools protocol, `cdp.py`) loads each
slide on its own page (`render.html` + the render bundle), waits until what it
shows has loaded, measures its layout (`src/ts/render/measure.ts`: text that does
not fit its zone, objects outside the slide, text too small to read) and, unless
only checking, screenshots it. The viewport is set to the slide's exact size, so
the image is exactly the slide.

A contact sheet lays the slides out in a grid on one more page, each under a
label with its number and id, so the whole deck is one image to look at.
"""

from __future__ import annotations

import base64
import dataclasses
import importlib.resources
import json
import math
import tempfile
from dataclasses import dataclass, field
from html import escape as escape_html
from pathlib import Path
from typing import cast

from typing_extensions import override

from inkflow.cdp import Browser, Page
from inkflow.editor.compare import (
    Comparison,
    DeckFacts,
    ElementChange,
    PairDiff,
    strip_editor_attrs,
    what_changed,
)
from inkflow.editor.comparesrc import SideBuild
from inkflow.enums import ColorMode
from inkflow.export import (
    PdfPage,
    asset_roots,
    copy_assets,
    find_chromium,
    is_paper_svg,
    pdf_pages,
    served,
    slide_dimensions,
)
from inkflow.fonts import embed_fonts_css_subsetted
from inkflow.loaders import load_deck_styles
from inkflow.logging import logger
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData, process_deck
from inkflow.server import load_deck
from inkflow.sizes import print_body_pt
from inkflow.titles import resolve_deck_title

# ── findings ──────────────────────────────────────────────────────────────────

_SIDES = ("top", "right", "bottom", "left")


@dataclass(frozen=True)
class Finding:
    """One layout problem on one slide, measured in slide units."""

    slide: int
    slide_id: str
    kind: str  # overflow | clipped | outside | small-text | low-res | contrast
    target: str
    top: int = 0
    right: int = 0
    bottom: int = 0
    left: int = 0
    entirely: bool = False
    size: float = 0.0
    minimum: float = 0.0
    text: str = ""
    unit: str = "px"
    """``pt`` for text measured as printed (a print deck)."""
    body: bool = False
    """Printed small text that is body text (paragraphs, lists, tables)."""
    dpi: float = 0.0
    """A picture's resolution at its printed size (``low-res``)."""
    problem: bool = False
    """A ``low-res`` picture below `PRINT_DPI_PROBLEM` (else a hint)."""
    ratio: float = 0.0
    """Contrast: the text's ratio against what is behind it, and the one it
    needs (WCAG: 4.5:1, or 3:1 for large text)."""
    needs: float = 0.0
    color: str = ""
    background: str = ""

    @property
    def is_problem(self) -> bool:
        """Small text, a picture that is merely soft, and normal-size text
        between 3:1 and 4.5:1 contrast are hints; everything else is something
        to fix."""
        if self.kind == "low-res":
            return self.problem
        if self.kind == "contrast":
            return self.ratio < 3
        return self.kind != "small-text"

    def _sides(self) -> list[str]:
        return [side for side in _SIDES if getattr(self, side) > 0]

    def _reach(self) -> str:
        return ", ".join(f"{getattr(self, side)}px ({side})" for side in self._sides())

    def message(self) -> str:
        where = f"slide {self.slide}"
        if self.slide_id:
            where += f" ({self.slide_id})"
        if self.kind == "overflow":
            said = f"text overflows its zone by {self._reach()}"
        elif self.kind == "clipped":
            said = f"{self.text or 'a box'} is cut off by {self._reach()}"
        elif self.kind == "outside" and self.entirely:
            sides = ", ".join(self._sides())
            said = f"lies entirely outside the slide ({sides}), so it is not shown"
        elif self.kind == "outside" and len(self._sides()) == 1:
            side = self._sides()[0]
            said = f"lies {getattr(self, side)}px outside the slide ({side})"
        elif self.kind == "outside":
            said = f"lies outside the slide by {self._reach()}"
        elif self.kind == "low-res":
            what = f"{self.text} " if self.text else ""
            said = (
                f"picture {what}prints at {self.dpi:g} dpi"
                + (", pixelated" if self.problem else ", soft")
                + f" (below {self.minimum:g} dpi at its printed size):"
                + " use a larger image, or a vector one (SVG, PDF)"
            )
        elif self.kind == "contrast":
            said = (
                f"contrast {self.ratio:g}:1 against its background"
                + f" (needs {self.needs:g}:1): {self.color} on {self.background}"
            )
            if self.text:
                said += f' "{self.text}"'
        elif self.unit == "pt":
            what = "body text" if self.body else "text"
            said = f"{what} {self.size:g} pt is likely too small to read on paper"
            if self.minimum:
                said += f" (below {self.minimum:g} pt)"
            if self.text:
                said += f': "{self.text}"'
        else:
            said = f"text {self.size:g}px tall is likely too small to read"
            if self.minimum:
                said += f" (below {self.minimum:g}px)"
            if self.text:
                said += f': "{self.text}"'
        return f"{where}: {self.target}: {said}"


def parse_findings(slide: int, slide_id: str, raw: object) -> list[Finding]:
    """The findings the render page measured, as `Finding`s (unknown ones dropped)."""
    if not isinstance(raw, list):
        return []
    found: list[Finding] = []
    for item in cast("list[object]", raw):
        if not isinstance(item, dict):
            continue
        data = cast("dict[str, object]", item)
        kind = data.get("kind")
        target = data.get("target")
        if kind not in (
            "overflow",
            "clipped",
            "outside",
            "small-text",
            "low-res",
            "contrast",
        ):
            continue
        if not isinstance(target, str):
            continue

        def number(key: str) -> float:
            value = data.get(key)  # noqa: B023
            return float(value) if isinstance(value, int | float) else 0.0

        text = data.get("what") if kind == "clipped" else data.get("text")
        found.append(
            Finding(
                slide=slide,
                slide_id=slide_id,
                kind=kind,
                target=target,
                top=round(number("top")),
                right=round(number("right")),
                bottom=round(number("bottom")),
                left=round(number("left")),
                entirely=data.get("entirely") is True,
                size=number("size"),
                minimum=number("min"),
                text=text if isinstance(text, str) else "",
                unit="pt" if data.get("unit") == "pt" else "px",
                body=data.get("body") is True,
                dpi=number("dpi"),
                problem=data.get("problem") is True,
                ratio=number("ratio"),
                needs=number("needs"),
                color=str(data.get("color") or ""),
                background=str(data.get("background") or ""),
            )
        )
    return found


def render_json(result: RenderResult) -> dict[str, object]:
    """`inkflow render --json`: images, findings (with their messages) and,
    when measured, every slide's boxes."""
    out: dict[str, object] = {
        "slides": result.slides,
        "images": [str(p) for p in result.images],
        "findings": [
            {**dataclasses.asdict(f), "problem": f.is_problem, "message": f.message()}
            for f in result.findings
        ],
    }
    if result.boxes:
        out["boxes"] = [dataclasses.asdict(b) for b in result.boxes]
    return out


def summary(findings: list[Finding], slide_count: int) -> str:
    """One line closing a check: how many problems and hints in how many slides."""
    problems = sum(1 for f in findings if f.is_problem)
    hints = len(findings) - problems
    slides = f"{slide_count} slide" + ("" if slide_count == 1 else "s")
    if not findings:
        return f"no layout problems in {slides}"
    parts: list[str] = []
    if problems:
        parts.append(f"{problems} layout problem" + ("" if problems == 1 else "s"))
    if hints:
        parts.append(f"{hints} hint" + ("" if hints == 1 else "s"))
    return f"{' and '.join(parts)} in {slides}"


# ── boxes ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Rect:
    """A box in slide units: corner and size."""

    x: float
    y: float
    w: float
    h: float

    @override
    def __str__(self) -> str:
        return f"{self.x:g},{self.y:g} {self.w:g}x{self.h:g}"


@dataclass(frozen=True)
class ElementBox:
    """Where the browser drew one element of a slide (`src/ts/render/boxes.ts`):
    an element with an id, a zone, or one block of a zone's text."""

    id: str
    kind: str
    box: Rect
    depth: int = 0
    parent: str | None = None
    text: str = ""
    zone: str | None = None
    block: Rect | None = None
    """A text block's layout box (``box`` is the extent of its text)."""
    content: Rect | None = None
    """A text zone's content extent."""
    free: float | None = None
    """A text zone's height minus its content's (negative: it overflows)."""
    hidden: bool = False

    def line(self) -> str:
        parts = [f"{'  ' * self.depth}{self.id}", str(self.box), self.kind]
        if self.text:
            parts.append(f'"{self.text}"')
        if self.content is not None and self.free is not None:
            parts.append(
                f"content {self.content.w:g}x{self.content.h:g}, free {self.free:g}"
            )
        if self.hidden:
            parts.append("(hidden)")
        return "  ".join(parts)


@dataclass(frozen=True)
class SlideBoxes:
    slide: int
    slide_id: str
    width: int
    height: int
    elements: list[ElementBox]

    def text(self) -> str:
        head = f"slide {self.slide}"
        if self.slide_id:
            head += f" ({self.slide_id})"
        head += f": {self.width}x{self.height}"
        return "\n".join([head, *(e.line() for e in self.elements)])


def _rect(raw: object) -> Rect | None:
    if not isinstance(raw, dict):
        return None
    data = cast("dict[str, object]", raw)
    values = [data.get(k) for k in ("x", "y", "w", "h")]
    if not all(isinstance(v, int | float) for v in values):
        return None
    x, y, w, h = cast("list[float]", values)
    return Rect(x, y, w, h)


def parse_boxes(raw: object) -> list[ElementBox]:
    """The boxes the render page measured, as `ElementBox`es (malformed ones
    dropped)."""
    if not isinstance(raw, list):
        return []
    out: list[ElementBox] = []
    for item in cast("list[object]", raw):
        if not isinstance(item, dict):
            continue
        data = cast("dict[str, object]", item)
        ident, kind, box = data.get("id"), data.get("kind"), _rect(data.get("box"))
        if not isinstance(ident, str) or not isinstance(kind, str) or box is None:
            continue
        depth, parent = data.get("depth"), data.get("parent")
        text, zone, free = data.get("text"), data.get("zone"), data.get("free")
        out.append(
            ElementBox(
                id=ident,
                kind=kind,
                box=box,
                depth=depth if isinstance(depth, int) else 0,
                parent=parent if isinstance(parent, str) else None,
                text=text if isinstance(text, str) else "",
                zone=zone if isinstance(zone, str) else None,
                block=_rect(data.get("block")),
                content=_rect(data.get("content")),
                free=float(free) if isinstance(free, int | float) else None,
                hidden=data.get("hidden") is True,
            )
        )
    return out


# ── contact sheet ─────────────────────────────────────────────────────────────

SHEET_WIDTH = 1600
SHEET_PER_PAGE = 16
_GAP = 16
_LABEL = 30


def sheet_columns(count: int) -> int:
    """Columns for ``count`` slides: a square-ish grid, at most four across."""
    for columns, fits in ((1, 1), (2, 4), (3, 9)):
        if count <= fits:
            return columns
    return 4


@dataclass(frozen=True)
class SheetLayout:
    """Where each slide goes on one contact sheet, in CSS px."""

    count: int
    columns: int
    rows: int
    thumb_width: int
    thumb_height: int
    width: int
    height: int

    def cell(self, index: int) -> tuple[int, int]:
        """Top-left corner of the ``index``-th cell (its label sits on top)."""
        row, col = divmod(index, self.columns)
        return (
            _GAP + col * (self.thumb_width + _GAP),
            _GAP + row * (_LABEL + self.thumb_height + _GAP),
        )


def sheet_layout(
    count: int, slide_width: int, slide_height: int, width: int = SHEET_WIDTH
) -> SheetLayout:
    columns = sheet_columns(count)
    rows = max(1, math.ceil(count / columns))
    thumb_width = (width - _GAP * (columns + 1)) // columns
    thumb_height = round(thumb_width * slide_height / slide_width)
    height = _GAP + rows * (_LABEL + thumb_height + _GAP)
    return SheetLayout(count, columns, rows, thumb_width, thumb_height, width, height)


def sheet_pages(numbers: list[int], per_page: int = SHEET_PER_PAGE) -> list[list[int]]:
    """Slides split into sheets of at most ``per_page``, evenly sized."""
    if not numbers:
        return []
    pages = math.ceil(len(numbers) / per_page)
    size = math.ceil(len(numbers) / pages)
    return [numbers[i : i + size] for i in range(0, len(numbers), size)]


def sheet_paths(output: Path, pages: int) -> list[Path]:
    """The files the sheets go to: ``output`` itself if it is a .png, else in it."""
    if output.suffix.lower() == ".png":
        if pages == 1:
            return [output]
        return [output.with_name(f"{output.stem}-{i}.png") for i in range(1, pages + 1)]
    if pages == 1:
        return [output / "sheet.png"]
    return [output / f"sheet-{i}.png" for i in range(1, pages + 1)]


def sheet_html(layout: SheetLayout, cells: list[tuple[int, str, str, int]]) -> str:
    """The sheet page: ``cells`` are (number, slide id, image file, problems)."""
    parts: list[str] = []
    for index, (number, slide_id, image, problems) in enumerate(cells):
        x, y = layout.cell(index)
        flag = (
            f'<span class="flag">{problems} problem{"" if problems == 1 else "s"}'
            + "</span>"
            if problems
            else ""
        )
        parts.append(
            f'<div class="label" style="left:{x}px;top:{y}px;'
            + f'width:{layout.thumb_width}px"><b>{number}</b> '
            + f"{escape_html(slide_id)}{flag}</div>"
            + f'<img src="{escape_html(image)}" style="left:{x}px;'
            + f"top:{y + _LABEL}px;width:{layout.thumb_width}px;"
            + f'height:{layout.thumb_height}px">'
        )
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
        + "html,body{margin:0;background:#3b3d42;}"
        + f"body{{position:relative;width:{layout.width}px;"
        + f"height:{layout.height}px;font:16px/{_LABEL}px sans-serif;color:#eee}}"
        + f".label{{position:absolute;height:{_LABEL}px;white-space:nowrap;"
        + "overflow:hidden;text-overflow:ellipsis}"
        + ".label b{font-size:19px;margin-right:4px}"
        + ".flag{margin-left:10px;padding:1px 6px;border-radius:4px;"
        + "background:#d9480f;color:#fff;font-size:14px}"
        + "img{position:absolute;object-fit:contain;outline:1px solid #6b6e75}"
        + "</style></head><body>"
        + "".join(parts)
        + "</body></html>"
    )


# ── rendering ─────────────────────────────────────────────────────────────────


def _page_template(
    deck: Deck,
    project_dir: Path,
    slides: list[SlideData],
    styles_css: str,
    step: int | None,
) -> str:
    """The single-slide page (render.html) for one deck, its fonts subset to
    what ``slides`` use; ``__RENDER_SVG__``, ``__W__`` and ``__H__`` are left
    to fill per slide."""
    if deck.embed_fonts:
        font_css = embed_fonts_css_subsetted(
            slides, project_dir, deck.theme.fonts_dir, styles_css=styles_css
        )
        if font_css:
            styles_css = (font_css + "\n" + styles_css).strip()
    pkg = importlib.resources.files("inkflow")
    return (
        pkg.joinpath("render.html")
        .read_text(encoding="utf-8")
        .replace("/* __CSS__ */", pkg.joinpath("bundles", "presenter.css").read_text())
        .replace("/* __STYLES__ */", styles_css)
        .replace("/* __JS__ */", pkg.joinpath("bundles", "render.js").read_text())
        .replace("__RENDER_STEP__", json.dumps(step))
        .replace(
            "__DATA_THEME__", "" if deck.effective_mode == ColorMode.DARK else "light"
        )
        .replace("__TITLE__", escape_html(resolve_deck_title(deck, project_dir)))
    )


def print_check(page: PdfPage) -> dict[str, float]:
    """How the render page checks a slide printed on ``page`` (measure.ts's
    ``PrintCheck``): text in points against the sheet's body size
    (`sizes.print_body_pt`): below 0.6 of it a hint (18 pt on A0), body text
    below 0.8 of it (24 pt on A0)."""
    cw, ch = page.canvas
    body = print_body_pt(page.width, page.height)
    return {
        "ptPerUnit": min(page.width / cw, page.height / ch),
        "minPt": round(body * PRINT_MIN_TEXT, 1),
        "bodyPt": round(body * PRINT_MIN_BODY, 1),
    }


PRINT_MIN_TEXT = 0.6
"""Printed text below this fraction of the sheet's body size is a hint."""
PRINT_MIN_BODY = 0.8
"""Printed body text below this fraction of the sheet's body size is a hint."""


def print_checks(deck: Deck, slides: list[SlideData]) -> list[dict[str, float] | None]:
    """Each slide's print check, ``None`` for a screen slide: a print deck's
    every slide, and in a deck without a size the slides drawn on paper
    (``width``/``height`` in mm, cm, in, pt or pc)."""
    pages = pdf_pages(slides, deck)
    checks: list[dict[str, float] | None] = []
    for slide, page in zip(slides, pages, strict=True):
        printed = deck.is_print or (deck.size is None and is_paper_svg(slide["svg"]))
        checks.append(print_check(page) if printed else None)
    return checks


def _slide_page(template: str, svg: str, print_: dict[str, float] | None = None) -> str:
    w, h = slide_dimensions(svg)
    html = template.replace("__RENDER_PRINT__", json.dumps(print_))
    html = html.replace("__RENDER_SVG__", json.dumps(svg).replace("</", "<\\/"))
    return html.replace("__W__", str(w)).replace("__H__", str(h))


@dataclass
class RenderResult:
    images: list[Path] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    slides: list[int] = field(default_factory=list)
    boxes: list[SlideBoxes] = field(default_factory=list)


def render_slides(
    deck_path: Path,
    slide_numbers: list[int] | None,
    output: Path | None,
    *,
    sheet: bool = False,
    step: int | None = None,
    scale: float = 1.0,
    chromium: str | None = None,
    no_sandbox: bool = False,
    boxes: bool = False,
    contrast: bool = True,
) -> RenderResult:
    """Render slides (1-based, as the presenter numbers them; ``None`` = all).

    Each slide is shown at ``step`` (its final build state when ``None``) on a
    page with nothing else on it and measured. With an ``output``, it is also
    written as a PNG: ``output`` is the file for a single slide or a directory
    for several (``slide-N.png``); with ``sheet``, the slides go onto contact
    sheets instead (`sheet_paths`). Without one, nothing is written. With
    ``boxes``, every element's rendered box is read back too (`boxes`).
    With ``contrast``, text is checked against what is behind it (`_contrast`).
    """
    exe = chromium or find_chromium()
    if exe is None:
        raise RuntimeError(
            "Chromium not found. Install chromium or google-chrome,"
            + " or pass --chromium PATH."
        )
    deck = load_deck(deck_path)
    project_dir = deck_path.parent
    slides = process_deck(deck, project_dir, deck_path)
    if not slides:
        raise RuntimeError("Cannot render: the deck has no visible slides.")
    numbers = (
        list(range(1, len(slides) + 1)) if slide_numbers is None else slide_numbers
    )
    for n in numbers:
        if not 1 <= n <= len(slides):
            raise ValueError(f"no slide {n}: the deck has {len(slides)} slides")
    template = _page_template(
        deck, project_dir, slides, load_deck_styles(deck, project_dir), step
    )

    single = (
        output is not None
        and not sheet
        and len(numbers) == 1
        and output.suffix.lower() == ".png"
    )
    if output is not None and not single and not sheet:
        output.mkdir(parents=True, exist_ok=True)
    pages = sheet_pages(numbers) if sheet else []
    layouts = [
        sheet_layout(len(p), *slide_dimensions(slides[p[0] - 1]["svg"])) for p in pages
    ]
    # Each slide is shot at the size its cell shows it, so nothing is resampled.
    thumb_width = {
        n: layout.thumb_width
        for p, layout in zip(pages, layouts, strict=True)
        for n in p
    }

    result = RenderResult(slides=numbers)
    shots: dict[int, str] = {}
    checks = print_checks(deck, slides)
    with (
        tempfile.TemporaryDirectory() as tmp,
        served(Path(tmp)) as url,
        Browser.launch(exe, no_sandbox=no_sandbox) as browser,
    ):
        copy_assets(slides, asset_roots(deck, project_dir), Path(tmp))
        page = browser.new_page()
        for n in numbers:
            svg = slides[n - 1]["svg"]
            w, h = slide_dimensions(svg)
            html = _slide_page(template, svg, checks[n - 1])
            (Path(tmp) / f"slide-{n}.html").write_text(html, encoding="utf-8")
            density = thumb_width[n] / w if sheet else scale
            page.viewport(w, h, density)
            page.navigate(f"{url}/slide-{n}.html")
            raw = page.evaluate("window.inkflowRendered")
            if raw is None:
                logger.warning(f"slide {n}: the render page did not measure it")
            result.findings += parse_findings(n, slides[n - 1]["id"], raw)
            if boxes:
                measured = parse_boxes(page.evaluate("window.inkflowBoxes()"))
                result.boxes.append(SlideBoxes(n, slides[n - 1]["id"], w, h, measured))
            png = page.screenshot(w, h) if output is not None else None
            if contrast:
                result.findings += _contrast(page, n, slides[n - 1]["id"], w, h, png)
            if png is None:
                continue
            if sheet:
                shots[n] = f"thumb-{n}.png"
                (Path(tmp) / shots[n]).write_bytes(png)
                continue
            assert output is not None
            target = (output if single else output / f"slide-{n}.png").resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(png)
            result.images.append(target)
        if sheet and output is not None:
            result.images += _write_sheets(
                page,
                url,
                Path(tmp),
                list(zip(pages, layouts, strict=True)),
                output,
                slides,
                result.findings,
                shots,
            )
    return result


def _contrast(
    page: Page, n: int, slide_id: str, w: int, h: int, shown: bytes | None
) -> list[Finding]:
    """Text whose contrast with what is behind it is too low
    (src/ts/render/contrast.ts): the slide is shot as shown and with its
    text's paint made transparent, and the page compares the two."""
    shown_b64 = (
        base64.b64encode(shown).decode("ascii")
        if shown is not None
        else page.screenshot_base64(w, h, fast=True)
    )
    if not page.evaluate("window.inkflowHideText()"):
        return []  # no text
    hidden_b64 = page.screenshot_base64(w, h, fast=True)
    raw = page.evaluate(
        f"window.inkflowContrast({json.dumps(shown_b64)}, {json.dumps(hidden_b64)})"
    )
    return parse_findings(n, slide_id, raw)


def _write_sheets(
    page: Page,
    url: str,
    tmp: Path,
    pages: list[tuple[list[int], SheetLayout]],
    output: Path,
    slides: list[SlideData],
    findings: list[Finding],
    shots: dict[int, str],
) -> list[Path]:
    problems: dict[int, int] = {}
    for f in findings:
        if f.is_problem:
            problems[f.slide] = problems.get(f.slide, 0) + 1
    written: list[Path] = []
    for index, ((numbers, layout), target) in enumerate(
        zip(pages, sheet_paths(output, len(pages)), strict=True), start=1
    ):
        cells = [
            (n, slides[n - 1]["id"], shots[n], problems.get(n, 0)) for n in numbers
        ]
        name = f"sheet-{index}.html"
        (tmp / name).write_text(sheet_html(layout, cells), encoding="utf-8")
        page.viewport(layout.width, layout.height, 1)
        page.navigate(f"{url}/{name}")
        page.evaluate("document.fonts.ready.then(() => true)")
        target = target.resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(page.screenshot(layout.width, layout.height))
        written.append(target)
    return written


# ── comparison sheet ──────────────────────────────────────────────────────────

PAIRS_PER_SHEET = 6
_HEAD = 34


@dataclass(frozen=True)
class PairCell:
    """One row of a comparison sheet: a caption and the slide on each side
    (an image file, or None when that side lacks it), with boxes to outline
    in slide units: (change, x, y, width, height)."""

    caption: str
    status: str
    left: str | None
    right: str | None
    left_boxes: list[tuple[str, float, float, float, float]] = field(
        default_factory=list
    )
    right_boxes: list[tuple[str, float, float, float, float]] = field(
        default_factory=list
    )


def pair_sheet_layout(
    count: int, slide_width: int, slide_height: int, width: int = SHEET_WIDTH
) -> SheetLayout:
    """Rows of two slides (left | right) under one caption each."""
    thumb_width = (width - _GAP * 3) // 2
    thumb_height = round(thumb_width * slide_height / slide_width)
    height = _HEAD + _GAP + count * (_LABEL + thumb_height + _GAP)
    return SheetLayout(
        count, 2, count, thumb_width, thumb_height, width, max(height, _HEAD + _GAP)
    )


_OUTLINE = {"changed": "#f2a516", "added": "#3fbf6f", "removed": "#ef5350"}


def pair_sheet_html(
    layout: SheetLayout,
    labels: tuple[str, str],
    rows: list[PairCell],
    slide_width: int,
) -> str:
    """The comparison sheet page: both sides' names on top, then one row per
    pair, its changed elements outlined (amber changed, green added, red
    removed)."""
    scale = layout.thumb_width / slide_width
    parts: list[str] = [
        f'<div class="side" style="left:{_GAP}px;width:{layout.thumb_width}px">'
        + f"{escape_html(labels[0])}</div>",
        f'<div class="side" style="left:{_GAP * 2 + layout.thumb_width}px;'
        + f'width:{layout.thumb_width}px">{escape_html(labels[1])}</div>',
    ]
    for index, row in enumerate(rows):
        y = _HEAD + _GAP + index * (_LABEL + layout.thumb_height + _GAP)
        parts.append(
            f'<div class="label s-{escape_html(row.status)}" style="left:{_GAP}px;'
            + f'top:{y}px;width:{layout.width - 2 * _GAP}px">'
            + f"{escape_html(row.caption)}</div>"
        )
        for col, (image, boxes) in enumerate(
            ((row.left, row.left_boxes), (row.right, row.right_boxes))
        ):
            x = _GAP + col * (layout.thumb_width + _GAP)
            top = y + _LABEL
            size = f"width:{layout.thumb_width}px;height:{layout.thumb_height}px"
            if image is None:
                parts.append(
                    f'<div class="none" style="left:{x}px;top:{top}px;{size}">'
                    + "not in this deck</div>"
                )
                continue
            parts.append(
                f'<img src="{escape_html(image)}" style="left:{x}px;top:{top}px;'
                + f'{size}">'
            )
            for change, bx, by, bw, bh in boxes:
                parts.append(
                    '<div class="box" style="'
                    + f"left:{x + bx * scale - 3:.1f}px;"
                    + f"top:{top + by * scale - 3:.1f}px;"
                    + f"width:{bw * scale + 6:.1f}px;height:{bh * scale + 6:.1f}px;"
                    + f'border-color:{_OUTLINE.get(change, "#f2a516")}"></div>'
                )
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
        + "html,body{margin:0;background:#3b3d42;}"
        + f"body{{position:relative;width:{layout.width}px;"
        + f"height:{layout.height}px;font:16px/{_LABEL}px sans-serif;color:#eee}}"
        + f".side{{position:absolute;top:{_GAP // 2}px;height:{_HEAD}px;"
        + f"line-height:{_HEAD}px;font-size:19px;font-weight:bold;white-space:nowrap;"
        + "overflow:hidden;text-overflow:ellipsis}"
        + f".label{{position:absolute;height:{_LABEL}px;white-space:nowrap;"
        + "overflow:hidden;text-overflow:ellipsis}"
        + ".s-changed{color:#f7c55c}.s-added{color:#7fdc9f}.s-removed{color:#ff8a80}"
        + "img,.none{position:absolute;object-fit:contain;outline:1px solid #6b6e75}"
        + ".none{display:flex;align-items:center;justify-content:center;"
        + "color:#9a9da3;background:#2c2e33}"
        + ".box{position:absolute;box-sizing:border-box;border:3px solid;"
        + "border-radius:4px}"
        + "</style></head><body>"
        + "".join(parts)
        + "</body></html>"
    )


def _boxes(
    elements: list[ElementChange], side: str
) -> list[tuple[str, float, float, float, float]]:
    out: list[tuple[str, float, float, float, float]] = []
    for e in elements:
        loc = e.left if side == "left" else e.right
        if loc is None or loc.box is None:
            continue
        out.append((e.change, *loc.box))
    return out


def render_comparison(
    left: SideBuild,
    right: SideBuild,
    left_facts: DeckFacts,
    right_facts: DeckFacts,
    result: Comparison,
    labels: tuple[str, str],
    output: Path,
    *,
    chromium: str | None = None,
    no_sandbox: bool = False,
) -> list[Path]:
    """Side-by-side images of the pairs that differ (`inkflow compare --sheet`):
    one browser renders both decks, each slide on a page with its own deck's
    styles, at the size its cell shows it."""
    exe = chromium or find_chromium()
    if exe is None:
        raise RuntimeError(
            "Chromium not found. Install chromium or google-chrome,"
            + " or pass --chromium PATH."
        )
    pairs = result.changes()
    if not pairs:
        return []
    builds = {"left": left, "right": right}
    facts = {"left": left_facts, "right": right_facts}
    first = next(
        (s["svg"] for b in (right, left) for s in b.slides),
        "",
    )
    slide_w, slide_h = slide_dimensions(first) if first else (1920, 1080)
    pages = [
        pairs[i : i + PAIRS_PER_SHEET] for i in range(0, len(pairs), PAIRS_PER_SHEET)
    ]
    layouts = [pair_sheet_layout(len(p), slide_w, slide_h) for p in pages]
    thumb_width = layouts[0].thumb_width
    written: list[Path] = []
    with (
        tempfile.TemporaryDirectory() as tmp,
        served(Path(tmp)) as url,
        Browser.launch(exe, no_sandbox=no_sandbox) as browser,
    ):
        root = Path(tmp)
        templates: dict[str, str] = {}
        for side, build in builds.items():
            (root / side).mkdir()
            copy_assets(build.slides, build.roots, root / side)
            templates[side] = _page_template(
                build.deck, build.project_dir, build.slides, build.styles, None
            )
        page = browser.new_page()

        def shot(side: str, index: int | None) -> str | None:
            if index is None:
                return None
            build = builds[side]
            visible = facts[side].slides[index].number
            if visible is None:
                return None
            svg = strip_editor_attrs(build.slides[visible - 1]["svg"])
            w, h = slide_dimensions(svg)
            name = f"{side}/slide-{index}.html"
            (root / name).write_text(_slide_page(templates[side], svg), "utf-8")
            page.viewport(w, h, thumb_width / w)
            page.navigate(f"{url}/{name}")
            page.evaluate("window.inkflowRendered")
            png = f"{side}-{index}.png"
            (root / png).write_bytes(page.screenshot(w, h))
            return png

        for number, (pairs_on_page, layout, target) in enumerate(
            zip(pages, layouts, sheet_paths(output, len(pages)), strict=True), 1
        ):
            rows: list[PairCell] = []
            for pair in pairs_on_page:
                rows.append(
                    PairCell(
                        caption=pair_caption(pair, left_facts, right_facts),
                        status=pair.status,
                        left=shot("left", pair.left),
                        right=shot("right", pair.right),
                        left_boxes=_boxes(pair.elements, "left"),
                        right_boxes=_boxes(pair.elements, "right"),
                    )
                )
            name = f"sheet-{number}.html"
            (root / name).write_text(
                pair_sheet_html(layout, labels, rows, slide_w), encoding="utf-8"
            )
            page.viewport(layout.width, layout.height, 1)
            page.navigate(f"{url}/{name}")
            page.evaluate("document.fonts.ready.then(() => true)")
            target = target.resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(page.screenshot(layout.width, layout.height))
            written.append(target)
    return written


def pair_caption(pair: PairDiff, left: DeckFacts, right: DeckFacts) -> str:
    """What a sheet row says about its pair, as `inkflow compare` prints it."""
    ls = left.slides[pair.left] if pair.left is not None else None
    rs = right.slides[pair.right] if pair.right is not None else None
    shown = rs or ls
    name = shown.id if shown is not None else ""
    number = shown.number if shown is not None else None
    num = str(number) if number is not None else "·"
    if pair.status == "added":
        return f"+ {num} {name}: only on the right"
    if pair.status == "removed":
        return f"- {num} {name}: only on the left"
    what = ", ".join(what_changed(pair)) if pair.status == "changed" else ""
    if pair.moved and ls is not None and rs is not None:
        lnum = str(ls.number) if ls.number is not None else "·"
        return f"↕ {lnum} → {num} {name}" + (f": {what}" if what else "")
    return f"~ {num} {name}" + (f": {what}" if what else "")
