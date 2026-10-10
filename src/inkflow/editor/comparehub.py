"""The editor's compare view, server side: one server builds both decks.

An editor page opens a comparison with ``{"type": "compare-open", "view": n,
"left": <source>, "right": <source>}`` (sources: `comparesrc.Source`) and gets
``{"type": "compare-model", "view": n, …}`` back: both sides' slides (display
SVG, notes text, numbers and ids), each side's stylesheet for the shadow roots
it is shown in, and the pairs with what differs (`compare.pair_json`). The
model is sent again whenever either side rebuilds: the live deck after every
rebuild of the server, a deck folder (an agent's worktree) when its files
change (it is watched while compared), never a commit (it cannot change).
``{"type": "compare-close"}`` (or the page going away) ends it.

Sides are shared between pages and dropped when no page compares them. Each
gets a random token; its pictures are served at ``/_cmp/<token>/<ref>``,
resolved with that deck's own `AssetRoots`, so nothing outside its folders
can be reached. "Take this slide" (an edit-op the session applies, see
`take_request`) and the picker's lists (``compare-sources``) also live here.
"""

from __future__ import annotations

import asyncio
import base64
import json
import secrets
import sys
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast
from urllib.parse import unquote

from typing_extensions import override
from watchfiles import (
    Change,
    DefaultFilter,
    awatch,  # pyright: ignore[reportUnknownVariableType]
)
from websockets.asyncio.server import ServerConnection

from inkflow.assets import MIME_TYPES
from inkflow.editor import comparesrc, gitops
from inkflow.editor.compare import (
    Comparison,
    DeckFacts,
    compare_decks,
    pair_json,
)
from inkflow.editor.comparesrc import (
    CompareError,
    DeckLoader,
    Resolved,
    SideBuild,
    Source,
    deck_facts,
    display_svg,
    shadow_css,
)
from inkflow.editor.transfer import TransferError, export_slides
from inkflow.fonts import embed_fonts_css, shipped_font_url
from inkflow.ink import ink_path
from inkflow.loaders import load_deck_scripts, load_deck_styles
from inkflow.logging import logger
from inkflow.manifest import Deck
from inkflow.pipeline import SlideData

Send = Callable[[ServerConnection, dict[str, object]], Awaitable[None]]


@dataclass
class Side:
    resolved: Resolved
    token: str
    build: SideBuild | None = None
    error: str | None = None
    facts: DeckFacts | None = None
    payload: dict[str, object] | None = None
    """The side as sent to pages (slides, css), made once per build."""
    watcher: asyncio.Task[None] | None = None


@dataclass
class View:
    id: object
    left: Source
    right: Source
    left_key: str
    right_key: str
    result: Comparison | None = None
    built: tuple[int, int] = (0, 0)
    """``id`` of the two builds ``result`` was computed from."""


