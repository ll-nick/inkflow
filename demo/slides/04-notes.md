Morph matches elements by `id` and animates them in **SVG user units**,
so a single transition covers every transform at once. Watch for:

- the **box** moving while it resizes non-uniformly — corners stay round, not oval
- the **group** travelling as one unit; its label's font-size interpolates (grows) while the glyphs stay crisp and evenly spaced
- the **circle** scaling and recolouring on its own
- the **bar** rotating through its new angle
- the **line** endpoints sliding while the stroke stays even
- unmatched content (`exits` / `enters`) crossfading, while the title and footer stay put
