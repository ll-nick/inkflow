"""Feature-test deck for auto-advance (``Trigger.AFTER_PREVIOUS``).

Serve it with ``uv run inkflow serve -d tests/decks/auto_advance.py`` and step
through with the arrow keys. It exercises:

- A cascade started by a keypress: ``stage-1`` on the press, the rest
  ``AFTER_PREVIOUS``. The whole chain is one atomic run, so one press forward plays
  it staggered, a forward press while it is still playing snaps it to the end, and one
  press back mirrors it (last stage out first). Durations are slowed so the stagger and
  its reverse are easy to eyeball.
- A chain whose first cue is ``AFTER_PREVIOUS`` too, so it has no keypress to wait on
  and auto-plays on arrival, right after the entry transition (entry-play). Retreating
  into it from ahead lands it instantly, and stepping back out mirrors it.
- The same trigger in a markdown reveal via ``::step trigger=after-previous::``, so
  the second and third bullets reveal themselves after the first.
- ``WITH_PREVIOUS`` mixed into each chain: a caption that fades in together with the
  stage before it, showing the two "previous" triggers side by side.

It is also built (not served) by ``tests/test_decks.py`` as a compilation smoke test.
"""

from inkflow import (
    Cue,
    Deck,
    Direction,
    Inline,
    Slide,
    Trigger,
    animations,
    transitions,
)


def _stage(element: str, trigger: Trigger = Trigger.ON_CLICK) -> animations.SlideIn:
    """A pipeline-stage card sliding in from the left, slowed for eyeballing."""
    return animations.SlideIn(
        element, trigger, direction=Direction.LEFT, distance=90, duration=0.6
    )


# One press reveals the first stage; the rest of the pipeline cascades in on its own,
# each stage sliding in once the previous one has landed. A caption rides in WITH the
# final stage to show WITH_PREVIOUS chaining off an auto-advanced cue.
CASCADE: list[Cue] = [
    _stage("stage-1"),
    _stage("stage-2", Trigger.AFTER_PREVIOUS),
    _stage("stage-3", Trigger.AFTER_PREVIOUS),
    _stage("stage-4", Trigger.AFTER_PREVIOUS),
    animations.FadeIn("caption", Trigger.WITH_PREVIOUS, duration=0.6),
]


# The same cascade, but the first stage is AFTER_PREVIOUS as well. With nothing before
# it to wait on, the run's offset is 0, so it plays on slide entry (after the
# transition) with no keypress at all.
ON_ENTER: list[Cue] = [
    _stage("stage-1", Trigger.AFTER_PREVIOUS),
    _stage("stage-2", Trigger.AFTER_PREVIOUS),
    _stage("stage-3", Trigger.AFTER_PREVIOUS),
    _stage("stage-4", Trigger.AFTER_PREVIOUS),
    animations.FadeIn("caption", Trigger.WITH_PREVIOUS, duration=0.6),
]


REVEALS = Inline("""\
# Reveals that advance themselves

::step duration=0.8::
Press once to reveal this line.

::step trigger=after-previous duration=0.8::
This one follows on its own, right after the first.

::step trigger=after-previous duration=0.8::
And so does this, one keypress, three reveals.
""")


def main() -> Deck:
    return Deck(
        # A slow crossfade so the entry is calm and the cascade is the star.
        transition=transitions.Crossfade(duration=0.8),
        slides=[
            Slide("auto-advance", id="cascade", animations=CASCADE),
            Slide("auto-advance-on-enter", id="on-enter", animations=ON_ENTER),
            Slide("content", id="reveals", md=REVEALS),
        ],
    )
