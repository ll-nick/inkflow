from pathlib import Path

from inkflow import (
    Bounce,
    Crossfade,
    Cut,
    Deck,
    MarkdownSlide,
    Media,
    Morph,
    Slide,
)

deck = Deck()

deck.slides = [
    Slide(
        "slides/01-title.svg",
        notes=(
            "Welcome the audience. Mention that every slide in this deck is a "
            "plain SVG file edited in Inkscape — no proprietary format, no "
            "lock-in. Open the presenter view (press `p`) to see these notes."
        ),
    ),
    Slide(
        "slides/02-diagram.svg",
        transition=Cut(),
        animations=[
            Bounce("#box-deck", step=1),
            Bounce("#arrow-1", step=2),
            Bounce("#box-pipeline", step=3),
            Bounce("#arrow-2", step=4),
            Bounce("#box-browser", step=5),
        ],
        notes=(
            "Walk through the pipeline left-to-right, one click per box:\n\n"
            "1. **deck.py** — Python manifest listing slides and animations.\n"
            "2. **arrow** — load step.\n"
            "3. **pipeline** — strips editor metadata and annotates animations.\n"
            "4. **arrow** — serve step.\n"
            "5. **browser** — live-reloads over WebSocket on every file save."
        ),
    ),
    Slide(
        "slides/03-crossfade.svg",
        transition=Crossfade(),
        notes=(
            "Crossfade is the gentlest transition — use it between unrelated "
            "slides. Compare with the morph that comes next."
        ),
    ),
    Slide(
        "slides/04-morph.svg",
        transition=Morph(duration=1.8),
        notes=Path("slides/04-notes.md"),
    ),
    MarkdownSlide(
        "layouts/content.svg",
        content="slides/05-markdown.md",
    ),
    MarkdownSlide(
        "layouts/media-right.svg",
        content="slides/06-image.md",
        media=Media("assets/demo.jpg", fit="cover"),
    ),
    MarkdownSlide(
        "layouts/media-right.svg",
        content="slides/07-video.md",
        media="assets/demo.mp4",
        notes="Notes can also be added both in markdown and in `deck.py`.",
    ),
    Slide(
        "slides/10-clips.svg",
        content=[
            Media("assets/demo.jpg", element="#zone-left", fit="cover"),
            Media("assets/demo.jpg", element="#zone-center", fit="cover"),
            Media("assets/demo.mp4", element="#zone-right", fit="cover"),
        ],
    ),
]
