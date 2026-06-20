"""Feature-test deck: every transition exactly once, for manual verification.

Serve it with ``uv run inkflow serve tests/decks/transitions.py`` and step through
with the arrow keys. Each slide is labelled with the transition used to enter it,
so it is obvious which one is playing. The custom ``flip`` is registered in the
sibling ``scripts.js`` (picked up automatically by the scripts cascade).

This deck is also built (not served) by ``tests/test_decks.py`` as a compilation
smoke test. It is not collected by pytest itself (the filename is not ``test_*``).
"""

from dataclasses import dataclass

from inkflow import Deck, Direction, Slide, Transition, transitions


@dataclass
class Flip(Transition):
    """Custom 3D card flip; JS handler registered in scripts.js."""

    axis: str = "horizontal"
    perspective: int = 1200  # viewer distance in px; smaller = more dramatic 3D


# Long durations on purpose: this deck exists to eyeball each transition in
# detail, so every animated transition runs slowly.
SLOW = 3.0


def main() -> Deck:
    return Deck(
        slides=[
            Slide("slides/title.svg"),
            Slide("slides/cut.svg", transition=transitions.Cut()),
            Slide(
                "slides/crossfade.svg",
                transition=transitions.Crossfade(duration=SLOW),
            ),
            Slide(
                "slides/push.svg",
                transition=transitions.Push(direction=Direction.LEFT, duration=SLOW),
            ),
            Slide(
                "slides/cover.svg",
                transition=transitions.Cover(direction=Direction.UP, duration=SLOW),
            ),
            Slide("slides/zoom.svg", transition=transitions.Zoom(duration=SLOW)),
            Slide(
                "slides/fade.svg",
                transition=transitions.Fade(color="#2a1a3a", duration=SLOW),
            ),
            Slide(
                "slides/wipe.svg",
                transition=transitions.Wipe(direction=Direction.RIGHT, duration=SLOW),
            ),
            # Morph: the two slides share #box (morphs in place) while the
            # background differs (smooth crossfade) and the label is identical
            # (static) — exercises all three morph behaviours.
            Slide(
                "slides/morph-a.svg",
                transition=transitions.Push(direction=Direction.LEFT, duration=SLOW),
            ),
            Slide(
                "slides/morph-b.svg",
                transition=transitions.Morph(duration=SLOW),
            ),
            Slide("slides/flip.svg", transition=Flip(duration=SLOW)),
        ]
    )
