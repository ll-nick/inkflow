The deck.py is the core file of your slide deck.
It is a Python script that returns a `Deck` object, which is a list of `Slide` objects.
Each slide can be an SVG file, or a predefined layout.
Inject Markdown and media content into the layout zones, and define transitions and animations for each slide.

More on Markdown features later, but spoiler: Inkflow supports syntax highlighted code blocks with line-wise step reveals.

The code block uses `{1-2|3-4|…|all}` line-range syntax to step through the highlighted regions.

The deck file is loaded with `importlib` at serve time and reloaded on every save,
so changes appear instantly without restarting the server.
