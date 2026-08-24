from inkflow import Deck, Slide, transitions


def main() -> Deck:
    return Deck(
        slides=[
            Slide("title"),
            Slide("just-svg"),
            Slide("just-md", md="just-md", transition=transitions.Morph()),
        ],
    )
