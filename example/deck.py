from inkflow import Bounce, Deck, FadeIn, Slide

deck = Deck(main=None)

deck.slides = [
    Slide("slides/01-title.svg", animations=[
        FadeIn("#headline", step=1),
        FadeIn("#subtitle", step=2),
        FadeIn("#byline",   step=3),
    ]),
    Slide("slides/02-diagram.svg", animations=[
        Bounce("#box-deck",      step=1),
        Bounce("#arrow-1",       step=2),
        Bounce("#box-pipeline",  step=3),
        Bounce("#arrow-2",       step=4),
        Bounce("#box-browser",   step=5),
    ]),
]
