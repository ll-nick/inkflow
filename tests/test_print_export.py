"""PDF export at print sizes: page sizes, mixed pages, bleed and crop marks."""

# pyright: reportPrivateUsage=none
from __future__ import annotations

import re
import struct
import textwrap
import zlib
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow.cli import main
from inkflow.export import (
    PdfPage,
    _crop_marks,
    _page_css,
    build_pdf,
    extend_backgrounds,
    find_chromium,
    parse_bleed,
    pdf_pages,
)
from inkflow.manifest import Deck
from inkflow.pdfboxes import PageBoxes, set_page_boxes
from inkflow.pipeline import SlideData
from inkflow.sizes import PageSize
from inkflow.svgio import parse_svg

A0_PT = (2383.937, 3370.394)


def _slide(svg: str) -> SlideData:
    return {"svg": svg, "notes": "", "id": "s", "title": "s"}  # pyright: ignore[reportReturnType]


def _svg(view_box: str, extra: str = "") -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}"{extra}></svg>'


class TestPdfPages:
    def test_the_deck_size_gives_every_page(self) -> None:
        slides = [_slide(_svg("0 0 3179 4494")), _slide(_svg("0 0 1920 1080"))]
        pages = pdf_pages(slides, Deck(size="a0"))
        assert [(p.width, p.height) for p in pages] == [
            pytest.approx(A0_PT, abs=1e-3)
        ] * 2
        # Each slide keeps its own canvas, fitted (letterboxed) onto the page.
        assert pages[1].canvas == (1920, 1080)

    def test_a_poster_drawn_for_a0_prints_on_a1(self) -> None:
        pages = pdf_pages([_slide(_svg("0 0 3179 4494"))], Deck(size="a1"))
        assert (pages[0].width, pages[0].height) == pytest.approx(
            (594 * 72 / 25.4, 841 * 72 / 25.4)
        )

    def test_without_a_size_each_slide_keeps_its_own(self) -> None:
        slides = [
            _slide(_svg("0 0 841 1189", ' width="841mm" height="1189mm"')),
            _slide(_svg("0 0 3179 4494")),
            _slide(_svg("0 0 1920 1080", ' width="1920" height="1080"')),
            _slide(_svg("0 0 100 50", ' width="10in"')),
        ]
        pages = pdf_pages(slides, Deck())
        assert (pages[0].width, pages[0].height) == pytest.approx(A0_PT, abs=1e-3)
        assert (pages[1].width, pages[1].height) == (3179 * 0.75, 4494 * 0.75)
        assert (pages[2].width, pages[2].height) == (1440, 810)
        assert (pages[3].width, pages[3].height) == (720, 360)

    def test_an_override_wins(self) -> None:
        slides = [_slide(_svg("0 0 841 1189", ' width="841mm" height="1189mm"'))]
        pages = pdf_pages(slides, Deck(size="a0"), PageSize("letter"))
        assert (pages[0].width, pages[0].height) == (612, 792)

    def test_each_size_is_a_named_page(self) -> None:
        pages = [
            PdfPage(100, 200, (100, 200)),
            PdfPage(300, 100, (300, 100)),
            PdfPage(100, 200, (100, 200)),
        ]
        css, classes = _page_css(pages)
        assert classes == ["p0", "p1", "p0"]
        assert "@page p0 { size: 100pt 200pt; margin: 0; }" in css
        assert "@page p1 { size: 300pt 100pt; margin: 0; }" in css
        assert ".slide.p1 { page: p1;" in css

    def test_bleed_and_marks_grow_the_sheet(self) -> None:
        page = PdfPage(1000, 2000, (1000, 2000), bleed=parse_bleed("3mm"), marks=True)
        assert page.bleed == pytest.approx(8.504, abs=1e-3)
        # Bleed, then a gap as wide as the bleed, then a 5 mm mark.
        assert page.margin == pytest.approx(8.504 * 2 + 14.17, abs=1e-2)
        assert page.paper == pytest.approx(
            (1000 + 2 * page.margin, 2000 + 2 * page.margin)
        )
        marks = parse_svg(_crop_marks(page))
        assert len(marks) == 8  # two per corner
        for line in marks:
            x1, y1, x2, y2 = (float(line.get(a, "0")) for a in ("x1", "y1", "x2", "y2"))
            # Every mark lies outside the bleed.
            m, b = page.margin, page.bleed
            inside = (
                m - b < min(x1, x2) < m + 1000 + b
                and m - b < min(y1, y2) < m + 2000 + b
                and m - b < max(x1, x2) < m + 1000 + b
                and m - b < max(y1, y2) < m + 2000 + b
            )
            assert not inside


