"""Shared step-resolution rule for the deck's step timeline.

Both the markdown-reveal sequence (``zones.py``) and the deck's
``animations=[...]`` list (``pipeline.py``) turn each cue's `Trigger` into a
concrete step number using the same rule; this is the one place it lives.
"""

from __future__ import annotations

from inkflow.enums import Trigger


class StepResolver:
    """Assigns concrete step numbers to an ordered sequence of triggers.

    ``high`` is the running max, ``current`` the last-assigned step; both start
    at ``base``. ``ON_CLICK`` advances the max, ``WITH_PREVIOUS`` reuses the
    last step, and a ``Trigger.at(n)`` pin lands on ``n`` and lifts the max.
    """

    def __init__(self, base: int = 0) -> None:
        self.high: int = base
        self.current: int = base

    def resolve(self, trigger: Trigger) -> int:
        pinned = trigger.explicit_step
        if pinned is not None:
            self.current = pinned
            self.high = max(self.high, pinned)
        elif trigger == Trigger.WITH_PREVIOUS:
            pass  # share the previous step
        else:  # ON_CLICK (and any unknown value falls here)
            self.high += 1
            self.current = self.high
        return self.current

    def bump(self, reached: int) -> None:
        """Fold in a step reached outside the trigger rule (markdown
        code-highlight stages consume steps inside a chunk's rendered HTML)."""
        self.high = max(self.high, reached)
        self.current = self.high
