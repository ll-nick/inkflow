"""PDF figures as pictures: a page converted to SVG, cached, shown everywhere."""

from __future__ import annotations

import importlib.util
import logging
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest

from inkflow import Deck, Image, Slide, pdf
from inkflow.assets import AssetRoots
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import file_hash
from inkflow.editor.transfer import export_assets, retarget_fragment
from inkflow.export import build_static_html
from inkflow.logging import collect_logs
from inkflow.pipeline import process_deck
from inkflow.server import (
    _resolve_asset,  # pyright: ignore[reportPrivateUsage]
    load_deck,
)
from inkflow.svgio import parse_svg
from inkflow.verify import verify_slide

needs_pdftocairo = pytest.mark.skipif(
    shutil.which("pdftocairo") is None, reason="pdftocairo (poppler) not installed"
)

_SVG = "http://www.w3.org/2000/svg"
_XHTML = "http://www.w3.org/1999/xhtml"


def make_pdf(pages: list[tuple[float, float, str]]) -> bytes:
    """A small valid PDF: one page per ``(width, height, content stream)``."""
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"",  # the page tree, once the pages are numbered
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    kids: list[int] = []
    for width, height, content in pages:
        data = content.encode()
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(data), data))
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %g %g] /Contents %d 0 R"
            % (width, height, len(objects))
            + b" /Resources << /Font << /F1 3 0 R >> >> >>"
        )
        kids.append(len(objects))
    refs = b" ".join(b"%d 0 R" % k for k in kids)
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (refs, len(kids))
    out = b"%PDF-1.4\n"
    offsets: list[int] = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(objects) + 1)
    return out + b"startxref\n%d\n%%%%EOF\n" % xref


# A plot (a filled bar, a line, a label) and a small square on page 2.
FIGURE = make_pdf(
    [
        (
            300,
            160,
            "0.2 0.4 0.8 rg 20 20 100 60 re f 0 0 0 RG 2 w 20 20 m 260 140 l S"
            + " BT /F1 18 Tf 140 30 Td (y = x) Tj ET",
        ),
        (100, 100, "0.8 0.2 0.2 rg 10 10 80 80 re f"),
    ]
)


def _project(tmp_path: Path) -> Path:
    (tmp_path / "figures").mkdir(parents=True)
    (tmp_path / "figures" / "plot.pdf").write_bytes(FIGURE)
    (tmp_path / "slides").mkdir()
    return tmp_path


def _slide_svg(project: Path, body: str) -> None:
    (project / "slides" / "s.svg").write_text(
        f'<svg xmlns="{_SVG}" viewBox="0 0 1920 1080">{body}'
        + '<rect id="zone-media" x="1000" y="100" width="800" height="600"/></svg>',
        encoding="utf-8",
    )


def _installed(*names: str) -> Callable[[str], str | None]:
    """A ``shutil.which`` that finds only ``names``."""
    return lambda name: f"/usr/bin/{name}" if name in names else None


class FakePyMuPDF:
    """Stands in for the ``pymupdf`` module: two pages, each one SVG."""

    class Document:
        page_count: int = 2

        def load_page(self, page_id: int) -> FakePyMuPDF.Page:
            return FakePyMuPDF.Page(page_id)

        def close(self) -> None:
            pass

    class Page:
        def __init__(self, page_id: int) -> None:
            self.page_id: int = page_id

        def get_svg_image(self, *, text_as_path: bool = True) -> str:
            assert text_as_path
            return f'<svg xmlns="{_SVG}" id="page{self.page_id}"/>'

    @staticmethod
    def open(_path: str) -> FakePyMuPDF.Document:
        return FakePyMuPDF.Document()


def _only(monkeypatch: pytest.MonkeyPatch, *names: str) -> None:
    """Make ``names`` the only converters available (``pymupdf``: the extra)."""
    monkeypatch.setattr("inkflow.pdf.shutil.which", _installed(*names))
    fake = FakePyMuPDF if "pymupdf" in names else None
    monkeypatch.setattr("inkflow.pdf._pymupdf", lambda: fake)


