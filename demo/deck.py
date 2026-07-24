from dataclasses import dataclass

from inkflow import (
    Animation,
    Deck,
    Direction,
    Image,
    MediaFit,
    Slide,
    Transition,
    Trigger,
    Video,
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
        title="Inkflow Demo",
        slides=[
            Slide(
                "title.svg",
                zones={
                    "media": Image(
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
                        "box-svg", direction=Direction.LEFT, distance=300
                    ),
                    animations.ZoomIn("arrow-svg", scale=0.6),
                    animations.ZoomIn("box-deck", Trigger.WITH_PREVIOUS, scale=0.6),
                    animations.SlideIn(
                        "box-md", direction=Direction.DOWN, distance=300
                    ),
                    animations.SlideIn(
                        "arrow-md",
                        Trigger.WITH_PREVIOUS,
                        direction=Direction.DOWN,
                        distance=300,
                    ),
                    animations.SlideIn(
                        "arrow-render", direction=Direction.RIGHT, distance=500
                    ),
                    animations.SlideIn(
                        "box-browser",
                        Trigger.WITH_PREVIOUS,
                        direction=Direction.RIGHT,
                        distance=500,
                    ),
                    animations.FadeIn("inherit"),
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
                    animations.FadeIn("shape-fade"),
                    animations.SlideIn("shape-slide", direction=Direction.DOWN),
                    animations.ZoomIn("shape-zoom", scale=0.4),
                    animations.Bounce("shape-bounce"),
                    animations.Highlight("shape-highlight"),
                    Flicker("shape-flicker", delay=0.1),
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
                    "image": Image(
                        src="assets/cover-dark.webp",
                        alt_src="assets/cover-light.webp",
                        fit=MediaFit.COVER,
                        y=-100,
                    ),
                    "video": Video(
                        "assets/logo.mp4",
                        fit=MediaFit.COVER,
                        loop=True,
                    ),
                },
                transition=transitions.Crossfade(),
                animations=[
                    animations.PlayVideo("video"),
                    animations.FadeIn("video-section", Trigger.WITH_PREVIOUS),
                ],
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
        ],
    )
