"""Deck edits and reads with one implementation behind every surface.

An op takes a typed request and an `OpContext`. A write op returns a `ChangeSet`
without touching the disk (`ChangeSet.apply` is the only writer); a read op returns
an `OpOutput`. Each op module registers its ops on import, and the CLI commands
are generated from that registry.
"""

from __future__ import annotations

from inkflow.ops import layout, parent, svg, theme
from inkflow.ops.changeset import ChangeSet, ConflictError, FileEdit, OpError
from inkflow.ops.registry import DeckUse, OpContext, OpResult, registered_ops

__all__ = [
    "ChangeSet",
    "ConflictError",
    "DeckUse",
    "FileEdit",
    "OpContext",
    "OpError",
    "OpResult",
    "layout",
    "parent",
    "registered_ops",
    "svg",
    "theme",
]