def _images(svg: str) -> list[dict[str, str]]:
    root = parse_svg(svg)
    return [
        {str(k): str(v) for k, v in el.attrib.items()}
        for el in root.iter(f"{{{_SVG}}}image", f"{{{_XHTML}}}img")
        if el.get("data-inkflow-pdf")
    ]


# ── References ──


@pytest.mark.parametrize(
    ("ref", "page"),
    [
        ("plot.pdf", 1),
        ("plot.pdf#page=3", 3),
        ("plot.pdf#zoom=50&page=2", 2),
        ("plot.pdf#view=Fit", 1),
        ("plot.pdf#page=0", None),
        ("plot.pdf#page=two", None),
    ],
)
def test_page_of(ref: str, page: int | None) -> None:
    assert pdf.page_of(ref) == page


def test_references() -> None:
    assert pdf.is_pdf_ref("figures/Plot.PDF#page=2")
    assert not pdf.is_pdf_ref("https://example.com/plot.pdf")
    assert not pdf.is_pdf_ref("plot.png")
    assert pdf.with_page("plot.pdf#page=4", 1) == "plot.pdf"
    assert pdf.with_page("plot.pdf", 2) == "plot.pdf#page=2"


def test_image_page_is_kept_as_the_fragment() -> None:
    assert Image("plot.pdf", page=2).src == "plot.pdf#page=2"
    assert Image("plot.pdf", page=1).src == "plot.pdf"
    with pytest.raises(ValueError, match="1 or more"):
        _ = Image("plot.pdf", page=0)
    with pytest.raises(ValueError, match="src or page"):
        _ = Image("plot.pdf#page=2", page=3)


def test_the_cache_is_an_asset_root(tmp_path: Path) -> None:
    roots = AssetRoots(tmp_path)
    page = tmp_path / ".inkflow" / "cache" / "pdf" / "plot-p1-0123.svg"
    assert roots.canonicalize(page) == "_pdf/plot-p1-0123.svg"
    assert roots.locate("_pdf/plot-p1-0123.svg") == page
    assert roots.locate("_pdf/../../deck.py") is None


def test_page_count(tmp_path: Path) -> None:
    path = tmp_path / "plot.pdf"
    path.write_bytes(FIGURE)
    assert pdf.page_count(path) == 2


def test_page_count_without_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _only(monkeypatch)
    path = tmp_path / "plot.pdf"
    path.write_bytes(FIGURE)
    assert pdf.page_count(path) == 2


# ── Converting ──


