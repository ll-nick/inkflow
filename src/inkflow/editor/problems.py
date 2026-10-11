"""Each slide's problems, for the editor's marks and its Problems list.

Two kinds, from the checks the CLI already has:

- ``verify``: what ``inkflow verify`` finds (a missing file, a zone or an
  animation target the slide does not have, a chart whose data cannot be
  read, an arrow whose shapes moved…), checked after every build for the
  slides whose model entry changed (an entry's key is a digest of
  everything the editor knows of the slide, its files' hashes included).
  Stale Inkscape preview layers are left out: they matter only in Inkscape,
  and every layout edit would mark every slide.
- ``layout``: what ``inkflow render --check`` measures in Chromium (text
  that overflows or is cut off, objects outside the slide, text too small to
  read, pictures too coarse to print, and, only when asked, text without
  enough contrast). It takes a browser, so it runs once asked
  (`Problems.layout_on`), then again after each build for the slides whose
  SVG changed (kept by a digest of it).

Nothing is written anywhere: the server holds a `Problems` per served deck.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from inkflow.editor.session import LayoutChecker
from inkflow.enums import ColorMode
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData
from inkflow.sync import build_context

_SKIPPED = ("run inkflow sync",)
"""verify messages the editor does not mark (Inkscape preview layers)."""


@dataclass(frozen=True)
class Problem:
    level: str
    """``error``, ``warn`` or ``hint``."""
    message: str
    source: str
    """``verify`` or ``layout``."""
    kind: str = ""
    """A layout finding's kind (overflow, small-text, contrast…)."""

    def json(self) -> dict[str, object]:
        return {
            "level": self.level,
            "message": self.message,
            "source": self.source,
            "kind": self.kind,
        }


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]


def _no_sandbox() -> bool:
    # Chromium refuses its sandbox to root (a container).
    return hasattr(os, "geteuid") and os.geteuid() == 0


@dataclass
class Problems:
    verified: dict[str, list[Problem]] = field(default_factory=dict)
    """verify's problems by model entry key."""
    measured: dict[str, list[Problem]] = field(default_factory=dict)
    """Layout problems by the digest of the slide's SVG (and the contrast
    setting it was measured with)."""
    layout_on: bool = False
    """Someone asked for the layout check: it keeps up with each build."""
    contrast: bool = False
    running: bool = False
    error: str | None = None
    salt: str = ""
    """The hash of the deck.py the last verify ran against."""

    # ── verify ──

    def _verify_keys(self, model: dict[str, object]) -> list[str]:
        entries = cast("list[dict[str, object]]", model["slides"])
        return [f"{self.salt}:{e.get('key') or ''}" for e in entries]

    def verify(
        self, deck: Deck, project_dir: Path, model: dict[str, object], salt: str
    ) -> None:
        """Check the slides whose model entry (or deck.py, whose hash is
        ``salt``) is new; forget the others."""
        from inkflow.verify import verify_slide

        self.salt = salt
        keys = self._verify_keys(model)
        todo = [i for i, k in enumerate(keys) if k not in self.verified]
        if todo:
            preview = build_context(
                deck,
                project_dir,
                deck.theme,
                deck.effective_mode == ColorMode.DARK,
            )
            for i in todo:
                try:
                    issues = verify_slide(
                        deck.slides[i], project_dir, deck.theme, preview
                    )
                except Exception as exc:  # a check never breaks the editor
                    issues = [("warn", f"could not check this slide: {exc}")]
                self.verified[keys[i]] = [
                    Problem(level, message, "verify")
                    for level, message in issues
                    if not any(s in message for s in _SKIPPED)
                ]
        live = set(keys)
        for key in [k for k in self.verified if k not in live]:
            del self.verified[key]

    # ── layout ──

    def _layout_key(self, svg: str) -> str:
        return f"{_digest(svg)}:{int(self.contrast)}"

    def measure(
        self,
        deck: Deck,
        project_dir: Path,
        slides: list[SlideData],
        check: LayoutChecker,
    ) -> None:
        """Measure the shown slides whose SVG was not measured yet (with the
        current contrast setting), with ``check`` (``render.check_built``,
        handed in: render.py builds on the server)."""
        keys = [self._layout_key(s["svg"]) for s in slides]
        todo = [i for i, k in enumerate(keys) if k not in self.measured]
        self.error = None
        if todo:
            try:
                found = check(
                    deck,
                    project_dir,
                    slides,
                    todo,
                    contrast=self.contrast,
                    no_sandbox=_no_sandbox(),
                )
            except Exception as exc:  # no Chromium, a crashed page…
                self.error = str(exc) or type(exc).__name__
                return
            for i in todo:
                self.measured[keys[i]] = [
                    Problem(
                        "warn" if f.is_problem else "hint",
                        f.message().split(": ", 1)[-1],
                        "layout",
                        f.kind,
                    )
                    for f in found.get(i, [])
                ]
        live = set(keys)
        for key in [k for k in self.measured if k not in live]:
            del self.measured[key]

    # ── For the editor ──

    def json(
        self, model: dict[str, object], slides: list[SlideData]
    ) -> dict[str, object]:
        """Each slide's problems by deck index (a hidden slide has only
        verify's), and how the layout check stands."""
        entries = cast("list[dict[str, object]]", model["slides"])
        out: list[list[dict[str, object]]] = []
        for key, entry in zip(self._verify_keys(model), entries, strict=True):
            found = list(self.verified.get(key, []))
            visible = entry.get("visibleIndex")
            if self.layout_on and isinstance(visible, int) and visible < len(slides):
                found += self.measured.get(self._layout_key(slides[visible]["svg"]), [])
            out.append([p.json() for p in found])
        return {
            "type": "problems",
            "slides": out,
            "layout": {
                "on": self.layout_on,
                "contrast": self.contrast,
                "running": self.running,
                "error": self.error,
            },
        }
