# fontTools ships no type stubs, so its builder/pen calls in the font fixture below
# report partially-unknown member types. Silence that one rule for this test module.
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import logging
import textwrap
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from inkflow.fonts import (
    _best_match,  # pyright: ignore[reportPrivateUsage]
    _build_index,  # pyright: ignore[reportPrivateUsage]
    _css_weight_to_int,  # pyright: ignore[reportPrivateUsage]
    _first_named_family,  # pyright: ignore[reportPrivateUsage]
    _FontIndexKey,  # pyright: ignore[reportPrivateUsage]
    _FontRecord,  # pyright: ignore[reportPrivateUsage]
    _index_cache,  # pyright: ignore[reportPrivateUsage]
    _subset_font,  # pyright: ignore[reportPrivateUsage]
    embed_fonts_css,
    embed_fonts_css_subsetted,
    extract_font_specs,
    extract_font_specs_and_codepoints,
)
from inkflow.logging import collect_logs
from inkflow.pipeline import SlideData

# ── Helpers ───────────────────────────────────────────────────────────────────


def _slide(svg: str) -> SlideData:
    return {"svg": svg, "title": "", "id": "", "notes": ""}


def _svg(body: str) -> str:
    return textwrap.dedent(f"""\
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
          {body}
        </svg>
    """)


# ── _first_named_family ───────────────────────────────────────────────────────


def test_first_named_family_picks_first_custom() -> None:
    assert _first_named_family("Inter, sans-serif") == "Inter"


def test_first_named_family_skips_generics_to_find_custom() -> None:
    assert _first_named_family("sans-serif, Fira Code") == "Fira Code"


def test_first_named_family_all_generic_returns_none() -> None:
    assert _first_named_family("sans-serif, serif") is None


def test_first_named_family_strips_quotes() -> None:
    assert _first_named_family('"JetBrains Mono", monospace') == "JetBrains Mono"


def test_first_named_family_single_custom() -> None:
    assert _first_named_family("Inter") == "Inter"


# ── _css_weight_to_int ────────────────────────────────────────────────────────


def test_css_weight_normal() -> None:
    assert _css_weight_to_int("normal") == 400


def test_css_weight_bold() -> None:
    assert _css_weight_to_int("bold") == 700


def test_css_weight_numeric() -> None:
    assert _css_weight_to_int("600") == 600


def test_css_weight_thin() -> None:
    assert _css_weight_to_int("thin") == 100


def test_css_weight_relative_returns_none() -> None:
    assert _css_weight_to_int("bolder") is None


def test_css_weight_inherit_returns_none() -> None:
    assert _css_weight_to_int("inherit") is None


# ── extract_font_specs ────────────────────────────────────────────────────────


def test_extract_specs_from_font_family_attribute() -> None:
    slides = [_slide(_svg('<text font-family="Inter">Hello</text>'))]
    specs = extract_font_specs(slides)
    assert len(specs) == 1
    assert specs[0].family == "Inter"
    assert specs[0].weight_class == 400
    assert specs[0].is_italic is False


def test_extract_specs_with_weight_and_style() -> None:
    el = '<text font-family="Inter" font-weight="bold" font-style="italic">X</text>'
    slides = [_slide(_svg(el))]
    specs = extract_font_specs(slides)
    assert specs[0].weight_class == 700
    assert specs[0].is_italic is True


def test_extract_specs_deduplicates() -> None:
    slides = [
        _slide(
            _svg('<text font-family="Inter">A</text><text font-family="Inter">B</text>')
        )
    ]
    assert len(extract_font_specs(slides)) == 1


def test_extract_specs_skips_generic_families() -> None:
    slides = [_slide(_svg('<text font-family="sans-serif">X</text>'))]
    assert extract_font_specs(slides) == []


def test_extract_specs_from_style_block() -> None:
    body = textwrap.dedent("""\
        <defs>
          <style>text { font-family: "Fira Code"; font-weight: 300; }</style>
        </defs>
        <text>X</text>
    """)
    slides = [_slide(_svg(body))]
    specs = extract_font_specs(slides)
    assert any(s.family == "Fira Code" and s.weight_class == 300 for s in specs)


def test_extract_specs_from_inline_style() -> None:
    slides = [
        _slide(_svg('<text style="font-family: Inter; font-weight: bold;">X</text>'))
    ]
    specs = extract_font_specs(slides)
    assert any(s.family == "Inter" and s.weight_class == 700 for s in specs)


def test_extract_specs_across_multiple_slides() -> None:
    slides = [
        _slide(_svg('<text font-family="Inter">A</text>')),
        _slide(_svg('<text font-family="Roboto">B</text>')),
    ]
    families = {s.family for s in extract_font_specs(slides)}
    assert families == {"Inter", "Roboto"}


# ── extract_font_specs_and_codepoints ─────────────────────────────────────────


