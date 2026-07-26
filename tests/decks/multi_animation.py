"""Feature-test deck for multiple animations per element (WAAPI step engine).

Serve it with ``uv run inkflow serve -d tests/decks/multi_animation.py`` and step
through with the arrow keys. It exercises:

- several cues on one element (``hero``): it enters (FadeIn), is emphasized
  (Highlight), exits (SlideOut), then re-enters (Bounce), each on its own step —
  impossible under the old one-animation-per-element model;
- true-mirror reverse: stepping backward un-plays each stage in reverse order;
- the ``AnimationKind`` taxonomy (enter/exit/emphasis) via the semantic bases, which
  drives how the engine composes those cues into a single visible lifecycle;
- a custom ``Emphasis`` subclass (``Pulse``) resolved by name, with its own
  ``@keyframes anim-pulse`` injected via ``Deck(style=...)`` — so custom animations
  stay pure Python + CSS, no JavaScript.

It is also built (not served) by ``tests/test_decks.py`` as a compilation smoke test.
"""

from dataclasses import dataclass

from inkflow import Deck, Direction, Inline, Slide, Trigger, animations, transitions


@dataclass
class Pulse(animations.Emphasis):
    """Custom emphasis type, reachable by name. A quick brightness flash; because it is
    an emphasis it never changes whether the element is shown."""


# The step engine reads `@keyframes anim-pulse` (the kebab-cased type name).
PULSE_CSS = Inline("""
@keyframes anim-pulse {
    50% {
        filter: brightness(1.7);
    }
}
""")


def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),
        style=PULSE_CSS,
        slides=[
            Slide(
                "multi",
                id="multi",
                # All four cues target one element. They number 1..4 (ON_CLICK), and
                # Pulse shares step 2 with the Highlight (WITH_PREVIOUS).
                animations=[
                    animations.FadeIn("hero"),  # step 1: enter
                    animations.Highlight("hero"),  # step 2: emphasis
                    Pulse("caption", Trigger.WITH_PREVIOUS),  # step 2: custom emphasis
                    animations.SlideOut(
                        "hero", direction=Direction.DOWN
                    ),  # step 3: exit
                    animations.Bounce("hero"),  # step 4: re-enter
                ],
            ),
        ],
    )
