from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(
        slides=[
            Slide("title"),
            Slide("just-svg"),
        ],
    )
