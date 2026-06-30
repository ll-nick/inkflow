The `Flip` transition that just played is defined in `deck.py` itself — a few lines of
Python for the dataclass and a matching JS handler registered with
`registerTransition('flip', handler)`. Custom animations follow the same pattern:
Python dataclass plus a CSS `@keyframes` block.

Layouts, themes, animations, and transitions can all be bundled into ordinary Python
packages and shared with `uv add`.
