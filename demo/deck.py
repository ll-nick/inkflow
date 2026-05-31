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
    ),
    Slide(
        "slides/03-crossfade.svg",
        transition=Crossfade(),
    ),
    Slide(
        "slides/04-morph.svg",
        transition=Morph(duration=2.0),
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
    ),
]
