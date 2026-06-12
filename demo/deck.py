from dataclasses import dataclass
from pathlib import Path

from inkflow import (
    Animation,
    Deck,
    Media,
    Slide,
    Transition,
    animations,
    transitions,
)


# Custom animation: subclass Animation, write matching CSS in styles.css.
# The CSS class is derived from the type name: Flicker → anim-flicker.
@dataclass
class Flicker(Animation):
    """Neon-light flicker-on effect defined in this deck, not in inkflow itself."""


# Custom transition: subclass Transition, register matching JS handler in scripts.js.
# The type name becomes the handler key: Flip → "flip".
# Extra fields are serialized into TransitionData and available as t.axis in JS.
@dataclass
class Flip(Transition):
    """3D card-flip effect defined in this deck, not in inkflow itself."""

    axis: str = "horizontal"  # "horizontal" (rotateY) or "vertical" (rotateX)


def main() -> Deck:
    return Deck(
        slides=[
            Slide(
                "slides/01-title.svg",
                animations=[
                    # Highlight pulses an already-visible element to draw the eye.
                    animations.Highlight("#headline", step=1),
                    # Flicker is a custom type defined above. CSS in styles.css.
                    Flicker("#byline", step=2, delay=0.1),
                ],
                notes=(
                    "Welcome the audience. Mention that every slide in this deck is a "
                    "plain SVG file edited in Inkscape — no proprietary format, no "
                    "lock-in. Open the presenter view (press `p`) to see these notes."
                ),
            ),
            Slide(
                "slides/02-diagram.svg",
                transition=transitions.Cut(),
                animations=[
                    # A mix of the new parameterised animation types.
                    animations.SlideIn(
                        "#box-deck",
                        step=1,
                        direction="left",
                        distance=600,
                        duration=0.6,
                    ),
                    animations.FadeIn("#arrow-1", step=2, delay=0.1),
                    animations.ZoomIn("#box-pipeline", step=3, scale=0.6),
                    animations.FadeIn("#arrow-2", step=4, delay=0.1),
                    animations.SlideIn(
                        "#box-browser", step=5, direction="right", duration=0.6
                    ),
                ],
                notes=(
                    "Walk through the pipeline left-to-right, one click per box:\n\n"
                    "1. **deck.py** — Python manifest listing slides and animations.\n"
                    "2. **arrow** — load step.\n"
                    "3. **pipeline** — strips editor metadata, annotates animations.\n"
                    "4. **arrow** — serve step.\n"
                    "5. **browser** — live-reloads over WebSocket on every file save."
                ),
            ),
            Slide(
                "slides/03-crossfade.svg",
                transition=transitions.Push(direction="left"),
                notes=(
                    "Push slides both slides horizontally — the new one enters as the "
                    "old one exits. Direction controls which way the new slide enters."
                ),
            ),
            Slide(
                "slides/04-morph.svg",
                transition=transitions.Morph(duration=1.8),
                notes=Path("slides/04-notes.md"),
            ),
            Slide(
                "layouts/content.svg",
                md="slides/05-invisible.md",
                visible=False,
            ),
            Slide(
                "layouts/content.svg",
                md="slides/06-markdown.md",
            ),
            Slide(
                "layouts/media-right.svg",
                md="slides/07-image.md",
                zones={"media": Media("assets/demo.jpg", fit="cover")},
            ),
            Slide(
                "layouts/media-right.svg",
                md="slides/08-video.md",
                zones={"media": Media("assets/demo.mp4")},
                notes="Notes can also be added both in markdown and in `deck.py`.",
            ),
            Slide(
                "slides/10-clips.svg",
                transition=Flip(duration=0.8),
                zones={
                    "left": Media("assets/demo.jpg", fit="cover"),
                    "center": Media("assets/demo.jpg", fit="cover"),
                    "right": Media("assets/demo.mp4", fit="cover"),
                },
            ),
        ]
    )
