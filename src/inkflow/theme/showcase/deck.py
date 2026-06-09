from inkflow import Deck, MarkdownSlide, transitions

deck = Deck(transition=transitions.Crossfade())

deck.slides = [
    MarkdownSlide("cover", content="01-cover"),
    MarkdownSlide("section", content="02-section"),
    MarkdownSlide("default", content="03-default", steps=True),
    MarkdownSlide("center", content="04-center"),
    MarkdownSlide("two-cols", content="05-two-cols"),
    MarkdownSlide("two-cols-header", content="06-two-cols-header"),
    MarkdownSlide("fact", content="07-fact"),
    MarkdownSlide("quote", content="08-quote"),
    MarkdownSlide("statement", content="09-statement"),
    MarkdownSlide("media-left", content="10-media-left"),
    MarkdownSlide("media-right", content="11-media-right"),
    MarkdownSlide("end", content="12-end"),
]
