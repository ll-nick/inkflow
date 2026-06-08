# Image Zones

Embed images from disk — PNG, JPEG, WebP, GIF, and SVG are
all base64-inlined into the output SVG, so the result is
fully self-contained with no external file references.

The image on the right comes from `assets/demo.jpg` and
fills the `zone-image` rectangle declared in the layout.

- Any aspect ratio is supported
- Use `fit` to control how the image fills the zone
- `x` and `y` can be used to control the position of the image within the zone

::notes::

Highlight that images are base64-inlined — the final SVG is one
self-contained file you can email or check into a repo.