class TestBleed:
    def test_parse(self) -> None:
        assert parse_bleed(None) == 0
        assert parse_bleed("3mm") == pytest.approx(8.504, abs=1e-3)
        assert parse_bleed("3") == pytest.approx(8.504, abs=1e-3)
        assert parse_bleed("0.125in") == 9
        assert parse_bleed(5) == pytest.approx(14.17, abs=1e-2)
        with pytest.raises(ValueError, match="bleed"):
            parse_bleed("lots")
        with pytest.raises(ValueError, match="between"):
            parse_bleed("30mm")

    def test_backgrounds_run_into_the_bleed(self) -> None:
        svg = textwrap.dedent("""\
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">
              <g><rect width="100" height="200" class="inkflow-fill-bg"/></g>
              <image href="a.png" x="0" y="0" width="100" height="200"/>
              <rect id="small" x="10" y="10" width="20" height="20"/>
              <g transform="scale(2)"><rect width="100" height="200"/></g>
            </svg>""")
        out = parse_svg(extend_backgrounds(svg, 5))
        rects = out.findall(".//{http://www.w3.org/2000/svg}rect")
        assert [rects[0].get(a) for a in ("x", "y", "width", "height")] == [
            "-5",
            "-5",
            "110",
            "210",
        ]
        image = out.find(".//{http://www.w3.org/2000/svg}image")
        assert image is not None and image.get("width") == "110"
        assert image.get("preserveAspectRatio") == "xMidYMid slice"
        assert rects[1].get("x") == "10"  # not a background
        assert rects[2].get("width") == "100"  # scaled: not the canvas


# ── Page boxes ────────────────────────────────────────────────────────────────


def _pdf(boxes: list[str]) -> bytes:
    """A minimal PDF laid out as Chromium writes one: a classic xref table."""
    objs = [b"<</Type /Catalog /Pages 2 0 R>>"]
    kids = " ".join(f"{3 + i} 0 R" for i in range(len(boxes)))
    objs.append(f"<</Type /Pages /Kids [{kids}] /Count {len(boxes)}>>".encode())
    for box in boxes:
        objs.append(f"<</Type /Page\n/MediaBox [{box}]\n/Parent 2 0 R>>".encode())
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\n")
    offsets: list[int] = []
    for n, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<</Size {len(objs) + 1}\n/Root 1 0 R>>\n".encode()
    out += f"startxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def _boxes(data: bytes, name: bytes = b"MediaBox") -> list[list[float]]:
    return [
        [float(v) for v in m.group(1).split()]
        for m in re.finditer(rb"/" + name + rb"\s*\[([-\d. ]+)\]", data)
    ]


def _xref_is_valid(data: bytes) -> bool:
    start = int([m.group(1) for m in re.finditer(rb"startxref\s+(\d+)", data)][-1])
    section = data[start:]
    count = int(re.match(rb"xref\s+0\s+(\d+)", section).group(1))  # pyright: ignore[reportOptionalMemberAccess]
    entries = section[section.index(b"\n", 5) + 1 :]
    for n in range(1, count):
        offset = int(entries[20 * n : 20 * n + 10])
        if not data[offset:].startswith(f"{n} 0 obj".encode()):
            return False
    return True


