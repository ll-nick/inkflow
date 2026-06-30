from dataclasses import dataclass

from inkflow import (
    Animation,
    Deck,
    Direction,
    Media,
    MediaFit,
    Slide,
    Transition,
    animations,
    transitions,
)


# Custom animation: subclass Animation, write matching CSS in styles.css.
# The CSS class is derived from the type name: Flicker -> anim-flicker.
@dataclass
class Flicker(Animation):
    """Neon-light flicker-on effect defined in this deck, not in inkflow itself."""


# Custom transition: subclass Transition, register a matching JS handler in scripts.js.
# The type name becomes the handler key: Flip -> "flip".
@dataclass
class Flip(Transition):
    """3D card-flip effect defined in this deck, not in inkflow itself."""

    axis: str = "horizontal"  # "horizontal" (rotateY) or "vertical" (rotateX)
    perspective: int = 1200  # viewer distance in px; smaller = more dramatic 3D


def main() -> Deck:
    return Deck(
        slides=[
            Slide(
                "title.svg",
                zones={
                    "media": Media(
                        src="assets/cover-dark.webp",
                        alt_src="assets/cover-light.webp",
                        fit=MediaFit.COVER,
                    )
                },
                notes="notes/title.md",
            ),
            Slide(
                "content",
                md="features.md",
                transition=transitions.Crossfade(),
                notes="notes/features.md",
            ),
            # The web interface, introduced early so viewers know the keys to try live.
            Slide(
                "content",
                md="interface.md",
                transition=transitions.Push(direction=Direction.LEFT),
                notes="notes/interface.md",
            ),
            # Architecture diagram, revealed step by step.
            Slide(
                "how-it-works.svg",
                zones={"title": "# How it works"},
                transition=transitions.Cut(),
                animations=[
                    animations.SlideIn(
                        "#box-svg", step=1, direction=Direction.LEFT, distance=300
                    ),
                    animations.ZoomIn("#arrow-svg", step=2, scale=0.6),
                    animations.ZoomIn("#box-deck", step=2, scale=0.6),
                    animations.SlideIn(
                        "#box-md", step=3, direction=Direction.DOWN, distance=300
                    ),
                    animations.SlideIn(
                        "#arrow-md", step=3, direction=Direction.DOWN, distance=300
                    ),
                    animations.SlideIn(
                        "#arrow-render", step=4, direction=Direction.RIGHT, distance=500
                    ),
                    animations.SlideIn(
                        "#box-browser", step=4, direction=Direction.RIGHT, distance=500
                    ),
                    animations.FadeIn("#inherit", step=5),
                ],
                notes="notes/how-it-works.md",
            ),
            # deck.py shown as line-stepped, syntax-highlighted code (self-referential).
            Slide(
                "content",
                id="deck-py",
                md="deckpy.md",
                transition=transitions.Push(direction=Direction.LEFT),
                notes="notes/deckpy.md",
            ),
            # Markdown + math, full width with room to breathe.
            Slide(
                "content",
                md="markdown.md",
                transition=transitions.Push(direction=Direction.LEFT),
                notes="notes/markdown.md",
            ),
            # Animation variety, one step per click; Flicker is the custom type above.
            Slide(
                "animations.svg",
                zones={"title": "# Animations"},
                transition=transitions.Crossfade(),
                animations=[
                    animations.FadeIn("#shape-fade", step=1),
                    animations.SlideIn(
                        "#shape-slide", step=2, direction=Direction.DOWN
                    ),
                    animations.ZoomIn("#shape-zoom", step=3, scale=0.4),
                    animations.Bounce("#shape-bounce", step=4),
                    animations.Highlight("#shape-highlight", step=5),
                    Flicker("#shape-flicker", step=6, delay=0.1),
                ],
                notes="notes/animations.md",
            ),
            # Morph: matching ids interpolate between these two slides.
            Slide(
                "morph.svg",
                zones={"title": "# I like to morph it, morph it!"},
                transition=transitions.Morph(duration=1.5),
                notes="notes/morph.md",
            ),
            # Media: image and video injection, light/dark mode
            Slide(
                "media.svg",
                zones={
                    "title": "# Media",
                    "image": Media(
                        src="assets/cover-dark.webp",
                        alt_src="assets/cover-light.webp",
                        fit=MediaFit.COVER,
                        y=-100,
                    ),
                    "video": Media("assets/logo.mp4", fit=MediaFit.COVER),
                },
                transition=transitions.Crossfade(),
                animations=[animations.FadeIn("#video-section", step=1)],
                notes="notes/media.md",
            ),
            # Close. Arrives via the custom Flip transition it then name-checks.
            Slide(
                "content",
                md="hackable.md",
                transition=Flip(duration=0.8),
                notes="notes/hackable.md",
            ),
            Slide(
                "center",
                font_size=50,
                md="end.md",
                transition=transitions.Crossfade(),
                notes="notes/end.md",
            ),
        ]
    )
