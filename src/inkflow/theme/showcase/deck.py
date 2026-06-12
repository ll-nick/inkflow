from inkflow import Deck, MarkdownSlide, Media, transitions

deck = Deck(transition=transitions.Crossfade())

deck.slides = [
    MarkdownSlide(
        "cover",
        content="cover",
        media=Media(
            "https://images.unsplash.com/photo-1560237731-890b122a9b6c?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
            fit="cover",
        ),
    ),
    MarkdownSlide("default", content="default"),
    MarkdownSlide("section", content="section"),
    MarkdownSlide("center", content="center"),
    MarkdownSlide("two-cols", content="two-cols"),
    MarkdownSlide("fact", content="fact"),
    MarkdownSlide("quote", content="quote"),
    MarkdownSlide(
        "media-left",
        content="media-left",
        media=Media(
            "https://images.unsplash.com/photo-1560237731-890b122a9b6c?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
            fit="cover",
        ),
    ),
    MarkdownSlide(
        "media-right",
        content="media-right",
        media=Media(
            "https://images.unsplash.com/photo-1560237731-890b122a9b6c?q=80&w=1740&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
            fit="cover",
        ),
    ),
    MarkdownSlide("end", content="end"),
]
