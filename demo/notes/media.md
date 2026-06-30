Just like Markdown content, it's possible to inject media into a layout zone.
The zone doesn't even have to be a rectangle: it can be any shape, and the media will be clipped to fit so knock yourself out.

`alt_src` provides a light/dark-mode alternative image — inkflow swaps it in automatically
when the browser or OS is in light theme. `MediaFit.COVER` fills the zone and crops;
`MediaFit.CONTAIN` letterboxes instead.