class TestPageBoxes:
    def test_exact_size_hanging_from_the_top(self, tmp_path: Path) -> None:
        path = tmp_path / "a.pdf"
        path.write_bytes(_pdf(["0 0 2383.9199 3370.0798", "0 0 1440 810"]))
        assert set_page_boxes(path, [PageBoxes(*A0_PT), PageBoxes(1440, 810)])
        data = path.read_bytes()
        boxes = _boxes(data)
        # Exactly A0, its top where Chromium hung the content from.
        assert boxes[0] == pytest.approx(
            [0, 3370.0798 - A0_PT[1], A0_PT[0], 3370.0798], abs=1e-3
        )
        assert boxes[1] == [0, 0, 1440, 810]
        assert _xref_is_valid(data)

    def test_trim_and_bleed_boxes(self, tmp_path: Path) -> None:
        path = tmp_path / "b.pdf"
        path.write_bytes(_pdf(["0 0 200 300"]))
        assert set_page_boxes(path, [PageBoxes(200, 300, trim_inset=30, bleed=9)])
        data = path.read_bytes()
        assert _boxes(data, b"TrimBox") == [[30, 30, 170, 270]]
        assert _boxes(data, b"BleedBox") == [[21, 21, 179, 279]]
        assert _xref_is_valid(data)

    def test_an_unexpected_file_is_left_alone(self, tmp_path: Path) -> None:
        path = tmp_path / "c.pdf"
        path.write_bytes(b"%PDF-1.4 not really")
        assert not set_page_boxes(path, [PageBoxes(1, 1)])
        assert path.read_bytes() == b"%PDF-1.4 not really"
        two = tmp_path / "d.pdf"
        two.write_bytes(_pdf(["0 0 10 10", "0 0 10 10"]))
        assert not set_page_boxes(two, [PageBoxes(10, 10)])  # page count differs


# ── Through Chromium ──────────────────────────────────────────────────────────

needs_chromium = pytest.mark.skipif(
    find_chromium() is None, reason="chromium not available"
)


