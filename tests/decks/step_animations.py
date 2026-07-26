"""Feature-test deck for the step/animation system (PR: defaults-to-Python).

Serve it with ``uv run inkflow serve -d tests/decks/step_animations.py`` and step
through with the arrow keys. It exercises:

- markdown reveals as real ``Animation`` objects (default ``FadeIn``);
- the ``::step``/``::steps`` marker grammar: ``type=<ClassName>`` plus params,
  including a custom ``Animation`` subclass (``Glow``) resolved by name, and the
  ``trigger=`` param (``with-previous`` and an absolute pin);
- every built-in animation once via ``deck.py`` ``animations=[...]``, with slowed
  durations and exaggerated distances/scales/iterations so both forward playback and
  backward (reverse) playback are easy to eyeball;
- ``Trigger``: the default ``ON_CLICK`` (one cue per click), ``WITH_PREVIOUS``,
  and the ``Trigger.at(n)`` pin;
- concatenation: a slide whose markdown reveals number first, then its
  ``animations=[...]`` list continues the same count;
- the ``Easing`` value object (a preset and a ``cubic_bezier``), on both an
  animation and a transition.

It is also built (not served) by ``tests/test_decks.py`` as a compilation smoke
test. ``Glow`` is a complete custom type: the class below plus the matching
``anim-glow`` CSS injected via ``Deck(style=...)``, so it actually animates when
served (and its ``--anim-intensity`` param scales the glow).
"""

from dataclasses import dataclass

from inkflow import (
    Deck,
    Direction,
    Easing,
    Inline,
    Slide,
    Trigger,
    animations,
    transitions,
)


@dataclass
class Glow(animations.Enter):
    """Custom animation type, reachable from a ``type=Glow`` marker by name."""

    intensity: float = 1.0


# CSS for the custom Glow type. The step engine reads `@keyframes anim-glow`
# (camel_to_kebab of Glow) and substitutes the cue's own params for any
# `var(--anim-*)` token — including the custom `--anim-intensity`. Element fades in
# and gains a glow scaled by intensity.
GLOW_CSS = Inline("""
@keyframes anim-glow {
    from {
        opacity: 0;
        text-shadow: 0 0 0 var(--accent);
    }
    to {
        opacity: 1;
        text-shadow: 0 0 calc(10px * var(--anim-intensity)) var(--accent);
    }
}
""")


REVEALS = Inline("""\
# Reveals

::steps duration=1.4::
- default fade, item one
- default fade, item two
::steps end::

::step type=SlideIn direction=right distance=600 duration=1.4::
Slides in from the right.

::step type=Bounce distance=120 duration=1.2::
Bounces in.

::step type=FadeIn trigger=with-previous duration=1.4::
Fades in together with the bounce (shares its step).

::step type=Glow intensity=5 duration=1.4::
Custom deck-defined type, resolved by name.
""")


def main() -> Deck:
    return Deck(
        # Slow crossfade so it is easy to see the outgoing slide hold its final state.
        transition=transitions.Crossfade(easing=Easing.EASE_IN_OUT, duration=1.5),
        style=GLOW_CSS,
        slides=[
            Slide("default", id="reveals", md=REVEALS),
            Slide(
                "anim-targets",
                id="builtins",
                # Every built-in once, slowed and exaggerated for eyeballing forward
                # and reverse. Default ON_CLICK trigger -> one per click. FadeIn uses an
                # explicit Easing to exercise the value object.
                animations=[
                    animations.FadeIn(
                        "a", duration=1.4, easing=Easing.cubic_bezier(0.2, 0, 0.3, 1)
                    ),
                    animations.FadeOut("b", duration=1.4),
                    animations.Bounce(
                        # Bigger rise + a springier easing (higher 2nd control point)
                        # for a pronounced overshoot.
                        "c",
                        distance=120,
                        duration=1.2,
                        easing=Easing.cubic_bezier(0.34, 2.6, 0.64, 1),
                    ),
                    animations.SlideIn(
                        "d", direction=Direction.RIGHT, distance=600, duration=1.4
                    ),
                    animations.SlideOut(
                        "e", direction=Direction.UP, distance=600, duration=1.4
                    ),
                    animations.ZoomIn("f", scale=0.15, duration=1.4),
                    animations.ZoomOut("g", scale=2.5, duration=1.4),
                    animations.Highlight(
                        "h", color="#f38ba8", iterations=3, duration=0.7
                    ),
                ],
            ),
            # Concatenation: the two markdown reveals number 1..2, then the deck
            # animations=[...] list continues from there — badge-a lands on step 3
            # (ON_CLICK after the reveals), badge-b is pinned to step 5.
            Slide(
                "slides/mixed.svg",
                id="mixed",
                md=Inline(
                    "::steps::\n"
                    + "- reveal one (step 1)\n"
                    + "- reveal two (step 2)\n"
                    + "::steps end::\n"
                ),
                animations=[
                    animations.FadeIn("badge-a", duration=1.4),
                    animations.FadeIn("badge-b", Trigger.at(5), duration=1.4),
                ],
            ),
        ],
    )
