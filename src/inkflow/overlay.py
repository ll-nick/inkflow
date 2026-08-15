"""The `Overlay` DSL type.

Overlays are the second composition axis. `inkflow:parent` answers "what am I built
on" and composites *behind* a slide; an overlay answers "what goes on top of every
slide regardless of what it is built on" and composites *above* it. Chrome that cuts
across layouts — a logo, a footer, a header — belongs here rather than in a wrapper
layout per layout, which multiplies and cannot be kept in sync.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = ["Overlay"]


@dataclass
class Overlay:
    """An SVG composited on top of the finished slide.

    ```python
    Deck(
        overlays=[Overlay("footer"), Overlay("logo")],
        slides=[
            Slide("title.svg", overlays=[]),   # no chrome on the title
            Slide("content", md="intro.md"),   # inherits the deck's two
        ],
    )
    ```

    List order is paint order. Resolution is `Slide.overlays` → `Deck.overlays` →
    `Theme.overlays`, each an override: ``None`` inherits, ``[]`` means none.

    An overlay may set `inkflow:parent` to another *overlay*, which composites behind
    it inside the overlay group while the group as a whole stays on top of the slide.
    That is how a shared brand bar is extended per deck without duplicating it.
    """

    src: str
    """Reference to the overlay SVG. A bare name (e.g. ``"footer"``) is searched
    project ``overlays/`` → theme ``overlays/`` → built-in ``overlays/``; prefix with
    ``local:``, ``theme:``, or ``builtin:`` to pin one, or use a relative or absolute
    path. Layouts and overlays are separate namespaces, so a bare name never resolves
    to a layout."""
