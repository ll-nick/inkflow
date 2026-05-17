from inkflow import Bounce, Deck, Fade, Slide

deck = Deck(main=None)

deck.slides = [
    Slide("slides/01-title.svg", animations=[
        Fade("#headline", step=1),
        Fade("#subtitle", step=2),
        Fade("#byline",   step=3),
    ]),
    Slide("slides/02-diagram.svg", animations=[
        Bounce("#box-deck",      step=1),
        Bounce("#arrow-1",       step=2),
        Bounce("#box-pipeline",  step=3),
        Bounce("#arrow-2",       step=4),
        Bounce("#box-browser",   step=5),
    ]),
]
