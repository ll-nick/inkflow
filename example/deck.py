from inkflow import (
    Bounce,
    Crossfade,
    Cut,
    Deck,
    FadeIn,
    MarkdownSlide,
    Media,
    Morph,
    Slide,
)

deck = Deck()

deck.slides = [
    Slide(
        "slides/01-title.svg",
        animations=[
            FadeIn("#headline", step=1),
            FadeIn("#subtitle", step=2),
            FadeIn("#byline", step=3),
        ],
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
        src="slides/05-markdown.md",
    ),
    MarkdownSlide(
        "layouts/media-right.svg",
        src="slides/06-image.md",
        media=Media("assets/demo.jpg", fit="cover"),
    ),
    MarkdownSlide(
        "layouts/media-right.svg",
        src="slides/07-video.md",
        media="assets/demo.mp4",
    ),
]
