"""Feature-test deck for the step/animation system (PR: defaults-to-Python).

Serve it with ``uv run inkflow serve -d tests/decks/step_animations.py`` and step
through with the arrow keys. It exercises:

- markdown reveals as real ``Animation`` objects (default ``FadeIn``);
- the ``::step``/``::steps`` marker grammar: ``type=<ClassName>`` plus params,
  including a custom ``Animation`` subclass (``Glow``) resolved by name, and the
  ``trigger=`` param (``with-previous`` and an absolute pin);
- every built-in animation once via ``deck.py`` ``animations=[...]``, each with
  default params (so their defaults come from Python, not a CSS fallback);
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
from inkflow.manifest import Animation


@dataclass
class Glow(Animation):
    """Custom animation type, reachable from a ``type=Glow`` marker by name."""

    intensity: float = 1.0


# CSS for the custom Glow type. The class is `anim-glow` (camel_to_kebab of Glow),
# and it reads the `--anim-*` props the pipeline emits — including the custom
# `--anim-intensity`. Element fades in and gains a glow scaled by intensity.
GLOW_CSS = Inline("""
.anim-glow {
    opacity: 0;
    transition: opacity var(--anim-duration) var(--anim-easing) var(--anim-delay);
}
.anim-glow.active {
    opacity: 1;
    text-shadow: 0 0 calc(10px * var(--anim-intensity)) var(--accent);
}
""")


REVEALS = Inline("""\
# Reveals

::steps::
- default fade, item one
- default fade, item two
::steps end::

::step type=SlideIn direction=right distance=200::
Slides in from the right.

::step type=Bounce::
Bounces in.

::step type=FadeIn trigger=with-previous::
Fades in together with the bounce (shares its step).

::step type=Glow intensity=2::
Custom deck-defined type, resolved by name.
""")


def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(easing=Easing.EASE_IN_OUT),
        style=GLOW_CSS,
        slides=[
            Slide("default", id="reveals", md=REVEALS),
            Slide(
                "anim-targets",
                id="builtins",
                # Every built-in once, default params (defaults sourced from Python).
                # Default ON_CLICK trigger -> one per click. One uses an explicit
                # Easing to exercise the value object.
                animations=[
                    animations.FadeIn("a", easing=Easing.cubic_bezier(0.2, 0, 0.3, 1)),
                    animations.FadeOut("b"),
                    animations.Bounce("c"),
                    animations.SlideIn("d", direction=Direction.RIGHT),
                    animations.SlideOut("e", direction=Direction.UP),
                    animations.ZoomIn("f"),
                    animations.ZoomOut("g"),
                    animations.Highlight("h"),
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
                    animations.FadeIn("badge-a"),
                    animations.FadeIn("badge-b", Trigger.at(5)),
                ],
            ),
        ],
    )
