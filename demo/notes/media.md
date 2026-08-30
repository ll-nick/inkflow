Just like Markdown content, it's possible to inject media into a layout zone.
The zone doesn't even have to be a rectangle: it can be any shape, and the media will be clipped to fit so knock yourself out.

`alt_src` provides a light/dark-mode alternative image — inkflow swaps it in automatically
when the browser or OS is in light theme. `MediaFit.COVER` fills the zone and crops;
`MediaFit.CONTAIN` letterboxes instead.

Here is the light variant, which the slide is not showing you right now:

![The light-mode cover image](../assets/cover-light.webp)

Notes are Markdown, so they can carry images of their own — useful for anything you want
to glance at while presenting but not put on the slide. The path is relative to this file
like every other asset reference, hence the `../`.

