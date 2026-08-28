"""Feature-test deck: the geometry cases inside a morph, for manual verification.

    uv run inkflow serve tests/decks/morph.py

Each pair cuts in, then morphs across slowly. Step backwards too, since a morph
reverses rather than replaying forwards.

1. paths: all three should travel and bend, never snap into their new outline,
   and the arrowhead should follow the tangent.
2. stroke width: should thicken smoothly and land dashed and blue.
3. fallbacks: only the green rect moves. The other two are not the same shape as
   their counterpart, so they crossfade where they stand.

Also built (not served) by ``tests/test_decks.py`` as a compilation smoke test.
"""

from inkflow import Deck, Slide, transitions

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
        ]
    )
