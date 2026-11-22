"""Deck edits and queries with one implementation behind every surface.

An op takes a typed request and an `OpContext` and returns a `ChangeSet` without
touching the disk; `ChangeSet.apply` is the only writer. Each op module registers
its ops on import, and the CLI commands are generated from that registry.
"""

from __future__ import annotations

from inkflow.ops import parent
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
    "parent",
    "registered_ops",
]
