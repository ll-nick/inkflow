from __future__ import annotations

from pathlib import Path

import pytest
from lxml import etree

from inkflow.svgio import (
    parse_svg,
    parse_svg_file,
    serialize_svg,
    svg_matches_file,
)

# An SVG whose text references an entity declared as an external SYSTEM file. With the
# default parser this raises XMLSyntaxError (crashing the rebuild); the hardened parser
# leaves the reference inert (text=None) and never reads the file.
_EXTERNAL_ENTITY_SVG = (
    '<?xml version="1.0"?>'
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/hostname">]>'
    '<svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>'
)


class TestHardenedParse:
    def test_external_entity_is_inert_not_crash(self) -> None:
        root = parse_svg(_EXTERNAL_ENTITY_SVG)
        # entity not expanded, file never read
        assert root[0].text is None

    def test_default_parser_would_crash_on_same_input(self) -> None:
        # documents the crash the hardened parser prevents
        with pytest.raises(etree.XMLSyntaxError):
            etree.fromstring(_EXTERNAL_ENTITY_SVG.encode())

    def test_predefined_entities_round_trip(self) -> None:
        # &amp; etc. (common in rendered markdown) are unaffected
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>A&amp;B</text></svg>'
        assert parse_svg(svg)[0].text == "A&B"


class TestSerialize:
    def test_round_trip(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="a"/></svg>'
        assert serialize_svg(parse_svg(svg)) == svg

    def test_parse_accepts_str_and_bytes(self) -> None:
        svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
        assert parse_svg(svg).tag == parse_svg(svg.encode()).tag


class TestParseFile:
    def test_reads_root(self, tmp_path: Path) -> None:
        p = tmp_path / "ok.svg"
        p.write_text('<svg xmlns="http://www.w3.org/2000/svg"><rect id="a"/></svg>')
        assert parse_svg_file(p).find('.//*[@id="a"]') is not None

    def test_malformed_file_raises_naming_the_path(self, tmp_path: Path) -> None:
        p = tmp_path / "broken.svg"
        p.write_text("<svg><rect></svg>")
        with pytest.raises(ValueError, match=r"broken\.svg"):
            parse_svg_file(p)


_INKSCAPE_PROLOG = (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    "<!-- Created with Inkscape (http://www.inkscape.org/) -->\n\n"
)
_BODY = '<svg xmlns="http://www.w3.org/2000/svg">\n  <rect id="a"/>\n</svg>'
# How Inkscape writes markup that lxml writes as _BODY.
_INKSCAPE_BODY = (
    "<svg\n   xmlns=\"http://www.w3.org/2000/svg\">\n  <rect\n     id='a' />\n</svg>"
)


class TestMatchesFile:
    @pytest.mark.parametrize("body", [_BODY, _INKSCAPE_BODY])
    @pytest.mark.parametrize("newline", ["\n", "\r\n"])
    def test_unedited_document_matches_however_written(
        self, tmp_path: Path, body: str, newline: str
    ) -> None:
        path = tmp_path / "s.svg"
        path.write_bytes(
            (_INKSCAPE_PROLOG + body + "\n").replace("\n", newline).encode()
        )
        assert svg_matches_file(parse_svg_file(path), path)

    def test_edit_does_not_match(self, tmp_path: Path) -> None:
        path = tmp_path / "s.svg"
        path.write_text(_INKSCAPE_BODY, encoding="utf-8")
        root = parse_svg_file(path)
        root[0].set("id", "b")
        assert not svg_matches_file(root, path)

    def test_comment_edit_does_not_match(self, tmp_path: Path) -> None:
        path = tmp_path / "s.svg"
        path.write_text(_BODY, encoding="utf-8")
        root = parse_svg_file(path)
        root.append(etree.Comment("note"))
        assert not svg_matches_file(root, path)

    def test_missing_file_does_not_match(self, tmp_path: Path) -> None:
        assert not svg_matches_file(parse_svg(_BODY), tmp_path / "new.svg")
