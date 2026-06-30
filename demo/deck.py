from dataclasses import dataclass

from inkflow import (
    Animation,
    Deck,
    Direction,
    Inline,
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
    notes_how = Inline(
        "Top to bottom on the left, then out to the right. You draw each slide in any "
        + "SVG editor. `deck.py` sits at the core, where you declare the deck: its "
        + "order, transitions and animations. Markdown and media inject into the "
        + "layout zones from below. inkflow cleans, annotates and renders all of it "
        + "into the browser. Last, the corner mark: a slide can opt into a shared "
        + "parent layout, like master slides in PowerPoint, but it is never required."
    )
    notes_morph = Inline(
        "Morph matches elements by `id` and interpolates geometry and colour in SVG "
        + "user units. The box moves, resizes and recolours; the circle scales; the "
        + "bar grows. A single transition covers every change at once."
    )
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
            ),
            Slide(
                "content",
                md="features.md",
                transition=transitions.Crossfade(),
            ),
            # The web interface, introduced early so viewers know the keys to try live.
            Slide(
                "content",
                md="interface.md",
                transition=transitions.Push(direction=Direction.LEFT),
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
                notes=notes_how,
            ),
            # deck.py shown as line-stepped, syntax-highlighted code (self-referential).
            Slide(
                "content",
                id="deck-py",
                md="deckpy.md",
                transition=transitions.Push(direction=Direction.LEFT),
            ),
            # Markdown + math, full width with room to breathe.
            Slide(
                "content",
                md="markdown.md",
                transition=transitions.Push(direction=Direction.LEFT),
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
            ),
            # Morph: matching ids interpolate between these two slides.
            Slide(
                "morph.svg",
                zones={"title": "# I like to morph it, morph it!"},
                transition=transitions.Morph(duration=1.5),
                notes=notes_morph,
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
            ),
            # Close. Arrives via the custom Flip transition it then name-checks.
            Slide(
                "content",
                md="hackable.md",
                transition=Flip(duration=0.8),
            ),
            Slide(
                "center",
                font_size=50,
                md="end.md",
                transition=transitions.Crossfade(),
            ),
        ]
    )