@dataclass
class CompareHub:
    live_deck: Path
    load: DeckLoader
    """``server.load_deck`` (this module cannot import the server)."""
    sides: dict[str, Side] = field(default_factory=dict)
    views: dict[ServerConnection, View] = field(default_factory=dict)
    _count: int = 0

    def __post_init__(self) -> None:
        self.live_deck = self.live_deck.resolve()
        self.sides["live"] = Side(
            Resolved("live", "live", None, comparesrc.LIVE_LABEL),
            secrets.token_urlsafe(9),
        )

    @property
    def project_dir(self) -> Path:
        return self.live_deck.parent

    # ── The live deck ──

    async def live_built(self, build: SideBuild) -> None:
        """The server rebuilt its deck: pages comparing it get a new model."""
        side = self.sides["live"]
        side.build, side.error, side.facts, side.payload = build, None, None, None
        await self._refresh("live")

    # ── Opening and closing ──

    async def open(
        self, ws: ServerConnection, msg: dict[str, object], *, local: bool
    ) -> dict[str, object]:
        """Start (or change) the comparison of page ``ws``; returns its model."""
        left = _source(msg.get("left"), self.project_dir)
        right = _source(msg.get("right"), self.project_dir)
        in_use = [
            k.removeprefix("commit:") for k in self.sides if k.startswith("commit:")
        ]
        resolved = await asyncio.to_thread(
            lambda: [
                comparesrc.resolve(s, self.live_deck, local=local, in_use=in_use)
                for s in (left, right)
            ]
        )
        for r in resolved:
            await self._ensure(r)
        old = self.views.get(ws)
        view = View(msg.get("view"), left, right, resolved[0].key, resolved[1].key)
        self.views[ws] = view
        if old is not None:
            self._release(old)
        return await asyncio.to_thread(self.model, view)

    def close(self, ws: ServerConnection) -> None:
        view = self.views.pop(ws, None)
        if view is not None:
            self._release(view)

    def close_all(self) -> None:
        for ws in list(self.views):
            self.close(ws)

    def _release(self, view: View) -> None:
        used = {k for v in self.views.values() for k in (v.left_key, v.right_key)}
        for key in (view.left_key, view.right_key):
            side = self.sides.get(key)
            if key == "live" or key in used or side is None:
                continue
            del self.sides[key]
            if side.watcher is not None:
                side.watcher.cancel()
            if side.build is not None:
                sys.modules.pop(side.build.module, None)

    async def _ensure(self, resolved: Resolved) -> Side:
        side = self.sides.get(resolved.key)
        if side is None:
            side = Side(resolved, secrets.token_urlsafe(9))
            self.sides[resolved.key] = side
        elif resolved.key != "live":
            side.resolved = resolved
        if resolved.key == "live":
            if side.build is None:
                await self._build(side, self.live_deck, "_inkflow_deck")
            return side
        if side.build is None and side.error is None:
            self._count += 1
            await self._build(
                side, cast("Path", resolved.deck_path), f"_inkflow_cmp_{self._count}"
            )
        if resolved.watched and side.watcher is None:
            side.watcher = asyncio.create_task(self._watch(resolved.key))
        return side

    async def _build(self, side: Side, deck_path: Path, module: str) -> None:
        try:
            side.build = await asyncio.to_thread(
                comparesrc.build_side, deck_path, module, self.load
            )
            side.error = None
        except Exception as exc:
            logger.info(f"compare: {deck_path} did not build: {exc}")
            side.build, side.error = None, f"{type(exc).__name__}: {exc}"
        side.facts = side.payload = None

    async def _watch(self, key: str) -> None:
        side = self.sides.get(key)
        if side is None or side.resolved.deck_path is None:
            return
        folder = side.resolved.deck_path.parent
        module = side.build.module if side.build else f"_inkflow_cmp_{key}"
        try:
            async for _ in awatch(str(folder), watch_filter=_Filter(folder)):
                side = self.sides.get(key)
                if side is None:
                    return
                await self._build(side, cast("Path", side.resolved.deck_path), module)
                await self._refresh(key)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("compare: watching %s failed", folder)

    # ── Models ──

    async def _refresh(self, key: str) -> None:
        for ws, view in list(self.views.items()):
            if key not in (view.left_key, view.right_key):
                continue
            try:
                payload = await asyncio.to_thread(self.model, view)
                await ws.send(json.dumps(payload))
            except Exception:
                logger.debug("compare: could not update a page", exc_info=True)

    def _facts(self, side: Side) -> DeckFacts | None:
        if side.facts is None and side.build is not None:
            side.facts = deck_facts(side.build)
        return side.facts

    def comparison(self, view: View) -> Comparison | None:
        left, right = self.sides[view.left_key], self.sides[view.right_key]
        lf, rf = self._facts(left), self._facts(right)
        if lf is None or rf is None or left.build is None or right.build is None:
            return None
        built = (id(left.build), id(right.build))
        if view.result is None or view.built != built:
            view.result = compare_decks(lf, rf)
            view.built = built
        return view.result

    def model(self, view: View) -> dict[str, object]:
        """The ``compare-model`` message for one page."""
        result = self.comparison(view)
        left, right = self.sides[view.left_key], self.sides[view.right_key]
        return {
            "type": "compare-model",
            "view": view.id,
            "left": {**self._side_json(left), "source": view.left.as_json()},
            "right": {**self._side_json(right), "source": view.right.as_json()},
            "deck": result.deck if result else [],
            "pairs": [pair_json(p) for p in result.pairs] if result else [],
        }

    def _side_json(self, side: Side) -> dict[str, object]:
        r = side.resolved
        base: dict[str, object] = {
            "kind": r.kind,
            "label": r.label,
            "branch": r.branch,
            "sha": r.sha,
            "live": r.key == "live",
            "deckPath": str(r.deck_path or self.live_deck),
            "token": side.token,
            "missing": list(r.missing),
            "error": side.error,
        }
        if side.build is None:
            return {**base, "slides": [], "css": "", "fonts": "", "mode": "dark"}
        if side.payload is None:
            side.payload = self._payload(side, side.build)
        return {**base, **side.payload}

    def _payload(self, side: Side, build: SideBuild) -> dict[str, object]:
        facts = self._facts(side)
        css, fonts = shadow_css(build.styles)
        if side.resolved.key != "live" and build.deck.embed_fonts:
            fonts = embed_fonts_css(
                build.slides,
                build.project_dir,
                build.deck.theme.fonts_dir,
                styles_css=build.styles,
                font_url=shipped_font_url,
            )
        elif side.resolved.key == "live":
            fonts = ""  # the editor page has the live deck's fonts already
        roots = build.roots
        slides: list[dict[str, object]] = []
        for s in facts.slides if facts else []:
            entry = cast("list[dict[str, object]]", build.model["slides"])[s.index]
            visible = entry.get("visibleIndex")
            data = build.slides[visible] if isinstance(visible, int) else None
            slides.append(
                {
                    "index": s.index,
                    "number": s.number,
                    "id": s.id,
                    "title": s.title,
                    "visible": s.visible,
                    "svg": display_svg(data["svg"], side.token, roots)
                    if data
                    else None,
                    "notes": s.notes,
                }
            )
        return {
            "slides": slides,
            "css": css,
            "fonts": fonts,
            "mode": "light" if build.mode.value == "light" else "dark",
        }

    # ── Assets ──

    def asset(self, request_path: str) -> Path | None:
        """The file ``/_cmp/<token>/<ref>`` names, inside that side's roots."""
        parts = request_path.split("?", 1)[0].split("/", 3)
        if len(parts) < 4 or parts[1] != "_cmp":
            return None
        side = next((s for s in self.sides.values() if s.token == parts[2]), None)
        if side is None or side.build is None:
            return None
        located = side.build.roots.locate(unquote(parts[3]).lstrip("/"))
        if located is None or located.suffix.lower() not in MIME_TYPES:
            return None
        resolved = located.resolve()
        return resolved if resolved.is_file() else None

    # ── Take this slide ──

    def take_request(
        self, ws: ServerConnection, msg: dict[str, object]
    ) -> dict[str, object]:
        """What the session needs to take the other side's version of a pair
        into the live deck: a slide bundle (`transfer.export_slides`) and where
        it goes. The page names the pair by its row and both indices, which
        must still be the comparison's."""
        view = self.views.get(ws)
        if view is None:
            raise CompareError("no comparison is open")
        result = self.comparison(view)
        row = msg.get("pair")
        if (
            result is None
            or not isinstance(row, int)
            or not 0 <= row < len(result.pairs)
        ):
            raise CompareError("no such slide in the comparison")
        pair = result.pairs[row]
        if msg.get("left") != pair.left or msg.get("right") != pair.right:
            raise CompareError("the comparison changed; try again")
        if view.left_key == "live" and view.right_key != "live":
            live_at, other_at = pair.left, pair.right
            other = self.sides[view.right_key]
            live_side = [p.left for p in result.pairs[:row]]
        elif view.right_key == "live" and view.left_key != "live":
            live_at, other_at = pair.right, pair.left
            other = self.sides[view.left_key]
            live_side = [p.right for p in result.pairs[:row]]
        else:
            raise CompareError(
                "one side must be the working copy to take a slide into it"
            )
        if other_at is None:
            raise CompareError(f"this slide is not in {other.resolved.label}")
        if other.build is None:
            raise CompareError(f"{other.resolved.label} did not build")
        live = self.sides["live"].build
        if live is None:
            raise CompareError("the working copy has not built yet")
        try:
            bundle = export_slides(other.build.deck, other.build.deck_path, [other_at])
        except TransferError as exc:
            raise CompareError(str(exc)) from exc
        other_slide = other.build.deck.slides[other_at]
        other_facts = self._facts(other)
        other_id = other_facts.slides[other_at].id if other_facts else other_slide.src
        ink: dict[str, str] | None = None
        theirs = ink_path(other_slide, other_id, other.build.project_dir)
        if theirs.is_file():
            ink = {
                "rel": theirs.relative_to(other.build.project_dir).as_posix(),
                "data": base64.b64encode(theirs.read_bytes()).decode(),
            }
        take: dict[str, object] = {
            "bundle": bundle,
            "replace": live_at,
            "after": next((i for i in reversed(live_side) if i is not None), -1),
            "ink": ink,
            "from": other.resolved.label,
            "id": other_id,
        }
        live_facts = self._facts(self.sides["live"])
        if live_at is not None:
            live_id = live_facts.slides[live_at].id if live_facts else ""
            mine = ink_path(live.deck.slides[live_at], live_id, live.project_dir)
            take["liveInk"] = str(mine)
        else:
            used = {
                rel
                for s in (live_facts.slides if live_facts else [])
                for rel in s.files
            }
            take["inPlace"] = in_place(live.project_dir, bundle, used)
        return take

    # ── The picker ──

    def sources(self) -> dict[str, object]:
        """Commits, branches and worktrees to compare with, for the picker."""
        repo = gitops.open_repo(self.project_dir)
        if repo is None:
            return {"type": "compare-sources", "repo": False}
        try:
            log = gitops.log(repo, limit=60)
        except gitops.GitError:
            log = []
        current = comparesrc.worktree_branch(self.live_deck)
        scope = repo.scope
        trees: list[dict[str, object]] = []
        for tree in comparesrc.worktrees(repo.root):
            path = Path(str(tree["path"]))
            deck = (
                path / scope / self.live_deck.name
                if scope
                else path / self.live_deck.name
            )
            trees.append(
                {
                    "path": str(path),
                    "branch": tree.get("branch"),
                    "head": tree.get("head"),
                    "deck": str(deck) if deck.is_file() else None,
                    "main": path.resolve() == repo.root.resolve(),
                    "current": deck.resolve() == self.live_deck,
                }
            )
        return {
            "type": "compare-sources",
            "repo": True,
            "branch": current,
            "commits": log,
            "branches": [b for b in comparesrc.branches(repo.root)],
            "worktrees": trees,
        }