def _png(width: int, height: int) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(kind + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)

    row = bytes(3 * width)
    raw = b"".join(
        b"\x00" + bytes((i * 7 + j) % 256 for j in range(len(row)))
        for i in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


_POSTER_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3179 4494">
      <rect width="3179" height="4494" fill="#eef"/>
      <text x="200" y="400" font-size="120" font-family="sans-serif">Poster title</text>
      <image href="photo.png" x="200" y="600" width="800" height="800"/>
    </svg>
""")

_MM_SVG = textwrap.dedent("""\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 841 1189"
         width="841mm" height="1189mm">
      <text x="50" y="100" font-size="40" font-family="sans-serif">In mm</text>
    </svg>
""")


def _deck(tmp_path: Path, size: str | None, *srcs: str) -> Path:
    slides = ", ".join(f'Slide("slides/{s}")' for s in srcs)
    arg = f"size={size!r}, " if size else ""
    deck = tmp_path / "deck.py"
    deck.write_text(
        "from inkflow import Deck, Slide\n\n\n"
        + f"def main() -> Deck:\n    return Deck({arg}slides=[{slides}])\n"
    )
    return deck


@pytest.fixture
def poster(tmp_path: Path) -> Path:
    (tmp_path / "slides").mkdir()
    (tmp_path / "slides" / "poster.svg").write_text(_POSTER_SVG)
    (tmp_path / "slides" / "photo.png").write_bytes(_png(1200, 900))
    (tmp_path / "slides" / "mm.svg").write_text(_MM_SVG)
    (tmp_path / "slides" / "wide.svg").write_text(_svg("0 0 1920 1080"))
    return tmp_path


@needs_chromium
class TestPrintedPdf:
    def test_a0_poster_is_exactly_a0_vector_and_full_resolution(
        self, poster: Path
    ) -> None:
        out = poster / "a0.pdf"
        build_pdf(_deck(poster, "a0", "poster.svg"), out, no_sandbox=True)
        data = out.read_bytes()
        (box,) = _boxes(data)
        assert box[2] - box[0] == pytest.approx(A0_PT[0], abs=0.01)
        assert box[3] - box[1] == pytest.approx(A0_PT[1], abs=0.01)
        # Text stays text, in the shipped font: sans-serif is the deck's Inter,
        # which Chromium embeds as a Type 3 font (outlines) since it is variable.
        assert b"InterVariable" in data
        assert b"/FontFile" in data or b"/Type3" in data
        # The photo is embedded at its own resolution, not resampled.
        assert re.search(rb"/Width 1200\s*/Height 900|/Height 900\s*/Width 1200", data)
        assert len(data) < 2_000_000

    def test_mixed_sizes_print_on_their_own_pages(self, poster: Path) -> None:
        out = poster / "mixed.pdf"
        build_pdf(
            _deck(poster, None, "poster.svg", "mm.svg", "wide.svg"),
            out,
            no_sandbox=True,
        )
        sizes = [(b[2] - b[0], b[3] - b[1]) for b in _boxes(out.read_bytes())]
        assert sizes[0] == pytest.approx((3179 * 0.75, 4494 * 0.75), abs=0.01)
        assert sizes[1] == pytest.approx(A0_PT, abs=0.01)
        assert sizes[2] == pytest.approx((1440, 810), abs=0.01)

    def test_bleed_and_crop_marks(self, poster: Path) -> None:
        out = poster / "bleed.pdf"
        build_pdf(
            _deck(poster, "a1", "poster.svg"),
            out,
            no_sandbox=True,
            bleed="3mm",
            crop_marks=True,
        )
        data = out.read_bytes()
        (trim,) = _boxes(data, b"TrimBox")
        (bleed,) = _boxes(data, b"BleedBox")
        assert trim[2] - trim[0] == pytest.approx(594 * 72 / 25.4, abs=0.01)
        assert trim[3] - trim[1] == pytest.approx(841 * 72 / 25.4, abs=0.01)
        assert trim[0] - bleed[0] == pytest.approx(3 * 72 / 25.4, abs=0.01)


def test_cli_size_accepts_names_and_px(poster: Path) -> None:
    deck = _deck(poster, None, "wide.svg")
    result = CliRunner().invoke(
        main, ["export", "--deck", str(deck), "--size", "b7", "--chromium", "/no"]
    )
    assert result.exit_code != 0
    assert "--size" in result.output and "page size" in result.output
    result = CliRunner().invoke(
        main, ["export", "--deck", str(deck), "--bleed", "huge", "--chromium", "/no"]
    )
    assert result.exit_code != 0 and "bleed" in result.output


def test_editor_export_passes_print_marks(poster: Path) -> None:
    from inkflow.editor.session import EditorSession, Exporters

    calls: list[dict[str, object]] = []

    def html(deck_path: Path, out_dir: Path, inline_assets: bool = True) -> None:
        del deck_path, out_dir, inline_assets
        raise AssertionError("not asked for")

    def pdf(
        deck_path: Path,
        output: Path,
        chromium: str | None = None,
        no_sandbox: bool = False,
        size: PageSize | str | tuple[float, float] | None = None,
        bleed: str | float | None = None,
        crop_marks: bool = False,
    ) -> None:
        del deck_path, chromium, no_sandbox, size
        calls.append({"bleed": bleed, "marks": crop_marks})
        output.write_bytes(b"%PDF")

    deck = _deck(poster, "a0", "poster.svg")
    session = EditorSession(deck, Exporters(html=html, pdf=pdf))
    session.apply({"action": "export", "format": "pdf"}, None)
    session.apply({"action": "export", "format": "pdf", "printMarks": True}, None)
    assert calls == [
        {"bleed": None, "marks": False},
        {"bleed": "3mm", "marks": True},
    ]
