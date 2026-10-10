"""A background behind a picture (backgrounds.py)."""

from __future__ import annotations

import pytest

from inkflow import Image
from inkflow.backgrounds import PAPER, background_paint, picture_backgrounds
from inkflow.content import substitute_content
from inkflow.editor.codegen import Code
from inkflow.svgio import parse_svg, serialize_svg


@pytest.mark.parametrize(
    ("value", "paint"),
    [
        ("paper", PAPER),
        ("surface", "var(--inkflow-surface)"),
        ("blue", "var(--inkflow-blue)"),
        ("#fafafa", "#fafafa"),
        ("#abc", "#abc"),
    ],
)
def test_paints(value: str, paint: str) -> None:
    assert background_paint(value) == paint


@pytest.mark.parametrize("value", ["red; x: y", "url(#a)", "", "ivory"])
def test_anything_else_is_refused(value: str) -> None:
    with pytest.raises(ValueError, match="background"):
        background_paint(value)
    with pytest.raises(ValueError, match="background"):
        Image("fig.pdf", background=value)


def test_a_rect_behind_a_slide_picture() -> None:
    root = parse_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow">'
        + '<image id="fig" href="fig.pdf" x="100" y="50" width="400" height="200"'
        + ' transform="rotate(5)" inkflow:background="paper"/>'
        + '<image href="b.png" x="0" y="0" width="10" height="10"/></svg>'
    )
    picture_backgrounds(root)
    rect, image = root[0], root[1]
    assert rect.tag.endswith("rect") and image.get("id") == "fig"
    # Its margin is 4% of the shorter side (8), around the picture's box.
    assert {k: rect.get(k) for k in ("x", "y", "width", "height")} == {
        "x": "92",
        "y": "42",
        "width": "416",
        "height": "216",
    }
    assert rect.get("style") == "fill: #ffffff"
    assert rect.get("transform") == "rotate(5)"
    assert rect.get("pointer-events") == "none"
    assert len(root) == 3  # nothing behind the picture that asked for nothing


def test_a_given_margin_and_a_drawn_diagram() -> None:
    root = parse_svg(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkflow="urn:inkflow">'
        + '<svg data-drawio="d.drawio.svg" x="0" y="0" width="100" height="50"'
        + ' inkflow:background="surface" inkflow:background-padding="0"/></svg>'
    )
    picture_backgrounds(root)
    assert serialize_svg(root[0]).count('width="100"') == 1
    assert root[0].get("style") == "fill: var(--inkflow-surface)"


def test_a_zone_picture_gets_it_as_css() -> None:
    root = parse_svg(
        '<svg xmlns="http://www.w3.org/2000/svg">'
        + '<rect id="zone-media" x="0" y="0" width="400" height="300"/></svg>'
    )
    out = serialize_svg(
        substitute_content(root, {"zone-media": Image("fig.pdf", background="paper")})
    )
    assert "background:#ffffff;padding:4%;box-sizing:border-box" in out
    plain = serialize_svg(
        substitute_content(
            parse_svg(
                '<svg xmlns="http://www.w3.org/2000/svg">'
                + '<rect id="zone-media" width="4" height="3"/></svg>'
            ),
            {"zone-media": Image("fig.pdf")},
        )
    )
    assert "background" not in plain


def test_deck_source() -> None:
    assert (
        Code().call(Image("figures/plot.pdf", background="paper"))
        == 'Image("figures/plot.pdf", background="paper")'
    )