def in_place(project_dir: Path, bundle: dict[str, object], used: set[str]) -> bool:
    """Whether a slide new to this deck can keep its files' own paths: each
    is missing here, already the same, or a slide's own file no slide here
    uses (say, the file of a slide that was taken out of deck.py). Else it is
    placed like a paste, under fresh names."""
    files = cast("dict[str, dict[str, str]]", bundle.get("files") or {})
    for rel, info in files.items():
        path = project_dir / rel
        if not path.is_file():
            continue
        if path.read_bytes() == base64.b64decode(info.get("data", "")):
            continue
        if info.get("role") in ("slide", "md", "notes") and rel not in used:
            continue
        return False
    return True


def _source(obj: object, project_dir: Path) -> Source:
    data = cast("dict[str, object]", obj) if isinstance(obj, dict) else {}
    if data.get("kind") == "spec":
        spec = data.get("spec")
        if not isinstance(spec, str) or not spec.strip():
            raise CompareError("an empty compare spec")
        return comparesrc.spec_source(spec.strip(), project_dir, project_dir)
    return Source.parse(cast("object", data or obj))


class _Filter(DefaultFilter):
    """The default ignores, plus the deck's own ``.inkflow/`` and ``build/``
    (only below the watched folder: the folder itself may sit in one)."""

    _root: Path

    def __init__(self, root: Path) -> None:
        super().__init__()
        self._root = root.resolve()

    @override
    def __call__(self, change: Change, path: str) -> bool:
        try:
            parts: Sequence[str] = Path(path).resolve().relative_to(self._root).parts
        except ValueError:
            return False
        if parts and parts[0] in (".inkflow", "build", ".git"):
            return False
        return super().__call__(change, path)


def side_build_from(
    deck: Deck, deck_path: Path, slides: list[SlideData], model: dict[str, object]
) -> SideBuild:
    """The live deck's build as a compare side (styles read again: the
    server's copy carries its embedded fonts)."""
    return SideBuild(
        deck=deck,
        deck_path=deck_path,
        slides=slides,
        model=model,
        styles=load_deck_styles(deck, deck_path.parent),
        scripts=load_deck_scripts(deck, deck_path.parent),
    )
