"""``python -m inkflow``: the same command line as ``inkflow``."""

import os
import sys

# Started without a console (the desktop launcher's pythonw on Windows), the
# standard streams are None; the terminal UI and logging need somewhere to go.
for _name in ("stdout", "stderr"):
    if getattr(sys, _name) is None:
        setattr(sys, _name, open(os.devnull, "w", encoding="utf-8"))  # noqa: SIM115

from inkflow.cli import main  # noqa: E402

if __name__ == "__main__":
    main(prog_name="inkflow")
