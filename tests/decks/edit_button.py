"""Feature-test deck for the presenter's Edit button.

Serve it with ``uv run inkflow serve tests/decks/edit_button.py`` and click the
Edit button (or its dropdown, on slides with more than one entry) in the status
bar on each slide:

1. **SVG only** — no markdown, no notes. Edit should act directly (no dropdown):
   with no ``INKFLOW_EDIT_CMD_SVG`` set, it copies the slide's absolute path to
   the clipboard; with it set (e.g. ``INKFLOW_EDIT_CMD_SVG="code -r {path}"``),
   it launches that command instead.
2. **Content file** — ``md=`` points at a real file. Edit should offer a
   two-item dropdown: Layout, Content.
3. **Content and notes files** — both ``md=`` and ``notes=`` are file-backed.
   Edit should offer a three-item dropdown: Layout, Content, Notes.

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
        ],
    )
