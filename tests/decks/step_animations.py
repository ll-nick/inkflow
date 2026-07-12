"""Feature-test deck for the step/animation system (PR: defaults-to-Python).

Serve it with ``uv run inkflow serve -d tests/decks/step_animations.py`` and step
through with the arrow keys. It exercises:

- markdown reveals as real ``Animation`` objects (default ``FadeIn``);
- the ``::step``/``::steps`` marker grammar: ``type=<ClassName>`` plus params,
  including a custom ``Animation`` subclass (``Glow``) resolved by name;
- every built-in animation once via ``deck.py`` ``animations=[...]``, each with
  default params (so their defaults come from Python, not a CSS fallback);
- the ``Easing`` value object (a preset and a ``cubic_bezier``), on both an
  animation and a transition.

It is also built (not served) by ``tests/test_decks.py`` as a compilation smoke
test. ``Glow`` is a complete custom type: the class below plus the matching
``anim-glow`` CSS injected via ``Deck(style=...)``, so it actually animates when
served (and its ``--anim-intensity`` param scales the glow).
"""

from dataclasses import dataclass

from inkflow import Deck, Direction, Easing, Inline, Slide, animations, transitions
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
                # One uses an explicit Easing to exercise the value object.
                animations=[
                    animations.FadeIn(
                        "#a", step=1, easing=Easing.cubic_bezier(0.2, 0, 0.3, 1)
                    ),
                    animations.FadeOut("#b", step=2),
                    animations.Bounce("#c", step=3),
                    animations.SlideIn("#d", direction=Direction.RIGHT, step=4),
                    animations.SlideOut("#e", direction=Direction.UP, step=5),
                    animations.ZoomIn("#f", step=6),
                    animations.ZoomOut("#g", step=7),
                    animations.Highlight("#h", step=8),
                ],
            ),
        ],
    )
