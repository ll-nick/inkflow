"""The ``inkflow`` command-line interface.

The command group lives in ``_common`` alongside the shared options and helpers;
the per-area submodules register their commands on it by import side effect. This
module wires them together and re-exports ``main`` as the console-script entry
point (``inkflow.cli:main``).
"""

from __future__ import annotations

from importlib import import_module

from inkflow.cli._common import main

# Import each submodule for its side effect: registering commands on ``main``.
for _submodule in ("authoring", "color", "present", "project", "verify"):
    import_module(f"inkflow.cli.{_submodule}")

__all__ = ["main"]
