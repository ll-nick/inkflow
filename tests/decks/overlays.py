"""Feature-test deck: overlays, for manual verification.

Serve it with ``uv run inkflow serve -d tests/decks/overlays.py`` and step through
with the arrow keys. Each slide states which overlay behavior it exercises; check
the chrome against the description.

Every slide uses the built-in ``default`` layout, so nothing here relies on a
project-local SVG. That is the point: chrome now attaches to a deck that would
otherwise be pure Markdown, without a wrapper layout per layout.
"""

from inkflow import Deck, Inline, Overlay, Slide, animations, transitions

DECK_CHROME = """
Both overlays apply. The footer brings the accent rule with it, inherited from
the `brand` overlay it names as its parent, and the logo mark sits top right.
"""

OPT_OUT = """
`overlays=[]` on this slide, so no footer, no rule and no logo. The layout's own
slide number is untouched: it belongs to `numbered`, not to the chrome.
"""

OVERRIDE = """
`overlays=[Overlay("logo")]` *replaces* the deck list rather than adding to it,
so the logo is here and the footer is not.
"""

OVERLAY_ZONE = """
The footer declares `zone-footer-note`, which this slide fills exactly like a
layout zone. Every other slide leaves it empty, so it is pruned there.
"""

ANIMATED_CHROME = """
Overlays composite before annotation, so a cue can target an element inside
them. Press right and the footer badge zooms in.
"""

CHROME_TRANSITIONS = """
Overlays are part of the slide SVG, so they travel with it. Arriving here via
Push, the footer and logo slide in alongside the content.
"""


def _slide(slide_id: str, title: str, body: str, **kwargs: object) -> Slide:
    return Slide(
        "builtin:default",
        id=slide_id,
        zones={"title": f"# {title}", "content": Inline(body)},
        **kwargs,  # pyright: ignore[reportArgumentType]
    )


def main() -> Deck:
    return Deck(
        # footer names brand as its parent, so the accent rule arrives through the
        # overlay's own chain instead of being copied into every overlay.
        overlays=[Overlay("footer"), Overlay("logo")],
        slides=[
            _slide("deck-chrome", "Deck-level chrome", DECK_CHROME),
            _slide("opt-out", "Per-slide opt-out", OPT_OUT, overlays=[]),
            _slide(
                "override",
                "Per-slide override",
                OVERRIDE,
                overlays=[Overlay("logo")],
            ),
            # Not via _slide(): this one fills a third zone that the overlay
            # declares, rather than the layout.
            Slide(
                "builtin:default",
                id="overlay-zone",
                zones={
                    "title": "# Content in an overlay zone",
                    "content": Inline(OVERLAY_ZONE),
                    "footer-note": "filled from the deck",
                },
            ),
            _slide(
                "animated-chrome",
                "Animating overlay chrome",
                ANIMATED_CHROME,
                animations=[animations.ZoomIn("footer-badge", scale=0.2)],
            ),
            _slide(
                "chrome-transitions",
                "Chrome and transitions",
                CHROME_TRANSITIONS,
                transition=transitions.Push(),
            ),
        ],
    )
