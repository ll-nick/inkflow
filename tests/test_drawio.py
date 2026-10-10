"""draw.io diagrams (*.drawio.svg): the source inside, stored uncompressed;
the editor's load/save; git's view of them; opening them elsewhere."""

from __future__ import annotations

import base64
import urllib.parse
import zlib
from pathlib import Path

import pytest
from click.testing import CliRunner

from inkflow import drawio
from inkflow.cli import main
from inkflow.edit import App, EditCommands, open_choices
from inkflow.editor.session import EditError, EditorSession
from inkflow.editor.svgops import SvgFile, file_hash

MODEL = (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="a" value="Client" vertex="1" parent="1">'
    + '<mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>'
    + "</root></mxGraphModel>"
)


def _compressed(model: str) -> str:
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = deflate.compress(urllib.parse.quote(model).encode()) + deflate.flush()
    return base64.b64encode(raw).decode()


def _svg(mxfile: str, width: int = 200, height: int = 100) -> str:
    content = (
        mxfile.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}px" '
        + f'height="{height}px" viewBox="-0.5 -0.5 {width} {height}" '
        + f'content="{content}"><rect width="80" height="40"/></svg>'
    )


COMPRESSED = _svg(
    f'<mxfile host="test"><diagram id="p" name="Page-1">{_compressed(MODEL)}'
    + "</diagram></mxfile>"
)


def test_the_source_comes_out_uncompressed() -> None:
    data = COMPRESSED.encode()
    assert drawio.is_drawio_svg(data)
    assert not drawio.is_drawio_svg(b"<svg xmlns='http://www.w3.org/2000/svg'/>")
    source = drawio.source(data)
    assert 'value="Client"' in source and 'compressed="false"' in source
    stored = drawio.normalize(data).decode()
    assert "&lt;mxGraphModel&gt;" in stored  # readable in the file itself
    assert drawio.size(data) == (200.0, 100.0)
    # git's view: one tag a line
    text = drawio.textconv(data)
    assert '\n        <mxCell id="a" value="Client"' in text
    with pytest.raises(drawio.DrawioError, match=r"no draw\.io diagram"):
        drawio.normalize(b"<svg xmlns='http://www.w3.org/2000/svg'/>")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    deck = tmp_path / "deck"
    (deck / "slides").mkdir(parents=True)
    (deck / "deck.py").write_text("# deck\n", encoding="utf-8")
    (deck / "slides" / "s.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">'
        + '<image id="pic" href="../diagrams/flow.drawio.svg" x="100" y="100"'
        + ' width="400" height="200"/></svg>',
        encoding="utf-8",
    )
    return deck


def test_load_and_save_through_the_session(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = EditorSession(project / "deck.py")
    fresh = session.apply({"action": "drawio-load"}, None)
    assert fresh["xml"] == "" and fresh["url"] == drawio.DEFAULT_URL
    monkeypatch.setenv("INKFLOW_DRAWIO_URL", "http://localhost:8080/")
    # A new diagram gets its file on the first save.
    made = session.apply({"action": "drawio-save", "svg": COMPRESSED}, object())  # pyright: ignore[reportArgumentType]
    assert made["rel"] == "diagrams/diagram-1.drawio.svg"
    assert (made["width"], made["height"]) == (200.0, 100.0)
    (project / "diagrams" / "flow.drawio.svg").write_text(COMPRESSED, encoding="utf-8")
    loaded = session.apply(
        {"action": "drawio-load", "path": "diagrams/flow.drawio.svg"}, None
    )
    assert 'value="Client"' in str(loaded["xml"])
    assert loaded["url"] == "http://localhost:8080/" and loaded["name"] == "flow"
    # Saved again, taller: the slide's picture keeps its width, new height.
    slide = project / "slides" / "s.svg"
    loc = "0:" + "0"
    taller = _svg(
        f'<mxfile><diagram id="p" name="Page-1">{MODEL}</diagram></mxfile>', 200, 200
    )
    session.apply(
        {
            "action": "drawio-save",
            "path": "diagrams/flow.drawio.svg",
            "svg": taller,
            "image": {
                "file": str(slide),
                "hash": file_hash(slide.read_bytes()),
                "loc": loc,
            },
        },
        object(),  # pyright: ignore[reportArgumentType]
    )
    image = SvgFile.from_bytes(slide, slide.read_bytes()).root[0]
    assert (image.get("width"), image.get("height")) == ("400", "400")
    assert 'height="200px"' in (project / "diagrams" / "flow.drawio.svg").read_text()
    # One undo step puts both back.
    session.apply({"action": "undo"}, None)
    assert SvgFile.from_bytes(slide, slide.read_bytes()).root[0].get("height") == "200"
    with pytest.raises(EditError, match="outside"):
        session.apply({"action": "drawio-load", "path": "../x.drawio.svg"}, None)
    with pytest.raises(EditError, match=r"not a draw\.io"):
        session.apply({"action": "drawio-load", "path": "slides/s.svg"}, None)


def test_clean_leaves_diagrams_alone_and_diffs_show_the_source(
    project: Path,
) -> None:
    diagram = project / "flow.drawio.svg"
    diagram.write_text(COMPRESSED, encoding="utf-8")
    runner = CliRunner()
    result = runner.invoke(main, ["clean", str(diagram)])
    assert result.exit_code == 0 and diagram.read_text() == COMPRESSED
    result = runner.invoke(main, ["clean", "--stdout", str(diagram)])
    assert result.exit_code == 0 and "<mxfile" in result.output
    assert 'value="Client"' in result.output


def test_open_with_offers_draw_io(monkeypatch: pytest.MonkeyPatch) -> None:
    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in ("drawio", "inkscape") else None

    monkeypatch.setattr("inkflow.edit.shutil.which", which)
    choices = open_choices(Path("flow.drawio.svg"), EditCommands(None, None))
    assert [c.id for c in choices][:2] == ["drawio", "inkscape"]


def test_a_new_diagram_for_draw_io_desktop(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = EditorSession(project / "deck.py")
    made = session.apply({"action": "drawio-new"}, object())  # pyright: ignore[reportArgumentType]
    assert made["rel"] == "diagrams/diagram-1.drawio.svg"
    assert (made["width"], made["height"]) == drawio.BLANK_SIZE
    data = (project / "diagrams" / "diagram-1.drawio.svg").read_bytes()
    assert drawio.is_drawio_svg(data) and b"New diagram" in data  # placeholder
    assert "<mxCell" in drawio.source(data)
    # Opening it in draw.io desktop leaves the file exactly as it is (no
    # Inkscape preview layers, unlike a slide SVG).
    launched: list[str] = []

    def which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name == "drawio" else None

    monkeypatch.setattr("inkflow.edit.shutil.which", which)

    def open_with(path: Path, app: App) -> None:
        launched.append(f"{app.id}:{path.name}")

    monkeypatch.setattr("inkflow.editor.session.open_with", open_with)
    session.apply(
        {
            "action": "open-file",
            "path": "diagrams/diagram-1.drawio.svg",
            "app": "drawio",
            "_local": True,
        },
        object(),  # pyright: ignore[reportArgumentType]
    )
    assert launched == ["drawio:diagram-1.drawio.svg"]
    assert (project / "diagrams" / "diagram-1.drawio.svg").read_bytes() == data
