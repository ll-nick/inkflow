"""A tour of a theme: the built-in layouts with text, code, a table and charts.

The screenshots on the built-in themes page are this deck rendered with each
theme in both colour modes:

    INKFLOW_TOUR_THEME=paper INKFLOW_TOUR_MODE=light \
        inkflow render --deck themes-tour/deck.py --sheet

INKFLOW_TOUR_THEME is default, paper or stage; INKFLOW_TOUR_MODE is dark or
light (the theme's own mode when not set).
"""

import os

from inkflow import ColorMode, Deck, Image, MediaFit, Slide, transitions
from inkflow.builtin_themes import THEMES

PHOTO = (
    "https://images.unsplash.com/photo-1560237731-890b122a9b6c"
    + "?q=80&w=1740&auto=format&fit=crop"
)


def main() -> Deck:
    theme = THEMES[os.environ.get("INKFLOW_TOUR_THEME", "paper")]()
    mode = os.environ.get("INKFLOW_TOUR_MODE")
    photo = Image(PHOTO, fit=MediaFit.COVER)
    return Deck(
        title=f"{theme.name} theme",
        theme=theme,
        mode=ColorMode(mode) if mode else None,
        transition=transitions.Crossfade(),
        slides=[
            Slide("cover", md="cover", zones={"media": photo}),
            Slide("content", md="content"),
            Slide("agenda", md="agenda"),
            Slide("section", md="section"),
            Slide("two-cols", md="code"),
            Slide("two-cols", md="charts"),
            Slide("two-cols", md="lines"),
            Slide("content", md="palette"),
            Slide("fact", md="fact"),
            Slide("quote", md="quote"),
            Slide("comparison", md="comparison"),
            Slide("three-cols", md="three-cols"),
            Slide(
                "three-cards",
                md="three-cards",
                zones={f"media-{n}": photo for n in (1, 2, 3)},
            ),
            Slide("quad", md="quad"),
            Slide("media-left", md="media-left", zones={"media": photo}),
            Slide("media-right", md="media-right", zones={"media": photo}),
            Slide("title-media", md="title-media", zones={"media": photo}),
            Slide("full-media", md="full-media", zones={"media": photo}),
            Slide("center", md="center"),
            Slide("end", md="end"),
        ],
    )