def test_extract_codepoints_from_text() -> None:
    slides = [_slide(_svg("<text>Hello</text>"))]
    _, cp = extract_font_specs_and_codepoints(slides)
    assert ord("H") in cp
    assert ord("e") in cp
    assert ord("o") in cp


def test_extract_codepoints_empty_svg() -> None:
    slides = [_slide(_svg(""))]
    assert isinstance(extract_font_specs_and_codepoints(slides)[1], set)


def test_extract_specs_and_codepoints_single_pass() -> None:
    # both specs and codepoints come back from one call over the same slides
    slides = [_slide(_svg('<text font-family="Arial">Hi</text>'))]
    specs, cp = extract_font_specs_and_codepoints(slides)
    assert {s.family for s in specs} == {"Arial"}
    assert ord("H") in cp and ord("i") in cp


# ── _best_match ───────────────────────────────────────────────────────────────


def _record(weight: int, italic: bool) -> _FontRecord:
    return _FontRecord(
        path=Path("dummy.ttf"), family="Test", weight_class=weight, is_italic=italic
    )


def test_best_match_prefers_italic_match() -> None:
    records = [_record(400, False), _record(400, True)]
    assert _best_match(records, 400, True).is_italic is True


def test_best_match_falls_back_to_non_italic_pool() -> None:
    records = [_record(400, False), _record(700, False)]
    result = _best_match(records, 400, True)
    assert result.weight_class == 400


def test_best_match_closest_weight() -> None:
    records = [_record(300, False), _record(700, False)]
    assert _best_match(records, 400, False).weight_class == 300


# ── _build_index caching ──────────────────────────────────────────────────────


def test_build_index_cached_on_second_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fonts_dir = tmp_path / "fonts"
    fonts_dir.mkdir()  # must exist for _font_dirs to include it
    scan_count = {"n": 0}
    original_rglob = Path.rglob

    def counting_rglob(self: Path, pattern: str):  # type: ignore[override]
        if self == fonts_dir:
            scan_count["n"] += 1
        return original_rglob(self, pattern)

    _index_cache.pop(_FontIndexKey(tmp_path, None), None)
    monkeypatch.setattr(Path, "rglob", counting_rglob)
    _build_index(tmp_path)
    _build_index(tmp_path)
    assert scan_count["n"] == 1  # scanned once, second call hits cache


def test_build_index_force_bypasses_cache(tmp_path: Path) -> None:
    _index_cache.pop(_FontIndexKey(tmp_path, None), None)
    _build_index(tmp_path)
    _build_index(tmp_path, force=True)
    # just verify no crash and cache is repopulated
    assert _FontIndexKey(tmp_path, None) in _index_cache


def test_build_index_includes_project_local_fonts(tmp_path: Path) -> None:
    fonts_dir = tmp_path / "fonts"
    fonts_dir.mkdir()
    _index_cache.pop(_FontIndexKey(tmp_path, None), None)
    # Even with no font files, the directory is searched without error
    index = _build_index(tmp_path, force=True)
    assert isinstance(index, dict)


# ── embed_fonts_css — no fonts ────────────────────────────────────────────────


def test_embed_fonts_css_no_named_fonts(tmp_path: Path) -> None:
    slides = [_slide(_svg('<text font-family="sans-serif">X</text>'))]
    with collect_logs(logging.WARNING) as warnings:
        css = embed_fonts_css(slides, tmp_path)
    assert css == ""
    assert warnings == []


def test_embed_fonts_css_empty_slides(tmp_path: Path) -> None:
    with collect_logs(logging.WARNING) as warnings:
        css = embed_fonts_css([], tmp_path)
    assert css == ""
    assert warnings == []


# ── embed_fonts_css — font not found ─────────────────────────────────────────


def test_embed_fonts_css_family_not_found_produces_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(_index_cache, _FontIndexKey(tmp_path, None), {})
    slides = [_slide(_svg('<text font-family="NonExistentFont">X</text>'))]
    with collect_logs(logging.WARNING) as warnings:
        css = embed_fonts_css(slides, tmp_path)
    assert css == ""
    assert any("NonExistentFont" in w.message for w in warnings)


# ── embed_fonts_css — success (mocked font file) ──────────────────────────────


def test_embed_fonts_css_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_font_bytes = b"FAKE_FONT_DATA"
    fake_path = tmp_path / "Inter.ttf"
    fake_path.write_bytes(fake_font_bytes)
    fake_record = _FontRecord(
        path=fake_path, family="Inter", weight_class=400, is_italic=False
    )
    monkeypatch.setitem(
        _index_cache, _FontIndexKey(tmp_path, None), {"inter": [fake_record]}
    )

    slides = [_slide(_svg('<text font-family="Inter">Hello</text>'))]
    with collect_logs(logging.WARNING) as warnings:
        css = embed_fonts_css(slides, tmp_path)

    assert "@font-face" in css
    assert 'font-family: "Inter"' in css
    assert "data:font/ttf;base64," in css
    assert warnings == []


