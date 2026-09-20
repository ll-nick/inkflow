"""Feature-test deck for the presenter's Edit button.

Serve it with ``uv run inkflow serve tests/decks/edit_button.py`` and click the
Edit button (opens a dropdown on every slide, in the status bar) on each slide.
Every dropdown ends with a **Deck** entry (this file) — ``pipeline._editable_files``
always appends the deck script, so no slide ever has just one editable file:

1. **SVG only** — no markdown, no notes. Two-item dropdown: Layout, Deck.
2. **Content file** — ``md=`` points at a real file. Three-item dropdown:
   Layout, Content, Deck.
3. **Content and notes files** — both ``md=`` and ``notes=`` are file-backed.
   Four-item dropdown: Layout, Content, Notes, Deck.
4. **Layout with a parent chain** — ``layouts/edit-parent-child.svg`` has
   ``inkflow:parent="edit-parent-base"``, which itself has
   ``inkflow:parent="edit-parent-grandparent"``: two project-local ancestors.
   Four-item dropdown, root ancestor first so the immediate parent sits next
   to the layout it belongs to: Parent (edit-parent-grandparent.svg), Parent
   (edit-parent-base.svg), Layout (edit-parent-child.svg), Deck — the two
   Parent rows told apart by filename since the label repeats. A built-in/theme
   ancestor is never offered this way (see
   ``TestEditableFiles.test_theme_ancestor_excluded`` in test_pipeline.py).

With no ``INKFLOW_EDIT_CMD``/``INKFLOW_EDIT_CMD_SVG`` set, every row copies its
absolute path to the clipboard; with ``INKFLOW_EDIT_CMD`` set (e.g.
``INKFLOW_EDIT_CMD="code -r {path}"``), every row launches that command
instead, unless ``INKFLOW_EDIT_CMD_SVG`` overrides it for the Layout/Parent
rows specifically. Either way a confirmation toast appears bottom-right.

Also built (not served) by ``tests/test_decks.py`` as a compilation smoke test.
"""

from inkflow import Deck, Slide


def main() -> Deck:
    return Deck(
        slides=[
            Slide(
                "builtin:title",
                id="svg-only",
                zones={"title": "SVG only: Edit acts directly, no dropdown"},
            ),
            Slide("builtin:content", id="content-file", md="edit-content"),
            Slide(
                "builtin:content",
                id="content-and-notes",
                md="edit-content-and-notes",
                notes="slides/edit-notes.md",
            ),
            Slide(
                "layouts/edit-parent-child",
                id="layout-with-parent",
                zones={"title": "This layout has a parent: Layout + Parent"},
            ),
        ],
    )
