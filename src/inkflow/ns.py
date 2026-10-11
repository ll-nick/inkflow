SVG = "http://www.w3.org/2000/svg"
XHTML = "http://www.w3.org/1999/xhtml"
XLINK = "http://www.w3.org/1999/xlink"
INKFLOW = "urn:inkflow"
INKSCAPE = "http://www.inkscape.org/namespaces/inkscape"
SODIPODI = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"

INKSCAPE_LABEL = f"{{{INKSCAPE}}}label"

INKFLOW_PARENT = f"{{{INKFLOW}}}parent"
INKFLOW_DEFAULT_ZONE = f"{{{INKFLOW}}}default-zone"
INKFLOW_LOCKED = f"{{{INKFLOW}}}locked"
INKFLOW_SHOW_SHAPE = f"{{{INKFLOW}}}show-shape"
INKFLOW_SITES = f"{{{INKFLOW}}}sites"
INKFLOW_DRAWIO = f"{{{INKFLOW}}}drawio"
INKFLOW_BACKGROUND = f"{{{INKFLOW}}}background"
"""On a picture: what to paint behind it (see content.background_paint)."""
INKFLOW_BACKGROUND_PADDING = f"{{{INKFLOW}}}background-padding"
"""On a zone shape: draw its fill and border behind its text (a styled text box)."""
"""Set by the visual editor on an object or layer it must not select."""
INKFLOW_LAYOUT_SRC = f"{{{INKFLOW}}}layout-src"
INKFLOW_LAYOUT_HASH = f"{{{INKFLOW}}}layout-hash"
INKFLOW_OVERLAY_SRC = f"{{{INKFLOW}}}overlay-src"
INKFLOW_OVERLAY_HASH = f"{{{INKFLOW}}}overlay-hash"

# Authoring-only hints, read by `sync` and `verify` and never by the pipeline.
INKFLOW_PREVIEW = f"{{{INKFLOW}}}preview"
INKFLOW_PREVIEW_OVERLAYS = f"{{{INKFLOW}}}preview-overlays"

# The deck's own copy of a theme's layout or overlay (see layout.deck_copy).
INKFLOW_COPY_OF = f"{{{INKFLOW}}}copy-of"
"""On a file in the project's ``layouts/`` (``overlays/``): the theme's file it
is a copy of (``builtin:agenda``, ``theme:agenda``). The copy then stands in
for that file everywhere, also inside the theme's own layout chains."""
INKFLOW_LABEL = f"{{{INKFLOW}}}label"
"""A layout's display name as its author typed it ("customCodeExamples")."""
INKFLOW_HINT = f"{{{INKFLOW}}}hint"
"""``<inkflow:hint zone="title">Code example title</inkflow:hint>`` in a
layout: what the editor shows in that empty zone (a placeholder prompt);
never part of a built slide."""
