You draw each slide in any SVG editor. `deck.py` sits at the core, where you declare
the deck: its order, transitions, and animations. Markdown and media inject into the
layout zones from below. inkflow cleans, annotates, and renders all of it into the
browser.

Last, the corner mark: a slide can opt into a shared parent layout, like master slides
in PowerPoint, but it is never required.

`inkflow sync` will inject the layout parent as static background into the slide SVG,
so you can edit the slide in your SVG editor with a preview of what the final slide will look like.