@pytest.fixture
def fake_tool(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """A converter that writes a small SVG and records each command it ran."""
    calls: list[list[str]] = []

    def run(command: list[str]) -> object:
        import subprocess

        calls.append(command)
        Path(command[-1]).write_text(
            f'<svg xmlns="{_SVG}" width="10" height="10"/>', encoding="utf-8"
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setitem(
        pdf.CONVERTERS, "fake", lambda p, n, out: ["fake", str(p), str(n), str(out)]
    )
    monkeypatch.setattr("inkflow.pdf._run", run)
    return calls


def test_cache_is_keyed_by_content_and_page(
    tmp_path: Path, fake_tool: list[list[str]]
) -> None:
    project = _project(tmp_path)
    source = project / "figures" / "plot.pdf"
    first = pdf.convert(source, 1, project, "fake")
    assert first.parent == project / ".inkflow" / "cache" / "pdf"
    assert first.name.startswith("plot-p1-")
    assert (project / ".inkflow" / ".gitignore").read_text() == "*\n"
    assert pdf.convert(source, 1, project, "fake") == first
    assert len(fake_tool) == 1  # converted once
    second = pdf.convert(source, 2, project, "fake")
    assert second != first and len(fake_tool) == 2
    # A changed PDF converts again, under a new name.
    source.write_bytes(FIGURE + b"% changed\n")
    changed = pdf.convert(source, 1, project, "fake")
    assert changed != first and len(fake_tool) == 3
    assert not list(changed.parent.glob(".*.svg"))  # no partial files left


@pytest.mark.parametrize(
    ("installed", "chosen"),
    [
        ({"pymupdf", "pdftocairo", "mutool", "inkscape"}, "pymupdf"),
        ({"pdftocairo", "mutool", "inkscape"}, "pdftocairo"),
        ({"mutool", "inkscape"}, "mutool"),
        ({"inkscape"}, "inkscape"),
        (set[str](), None),
    ],
)
def test_converter_fallback_order(
    monkeypatch: pytest.MonkeyPatch, installed: set[str], chosen: str | None
) -> None:
    _only(monkeypatch, *installed)
    assert pdf.converter() == chosen


def test_pymupdf_converts_counts_and_has_its_own_cache_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_tool: list[list[str]]
) -> None:
    _only(monkeypatch, "pymupdf", "pdftocairo")
    project = _project(tmp_path)
    source = project / "figures" / "plot.pdf"
    page = pdf.convert(source, 2, project)
    assert page.read_text() == f'<svg xmlns="{_SVG}" id="page1"/>'
    assert pdf.page_count(source) == 2
    with pytest.raises(pdf.PdfError, match=r"page 3: plot\.pdf has 2"):
        _ = pdf.convert(source, 3, project)
    # Another converter draws the page anew rather than reuse this one.
    assert pdf.convert(source, 2, project, "fake") != page
    assert len(fake_tool) == 1


def test_the_hint_puts_the_extra_first(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("inkflow.pdf.sys.prefix", "/home/me/.local/share/pipx/x")
    assert pdf.install_hint().startswith(
        "install inkflow's PDF extra (pipx inject inkflow pymupdf;"
    )
    monkeypatch.setattr("inkflow.pdf.sys.prefix", "/usr")
    hint = pdf.install_hint()
    assert 'pip install "inkflow[pdf]"' in hint and "AGPL" in hint
    assert hint.index("inkflow[pdf]") < hint.index("poppler-utils")


@pytest.mark.skipif(
    importlib.util.find_spec("pymupdf") is None, reason="the pdf extra is not installed"
)
def test_real_pymupdf_draws_text_as_outlines(tmp_path: Path) -> None:
    project = _project(tmp_path)
    source = project / "figures" / "plot.pdf"
    assert pdf.page_count(source) == 2
    page = pdf.convert(source, 1, project, pdf.PYMUPDF)
    root = parse_svg(page.read_bytes())
    assert root.get("viewBox") == "0 0 300 160"
    assert "<text" not in page.read_text()
    with pytest.raises(pdf.PdfError):
        _ = pdf.convert(source, 3, project, pdf.PYMUPDF)


def test_converter_commands() -> None:
    src, out = Path("in.pdf"), Path("out.svg")
    assert pdf.CONVERTERS["pdftocairo"](src, 2, out) == [
        "pdftocairo",
        "-svg",
        "-f",
        "2",
        "-l",
        "2",
        "in.pdf",
        "out.svg",
    ]
    mutool = pdf.CONVERTERS["mutool"](src, 2, out)
    assert mutool[:4] == ["mutool", "convert", "-F", "svg"]
    assert mutool[-2:] == ["in.pdf", "2"]
    inkscape = pdf.CONVERTERS["inkscape"](src, 2, out)
    assert "--pdf-page=2" in inkscape and "--export-type=svg" in inkscape


def test_a_numbered_output_file_is_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    def run(command: list[str]) -> object:
        # Like mutool, which may number the file it writes.
        out = Path(command[command.index("-o") + 1])
        out.with_name("page1.svg").write_text(f'<svg xmlns="{_SVG}"/>')
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr("inkflow.pdf._run", run)
    project = _project(tmp_path)
    page = pdf.convert(project / "figures" / "plot.pdf", 1, project, "mutool")
    assert page.read_text() == f'<svg xmlns="{_SVG}"/>'


def test_a_failed_conversion_says_why(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    def run(command: list[str]) -> object:
        return subprocess.CompletedProcess(command, 99, "", "Wrong page range\n")

    monkeypatch.setattr("inkflow.pdf._run", run)
    project = _project(tmp_path)
    with pytest.raises(pdf.PdfError, match="page 7: Wrong page range"):
        _ = pdf.convert(project / "figures" / "plot.pdf", 7, project, "pdftocairo")


@needs_pdftocairo
def test_pdftocairo_converts_a_page_to_vector_svg(tmp_path: Path) -> None:
    project = _project(tmp_path)
    page = pdf.convert(project / "figures" / "plot.pdf", 2, project, "pdftocairo")
    root = parse_svg(page.read_bytes())
    assert (root.get("width"), root.get("height")) == ("100", "100")
    first = pdf.convert(project / "figures" / "plot.pdf", 1, project, "pdftocairo")
    # Text is drawn as glyph outlines: the figure keeps its font anywhere.
    assert "<text" not in first.read_text() and "glyph" in first.read_text()
    with pytest.raises(pdf.PdfError):
        _ = pdf.convert(project / "figures" / "plot.pdf", 3, project, "pdftocairo")


# ── Slides ──


@needs_pdftocairo
@pytest.mark.parametrize("editor", [False, True])
def test_pipeline_points_every_kind_of_picture_at_its_page(
    tmp_path: Path, editor: bool
) -> None:
    project = _project(tmp_path)
    _slide_svg(
        project,
        '<image id="fig" href="../figures/plot.pdf#page=2" x="0" y="0"'
        + ' width="400" height="400"/>',
    )
    (project / "slides" / "s.md").write_text(
        "::title::\n![a plot](../figures/plot.pdf)\n", encoding="utf-8"
    )
    (project / "slides" / "t.svg").write_text(
        f'<svg xmlns="{_SVG}" viewBox="0 0 1920 1080">'
        + '<rect id="zone-title" x="0" y="0" width="1920" height="1080"/></svg>',
        encoding="utf-8",
    )
    deck = Deck(
        slides=[
            Slide("slides/s.svg", zones={"media": Image("figures/plot.pdf", page=2)}),
            Slide("slides/t.svg", md="slides/s.md"),
        ],
        embed_fonts=False,
    )
    with collect_logs(logging.WARNING) as warnings:
        slides = process_deck(deck, project, project / "deck.py", editor=editor)
    assert not warnings
    image, zone = _images(slides[0]["svg"])
    assert image["data-inkflow-pdf"] == "figures/plot.pdf#page=2"
    assert image["href"].startswith("_pdf/plot-p2-")
    assert zone["data-inkflow-pdf"] == "figures/plot.pdf#page=2"
    assert zone["src"] == image["href"]
    (markdown,) = _images(slides[1]["svg"])
    assert markdown["data-inkflow-pdf"] == "figures/plot.pdf"
    assert markdown["src"].startswith("_pdf/plot-p1-")
    roots = AssetRoots(project)
    for ref in (image["href"], markdown["src"]):
        located = roots.locate(ref)
        assert located is not None and located.is_file()
        # What `serve` answers for the reference the slide carries.
        assert _resolve_asset(roots, f"/{ref}?v=1") == located.resolve()


def test_without_a_converter_a_placeholder_and_one_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _only(monkeypatch)
    project = _project(tmp_path)
    _slide_svg(project, '<image href="../figures/plot.pdf#page=2" width="4"/>')
    deck = Deck(
        slides=[
            Slide("slides/s.svg", zones={"media": Image("figures/plot.pdf")}),
            Slide("slides/s.svg"),
        ],
        embed_fonts=False,
    )
    with collect_logs(logging.WARNING) as warnings:
        slides = process_deck(deck, project, project / "deck.py")
    assert len(warnings) == 1
    assert "inkflow[pdf]" in warnings[0].message
    assert "poppler-utils" in warnings[0].message
    assert "mupdf-tools" in warnings[0].message
    image, zone = _images(slides[0]["svg"])
    assert image["href"].startswith("data:image/svg+xml;base64,")
    assert image["data-inkflow-pdf"] == "figures/plot.pdf#page=2"
    assert zone["src"].startswith("data:image/svg+xml;base64,")
    import base64

    drawn = base64.b64decode(image["href"].split(",", 1)[1]).decode()
    assert "plot.pdf, page 2" in drawn and "stroke-dasharray" in drawn
    assert not (project / ".inkflow").exists()


def test_a_missing_pdf_or_page_is_a_placeholder(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _slide_svg(
        project,
        '<image href="../figures/gone.pdf"/><image href="../figures/plot.pdf#page=x"/>',
    )
    deck = Deck(slides=[Slide("slides/s.svg")], embed_fonts=False)
    with collect_logs(logging.WARNING) as warnings:
        slides = process_deck(deck, project, project / "deck.py")
    messages = " ".join(w.message for w in warnings)
    assert "PDF not found: figures/gone.pdf" in messages
    assert "no page number" in messages
    assert all(i["href"].startswith("data:") for i in _images(slides[0]["svg"]))


# ── Build ──


@needs_pdftocairo
@pytest.mark.parametrize("inline", [False, True])
def test_build_carries_the_converted_page(tmp_path: Path, inline: bool) -> None:
    project = _project(tmp_path / "deck")
    _slide_svg(project, '<image href="../figures/plot.pdf" width="300"/>')
    (project / "deck.py").write_text(
        "from inkflow import Deck, Slide\n\n\ndef main() -> Deck:\n"
        + '    return Deck(slides=[Slide("slides/s.svg")], embed_fonts=False)\n',
        encoding="utf-8",
    )
    out = tmp_path / "out"
    build_static_html(project / "deck.py", out, inline_assets=inline)
    html = (out / "index.html").read_text(encoding="utf-8")
    copied = list(out.rglob("*.svg"))
    if inline:
        assert "data:image/svg+xml;base64," in html and not copied
    else:
        (page,) = copied
        # Beside index.html under _pdf/, not in a hidden folder.
        assert page.relative_to(out).parts[0] == "_pdf"
        assert f"_pdf/{page.name}" in html
    assert not list(out.rglob("*.pdf"))  # the source PDF stays home


# ── Editor ──


DECK_PY = """\
from inkflow import Deck, Image, Slide


def main() -> Deck:
    return Deck(
        slides=[Slide("slides/s.svg", zones={"media": Image("figures/plot.pdf")})],
        embed_fonts=False,
    )
"""


@needs_pdftocairo
def test_editor_writes_back_the_pdf_reference(tmp_path: Path) -> None:
    from inkflow.editor.provenance import INK

    project = _project(tmp_path)
    _slide_svg(
        project,
        '<image id="fig" href="../figures/plot.pdf#page=2" x="0" y="0"'
        + ' width="400" height="400"/>',
    )
    (project / "deck.py").write_text(DECK_PY, encoding="utf-8")
    deck = load_deck(project / "deck.py")
    slides = process_deck(deck, project, project / "deck.py", editor=True)
    image = next(i for i in _images(slides[0]["svg"]) if i.get("id") == "fig")
    session = EditorSession(project / "deck.py")
    svg = project / "slides" / "s.svg"
    # Moving it (what the canvas sends), then cropping it.
    for ops in (
        [{"kind": "attrs", "loc": image[INK], "set": {"x": "50"}}],
        [{"kind": "crop-frame", "loc": image[INK]}],
    ):
        result = session.apply(
            {
                "action": "svg",
                "file": str(svg),
                "hash": file_hash(svg.read_bytes()),
                "ops": ops,
            },
            deck,
        )
        assert result["ok"]
    text = svg.read_text()
    assert "_pdf" not in text and "data-inkflow-pdf" not in text
    written = parse_svg(text).find(f".//{{{_SVG}}}image")
    assert written is not None and written.get("href") == "../figures/plot.pdf#page=2"
    frame = written.getparent()
    assert frame is not None and frame.tag == f"{{{_SVG}}}svg"  # cropped

    # The zone's page, picked in its panel.
    session.apply(
        {
            "action": "zone-media",
            "slide": 0,
            "zone": "media",
            "src": str(project / "figures" / "plot.pdf"),
            "page": 2,
        },
        deck,
    )
    assert 'Image("figures/plot.pdf#page=2")' in (project / "deck.py").read_text()


@needs_pdftocairo
def test_page_picker_actions(tmp_path: Path) -> None:
    project = _project(tmp_path)
    (project / "deck.py").write_text(DECK_PY, encoding="utf-8")
    session = EditorSession(project / "deck.py")
    info = session.apply({"action": "pdf-pages", "path": "figures/plot.pdf"}, None)
    assert info["pages"] == 2 and info["converter"] == pdf.converter()
    assert info["ignored"] is False
    page = session.apply(
        {"action": "pdf-page", "path": "figures/plot.pdf#page=2", "page": 2}, None
    )
    url = cast("str", page["url"])
    assert url.startswith("_pdf/plot-p2-")
    assert AssetRoots(project).locate(url) is not None
    for bad in ("../x.pdf", "deck.py", "figures/none.pdf"):
        with pytest.raises(EditError):
            session.apply({"action": "pdf-pages", "path": bad}, None)
    with pytest.raises(EditError, match="could not convert page 9"):
        session.apply(
            {"action": "pdf-page", "path": "figures/plot.pdf", "page": 9}, None
        )


def test_pdfs_upload_and_open(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from inkflow.edit import open_choices, resolve_edit_commands
    from inkflow.editor import media

    project = _project(tmp_path)
    staged = project / "upload.part"
    staged.write_bytes(FIGURE)
    assert media.settle(project, staged, "Figure 3.pdf") == project / "assets" / (
        "figure-3.pdf"
    )
    monkeypatch.setattr(
        "inkflow.edit.shutil.which",
        _installed("okular", "inkscape"),
    )
    apps = open_choices(project / "figures" / "plot.pdf", resolve_edit_commands())
    assert [a.id for a in apps] == ["okular", "inkscape", "system"]


def test_copied_objects_bring_the_pdf_and_keep_the_page(tmp_path: Path) -> None:
    project = _project(tmp_path)
    files = export_assets(project, ["figures/plot.pdf#page=2"])
    assert list(files) == ["figures/plot.pdf"]
    xml = '<image href="figures/plot.pdf#page=2"/>'
    moved = retarget_fragment(xml, "slides/s.svg", {"figures/plot.pdf": "a/p.pdf"})
    assert moved == '<image href="../a/p.pdf#page=2"/>'


# ── Verify ──


def test_verify_reports_pages_and_a_missing_converter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from inkflow.sync import build_context

    project = _project(tmp_path)
    _slide_svg(project, '<image href="../figures/plot.pdf#page=5"/>')
    deck = Deck(
        slides=[Slide("slides/s.svg", zones={"media": Image("figures/plot.pdf")})]
    )
    preview = build_context(deck, project, deck.theme, True)
    issues = verify_slide(deck.slides[0], project, deck.theme, preview)
    assert ("error", "plot.pdf has 2 pages, not 5") in issues
    assert not any("media not found" in m for _, m in issues)
    _only(monkeypatch)
    issues = verify_slide(deck.slides[0], project, deck.theme, preview)
    assert any(level == "warn" and "poppler-utils" in m for level, m in issues)
