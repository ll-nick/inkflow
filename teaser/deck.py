from inkflow import Deck, Slide
from inkflow.transitions import Morph


def main() -> Deck:
    return Deck(
        slides=[
            Slide("title"),
            Slide("just-svg"),
            Slide("just-md", md="just-md", transition=Morph()),
            Slide(
                "get-started",
                md="get-started",
                transition=Morph(),
            ),
        ],
    )
