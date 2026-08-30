"""Feature-test deck: the geometry cases inside a morph, for manual verification.

    uv run inkflow serve tests/decks/morph.py

Each pair cuts in, then morphs across slowly. Step backwards too, since a morph
reverses rather than replaying forwards.

1. paths: all three should travel and bend, never snap into their new outline,
   and the arrowhead should follow the tangent.
2. stroke width: should thicken smoothly and land dashed and blue.
3. fallbacks: only the green rect moves. The other two are not the same shape as
   their counterpart, so they crossfade where they stand.
4. ghost context: everything that fades out must keep its own look for the whole
   transition, including the arrowhead whose marker only the first slide defines.
   The incoming arrow must stay square-headed and teal: both slides define
   `#shared`, and the copy must not shadow the live one.
5. z-order: the teal panel is the one that morphs. The dark red panel must fade
   out *behind* it and the yellow one *in front* of it, matching where each sat on
   the outgoing slide. Both stay visible over the slide background throughout:
   leaving from behind means behind the teal panel, not behind the whole slide.

Also built (not served) by ``tests/test_decks.py`` as a compilation smoke test.
"""

from inkflow import Deck, Inline, Slide, transitions

# Keyed on the layout class the pipeline derives from the file stem, so it reaches the
# slide only while that slide is on screen. A ghost that lost its own root would lose
# this rule with it.
STYLE = Inline(".layout-morph-context-a #deck-styled { fill: #a6e3a1 }")

# Long on purpose: this deck exists to watch the tween.
SLOW = 3.0


def pair(name: str) -> list[Slide]:
    """The two slides of one case: cut in, then morph across."""
    return [
        Slide(f"slides/morph-{name}-a.svg", transition=transitions.Cut()),
        Slide(
            f"slides/morph-{name}-b.svg",
            transition=transitions.Morph(duration=SLOW),
        ),
    ]


def main() -> Deck:
    return Deck(
        slides=[
            Slide("slides/title.svg"),
            *pair("paths"),
            *pair("stroke"),
            *pair("fallback"),
            *pair("context"),
            *pair("zorder"),
        ],
        style=STYLE,
    )
