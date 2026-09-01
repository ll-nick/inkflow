SVG = "http://www.w3.org/2000/svg"
XHTML = "http://www.w3.org/1999/xhtml"
XLINK = "http://www.w3.org/1999/xlink"
INKFLOW = "urn:inkflow"
INKSCAPE = "http://www.inkscape.org/namespaces/inkscape"
SODIPODI = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"

INKSCAPE_LABEL = f"{{{INKSCAPE}}}label"

INKFLOW_PARENT = f"{{{INKFLOW}}}parent"
INKFLOW_DEFAULT_ZONE = f"{{{INKFLOW}}}default-zone"
INKFLOW_LAYOUT_SRC = f"{{{INKFLOW}}}layout-src"
INKFLOW_LAYOUT_HASH = f"{{{INKFLOW}}}layout-hash"
INKFLOW_OVERLAY_SRC = f"{{{INKFLOW}}}overlay-src"
INKFLOW_OVERLAY_HASH = f"{{{INKFLOW}}}overlay-hash"

# Authoring-only hints, read by `sync` and `verify` and never by the pipeline.
INKFLOW_PREVIEW = f"{{{INKFLOW}}}preview"
INKFLOW_PREVIEW_OVERLAYS = f"{{{INKFLOW}}}preview-overlays"
