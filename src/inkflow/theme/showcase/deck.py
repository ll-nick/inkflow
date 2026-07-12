from inkflow import Deck, Image, MediaFit, Slide, transitions


def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),
        slides=[
            Slide(
                "cover",
                md="cover",
                zones={
                    "media": Image(
                        "https://images.unsplash.com/photo-1560237731-890b122a9b6c?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
                        alt_src="https://images.unsplash.com/photo-1428908728789-d2de25dbd4e2?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
                        fit=MediaFit.COVER,
                    )
                },
            ),
            Slide("default", md="default"),
            Slide("section", md="section"),
            Slide("center", md="center"),
            Slide("two-cols", md="two-cols"),
            Slide("fact", md="fact"),
            Slide("quote", md="quote"),
            Slide(
                "media-left",
                md="media-left",
                zones={
                    "media": Image(
                        "https://images.unsplash.com/photo-1560237731-890b122a9b6c?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
                        fit=MediaFit.COVER,
                    )
                },
            ),
            Slide(
                "media-right",
                md="media-right",
                zones={
                    "media": Image(
                        "https://images.unsplash.com/photo-1560237731-890b122a9b6c?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
                        fit=MediaFit.COVER,
                    )
                },
            ),
            Slide("end", md="end"),
        ],
    )