def test_embed_fonts_css_success_sets_weight_and_style(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_path = tmp_path / "Inter-Bold.ttf"
    fake_path.write_bytes(b"BOLD_FONT")
    fake_record = _FontRecord(
        path=fake_path, family="Inter", weight_class=700, is_italic=False
    )
    monkeypatch.setitem(
        _index_cache, _FontIndexKey(tmp_path, None), {"inter": [fake_record]}
    )

    slides = [_slide(_svg('<text font-family="Inter" font-weight="bold">X</text>'))]
    css = embed_fonts_css(slides, tmp_path)
    assert "font-weight: 700" in css
    assert "font-style: normal" in css


# ── embed_fonts_css_subsetted — success (mocked _subset_font) ────────────────


def test_embed_fonts_css_subsetted_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_path = tmp_path / "Inter.ttf"
    fake_path.write_bytes(b"FULL_FONT")
    fake_record = _FontRecord(
        path=fake_path, family="Inter", weight_class=400, is_italic=False
    )
    monkeypatch.setitem(
        _index_cache, _FontIndexKey(tmp_path, None), {"inter": [fake_record]}
    )
    monkeypatch.setattr(
        "inkflow.fonts._subset_font",
        lambda path, codepoints: (b"SUBSET_DATA", "font/woff2", "woff2"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownArgumentType]
    )

    slides = [_slide(_svg('<text font-family="Inter">Hi</text>'))]
    with collect_logs(logging.WARNING) as warnings:
        css = embed_fonts_css_subsetted(slides, tmp_path)

    assert "@font-face" in css
    assert 'format("woff2")' in css
    assert warnings == []


def test_embed_fonts_css_subsetted_fallback_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_path = tmp_path / "Inter.ttf"
    fake_path.write_bytes(b"FULL_FONT")
    fake_record = _FontRecord(
        path=fake_path, family="Inter", weight_class=400, is_italic=False
    )
    monkeypatch.setitem(
        _index_cache, _FontIndexKey(tmp_path, None), {"inter": [fake_record]}
    )
    monkeypatch.setattr(
        "inkflow.fonts._subset_font",
        MagicMock(side_effect=RuntimeError("subsetting failed")),
    )

    slides = [_slide(_svg('<text font-family="Inter">Hi</text>'))]
    with collect_logs(logging.WARNING) as warnings:
        css = embed_fonts_css_subsetted(slides, tmp_path)

    # Falls back to full font embedding
    assert "@font-face" in css
    assert any("subsetting failed" in w.message for w in warnings)


# ── _subset_font — real subsetting ───────────────────────────────────────────


def _write_minimal_ttf(path: Path) -> None:
    """Synthesize a tiny but valid TTF containing the glyph 'A'."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 700))
    pen.lineTo((500, 700))
    pen.lineTo((500, 0))
    pen.closePath()

    fb = FontBuilder(unitsPerEm=1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", "A"])
    fb.setupCharacterMap({0x41: "A"})
    fb.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "A": pen.glyph()})
    fb.setupHorizontalMetrics({".notdef": (600, 0), "A": (600, 0)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "Test", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    fb.save(str(path))


def _add_private_table(font_path: Path) -> None:
    """Stamp an FFTM table into the font, the way FontForge does with every font it
    builds (DejaVu, and most libre families)."""
    from fontTools.ttLib import TTFont, newTable

    font = TTFont(font_path)
    table = newTable("FFTM")
    # A version field and three timestamps, straight from the wire format.
    table.decompile(b"\x00" * 28, font)
    font["FFTM"] = table
    font.save(str(font_path))


def test_subset_font_drops_private_tables_quietly(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """fontTools has no subsetter for a private table, so left to itself it drops it
    with a warning — once per font variant of every deck, for nothing the user can act
    on. Naming the table in the subsetter options takes the quiet path instead."""
    import io

    from fontTools.ttLib import TTFont

    font_path = tmp_path / "Test.ttf"
    _write_minimal_ttf(font_path)
    _add_private_table(font_path)

    with caplog.at_level(logging.WARNING, logger="fontTools"):
        data, _, _ = _subset_font(font_path, frozenset({ord("A")}))

    assert [record.getMessage() for record in caplog.records] == []
    assert "FFTM" not in TTFont(io.BytesIO(data))


def test_subset_font_emits_woff2(tmp_path: Path) -> None:
    font_path = tmp_path / "Test.ttf"
    _write_minimal_ttf(font_path)

    data, mime, fmt = _subset_font(font_path, frozenset({ord("A")}))

    assert mime == "font/woff2"
    assert fmt == "woff2"
    # WOFF2 files begin with the "wOF2" signature.
    assert data[:4] == b"wOF2"
