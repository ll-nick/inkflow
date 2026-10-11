"""The visual editor's backend: provenance, write-back operations and the model.

The browser editor (``src/ts/editor``) never writes a file itself. It sends small
operations over the WebSocket, and this package applies them to the same source
files an author edits by hand: slide SVGs, Markdown and ``deck.py``. The watcher
then rebuilds exactly as it would after any other edit.
"""
