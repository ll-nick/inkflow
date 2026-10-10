"""Apply one editor request to the project's files, as one undoable step.

Every request from the browser is a small JSON message. ``EditorSession.apply``
validates it against the current build, turns it into new bytes for one or more
files (an SVG, a Markdown file, ``deck.py``), writes them, and records the step
so ``undo``/``redo`` can restore exactly those bytes. Nothing here rebuilds: the
file watcher picks the writes up like any other edit, which is also how the
editor and an agent editing the same files stay in step.
"""

from __future__ import annotations

import ast
import base64
import contextlib
import dataclasses
import os
import re
import secrets
import shutil
import sys
import tempfile
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, cast

from lxml import etree

from inkflow import animations as animations_module
from inkflow import drawio, instances, pdf, publish
from inkflow import transitions as transitions_module
from inkflow.animations import Cue
from inkflow.assets import AssetRoots
from inkflow.charts import (
    ChartError,
    ResolvedChart,
    Table,
    render,
    serialize_rows,
)
from inkflow.edit import KINDS, NO_EDIT_COMMANDS, EditCommands, open_choices, open_with
from inkflow.editor import (
    chartedit,
    gitops,
    media,
    nativedialog,
    places,
    projects,
    worktrees,
)
from inkflow.editor.codegen import Code, coerce_fields
from inkflow.editor.deckedit import (
    INFER,
    DeckEditError,
    DeckSource,
    Group,
    Infer,
    add_section,
    flatten,
    move_in_groups,
    move_section,
    remove_section,
)
from inkflow.editor.drawioedit import DiagramEditError, apply_cell_ops
from inkflow.editor.filerename import (
    RenameError,
    plan_rename,
    plan_slide_rename,
    project_files,
    reference_counts,
)
from inkflow.editor.findreplace import (
    MAX_HITS,
    DeckStrings,
    FindError,
    Options,
    Segment,
    iter_hits,
    pattern,
    replace_in,
    svg_segments,
)
from inkflow.editor.model import MEDIA_HIDDEN_FIELDS
from inkflow.editor.previews import layout_previews
from inkflow.editor.svgops import (
    SvgFile,
    SvgOpError,
    all_ids,
    apply_ops,
    element_at,
    file_hash,
    group,
    set_style,
    ungroup,
    unique_id,
)
from inkflow.editor.themeedit import (
    ThemeEditError,
    merge,
    read_overrides,
    theme_values,
    write_overrides,
)
from inkflow.editor.transfer import (
    TransferError,
    export_assets,
    export_slides,
    plan_asset_paste,
    plan_slide_paste,
    plan_slide_replace,
    retarget_fragment,
)
from inkflow.enums import ColorMode, MediaFit
from inkflow.fontreport import (
    BundlePlan,
    FontDirs,
    FontReport,
    FontSetError,
    Where,
    build_index,
    family_report,
    first_family,
    font_report,
    plan_bundle,
    role_faces,
    token_value,
)
from inkflow.fonts import font_index
from inkflow.ink import (
    InkError,
    Stroke,
    add_strokes,
    erase_strokes,
    ink_path,
    view_box,
)
from inkflow.layout import (
    create_slide,
    discover_layouts,
    preview_layers_text,
    resolve_chain,
    resolve_parent_path,
)
from inkflow.logging import logger
from inkflow.manifest import Chart, Deck, Image, Inline, Slide, TextBox, Video
from inkflow.ns import INKFLOW_SHOW_SHAPE
from inkflow.pack import plan_pack, run_uv_lock
from inkflow.pipeline import resolve_slide_src, slide_ids
from inkflow.sizes import PageSize
from inkflow.svgio import parse_svg_file
from inkflow.sync import build_context, plan_preview
from inkflow.titles import resolve_deck_title
from inkflow.transitions import Transition
from inkflow.zones import remove_zone_section, replace_zone_text, zone_spans

DECK_MODULE = "_inkflow_deck"
_PROJECT_ACTIONS = (
    "project-info",
    "browse",
    "new-deck",
    "open-deck",
    "quit",
    "places-set",
    "system-pick",
)
_MEDIA_ACTIONS = frozenset(
    {
        "import-path",
        "upload-chunk",
        "media-info",
        "convert-plan",
        "convert",
        "convert-status",
        "convert-cancel",
        "discard-source",
    }
)


class EditError(Exception):
    """A request that cannot be applied; the message is shown to the user."""


@dataclass
class _Change:
    path: Path
    before: bytes | None
    after: bytes | None


@dataclass
class _Move:
    """A file renamed by a step (``rename``). Its bytes are not kept: a picture
    or a video may be large, and undo only has to move it back. A move whose
    file also changes (``content``) is recorded in the step's changes instead,
    as the old path deleted and the new one created; it is listed here only to
    be reported as a rename."""

    src: Path
    dst: Path
    content: bool = False
    copy: bool = False
    """A copy (``_Txn.copy``) rather than a rename: ``src`` stays where it
    is (it may be outside the project), undo removes ``dst``."""


def _prune_empty(paths: list[Path], root: Path) -> None:
    """Remove the folders ``paths`` lived in once they are empty (a rename that
    moved the last file out), up to the project folder."""
    for path in paths:
        folder = path.parent
        while folder != root and folder.is_relative_to(root):
            try:
                folder.rmdir()
            except OSError:
                break
            folder = folder.parent


@dataclass
class _Step:
    label: str
    changes: list[_Change]
    coalesce: str | None = None
    """Consecutive steps with the same key merge into one (typing, nudging)."""
    seq: int = 0
    """Serial number in its History (0 until recorded), which an undo can name
    so it undoes that step only (the editor's "Undo" on an agent's edit)."""
    moves: list[_Move] = field(default_factory=list)
    prune: Path | None = None
    """The project folder, for a step that removes the folders it empties."""


@dataclass
class History:
    """Undo/redo over whole-file snapshots of the files each step wrote."""

    done: list[_Step] = field(default_factory=list)
    undone: list[_Step] = field(default_factory=list)
    limit: int = 200
    serial: int = 0

    def record(self, step: _Step) -> None:
        self.serial += 1
        step.seq = self.serial
        last = self.done[-1] if self.done else None
        if (
            step.coalesce is not None
            and last is not None
            and last.coalesce == step.coalesce
        ):
            befores = {c.path: c.before for c in last.changes}
            merged = [
                _Change(c.path, befores.get(c.path, c.before), c.after)
                for c in step.changes
            ]
            merged += [
                c for c in last.changes if c.path not in {m.path for m in merged}
            ]
            self.done[-1] = _Step(
                last.label, merged, step.coalesce, step.seq, [*last.moves, *step.moves]
            )
            self.undone.clear()
            return
        self.done.append(step)
        del self.done[: -self.limit]
        self.undone.clear()

    def _swap(self, step: _Step, forward: bool) -> None:
        moves = [
            (m.src, m.dst) if forward else (m.dst, m.src)
            for m in step.moves
            if not m.content and not m.copy
        ]
        copies = [(m.src, m.dst) for m in step.moves if m.copy]
        for src, dst in copies:
            if forward and (not src.is_file() or dst.exists()):
                raise EditError(
                    f"{src.name} moved or {dst.name} changed outside the editor; "
                    + "cannot redo that edit"
                )
        for src, dst in moves:
            if not src.is_file() or dst.exists():
                raise EditError(
                    f"{src.name} moved or changed outside the editor; "
                    + "cannot undo past that edit"
                )
        for change in step.changes:
            expected = change.before if forward else change.after
            current = change.path.read_bytes() if change.path.exists() else None
            if current != expected:
                raise EditError(
                    f"{change.path.name} changed outside the editor; "
                    + "cannot undo past that edit"
                )
        if forward:
            _do_moves(moves)
            _do_copies(copies)
        else:
            for _src, dst in copies:
                dst.unlink(missing_ok=True)
        for change in step.changes:
            target = change.after if forward else change.before
            if target is None:
                change.path.unlink(missing_ok=True)
            else:
                change.path.parent.mkdir(parents=True, exist_ok=True)
                change.path.write_bytes(target)
        if not forward:
            _do_moves(list(reversed(moves)))
        if step.prune is not None:
            left = [m.src if forward else m.dst for m in step.moves if not m.copy]
            left += [m.dst for m in step.moves if m.copy and not forward]
            left += [
                c.path
                for c in step.changes
                if (c.after if forward else c.before) is None
            ]
            _prune_empty(left, step.prune)

    def undo(self, seq: int | None = None) -> _Step:
        """Undo the last step; with ``seq``, only when that is the step."""
        if not self.done:
            raise EditError("nothing to undo")
        step = self.done[-1]
        if seq is not None and step.seq != seq:
            raise EditError("other edits came after that one: undo them first (Ctrl+Z)")
        self._swap(step, forward=False)
        self.undone.append(self.done.pop())
        return step

    def redo(self) -> _Step:
        if not self.undone:
            raise EditError("nothing to redo")
        step = self.undone[-1]
        self._swap(step, forward=True)
        self.done.append(self.undone.pop())
        return step


def _do_moves(moves: list[tuple[Path, Path]]) -> None:
    for src, dst in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.rename(src, dst)


def _do_copies(copies: list[tuple[Path, Path]]) -> None:
    for src, dst in copies:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)


class _Txn:
    """The files one request writes, staged in memory until commit."""

    project_dir: Path
    staged: dict[Path, bytes | None]
    """New contents by path; None deletes the file."""
    originals: dict[Path, bytes | None]

    moves: list[_Move]
    prune: bool
    """Remove the folders the moves empty (a rename)."""

    def __init__(self, project_dir: Path) -> None:
        self.project_dir = project_dir
        self.staged = {}
        self.originals = {}
        self.moves = []
        self.prune = False

    def move(self, src: Path, dst: Path, content: bytes | None = None) -> None:
        """Rename ``src`` to ``dst``; with ``content``, also give it new bytes
        (recorded as a delete and a create, reported as the rename)."""
        src, dst = self._check(src), self._check(dst)
        if content is not None:
            self.write(src, None)
            self.write(dst, content)
        self.moves.append(_Move(src, dst, content is not None))

    def copy(self, src: Path, dst: Path) -> None:
        """Copy ``src`` (anywhere: a font of this computer, a picture outside
        the deck) to ``dst`` in the project, without holding its bytes: undo
        removes the copy, redo copies again."""
        dst = self._check(dst)
        if dst.exists() or dst in self.staged:
            raise EditError(f"{dst.name} already exists")
        if not src.is_file():
            raise EditError(f"{src} does not exist")
        self.moves.append(_Move(src.resolve(), dst, copy=True))

    def read(self, path: Path) -> bytes:
        data = self.read_optional(path)
        if data is None:
            raise EditError(f"{path.name} does not exist")
        return data

    def read_optional(self, path: Path) -> bytes | None:
        """The file as this request left it, or None when there is none."""
        path = self._check(path)
        if path in self.staged:
            return self.staged[path]
        if path not in self.originals:
            self.originals[path] = path.read_bytes() if path.exists() else None
        return self.originals[path]

    def write(self, path: Path, data: bytes | None) -> None:
        """Stage new contents for ``path``; None deletes it."""
        path = self._check(path)
        if path not in self.originals:
            self.originals[path] = path.read_bytes() if path.exists() else None
        self.staged[path] = data

    def _check(self, path: Path) -> Path:
        resolved = path.resolve()
        if not resolved.is_relative_to(self.project_dir.resolve()):
            raise EditError(f"{path} is outside the project")
        return resolved

    def commit(self, label: str) -> _Step:
        changes = [
            _Change(path, self.originals[path], data)
            for path, data in self.staged.items()
            if self.originals[path] != data
        ]
        _do_moves([(m.src, m.dst) for m in self.moves if not m.content and not m.copy])
        _do_copies([(m.src, m.dst) for m in self.moves if m.copy])
        for change in changes:
            if change.after is None:
                change.path.unlink(missing_ok=True)
                continue
            change.path.parent.mkdir(parents=True, exist_ok=True)
            change.path.write_bytes(change.after)
        prune = self.project_dir.resolve() if self.prune else None
        if prune is not None:
            gone = [c.path for c in changes if c.after is None]
            _prune_empty([m.src for m in self.moves if not m.copy] + gone, prune)
        return _Step(label, changes, moves=list(self.moves), prune=prune)


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "slide"


def _unique_path(directory: Path, stem: str, suffix: str) -> Path:
    candidate = directory / f"{stem}{suffix}"
    n = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{n}{suffix}"
        n += 1
    return candidate


def as_strings(value: list[object]) -> list[str]:
    return [str(v) for v in value]


def _py(value: object) -> str:
    return Code().literal(value)


_ZONE_NAME = re.compile(r"[A-Za-z][\w-]*")


def _zone_base(msg: dict[str, object], default: str) -> str:
    """The name a new zone asks for (``zone``: an agent's ``--id``), else
    ``default``; numbered on (``-2``) when the slide has it already."""
    name = msg.get("zone")
    if not isinstance(name, str) or not name:
        return default
    name = name.removeprefix("zone-")
    if not _ZONE_NAME.fullmatch(name):
        raise EditError(f"{name!r} is not a zone name: letters, digits, - and _")
    return name


class HtmlBuilder(Protocol):
    def __call__(
        self, deck_path: Path, out_dir: Path, inline_assets: bool = False
    ) -> None: ...


class PdfBuilder(Protocol):
    def __call__(
        self,
        deck_path: Path,
        output: Path,
        chromium: str | None = None,
        no_sandbox: bool = False,
        size: PageSize | str | tuple[float, float] | None = None,
        bleed: str | float | None = None,
        crop_marks: bool = False,
    ) -> None: ...


@dataclass(frozen=True)
class Exporters:
    """``export.build_static_html`` and ``export.build_pdf``, handed in by the
    caller: the export module builds on the server module, which owns this
    session, so importing it here would be a cycle."""

    html: HtmlBuilder
    pdf: PdfBuilder


class EditorSession:
    deck_path: Path
    project_dir: Path
    history: History
    built_hash: str | None
    """Hash of the deck.py the current build came from (set by the server)."""
    server: dict[str, object]
    """Where the serving process listens, recorded in the editor context."""
    exports: dict[str, Path]
    """Files this session exported, by download token (served by the server)."""
    exporters: Exporters | None
    """The build functions behind the Export dialog (None: export unavailable)."""
    edit_commands: EditCommands
    """The configured ``INKFLOW_EDIT_CMD*`` commands, offered first by "Open"."""
    switch_to: Path | None
    """A deck.py the editor asked to open instead (the server switches to it)."""
    quit_requested: bool
    """The editor asked the server to stop ("Quit Inkflow")."""
    shape_deck_hash: str | None
    """While shape commands run: the deck.py they changed and loaded since
    the build (``_shapes``), which their next action may change in turn."""
    has_deck: bool
    """False on the start page (no deck yet): only opening or creating a deck
    works, and the home folder stands in for the project."""
    uploads: media.Uploads
    """Files arriving in chunks (no size limit)."""
    conversions: media.Conversions
    """ffmpeg conversions running in the background."""

    def __init__(
        self, deck_path: Path | None, exporters: Exporters | None = None
    ) -> None:
        self.exporters = exporters
        self.edit_commands = NO_EDIT_COMMANDS
        self.switch_to = None
        self.quit_requested = False
        self.has_deck = deck_path is not None
        self.deck_path = (deck_path or Path.home() / "deck.py").resolve()
        self.project_dir = self.deck_path.parent
        self.uploads = media.Uploads(self.project_dir)
        self.conversions = media.Conversions(self.project_dir)
        self.history = History()
        self.built_hash = None
        self.shape_deck_hash = None
        self.server = {}
        self.exports = {}

    # ── Entry point ──

    def apply(self, msg: dict[str, object], deck: Deck | None) -> dict[str, object]:
        action = msg.get("action")
        if not self.has_deck and action not in _PROJECT_ACTIONS:
            raise EditError("open or create a deck first")
        if action == "undo":
            seq = msg.get("step")
            step = self.history.undo(seq if isinstance(seq, int) else None)
            return self._result(step, undo=True)
        if action == "redo":
            step = self.history.redo()
            return self._result(step)
        if action == "upload":
            return self._upload(msg)
        if action == "export":
            return self._export(msg)
        if action == "copy-assets":
            refs = msg.get("refs")
            names = (
                [str(r) for r in cast("list[object]", refs)]
                if isinstance(refs, list)
                else []
            )
            return {"ok": True, "files": export_assets(self.project_dir, names)}
        if action == "math":
            return self._math(msg)
        if action in _MEDIA_ACTIONS:
            return self._media(msg)
        if action == "git":
            return self._git(msg)
        if action == "publish":
            return self._publish(msg, deck)
        if action == "worktree":
            return self._worktree(msg)
        if action in _PROJECT_ACTIONS:
            return self._project(msg, deck)
        if action == "open-apps":
            path = self._openable(msg)
            apps = open_choices(path, self.edit_commands)
            return {"ok": True, "apps": [{"id": a.id, "label": a.label} for a in apps]}
        if action == "open-file":
            return self._open_file(msg, deck)
        if action == "find":
            return {"ok": True, "hits": self._find(msg)}
        if action == "drawio-load":
            return self._drawio_load(msg)
        if action in ("pdf-pages", "pdf-page"):
            return self._pdf_pages(msg)
        if deck is None:
            raise EditError("the deck has not built yet")
        if action == "theme-get":
            return {"ok": True, "theme": self._theme_info(deck)}
        if action == "fonts" and msg.get("op") in (None, "report"):
            report = font_report(deck, self.project_dir)
            return {"ok": True, "fonts": report.json(self.project_dir)}
        if action == "pack":
            return self._pack(msg, deck)
        if action == "chart-preview":
            return self._chart_preview(msg, deck)
        if action == "chart-data":
            return self._chart_data(msg, deck)
        if action == "layout-previews":
            return {"ok": True, "layouts": layout_previews(deck, self.deck_path)}
        if action == "copy-slides":
            indices = msg.get("slides")
            if not isinstance(indices, list) or not all(
                isinstance(i, int) for i in cast("list[object]", indices)
            ):
                raise EditError("nothing to copy")
            try:
                bundle = export_slides(deck, self.deck_path, cast("list[int]", indices))
            except TransferError as exc:
                raise EditError(str(exc)) from exc
            return {"ok": True, "bundle": bundle}
        if action == "shape":
            return self._shapes(msg, deck)
        if action == "files":
            return {"ok": True, "files": self._file_list(deck)}
        txn = _Txn(self.project_dir)
        extra: dict[str, object] = {}
        handler = {
            "svg": self._svg,
            "zone-text": self._zone_text,
            "zone-media": self._zone_media,
            "media-props": self._media_props,
            "insert-video": self._insert_video,
            "insert-chart": self._insert_chart,
            "chart-props": self._chart_props,
            "chart-save-data": self._chart_save_data,
            "insert-textbox": self._insert_textbox,
            "shape-text": self._shape_text,
            "to-markdown": self._to_markdown,
            "theme-set": self._theme_set,
            "fonts": self._fonts,
            "replace": self._replace,
            "md-text": self._md_text,
            "notes": self._notes,
            "slide": self._slide,
            "anim": self._anim,
            "paste-slides": self._paste_slides,
            "paste-objects": self._paste_objects,
            "compare-take": self._compare_take,
            "drawio-save": self._drawio_save,
            "drawio-new": self._drawio_new,
            "ink": self._ink,
            "rename": self._rename,
            "delete-files": self._delete_files,
        }.get(cast("str", action))
        if handler is None:
            raise EditError(f"unknown action {action!r}")
        # An agent (``inkflow slide``) names the build it resolved slide
        # numbers against: a deck.py rebuilt since then may number them apart.
        expected = msg.get("deckHash")
        if (
            isinstance(expected, str)
            and self.built_hash is not None
            and expected != self.built_hash
        ):
            raise EditError("deck.py changed since the last build; try again")
        try:
            label = handler(msg, deck, txn, extra)
        except (
            DeckEditError,
            SvgOpError,
            TransferError,
            InkError,
            RenameError,
            ValueError,
            KeyError,
            TypeError,
            OSError,
        ) as exc:
            raise EditError(str(exc)) from exc
        agent = msg.get("agent")
        if isinstance(agent, str) and agent.strip():
            # Made by an agent through the CLI: the editor says so ("Agent: …").
            label = f"Agent: {agent.strip()}"
        step = txn.commit(label)
        coalesce = msg.get("coalesce")
        step.coalesce = coalesce if isinstance(coalesce, str) else None
        if step.changes or step.moves:
            self.history.record(step)
        return {**self._result(step), **extra}

    def _result(self, step: _Step, undo: bool = False) -> dict[str, object]:
        hashes: dict[str, str] = {}
        for change in step.changes:
            data = change.before if undo else change.after
            hashes[str(change.path)] = file_hash(data) if data is not None else ""
        return {
            "ok": True,
            "label": step.label,
            "hashes": hashes,
            "changes": self._changes(step, undo),
            "step": step.seq,
            "canUndo": bool(self.history.done),
            "canRedo": bool(self.history.undone),
            **self.history_labels(),
        }

    def history_labels(self) -> dict[str, str | None]:
        """What Undo and Redo would do now, for the editor's buttons."""
        done, undone = self.history.done, self.history.undone
        return {
            "undoLabel": done[-1].label if done else None,
            "redoLabel": undone[-1].label if undone else None,
        }

    def _changes(self, step: _Step, undo: bool) -> list[dict[str, str]]:
        """The files a step wrote (or an undo restored), relative to the
        project: created, deleted, modified, or renamed (a deleted file whose
        exact bytes reappear under another name)."""

        def rel(path: Path) -> str:
            try:
                return path.relative_to(self.project_dir).as_posix()
            except ValueError:
                return str(path)

        pairs = [
            (c.path, c.after, c.before) if undo else (c.path, c.before, c.after)
            for c in step.changes
        ]
        out: list[dict[str, str]] = []
        renamed: set[Path] = set()
        moved: set[Path] = set()
        for m in step.moves:
            if m.copy:
                change = "deleted" if undo else "created"
                out.append({"path": rel(m.dst), "change": change, "from": str(m.src)})
                continue
            src, dst = (m.dst, m.src) if undo else (m.src, m.dst)
            out.append({"path": rel(dst), "change": "renamed", "from": rel(src)})
            moved |= {src, dst}
        pairs = [p for p in pairs if p[0] not in moved]
        gone = {path: before for path, before, after in pairs if after is None}
        for path, before, after in pairs:
            if after is None:
                continue
            if before is not None:
                out.append({"path": rel(path), "change": "modified"})
                continue
            origin = next(
                (p for p, data in gone.items() if data == after and p not in renamed),
                None,
            )
            if origin is not None:
                renamed.add(origin)
                out.append(
                    {"path": rel(path), "change": "renamed", "from": rel(origin)}
                )
            else:
                out.append({"path": rel(path), "change": "created"})
        out += [
            {"path": rel(path), "change": "deleted"}
            for path in gone
            if path not in renamed
        ]
        return out

    # ── Helpers ──

    def _deck_slide(self, deck: Deck, msg: dict[str, object]) -> tuple[int, Slide]:
        index = msg.get("slide")
        if not isinstance(index, int) or not 0 <= index < len(deck.slides):
            raise EditError("no such slide")
        return index, deck.slides[index]

    def _deck_source(self, txn: _Txn) -> DeckSource:
        data = txn.read(self.deck_path)
        fresh = self.deck_path.resolve() in txn.staged
        # Slide indices in the request refer to the last build; a deck.py that
        # changed since (an edit not yet rebuilt) may not match them.
        if (
            not fresh
            and self.built_hash is not None
            and file_hash(data) not in (self.built_hash, self.shape_deck_hash)
        ):
            raise EditError("deck.py changed since the last build; try again")
        return DeckSource(data.decode("utf-8"))

    def _save_deck(self, txn: _Txn, source: DeckSource, imports: set[str]) -> None:
        if imports:
            source.ensure_imports(imports)
        txn.write(self.deck_path, source.code.encode("utf-8"))

    def _deck_class(self, name: str, base: type) -> type:
        module = sys.modules.get(DECK_MODULE)
        for mod in (animations_module, transitions_module, module):
            cls = getattr(mod, name, None) if mod is not None else None
            if isinstance(cls, type) and issubclass(cls, base):
                return cls
        raise EditError(f"unknown type {name!r}")

    # ── SVG ──

    def _svg(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        path = Path(cast("str", msg.get("file")))
        data = txn.read(path)
        expected = msg.get("hash")
        if isinstance(expected, str) and expected and file_hash(data) != expected:
            raise EditError(f"{path.name} changed on disk; wait for the reload")
        if drawio.is_drawio_path(path):
            # A diagram's shapes, edited in its source (editor/drawioedit.py).
            try:
                out = apply_cell_ops(
                    data, cast("list[dict[str, object]]", msg.get("ops") or [])
                )
            except DiagramEditError as exc:
                raise EditError(str(exc)) from exc
            txn.write(path, out)
            extra.update(ids={}, structural=False)
            return str(msg.get("label") or "Edit diagram shape")
        svg = SvgFile.from_bytes(path, data)
        untouched = svg.to_bytes()
        ops = cast("list[dict[str, object]]", msg.get("ops") or [])
        # A zone's content lives outside the SVG (deck.py, Markdown): deleting
        # or duplicating the zone's shape takes its content along.
        zone_ops: list[tuple[str, str, object]] = []
        if isinstance(msg.get("zoneSlide"), int):
            for op in ops:
                if op.get("kind") in ("delete", "duplicate"):
                    el_id = element_at(svg.root, op.get("loc")).get("id") or ""
                    if el_id.startswith("zone-"):
                        zone_ops.append((str(op["kind"]), el_id, op.get("key")))
        result_ids: dict[str, str] = {}
        structural = False
        for op in ops:
            if op.get("kind") == "group":
                result_ids["group"] = group(svg, cast("list[str]", op.get("locs")))
                structural = True
            elif op.get("kind") == "ungroup":
                ungroup(svg, cast("str", op.get("loc")))
                structural = True
        plain = [op for op in ops if op.get("kind") not in ("group", "ungroup")]
        prefixes: dict[str, str] = {}
        if plain:
            result = apply_ops(svg, plain)
            result_ids.update(result.ids)
            structural = structural or result.structural
            prefixes = result.renamed_prefixes
        out = svg.to_bytes()
        if out != untouched:
            # A batch that changes nothing leaves the file's own formatting alone.
            txn.write(path, out)
        # Locators only go stale if the file actually changed.
        structural = structural and out != untouched
        renames = {
            str(op["from"]): str(op["id"])
            for op in plain
            if op.get("kind") == "id" and isinstance(op.get("from"), str)
        }
        if renames:
            self._rename_cues(deck, path, renames, txn, prefixes)
        if zone_ops:
            index, slide = self._deck_slide(deck, {"slide": msg["zoneSlide"]})
            for kind, el_id, key in zone_ops:
                zone = el_id.removeprefix("zone-")
                if kind == "delete":
                    self._drop_zone_content(index, slide, zone, txn)
                else:
                    new_id = result_ids.get(
                        str(key if key is not None else "duplicate")
                    )
                    if new_id and new_id.startswith("zone-"):
                        self._copy_zone_content(
                            index,
                            slide,
                            deck,
                            zone,
                            new_id.removeprefix("zone-"),
                            txn,
                        )
        extra["ids"] = result_ids
        extra["structural"] = structural
        return str(msg.get("label") or "Edit shape")

    def _rename_cues(
        self,
        deck: Deck,
        path: Path,
        renames: dict[str, str],
        txn: _Txn,
        prefixes: dict[str, str] | None = None,
    ) -> None:
        """Keep ``animations=[...]`` pointing at an element whose id changed
        (and, for a renamed diagram, at its shapes: ``prefixes``)."""
        source = self._deck_source(txn)
        if source.slide_calls(expected=len(deck.slides)) is None:
            return
        code = Code()
        changed = False
        for index, slide in enumerate(deck.slides):
            try:
                src = resolve_slide_src(slide.src, self.project_dir, deck.theme)
            except Exception:
                continue
            if src.resolve() != path.resolve():
                continue
            if source.animation_count(index) != len(slide.animations):
                continue
            for i, cue in enumerate(slide.animations):
                element = renames.get(cue.element)
                for old, new_id in (prefixes or {}).items():
                    if element is None and cue.element.startswith(f"{old}-"):
                        element = f"{new_id}-{cue.element.removeprefix(f'{old}-')}"
                if element is not None:
                    new = dataclasses.replace(cue, element=element)
                    source.edit_animations(index, replace=(i, code.call(new)))
                    changed = True
        if changed:
            self._save_deck(txn, source, code.imports)

    # ── Zone content ──

    def _zone_text(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        zone = str(msg.get("zone"))
        text = str(msg.get("text", ""))
        origin = msg.get("origin")
        grow = msg.get("svg")
        if isinstance(grow, dict):
            # A text box that outgrew its frame is resized in the same step.
            self._svg(cast("dict[str, object]", grow), deck, txn, {})
        current = slide.zones.get(zone)
        # A TextBox keeps its settings in deck.py, and a slide whose Markdown
        # is written inline keeps its text there; everything else is Markdown.
        if isinstance(current, TextBox) or (
            zone in slide.zones and isinstance(slide.md, Inline)
        ):
            source = self._deck_source(txn)
            code = Code()
            if isinstance(current, TextBox):
                value = code.call(dataclasses.replace(current, text=text))
            elif text.strip():
                value = code.literal(text)
            else:
                value = None
            source.set_zone(index, zone, value)
            self._save_deck(txn, source, code.imports)
            return f"Edit {zone}"
        if not isinstance(slide.md, Inline):
            md_path = self._slide_markdown(index, slide, deck, txn, zone)
            source_text = txn.read(md_path).decode("utf-8")
            if origin == "md-file":
                if not text.strip():
                    raise EditError(
                        "this zone shows the whole Markdown file; "
                        + "edit its text instead of clearing it"
                    )
                new = text.rstrip() + "\n"
            else:
                new = replace_zone_text(source_text, zone, text)
            txn.write(md_path, new.encode("utf-8"))
            return f"Edit {zone}"
        new = replace_zone_text(str(slide.md), zone, text)
        source = self._deck_source(txn)
        source.set_slide_arg(index, "md", f"Inline({_py(new)})")
        self._save_deck(txn, source, {"Inline"})
        return f"Edit {zone}"

    def _zone_media(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Put an image (or video) into a zone via ``zones={...}`` in deck.py."""
        index, slide = self._deck_slide(deck, msg)
        zone = str(msg.get("zone"))
        src = msg.get("src")
        source = self._deck_source(txn)
        if src is None:
            source.set_zone(index, zone, None)
            self._save_deck(txn, source, set())
            return f"Clear {zone}"
        rel = self._deck_rel(Path(pdf.split_ref(str(src))[0]))
        cls = Video if Path(rel).suffix.lower() in media.VIDEO_SUFFIXES else Image
        page = msg.get("page")
        if isinstance(page, int) and pdf.is_pdf_ref(rel):
            rel = pdf.with_page(rel, max(page, 1))
        current = slide.zones.get(zone)
        fit = msg.get("fit")
        if type(current) is cls:
            # Replacing the file keeps how the zone shows it (fit, anchor,
            # playback) but not what belonged to the old file.
            value = dataclasses.replace(current, src=rel, alt_src=None)
            if isinstance(value, Video):
                value = dataclasses.replace(value, poster=None, start=None, end=None)
        else:
            value = cls(rel)
            if isinstance(fit, str):
                value.fit = MediaFit(fit)
        code = Code()
        source.set_zone(index, zone, code.call(value))
        self._save_deck(txn, source, code.imports)
        return f"Set {zone} media"

    def _media_props(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Change the settings of an image or video zone (fit, autoplay, loop...)."""
        index, slide = self._deck_slide(deck, msg)
        zone = str(msg.get("zone"))
        current = slide.zones.get(zone)
        if not isinstance(current, Image | Video):
            raise EditError(f"zone {zone!r} holds no image or video set in deck.py")
        raw = cast("dict[str, object]", msg.get("fields") or {})
        # An emptied text or number box means "back to the default", which for
        # the optional fields (poster, start, end) is None.
        raw = {k: None if v == "" else v for k, v in raw.items()}
        for hidden in MEDIA_HIDDEN_FIELDS:
            raw.pop(hidden, None)
        values = coerce_fields(type(current), raw)
        if isinstance(values.get("poster"), str):
            values["poster"] = self._deck_rel(Path(str(values["poster"])))
        updated = dataclasses.replace(current, **values)
        source = self._deck_source(txn)
        code = Code()
        source.set_zone(index, zone, code.call(updated))
        self._save_deck(txn, source, code.imports)
        return f"{'Video' if isinstance(current, Video) else 'Image'} settings"

    def _own_svg(
        self, msg: dict[str, object], deck: Deck, slide: Slide, txn: _Txn, what: str
    ) -> tuple[Path, SvgFile]:
        """The slide's own SVG named by the request, checked against its hash."""
        path = Path(cast("str", msg.get("file")))
        own = resolve_slide_src(slide.src, self.project_dir, deck.theme)
        if own.resolve() != path.resolve() or not self._is_own(own, deck):
            raise EditError(f"the {what} goes into the slide's own SVG")
        data = txn.read(path)
        expected = msg.get("hash")
        if isinstance(expected, str) and expected and file_hash(data) != expected:
            raise EditError(f"{path.name} changed on disk; wait for the reload")
        return path, SvgFile.from_bytes(path, data)

    def _free_zone_id(
        self, svg: SvgFile, path: Path, slide: Slide, deck: Deck, txn: _Txn, base: str
    ) -> str:
        """A ``zone-<base>`` id free in the whole composition, not just this file:
        a layout's own ``zone-video`` (or a Markdown section of that name) would
        otherwise take the content."""
        taken = all_ids(svg.root) | {f"zone-{z}" for z in slide.zones}
        try:
            chain = resolve_chain(path, self.project_dir, deck.theme)
        except ValueError:
            chain = []
        for ancestor in chain:
            taken |= all_ids(SvgFile.from_bytes(ancestor, ancestor.read_bytes()).root)
        md_path = self._md_file(slide)
        if md_path is not None:
            md = txn.read(md_path).decode("utf-8")
            taken |= {f"zone-{z}" for z in zone_spans(md)}
        return unique_id(svg.root, f"zone-{base}", taken)

    def _new_zone(
        self, msg: dict[str, object], deck: Deck, slide: Slide, txn: _Txn, base: str
    ) -> str:
        """Add a zone rect to the slide's own SVG; returns the zone's name."""
        path, svg = self._own_svg(msg, deck, slide, txn, base)
        zone_id = self._free_zone_id(svg, path, slide, deck, txn, base)
        box = {
            k: float(cast("float", msg.get(k))) for k in ("x", "y", "width", "height")
        }
        if box["width"] <= 0 or box["height"] <= 0:
            raise EditError(f"the {base} needs a size")
        xml = (
            f'<rect id="{zone_id}" x="{box["x"]:g}" y="{box["y"]:g}" '
            + f'width="{box["width"]:g}" height="{box["height"]:g}"/>'
        )
        parent = msg.get("parent") or "0:"
        apply_ops(svg, [{"kind": "insert", "parent": parent, "xml": xml}])
        txn.write(path, svg.to_bytes())
        return zone_id.removeprefix("zone-")

    def _insert_video(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """Place a video anywhere: a new zone rect in the slide's own SVG, filled
        with ``Video(...)`` through ``zones={...}`` in deck.py, as one step."""
        index, slide = self._deck_slide(deck, msg)
        src = msg.get("src")
        if not isinstance(src, str) or not src:
            raise EditError("no video to insert")
        rel = self._deck_rel(Path(src))
        if Path(rel).suffix.lower() not in media.VIDEO_SUFFIXES:
            raise EditError("not a video file")
        zone = self._new_zone(msg, deck, slide, txn, "video")
        source = self._deck_source(txn)
        code = Code()
        source.set_zone(index, zone, code.call(Video(rel)))
        self._save_deck(txn, source, code.imports)
        extra["ids"] = {"new": f"zone-{zone}"}
        extra["structural"] = True
        return "Insert video"

    # ── Charts ──

    def _zone_chart(self, deck: Deck, msg: dict[str, object]) -> tuple[int, str, Chart]:
        """The ``Chart(...)`` filling the request's zone through ``zones={...}``."""
        index, slide = self._deck_slide(deck, msg)
        zone = str(msg.get("zone"))
        chart = slide.zones.get(zone)
        if not isinstance(chart, Chart):
            raise EditError(f"zone {zone!r} holds no chart set in deck.py")
        return index, zone, chart

    def _chart_preview(self, msg: dict[str, object], deck: Deck) -> dict[str, object]:
        """The chart as the build would draw it, from settings and a table the
        dialog has not saved yet. Nothing is written."""
        try:
            if msg.get("zone") is not None:
                _, zone, chart = self._zone_chart(deck, msg)
            else:
                zone, chart = "chart", Chart(data={})
            chart = chartedit.apply_settings(chart, msg.get("chart"))
            if msg.get("table") is not None:
                table = Table.from_text(*chartedit.grid(msg.get("table")))
            else:
                table = chartedit.load(chart, self.project_dir)
            resolved = ResolvedChart(chart, table)
        except (ChartError, OSError, UnicodeDecodeError) as exc:
            resolved = ResolvedChart(Chart(data={}), None, str(exc))
            zone = "chart"
        except ValueError as exc:
            raise EditError(str(exc)) from exc
        width = float(cast("float", msg.get("width") or 960))
        height = float(cast("float", msg.get("height") or 540))
        index = msg.get("slide")
        slide = (
            deck.slides[index]
            if isinstance(index, int) and 0 <= index < len(deck.slides)
            else None
        )
        size = (
            slide.font_size
            if slide is not None and slide.font_size is not None
            else deck.effective_font_size
        )
        scale = deck.effective_size.chart_text_scale
        root = render(resolved, width, height, zone, size * scale)
        return {"ok": True, "svg": etree.tostring(root, encoding="unicode")}

    def _chart_data(self, msg: dict[str, object], deck: Deck) -> dict[str, object]:
        """A chart zone's table as cell text, for the grid editor."""
        _, _, chart = self._zone_chart(deck, msg)
        try:
            columns, rows = chartedit.text_table(chart, self.project_dir)
        except (ChartError, OSError, UnicodeDecodeError) as exc:
            raise EditError(str(exc)) from exc
        path = chartedit.data_path(chart, self.project_dir)
        return {
            "ok": True,
            "columns": columns,
            "rows": rows,
            "path": str(path) if path is not None else None,
            "src": chart.src,
        }

    def _insert_chart(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """Place a chart anywhere: its table written to a new ``data/chart-N.csv``,
        a new zone rect in the slide's own SVG, and ``Chart(...)`` filling it
        through ``zones={...}`` in deck.py, as one step."""
        index, slide = self._deck_slide(deck, msg)
        src = msg.get("src")
        if isinstance(src, str) and src:
            # A data file the project has already (an agent's `--data`): read
            # where it is, so editing the file redraws the chart.
            path = Path(src)
            path = (path if path.is_absolute() else self.project_dir / path).resolve()
            if not chartedit.is_data_file(path) or not path.is_file():
                raise EditError(f"no chart data at {src} (CSV, TSV, JSON or Markdown)")
            try:
                chartedit.load(Chart(self._deck_rel(path)), self.project_dir)
            except (ChartError, UnicodeDecodeError) as exc:
                raise EditError(f"{path.name}: {exc}") from exc
        else:
            columns, rows = chartedit.grid(msg.get("table"))
            path = chartedit.new_data_file(self.project_dir)
            txn.write(path, serialize_rows(".csv", columns, rows).encode("utf-8"))
        chart = chartedit.apply_settings(Chart(self._deck_rel(path)), msg.get("chart"))
        zone = self._new_zone(msg, deck, slide, txn, _zone_base(msg, "chart"))
        source = self._deck_source(txn)
        code = Code()
        source.set_zone(index, zone, code.call(chart))
        self._save_deck(txn, source, code.imports)
        extra["ids"] = {"new": f"zone-{zone}"}
        extra["structural"] = True
        return "Insert chart"

    def _chart_props(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Change a chart's settings (kind, columns, title...) in deck.py."""
        index, zone, chart = self._zone_chart(deck, msg)
        updated = chartedit.apply_settings(chart, msg.get("fields"))
        source = self._deck_source(txn)
        code = Code()
        source.set_zone(index, zone, code.call(updated))
        self._save_deck(txn, source, code.imports)
        return "Chart settings"

    def _chart_save_data(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Write a chart's edited table back where it came from: its data file
        (in that file's format), or ``data={...}`` in deck.py; with the dialog's
        settings, if it sent any, in the same step."""
        index, zone, chart = self._zone_chart(deck, msg)
        columns, rows = chartedit.grid(msg.get("table"))
        updated = chartedit.apply_settings(chart, msg.get("chart"))
        path = chartedit.data_path(chart, self.project_dir)
        if path is not None:
            if not chartedit.is_data_file(path):
                raise EditError(f"cannot write chart data to {path.name}")
            txn.write(path, serialize_rows(path.suffix, columns, rows).encode("utf-8"))
        else:
            data = Table.from_text(columns, rows).to_columns()
            updated = dataclasses.replace(updated, data=data)
        if updated != chart:
            source = self._deck_source(txn)
            code = Code()
            source.set_zone(index, zone, code.call(updated))
            self._save_deck(txn, source, code.imports)
        return "Edit chart data"

    def _insert_textbox(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """A text box that wraps: a new zone rect in the slide's own SVG whose
        Markdown goes where the slide's other text lives (its ``.md`` file, else
        ``zones={...}`` in deck.py)."""
        index, slide = self._deck_slide(deck, msg)
        text = str(msg.get("text") or "Text").strip() or "Text"
        zone = self._new_zone(msg, deck, slide, txn, _zone_base(msg, "text"))
        self._put_zone_text(index, slide, deck, zone, text, txn)
        extra["ids"] = {"new": f"zone-{zone}"}
        extra["zone"] = zone
        extra["structural"] = True
        return "Insert text box"

    # ── Find and replace ──

    def _find_files(self, msg: dict[str, object]) -> list[tuple[Path, str]]:
        """The files to search: those the browser names, plus deck.py."""
        raw = msg.get("files")
        names = (
            [str(f) for f in cast("list[object]", raw)] if isinstance(raw, list) else []
        )
        out: list[tuple[Path, str]] = []
        seen: set[Path] = set()
        for name in names:
            path = Path(name)
            path = (path if path.is_absolute() else self.project_dir / path).resolve()
            if path in seen or not path.is_file():
                continue
            if not path.is_relative_to(self.project_dir.resolve()):
                continue  # theme files are not the deck's to change
            kind = {".svg": "svg", ".md": "md"}.get(path.suffix.lower())
            if kind:
                seen.add(path)
                out.append((path, kind))
        out.append((self.deck_path, "deck"))
        return out

    def _find_options(self, msg: dict[str, object]) -> tuple[re.Pattern[str], Options]:
        opts = Options(
            match_case=bool(msg.get("matchCase")),
            whole_word=bool(msg.get("wholeWord")),
            regex=bool(msg.get("regex")),
        )
        try:
            return pattern(str(msg.get("query") or ""), opts), opts
        except FindError as exc:
            raise EditError(str(exc)) from exc

    def _segments(
        self, path: Path, kind: str, data: bytes
    ) -> tuple[list[Segment], Callable[[], bytes]]:
        """A file's searchable segments, and how to serialize it after edits."""
        if kind == "svg":
            svg = SvgFile.from_bytes(path, data)
            return svg_segments(svg), svg.to_bytes
        if kind == "deck":
            strings = DeckStrings(data.decode("utf-8"))
            return strings.segments(), lambda: strings.code.encode("utf-8")
        text = [data.decode("utf-8")]

        def set_md(v: str) -> None:
            text[0] = v

        return [Segment(text[0], set_md)], lambda: text[0].encode("utf-8")

    def _find(self, msg: dict[str, object]) -> list[dict[str, object]]:
        pat, _ = self._find_options(msg)
        hits: list[dict[str, object]] = []
        for path, kind in self._find_files(msg):
            try:
                segments, _ = self._segments(path, kind, path.read_bytes())
            except Exception:
                continue  # an unparsable file has nothing to offer
            segments = _on_deck_slide(segments, kind, msg)
            for hit in iter_hits(path, kind, segments, pat):
                hits.append(hit.to_json())
                if len(hits) >= MAX_HITS:
                    return hits
        return hits

    def _replace(
        self, msg: dict[str, object], _deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        pat, opts = self._find_options(msg)
        replacement = str(msg.get("replacement") or "")
        only = msg.get("only")
        target: tuple[Path, int] | None = None
        if isinstance(only, dict):
            spec = cast("dict[str, object]", only)
            target = (
                Path(str(spec.get("file"))).resolve(),
                int(cast("int", spec.get("index"))),
            )
        total = 0
        for path, kind in self._find_files(msg):
            if target is not None and path != target[0]:
                continue
            data = txn.read(path)
            segments, serialize = self._segments(path, kind, data)
            segments = _on_deck_slide(segments, kind, msg)
            count = replace_in(
                segments,
                pat,
                replacement,
                target[1] if target is not None else None,
                opts.regex,
            )
            if count:
                if kind == "deck":
                    self._check_deck(serialize())
                txn.write(path, serialize())
                total += count
        if not total:
            raise EditError("nothing to replace")
        extra["replaced"] = total
        return "Replace" if total == 1 else f"Replace {total}"

    def _check_deck(self, code: bytes) -> None:
        try:
            compile(code, str(self.deck_path), "exec")
        except SyntaxError as exc:
            raise EditError(f"the replacement would break deck.py: {exc}") from exc

    # ── Opening a source file in another program ──

    def _openable(self, msg: dict[str, object]) -> Path:
        """The project file a request names, if it is one a program may open."""
        raw = msg.get("path")
        if not isinstance(raw, str) or not raw:
            raise EditError("no file to open")
        path = Path(raw)
        path = (path if path.is_absolute() else self.project_dir / path).resolve()
        if not path.is_relative_to(self.project_dir.resolve()):
            raise EditError(f"{raw} is outside the project")
        suffix = path.suffix.lower().lstrip(".")
        if suffix != "svg" and suffix not in KINDS:
            raise EditError(f"cannot open {path.name}: not a deck source file")
        if not path.is_file():
            raise EditError(f"{raw} does not exist")
        return path

    def _open_file(
        self, msg: dict[str, object], deck: Deck | None
    ) -> dict[str, object]:
        # Set by the server from the connection itself, never by the browser: a
        # program opens on this machine's screen, so only a local page may ask.
        if msg.get("_local") is not True:
            raise EditError("files open only from an editor on this machine")
        path = self._openable(msg)
        apps = {a.id: a for a in open_choices(path, self.edit_commands)}
        app = apps.get(str(msg.get("app") or "system"))
        if app is None:
            raise EditError(f"no such program for {path.name}")
        result: dict[str, object] = {"ok": True}
        if (
            deck is not None
            and path.suffix.lower() == ".svg"
            and not drawio.is_drawio_path(path)  # draw.io's own file, never touched
        ):
            # Inkscape draws only what is in the file: bring its layout layers
            # and theme colours up to date first (one undoable step).
            text = self._inkscape_preview(path, deck)
            if text is not None:
                txn = _Txn(self.project_dir)
                txn.write(path, text.encode("utf-8"))
                step = txn.commit("Refresh Inkscape preview")
                self.history.record(step)
                result = self._result(step)
        error = open_with(path, app)
        if error is not None:
            raise EditError(error)
        return {**result, "opened": str(path.relative_to(self.project_dir))}

    def _inkscape_preview(self, path: Path, deck: Deck) -> str | None:
        """``path`` with its preview layers and theme colours brought up to date
        (what ``inkflow sync`` writes), or None when they already are."""
        dark = deck.effective_mode == ColorMode.DARK
        try:
            ctx = build_context(deck, self.project_dir, deck.theme, dark)
            return preview_layers_text(path, plan_preview(path, ctx).layers)
        except (ValueError, OSError) as exc:
            logger.warning(f"{path.name}: cannot update its Inkscape preview ({exc})")
            return None

    # ── Media files ──

    def _media_file(self, msg: dict[str, object]) -> Path:
        """A video named by a request: in the project, or (for an editor on
        this machine) a file elsewhere on it, converted from where it is."""
        raw = str(msg.get("path") or "")
        path = Path(raw)
        path = (path if path.is_absolute() else self.project_dir / path).resolve()
        inside = path.is_relative_to(self.project_dir.resolve())
        if not path.is_file() or not (inside or msg.get("_local") is True):
            raise EditError(f"no video at {raw}")
        return path

    def _placed(self, arrival: media.Arrival) -> dict[str, object]:
        if arrival.convert:
            # Not on a slide yet: the editor asks how to convert it first.
            return {"ok": True, "convert": True, "source": str(arrival.path)}
        path = arrival.path
        return {"ok": True, "path": str(path), "rel": self._deck_rel(path)}

    def _plan(self, msg: dict[str, object]) -> tuple[media.Plan, dict[str, object]]:
        source = self._media_file(msg)
        info = media.probe(source)
        raw_height = msg.get("height")
        height = int(cast("int", raw_height)) if raw_height else None
        plan = media.plan(
            source,
            self.project_dir / "assets",
            info,
            fmt=str(msg.get("format") or "mp4"),
            height=height,
            quality=int(cast("int", msg.get("quality") or 2)),
            audio=msg.get("audio") is not False,
        )
        return plan, info

    def _media(self, msg: dict[str, object]) -> dict[str, object]:
        action = msg.get("action")
        try:
            if action == "import-path":
                self._local_only(msg, "insert files by path")
                source = Path(str(msg.get("path") or ""))
                return self._placed(media.import_path(self.project_dir, source))
            if action == "upload-chunk":
                try:
                    data = base64.b64decode(str(msg.get("data") or ""), validate=True)
                except ValueError as exc:
                    raise EditError("upload is not valid base64") from exc
                done = self.uploads.chunk(
                    str(msg.get("upload") or ""),
                    str(msg.get("name") or ""),
                    data,
                    msg.get("last") is True,
                )
                return self._placed(done) if done else {"ok": True}
            if action == "media-info":
                info = media.probe(self._media_file(msg))
                return {
                    "ok": True,
                    "info": info,
                    "issues": media.issues(info),
                    "tools": media.tools(),
                    "qualities": list(media.QUALITIES),
                    "remux": media.remux_target(info),
                }
            if action == "discard-source":
                media.discard_source(self.project_dir, self._media_file(msg))
                return {"ok": True}
            if action == "convert-plan":
                plan, _ = self._plan(msg)
                rel = {
                    Path(a): self._deck_rel(Path(a))
                    for a in plan.args
                    if Path(a).is_absolute()
                    and Path(a).is_relative_to(self.project_dir)
                }
                rel[plan.out] = self._deck_rel(plan.out.parent) + "/" + plan.out.name
                return {
                    "ok": True,
                    "command": media.command_line(plan, rel),
                    "estimate": plan.estimate,
                    "out": rel[plan.out],
                }
            if action == "convert":
                self._local_only(msg, "run ffmpeg")
                plan, info = self._plan(msg)
                duration = info.get("duration")
                job = self.conversions.start(
                    plan,
                    duration if isinstance(duration, float) else None,
                    source=self._media_file(msg),
                )
                return {"ok": True, "job": job}
            job_id = str(msg.get("job") or "")
            if action == "convert-cancel":
                self.conversions.cancel(job_id)
                return {"ok": True}
            job = self.conversions.status(job_id)
            out: dict[str, object] = {
                "ok": True,
                "state": job.state,
                "progress": job.progress,
                "error": job.error,
            }
            if job.result is not None:
                out.update(path=str(job.result), rel=self._deck_rel(job.result))
            return out
        except (media.MediaError, OSError) as exc:
            raise EditError(str(exc)) from exc

    # ── Git ──

    # Operations that change files on disk: the editor's undo steps no longer
    # match them, so the history starts over.
    _GIT_REWRITES: frozenset[str] = frozenset(
        {"discard", "pull", "switch", "view", "revert", "restore", "create-branch"}
    )

    def _git(self, msg: dict[str, object]) -> dict[str, object]:
        op = str(msg.get("op") or "status")
        if op == "init":
            self._local_only(msg, "create a repository")
            try:
                gitops.init(self.project_dir, lfs=msg.get("lfs") is not False)
            except gitops.GitError as exc:
                raise EditError(str(exc)) from exc
            return {"ok": True, "git": gitops.status(self.project_dir)}
        if op == "status":
            return {"ok": True, "git": gitops.status(self.project_dir)}
        repo = gitops.open_repo(self.project_dir)
        if repo is None:
            raise EditError("this deck is not in a git repository")

        def text(key: str) -> str:
            return str(msg.get(key) or "")

        extra: dict[str, object] = {}
        try:
            if op == "commit":
                if msg.get("name") or msg.get("email"):
                    gitops.set_identity(repo, text("name"), text("email"))
                raw = msg.get("paths")
                paths = (
                    [str(p) for p in cast("list[object]", raw)]
                    if isinstance(raw, list)
                    else None
                )
                extra["message"] = (
                    f"Committed {gitops.commit(repo, text('message'), paths)}"
                )
            elif op in ("push", "pull"):
                self._local_only(msg, f"{op} from here")
                extra["message"] = (gitops.push if op == "push" else gitops.pull)(repo)
            elif op == "discard":
                raw = msg.get("paths")
                if not isinstance(raw, list):
                    raise EditError("choose the files to discard")
                gitops.discard(repo, [str(p) for p in cast("list[object]", raw)])
            elif op == "lfs-track":
                raw = msg.get("paths")
                if not isinstance(raw, list) or not raw:
                    raise EditError("choose the files to keep in Git LFS")
                added = gitops.lfs_track(
                    repo, [str(p) for p in cast("list[object]", raw)]
                )
                extra["message"] = (
                    f"Tracking {', '.join(added)} with Git LFS; commit to keep it"
                    if added
                    else "Converted to Git LFS; commit to keep it"
                )
            elif op == "lfs-off":
                gitops.lfs_off(repo)
                extra["message"] = "This deck uses git without LFS"
            elif op == "undo-commit":
                gitops.undo_commit(repo)
            elif op == "branches":
                extra["branches"] = gitops.branches(repo)
            elif op == "create-branch":
                gitops.create_branch(repo, text("name"))
            elif op == "switch":
                gitops.switch(repo, text("name"))
            elif op == "log":
                extra["log"] = gitops.log(repo)
            elif op == "view":
                gitops.view_commit(repo, text("sha"))
            elif op == "revert":
                gitops.revert(repo, text("sha"))
            elif op == "restore":
                gitops.restore_deck(repo, text("sha"))
            else:
                raise EditError(f"unknown git operation {op!r}")
        except gitops.GitError as exc:
            raise EditError(str(exc)) from exc
        if op in self._GIT_REWRITES:
            # The editor says so before the first such action in a session.
            self.history = History()
            extra["historyCleared"] = True
        return {"ok": True, **extra, "git": gitops.status(self.project_dir)}

    def _publish(self, msg: dict[str, object], deck: Deck | None) -> dict[str, object]:
        """Publishing on GitHub Pages or GitLab Pages (publish.py): ``status``
        says what each host's setup writes and what is in the way; ``setup``
        writes it as one undoable step (local only: the files are at the
        repository's root, which may be outside the deck)."""
        op = str(msg.get("op") or "status")
        if op == "status":
            return {"ok": True, "publish": self._publish_status(deck)}
        if op != "setup":
            raise EditError(f"unknown publish operation {op!r}")
        self._local_only(msg, "set up publishing")
        host = msg.get("host")
        if host not in publish.HOSTS:
            raise EditError("choose GitHub Pages or GitLab Pages")
        kind = host
        try:
            plan = publish.plan(
                self.deck_path,
                kind,
                msg.get("release") is True,
                readme=msg.get("readme") is True,
                title=resolve_deck_title(deck, self.project_dir) if deck else None,
            )
        except publish.PublishError as exc:
            raise EditError(str(exc)) from exc
        if plan.conflicts and msg.get("force") is not True:
            raise EditError(
                f"{', '.join(plan.conflicts)} exists already: replace it to go on"
            )
        changes: list[_Change] = []
        for rel, text in plan.files.items():
            path = (plan.where.root / rel).resolve()
            before = path.read_bytes() if path.exists() else None
            after = text.encode("utf-8")
            if before == after:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(after)
            changes.append(_Change(path, before, after))
        written = list(plan.files)
        result: dict[str, object] = {"ok": True}
        if changes:
            step = _Step(f"Publish on {publish.HOST_NAMES[kind]}", changes)
            self.history.record(step)
            result = self._result(step)
        return {
            **result,
            "written": written,
            "url": plan.url,
            "settingsUrl": plan.settings,
            "note": plan.url_note,
            "steps": plan.steps(written),
            "warnings": plan.warnings,
            "git": gitops.status(self.project_dir),
        }

    def _publish_status(self, deck: Deck | None) -> dict[str, object]:
        where = publish.layout(self.deck_path)
        hosts: dict[str, object] = {}
        urls: list[str] = []
        for host in publish.HOSTS:
            plan = publish.plan(self.deck_path, host, True)
            files: list[dict[str, object]] = []
            for rel in publish.paths_for(host, True):
                path = where.root / rel
                state = "none"
                if path.is_file():
                    text = path.read_text(encoding="utf-8", errors="replace")
                    state = "inkflow" if publish.made_by_inkflow(text) else "other"
                files.append(
                    {
                        "path": rel,
                        "exists": state,
                        "release": rel == publish.GITHUB_RELEASE,
                    }
                )
            hosts[host] = {
                "url": plan.url,
                "settingsUrl": plan.settings,
                "note": plan.url_note,
                "files": files,
                "warnings": plan.warnings,
            }
            if plan.url:
                urls.append(plan.url)
        configured = publish.detect(where.root)
        readme = where.root / "README.md"
        readme_state = "missing"
        if readme.is_file():
            text = readme.read_text(encoding="utf-8", errors="replace")
            linked = any(u in text for u in urls)
            readme_state = "linked" if linked else "present"
        fonts: list[str] = []
        if deck is not None:
            try:
                fonts = publish.font_warnings(deck, self.project_dir, self.deck_path)
            except Exception as exc:  # a font check never blocks publishing
                logger.warning(f"could not check the deck's fonts: {exc}")
        return {
            "root": str(where.root),
            "scope": where.scope,
            "inRepo": where.in_repo,
            "branch": where.branch,
            "remote": where.remote.project_url if where.remote else None,
            "suggested": publish.host_of(where.remote),
            "configured": configured,
            "hosts": hosts,
            "readme": readme_state,
            "fonts": fonts,
        }

    def _worktree(self, msg: dict[str, object]) -> dict[str, object]:
        """The deck's git worktrees (editor/worktrees.py): list them, add one
        for an agent to work in, merge one's branch, remove one."""
        op = str(msg.get("op") or "list")

        def text(key: str) -> str:
            value = msg.get(key)
            return value if isinstance(value, str) else ""

        extra: dict[str, object] = {}
        try:
            if op == "list":
                pass
            elif op == "add":
                self._local_only(msg, "add a worktree")
                info, note = worktrees.add(
                    self.deck_path, text("name"), text("base") or None
                )
                extra["worktree"] = info
                if note:
                    extra["note"] = note
            elif op == "remove":
                self._local_only(msg, "remove a worktree")
                extra["message"] = worktrees.remove(
                    self.deck_path, text("name"), force=msg.get("force") is True
                )
            elif op == "merge":
                self._local_only(msg, "merge a branch")
                merged = worktrees.merge(self.deck_path, text("branch"))
                extra["message"] = merged.message
                extra["files"] = merged.files
                if merged.note:
                    extra["note"] = merged.note
                if merged.files:
                    # The deck's files changed under the editor's undo steps.
                    self.history = History()
                    extra["historyCleared"] = True
                extra["git"] = gitops.status(self.project_dir)
            else:
                raise EditError(f"unknown worktree operation {op!r}")
            extra["worktrees"] = worktrees.list_worktrees(self.deck_path)
        except gitops.GitError as exc:
            raise EditError(str(exc)) from exc
        return {"ok": True, **extra}

    def _local_only(self, msg: dict[str, object], what: str) -> None:
        # Set by the server from the connection, never by the browser.
        if msg.get("_local") is not True:
            raise EditError(f"only an editor on this machine can {what}")

    # ── Decks ──

    def _project(self, msg: dict[str, object], deck: Deck | None) -> dict[str, object]:
        action = msg.get("action")
        try:
            if action == "project-info":
                return {
                    "ok": True,
                    **projects.new_deck_info(
                        self.deck_path if self.has_deck else None, deck
                    ),
                    "places": places.load(),
                    "recent": [
                        p for p in projects.recent() if p != str(self.deck_path)
                    ],
                }
            if action == "quit":
                self._local_only(msg, "stop inkflow")
                self.quit_requested = True
                return {"ok": True}
            self._local_only(msg, "open or create decks")
            kinds = {"video": media.video_suffixes(), "media": media.MEDIA_SUFFIXES}
            suffixes = kinds.get(str(msg.get("files")), frozenset())
            if action == "browse":
                path = msg.get("path")
                return {
                    "ok": True,
                    **projects.browse(
                        path if isinstance(path, str) else None,
                        self.project_dir,
                        suffixes,
                    ),
                    "places": places.load(),
                    "systemPicker": nativedialog.available(),
                }
            if action == "places-set":
                path = msg.get("path")
                return {
                    "ok": True,
                    "places": places.change(
                        str(msg.get("op")), path if isinstance(path, str) else None
                    ),
                }
            if action == "system-pick":
                start = msg.get("path")
                # Blocks this request (not the server) until the dialog closes.
                chosen = nativedialog.pick(
                    files=bool(suffixes),
                    start=Path(start) if isinstance(start, str) and start else None,
                    title=str(msg.get("title") or "Choose a folder"),
                    suffixes=suffixes,
                )
                return {"ok": True, "path": chosen}
            if action == "new-deck":
                deck_py = projects.create_deck(
                    Path(str(msg.get("path") or "")),
                    title=str(msg.get("title") or ""),
                    theme=str(msg.get("theme") or "starter"),
                    git=msg.get("git") is not False,
                    lfs=msg.get("lfs") is not False,
                    current=self.deck_path if self.has_deck else None,
                    size=str(msg["size"]) if msg.get("size") else None,
                )
            else:
                deck_py = projects.deck_file(str(msg.get("path") or ""))
                projects.remember(deck_py)
                if self.has_deck and deck_py == self.deck_path:
                    return {"ok": True, "deck": str(deck_py), "opening": False}
                # One server per deck: one that has it open already is used
                # (the page goes there) rather than a second one writing it.
                other = instances.serving(deck_py, exclude_pid=os.getpid())
                if other is not None:
                    return {
                        "ok": True,
                        "deck": str(deck_py),
                        "opening": False,
                        "redirect": other.url("/edit"),
                    }
        except (projects.ProjectError, places.PlacesError, OSError) as exc:
            raise EditError(str(exc)) from exc
        if msg.get("open") is not False:
            self.switch_to = deck_py
        return {"ok": True, "deck": str(deck_py), "opening": self.switch_to is not None}

    # ── draw.io diagrams ──

    def _diagram_path(self, raw: object) -> Path:
        """A ``*.drawio.svg`` in the project, named as a slide shows it
        (relative to the project) or by its full path."""
        if not isinstance(raw, str) or not raw.strip():
            raise EditError("which diagram?")
        path = Path(urllib.parse.unquote(raw.strip()))
        path = (path if path.is_absolute() else self.project_dir / path).resolve()
        if not path.is_relative_to(self.project_dir.resolve()):
            raise EditError("that diagram is outside the deck's folder")
        if not drawio.is_drawio_path(path):
            raise EditError("not a draw.io diagram (a .drawio.svg file)")
        return path

    def _pdf_pages(self, msg: dict[str, object]) -> dict[str, object]:
        """A PDF's pages for the editor's page picker: ``pdf-pages`` says how
        many there are and whether they can be shown, ``pdf-page`` converts one
        (the thumbnail, also the size a picture of it takes)."""
        raw = msg.get("path")
        if not isinstance(raw, str) or not raw.strip():
            raise EditError("which PDF?")
        path = Path(urllib.parse.unquote(pdf.split_ref(raw.strip())[0]))
        path = (path if path.is_absolute() else self.project_dir / path).resolve()
        if not path.is_relative_to(self.project_dir.resolve()):
            raise EditError("that PDF is outside the deck's folder")
        if path.suffix.lower() != ".pdf" or not path.is_file():
            raise EditError(f"no PDF at {raw}")
        tool = pdf.converter()
        if msg.get("action") == "pdf-pages":
            return {
                "ok": True,
                "pages": pdf.page_count(path),
                "converter": tool,
                "hint": None if tool else pdf.install_hint(),
                "ignored": gitops.is_ignored(self.project_dir, path),
            }
        page = msg.get("page")
        if not isinstance(page, int) or page < 1:
            raise EditError("which page?")
        try:
            converted = pdf.convert(path, page, self.project_dir, tool)
        except (pdf.PdfError, OSError) as exc:
            raise EditError(str(exc)) from exc
        return {"ok": True, "url": AssetRoots(self.project_dir).canonicalize(converted)}

    def _drawio_load(self, msg: dict[str, object]) -> dict[str, object]:
        """The diagram's source for the draw.io editor, and where draw.io is
        loaded from (``INKFLOW_DRAWIO_URL``, e.g. a self-hosted copy)."""
        url = os.environ.get("INKFLOW_DRAWIO_URL") or drawio.DEFAULT_URL
        if not msg.get("path"):
            return {"ok": True, "xml": "", "url": url, "name": "New diagram"}
        path = self._diagram_path(msg.get("path"))
        try:
            data = path.read_bytes()
            xml = drawio.source(data)
        except OSError as exc:
            raise EditError(f"cannot read {path.name}: {exc}") from exc
        except drawio.DrawioError as exc:
            raise EditError(f"{path.name}: {exc}") from exc
        return {
            "ok": True,
            "xml": xml,
            "url": url,
            "name": path.name[: -len(drawio.SUFFIX)],
            "path": str(path),
            "rel": self._deck_rel(path),
            # A save naming it (``expect``) is refused if the file changed.
            "hash": file_hash(data),
        }

    def _drawio_save(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """Write a diagram draw.io exported (its editable SVG), its source
        stored uncompressed. Without a path it is a new one in ``diagrams/``.
        With ``image`` (the slide's picture of it) the picture keeps its
        width and takes the diagram's new proportions, in the same step."""
        del deck
        svg = msg.get("svg")
        if not isinstance(svg, str) or not svg.strip():
            raise EditError("nothing to save")
        try:
            data = drawio.normalize(svg.encode("utf-8"))
        except drawio.DrawioError as exc:
            raise EditError(f"the diagram could not be saved: {exc}") from exc
        if msg.get("path"):
            path = self._diagram_path(msg.get("path"))
            label = f"Edit diagram {path.name[: -len(drawio.SUFFIX)]}"
            expect = msg.get("expect")
            if (
                isinstance(expect, str)
                and path.exists()
                and file_hash(txn.read(path)) != expect
            ):
                # A redraw of a source edited again meanwhile: the next one
                # draws the newer source.
                raise EditError(f"{path.name} changed meanwhile; wait for the reload")
        else:
            folder = self.project_dir / "diagrams"
            n = 1
            while (folder / f"diagram-{n}{drawio.SUFFIX}").exists():
                n += 1
            path = folder / f"diagram-{n}{drawio.SUFFIX}"
            label = "New diagram"
        txn.write(path, data)
        image = msg.get("image")
        if isinstance(image, dict):
            self._fit_diagram_image(
                cast("dict[str, object]", image), data, txn, msg.get("box")
            )
        width, height = drawio.size(data) or (0.0, 0.0)
        extra.update(
            path=str(path.resolve()),
            rel=self._deck_rel(path),
            width=width,
            height=height,
            structural=False,
        )
        return label

    def _drawio_new(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """A new, empty diagram file (for draw.io desktop, when the embedded
        draw.io cannot load): its picture is a placeholder until it is saved."""
        del msg, deck
        folder = self.project_dir / "diagrams"
        n = 1
        while (folder / f"diagram-{n}{drawio.SUFFIX}").exists():
            n += 1
        path = folder / f"diagram-{n}{drawio.SUFFIX}"
        txn.write(path, drawio.blank())
        width, height = drawio.BLANK_SIZE
        extra.update(
            path=str(path.resolve()),
            rel=self._deck_rel(path),
            width=width,
            height=height,
            structural=False,
        )
        return "New diagram"

    def _fit_diagram_image(
        self, image: dict[str, object], data: bytes, txn: _Txn, box: object = None
    ) -> None:
        """The picture keeps its width and takes the diagram's proportions, or,
        with ``box`` (a redraw after shapes were edited on the slide), takes
        that box: draw.io crops a picture to its drawing, so where the page
        sits on it moves, and the box keeps the unmoved shapes in place."""
        size = drawio.size(data)
        if not size or not size[0] or not size[1]:
            return
        file = Path(cast("str", image.get("file")))
        current = txn.read(file)
        expected = image.get("hash")
        if isinstance(expected, str) and expected and file_hash(current) != expected:
            raise EditError(f"{file.name} changed on disk; wait for the reload")
        svg = SvgFile.from_bytes(file, current)
        el = element_at(svg.root, image.get("loc"))
        if el.tag.rsplit("}", 1)[-1] != "image":
            return
        if isinstance(box, dict):
            values = cast("dict[str, object]", box)
            for key in ("x", "y", "width", "height"):
                value = values.get(key)
                if not isinstance(value, int | float):
                    raise EditError(f"the picture's {key} must be a number")
                el.set(key, f"{round(float(value), 2):g}")
            txn.write(file, svg.to_bytes())
            return
        try:
            width = float(el.get("width") or "")
        except ValueError:
            return
        el.set("height", f"{width * size[1] / size[0]:.4g}")
        txn.write(file, svg.to_bytes())

    # ── Formulas ──

    def _math(self, msg: dict[str, object]) -> dict[str, object]:
        """LaTeX rendered as the build renders it, for the editor's live preview."""
        from inkflow.markdown import html_fragment_to_xml, markdown_to_html

        latex = str(msg.get("latex") or "").strip()
        if not latex:
            raise EditError("an empty formula")
        if "$" in latex:
            raise EditError("a formula cannot contain $")
        block = bool(msg.get("block"))
        source = f"$$\n{latex}\n$$\n" if block else f"${latex}$"
        try:
            html = html_fragment_to_xml(markdown_to_html(source))
        except Exception as exc:
            raise EditError(f"cannot render this formula: {exc}") from exc
        match = re.search(r"<math\b.*?</math>", html, re.S)
        if match is None:
            raise EditError("cannot render this formula")
        return {"ok": True, "mathml": match.group(0)}

    # ── Theme panel ──

    def _theme_info(self, deck: Deck) -> dict[str, object]:
        styles = self.project_dir / "styles.css"
        css = styles.read_text(encoding="utf-8") if styles.is_file() else ""
        theme = deck.theme
        try:
            families = sorted(
                {r[0].family for r in font_index(self.project_dir, theme.fonts_dir)},
                key=str.lower,
            )
        except Exception:
            families = []
        return {
            "name": theme.name,
            "mode": "light" if deck.effective_mode == ColorMode.LIGHT else "dark",
            "deckMode": deck.mode.value if deck.mode is not None else None,
            "themeMode": theme.mode.value,
            "fontSize": deck.font_size,
            "themeFontSize": theme.font_size,
            "values": theme_values(theme),
            "overrides": read_overrides(css),
            "fonts": families,
        }

    def _theme_set(
        self, msg: dict[str, object], _deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Theme panel changes: token overrides in styles.css, the deck's colour
        mode and base font size in deck.py, as one step."""
        changes = msg.get("changes")
        if isinstance(changes, dict):
            styles = self.project_dir / "styles.css"
            css = txn.read(styles).decode("utf-8") if styles.is_file() else ""
            try:
                merged = merge(
                    read_overrides(css),
                    cast("dict[str, dict[str, str | None]]", changes),
                )
                txn.write(styles, write_overrides(css, merged).encode("utf-8"))
            except ThemeEditError as exc:
                raise EditError(str(exc)) from exc
        source: DeckSource | None = None
        imports: set[str] = set()
        if "mode" in msg:
            mode = msg.get("mode")
            source = self._deck_source(txn)
            if mode in ("dark", "light"):
                source.set_deck_arg("mode", f"ColorMode.{str(mode).upper()}")
                imports.add("ColorMode")
            else:
                source.set_deck_arg("mode", None)
        if "fontSize" in msg:
            size = msg.get("fontSize")
            source = source or self._deck_source(txn)
            if isinstance(size, int | float) and not isinstance(size, bool):
                if not 8 <= size <= 200:
                    raise EditError("font size must be between 8 and 200 px")
                source.set_deck_arg("font_size", str(int(size)))
            else:
                source.set_deck_arg("font_size", None)
        if source is not None:
            self._save_deck(txn, source, imports)
        return str(msg.get("label") or "Theme")

    def _fonts(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """``bundle``: copy the fonts only this computer has into ``fonts/``
        (``families``: only those; ``allWeights``; ``dryRun``: only the plan),
        with their licences and ``fonts/README.md``. ``set``: a font token
        (``role`` body/heading/mono, ``family``) written as the Theme dialog
        writes it, and that family bundled when it comes from this computer.
        One step either way; the fonts are copied, not held in the History."""
        op = msg.get("op")
        if op == "bundle":
            report = font_report(deck, self.project_dir)
            families = msg.get("families")
            plan = plan_bundle(
                report,
                self.project_dir,
                families=as_strings(cast("list[object]", families))
                if isinstance(families, list)
                else None,
                all_weights=msg.get("allWeights") is True,
            )
            extra["bundle"] = plan.json(self.project_dir)
            if msg.get("dryRun"):
                return "Bundle fonts"
            if plan.copies:
                self._local_only(msg, "copy this computer's fonts into the deck")
            self._apply_bundle(plan, txn)
            return "Bundle fonts into the deck"
        if op != "set":
            raise EditError(f"unknown fonts op {op!r}")
        role = str(msg.get("role") or "")
        try:
            value = token_value(role, str(msg.get("family") or ""))
        except FontSetError as exc:
            raise EditError(str(exc)) from exc
        styles = self.project_dir / "styles.css"
        css = txn.read(styles).decode("utf-8") if styles.is_file() else ""
        try:
            merged = merge(read_overrides(css), {"typography": {f"{role}_font": value}})
        except ThemeEditError as exc:
            raise EditError(str(exc)) from exc
        txn.write(styles, write_overrides(css, merged).encode("utf-8"))
        extra["value"] = value
        report = font_report(deck, self.project_dir)
        family = first_family(value)
        bundled: dict[str, object] = {}
        if family is not None:
            dirs = FontDirs.for_deck(deck, self.project_dir)
            index = build_index(dirs)
            one = family_report(family[0], role_faces(report, role), dirs, index)
            extra["family"] = one.json(self.project_dir)
            if one.where is Where.MACHINE and msg.get("bundle") is not False:
                if msg.get("_local") is True:
                    plan = plan_bundle(
                        FontReport([one], report.tokens, dirs),
                        self.project_dir,
                        index=index,
                    )
                    self._apply_bundle(plan, txn)
                    bundled = plan.json(self.project_dir)
                else:
                    extra["note"] = (
                        f'"{one.family}" comes from the server\'s computer: bundle '
                        + "it from an editor on that machine"
                    )
        extra["bundle"] = bundled
        return f"Font: {role} = {value}"

    def _apply_bundle(self, plan: BundlePlan, txn: _Txn) -> None:
        for copy in plan.copies:
            txn.copy(copy.src, copy.dst)
        for path, text in plan.texts.items():
            txn.write(path, text.encode("utf-8"))
        if plan.readme is not None:
            txn.write(self.project_dir / "fonts" / "README.md", plan.readme.encode())

    # ── Packing (a deck that looks the same everywhere) ──

    def _pack(self, msg: dict[str, object], deck: Deck) -> dict[str, object]:
        """``check``: what ties the deck to this machine (the commit's
        question); ``plan``: that and what packing would write; ``apply``:
        pack (local only: it copies this computer's files) as one step, then
        ``uv lock`` when a lock is missing, its file added to the step."""
        op = msg.get("op") or "check"
        try:
            plan = plan_pack(
                deck,
                self.project_dir,
                self.deck_path,
                with_pdf_pages=msg.get("withPdfPages") is True,
                all_weights=msg.get("allWeights") is True,
            )
        except (RenameError, OSError, ValueError) as exc:
            raise EditError(str(exc)) from exc
        summary = plan.json(self.project_dir)
        if op in ("check", "plan"):
            return {"ok": True, "pack": summary}
        if op != "apply":
            raise EditError(f"unknown pack op {op!r}")
        self._local_only(msg, "pack the deck (it copies this computer's files)")
        expected = msg.get("deckHash")
        if (
            isinstance(expected, str)
            and self.built_hash is not None
            and expected != self.built_hash
        ):
            raise EditError("deck.py changed since the last build; try again")
        txn = _Txn(self.project_dir)
        self._apply_bundle(plan.bundle, txn)
        for src, dst in plan.copy_in.copies:
            txn.copy(src, dst)
        for path, data in {**plan.copy_in.writes, **plan.writes}.items():
            if path.resolve().is_relative_to(self.project_dir.resolve()):
                txn.write(path, data)
        outside = {
            p: d
            for p, d in plan.writes.items()
            if not p.resolve().is_relative_to(self.project_dir.resolve())
        }
        label = "Pack the deck"
        agent = msg.get("agent")
        if isinstance(agent, str) and agent.strip():
            label = f"Agent: {agent.strip()}"
        step = txn.commit(label)
        # A pyproject.toml up the tree (the repository's) is not the deck's
        # file: written, but outside the step.
        for path, data in outside.items():
            path.write_bytes(data)
        lock_note = None
        if plan.lock_dir is not None:
            lock = plan.lock_dir / "uv.lock"
            before = lock.read_bytes() if lock.is_file() else None
            ok, lock_note = run_uv_lock(plan.lock_dir)
            after = lock.read_bytes() if lock.is_file() else None
            inside = lock.resolve().is_relative_to(self.project_dir.resolve())
            if ok and after != before and inside:
                step.changes.append(_Change(lock.resolve(), before, after))
        if step.changes or step.moves:
            self.history.record(step)
        result = self._result(step)
        changed = (
            [c.path for c in step.changes] + [m.dst for m in step.moves] + list(outside)
        )
        if plan.lock_dir is not None and (plan.lock_dir / "uv.lock").is_file():
            changed.append(plan.lock_dir / "uv.lock")
        root = gitops.repo_root(self.project_dir)
        git_paths: list[str] = []
        if root is not None:
            for path in changed:
                with contextlib.suppress(ValueError):
                    git_paths.append(
                        path.resolve().relative_to(root.resolve()).as_posix()
                    )
        return {
            **result,
            "pack": summary,
            "remaining": [i.json() for i in plan.remaining],
            "lock": lock_note,
            "gitPaths": sorted(set(git_paths)),
            "structural": True,
        }

    def _shape_text(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """Type into a rectangle or ellipse: it becomes a text zone that keeps
        its look (``inkflow:show-shape``), and animations and connectors that
        named it follow its new id."""
        index, slide = self._deck_slide(deck, msg)
        path, svg = self._own_svg(msg, deck, slide, txn, "text")
        el = element_at(svg.root, msg.get("loc"))
        if el.tag.rsplit("}", 1)[-1] not in ("rect", "ellipse", "circle"):
            raise EditError("only rectangles and ellipses can hold text")
        old = el.get("id") or ""
        if old.startswith("zone-"):
            zone_id = old
        else:
            base = _zone_base(msg, "text")
            zone_id = self._free_zone_id(svg, path, slide, deck, txn, base)
            apply_ops(
                svg, [{"kind": "id", "loc": msg.get("loc"), "id": zone_id, "from": old}]
            )
        el.set(INKFLOW_SHOW_SHAPE, "true")
        # Text in a shape is a label (diagrams, buttons): centred both ways,
        # unless the shape already says otherwise.
        style = el.get("style", "")
        set_style(
            el,
            {
                var: "center"
                for var in ("--inkflow-align", "--inkflow-valign")
                if var not in style
            },
        )
        txn.write(path, svg.to_bytes())
        if old and old != zone_id:
            self._rename_cues(deck, path, {old: zone_id}, txn)
        zone = zone_id.removeprefix("zone-")
        text = str(msg.get("text") or "Text").strip() or "Text"
        self._put_zone_text(index, slide, deck, zone, text, txn)
        extra["ids"] = {"new": zone_id}
        extra["structural"] = True
        return "Text in shape"

    # ── Shapes from the command line (``inkflow shape``) ──

    def _shapes(self, msg: dict[str, object], deck: Deck) -> dict[str, object]:
        """An agent's shape commands (editor/shapes.py), as one undoable step.

        Each command runs the actions the editor sends for the same click, as
        requests of their own: every one sees the files as the one before left
        them (a new Markdown file, a slide's new drawing). They share one
        ``coalesce`` key, so the History merges them into a single step; when
        a command is refused, that step is taken back and nothing remains.
        """
        from inkflow.editor import shapes

        expected = msg.get("deckHash")
        if (
            isinstance(expected, str)
            and self.built_hash is not None
            and expected != self.built_hash
        ):
            raise EditError("deck.py changed since the last build; try again")
        key = f"shape-{secrets.token_hex(6)}"
        try:
            outcome = shapes.run(self, msg, deck, key)
        except (EditError, ValueError, OSError) as exc:
            done = self.history.done
            if done and done[-1].coalesce == key:
                self.history.undo()
                self.history.undone.pop()
            raise EditError(str(exc)) from exc
        finally:
            self.shape_deck_hash = None
        done = self.history.done
        step = done[-1] if done and done[-1].coalesce == key else None
        result: dict[str, object]
        if step is not None:
            # Closed: the author's next nudge must not merge into it.
            step.coalesce = None
            result = self._result(step)
        else:
            result = {
                "ok": True,
                "label": "",
                "hashes": {},
                "changes": [],
                "step": 0,
                "canUndo": bool(done),
                "canRedo": bool(self.history.undone),
                **self.history_labels(),
            }
        result["shapes"] = outcome.reports
        result["created"] = outcome.created
        result["ids"] = {"new": outcome.created[-1]} if outcome.created else {}
        result["structural"] = True
        return result

    def slide_id(self, slide: Slide, deck: Deck) -> str:
        return self._slide_id(slide, deck)

    # ── Zone content that follows its zone ──

    def _md_file(self, slide: Slide) -> Path | None:
        if slide.md is None or isinstance(slide.md, Inline):
            return None
        try:
            return self._md_path(slide)
        except Exception:
            return None

    def _put_zone_text(
        self, index: int, slide: Slide, deck: Deck, zone: str, text: str, txn: _Txn
    ) -> None:
        if isinstance(slide.md, Inline):
            source = self._deck_source(txn)
            new = replace_zone_text(str(slide.md), zone, text)
            source.set_slide_arg(index, "md", f"Inline({_py(new)})")
            self._save_deck(txn, source, {"Inline"})
            return
        md_path = self._slide_markdown(index, slide, deck, txn)
        md = txn.read(md_path).decode("utf-8")
        txn.write(md_path, replace_zone_text(md, zone, text).encode("utf-8"))

    def _slide_markdown(
        self,
        index: int,
        slide: Slide,
        deck: Deck,
        txn: _Txn,
        zone: str | None = None,
        move_all: bool = False,
    ) -> Path:
        """The slide's Markdown file, created the first time the slide gets text.

        Slide text lives in Markdown, not in deck.py. A new file takes every
        plain-text zone from ``zones={...}`` with it; an existing one takes
        ``zone`` (the one being written), so a zone is never filled from both.
        A ``TextBox`` stays, since its settings are Python.
        """
        md_path = self._md_file(slide)
        created = md_path is None
        slide_id = self._slide_id(slide, deck)
        if md_path is None:
            md_path = _unique_path(self.project_dir / "slides", _slug(slide_id), ".md")
        moved = {
            name: value
            for name, value in slide.zones.items()
            if isinstance(value, str) and (created or move_all or name == zone)
        }
        if not created and not moved:
            return md_path
        text = "" if created else txn.read(md_path).decode("utf-8")
        # The title first, so it becomes the file's leading heading.
        for name in sorted(moved, key=lambda n: n != "title"):
            text = replace_zone_text(text, name, moved[name])
        txn.write(md_path, text.encode("utf-8"))
        source = self._deck_source(txn)
        for name in moved:
            source.set_zone(index, name, None)
        if created:
            source.set_slide_arg(index, "md", _py(md_path.name))
            if slide.id is None and md_path.stem != slide_id:
                source.set_slide_arg(index, "id", _py(slide_id))
        self._save_deck(txn, source, set())
        return md_path

    def _to_markdown(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Move a slide's text out of deck.py into its Markdown file."""
        index, slide = self._deck_slide(deck, msg)
        if isinstance(slide.md, Inline):
            # Inline Markdown becomes the file's content, with the zones' text.
            slide_id = self._slide_id(slide, deck)
            path = _unique_path(self.project_dir / "slides", _slug(slide_id), ".md")
            text = str(slide.md)
            moved = [n for n, v in slide.zones.items() if isinstance(v, str)]
            for name in moved:
                text = replace_zone_text(text, name, cast("str", slide.zones[name]))
            txn.write(path, text.encode("utf-8"))
            source = self._deck_source(txn)
            for name in moved:
                source.set_zone(index, name, None)
            source.set_slide_arg(index, "md", _py(path.name))
            if slide.id is None and path.stem != slide_id:
                source.set_slide_arg(index, "id", _py(slide_id))
            self._save_deck(txn, source, set())
            return "Move text to Markdown"
        if not any(isinstance(v, str) for v in slide.zones.values()):
            raise EditError("this slide has no text in deck.py to move")
        self._slide_markdown(index, slide, deck, txn, move_all=True)
        return "Move text to Markdown"

    def _slide_id(self, slide: Slide, deck: Deck) -> str:
        """The id the slide is known by now. A new Markdown file is named after
        it, since an id not written out is inferred from the Markdown file's
        name, so ``slide:<id>`` links keep pointing at the slide."""
        visible = [s for s in deck.slides if s.visible]
        for s, slide_id in zip(visible, slide_ids(visible), strict=True):
            if s is slide:
                return slide_id
        return slide_ids([slide])[0]

    def _drop_zone_content(
        self, index: int, slide: Slide, zone: str, txn: _Txn
    ) -> None:
        """Remove what filled a zone whose shape was deleted."""
        if zone in slide.zones:
            source = self._deck_source(txn)
            source.set_zone(index, zone, None)
            self._save_deck(txn, source, set())
            return
        md_path = self._md_file(slide)
        if md_path is not None:
            md = txn.read(md_path).decode("utf-8")
            if zone in zone_spans(md) or f"::{zone}" in md:
                txn.write(md_path, remove_zone_section(md, zone).encode("utf-8"))
        elif isinstance(slide.md, Inline):
            new = remove_zone_section(str(slide.md), zone)
            if new != str(slide.md):
                source = self._deck_source(txn)
                source.set_slide_arg(index, "md", f"Inline({_py(new)})")
                self._save_deck(txn, source, {"Inline"})

    def _copy_zone_content(
        self, index: int, slide: Slide, deck: Deck, old: str, new: str, txn: _Txn
    ) -> None:
        """Give a duplicated zone the same content as the one it copies."""
        if old in slide.zones:
            source = self._deck_source(txn)
            code = Code()
            source.set_zone(index, new, code.literal(slide.zones[old]))
            self._save_deck(txn, source, code.imports)
            return
        md_path = self._md_file(slide)
        md = (
            txn.read(md_path).decode("utf-8")
            if md_path is not None
            else str(slide.md)
            if isinstance(slide.md, Inline)
            else None
        )
        if md is None or old not in zone_spans(md):
            return
        start, end = zone_spans(md)[old]
        self._put_zone_text(index, slide, deck, new, md[start:end], txn)

    def _deck_rel(self, path: Path) -> str:
        resolved = path if path.is_absolute() else self.project_dir / path
        try:
            return resolved.resolve().relative_to(self.project_dir).as_posix()
        except ValueError as exc:
            raise EditError(f"{path} is outside the project") from exc

    def _md_path(self, slide: Slide) -> Path:
        from inkflow.loaders import load_md

        loaded = load_md(slide.md, self.project_dir)
        if loaded is None or loaded.path is None:
            raise EditError("this slide has no Markdown file")
        return loaded.path

    def _md_text(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        text = str(msg.get("text", ""))
        if isinstance(slide.md, Inline):
            source = self._deck_source(txn)
            source.set_slide_arg(index, "md", f"Inline({_py(text)})")
            self._save_deck(txn, source, {"Inline"})
        elif slide.md is not None:
            txn.write(self._md_path(slide), text.encode("utf-8"))
        else:
            md_dir = self.project_dir / "slides"
            path = _unique_path(md_dir, _slug(str(msg.get("name") or "slide")), ".md")
            txn.write(path, text.encode("utf-8"))
            source = self._deck_source(txn)
            source.set_slide_arg(index, "md", _py(path.name))
            self._save_deck(txn, source, set())
        return "Edit Markdown"

    def _notes(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        text = str(msg.get("text", ""))
        notes = slide.notes
        if isinstance(notes, Inline):
            source = self._deck_source(txn)
            source.set_slide_arg(
                index, "notes", f"Inline({_py(text)})" if text else None
            )
            self._save_deck(txn, source, {"Inline"} if text else set())
        elif notes:
            path = Path(str(notes))
            path = path if path.is_absolute() else self.project_dir / path
            txn.write(path, text.encode("utf-8"))
        elif text.strip():
            stem = _slug(str(msg.get("name") or "slide"))
            path = _unique_path(self.project_dir / "notes", stem, ".md")
            txn.write(path, text.encode("utf-8"))
            source = self._deck_source(txn)
            source.set_slide_arg(
                index, "notes", _py(path.relative_to(self.project_dir).as_posix())
            )
            self._save_deck(txn, source, set())
        return "Edit notes"

    # ── Slides ──

    def _slide(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        op = msg.get("op")
        source = self._deck_source(txn)
        if source.slide_calls(expected=len(deck.slides)) is None:
            raise EditError(
                "deck.py builds its slide list in code; edit it by hand or with Claude"
            )
        imports: set[str] = set()
        label = "Edit slide"
        # The slide list as this edit leaves it, for the saved ink to follow
        # the slides whose ids change (see _follow_ink); None: no id changes.
        slides_after: list[Slide] | None = None
        # A slide in ``slides_after`` that is not one of deck.slides: what it was
        # made from, and whether it is a copy (the original stays too).
        origins: dict[int, tuple[Slide, bool]] = {}
        relink: tuple[str, str] | None = None
        if op == "move":
            many = msg.get("slides")
            moved = (
                [int(cast("int", i)) for i in cast("list[object]", many)]
                if isinstance(many, list)
                else [int(cast("int", msg["from"]))]
            )
            section: int | Infer | None = INFER
            if "section" in msg:
                target = msg.get("section")
                section = None if target is None else int(cast("int", target))
            groups = self._section_groups(source, deck)
            try:
                after = move_in_groups(
                    groups, moved, int(cast("int", msg["to"])), section
                )
            except DeckEditError as exc:
                raise EditError(str(exc)) from exc
            source.restructure(after)
            slides_after = [deck.slides[cast("int", i)] for i in flatten(after)]
            extra["select"] = slides_after.index(deck.slides[min(moved)])
            label = "Move slides" if len(set(moved)) > 1 else "Move slide"
        elif isinstance(op, str) and op.startswith("section-"):
            label, after = self._section_op(op, msg, deck, source)
            source.restructure(after)
            if op == "section-add":
                imports.add("Section")
            slides_after = [deck.slides[cast("int", i)] for i in flatten(after)]
            if op == "section-remove" and msg.get("slides") and msg.get("files"):
                kept = {id(s) for s in slides_after}
                gone = [s for s in deck.slides if id(s) not in kept]
                self._drop_slide_files(gone, slides_after, deck, txn)
        elif op == "delete":
            many = msg.get("slides")
            if isinstance(many, list):
                indices = sorted(
                    {int(cast("int", i)) for i in cast("list[object]", many)},
                    reverse=True,
                )
            else:
                indices = [self._deck_slide(deck, msg)[0]]
            if any(not 0 <= i < len(deck.slides) for i in indices):
                raise EditError("no such slide")
            # Highest first, so each removal leaves the others' indices alone.
            for index in indices:
                source.remove_slide(index)
            slides_after = [s for i, s in enumerate(deck.slides) if i not in indices]
            if msg.get("files"):
                gone = [deck.slides[i] for i in indices]
                self._drop_slide_files(gone, slides_after, deck, txn)
            label = "Delete slide" if len(indices) == 1 else "Delete slides"
        elif op == "hide":
            index, _ = self._deck_slide(deck, msg)
            hidden = bool(msg.get("hidden"))
            source.set_slide_arg(index, "visible", "False" if hidden else None)
            slides_after = list(deck.slides)
            slides_after[index] = dataclasses.replace(
                deck.slides[index], visible=not hidden
            )
            origins[id(slides_after[index])] = (deck.slides[index], False)
            label = "Hide slide" if hidden else "Show slide"
        elif op == "title":
            index, _ = self._deck_slide(deck, msg)
            title = str(msg.get("title") or "").strip()
            source.set_slide_arg(index, "title", _py(title) if title else None)
            label = "Rename slide"
        elif op == "id":
            index, slide = self._deck_slide(deck, msg)
            new_id = str(msg.get("id") or "").strip()
            old_id = self._slide_id(slide, deck)
            self._check_new_id(new_id, slide, deck)
            source.set_slide_arg(index, "id", _py(new_id))
            slides_after = list(deck.slides)
            slides_after[index] = dataclasses.replace(slide, id=new_id)
            origins[id(slides_after[index])] = (slide, False)
            # Links to it (``slide:<id>``) are rewritten once deck.py is saved.
            relink = (old_id, new_id)
            label = "Change slide id"
        elif op == "font-size":
            index, _ = self._deck_slide(deck, msg)
            size = msg.get("size")
            source.set_slide_arg(
                index, "font_size", str(int(cast("int", size))) if size else None
            )
            label = "Font size"
        elif op == "transition":
            index, _ = self._deck_slide(deck, msg)
            spec = msg.get("spec")
            if spec is None:
                source.set_slide_arg(index, "transition", None)
            else:
                code = Code()
                obj = self._build(cast("dict[str, object]", spec), Transition)
                source.set_slide_arg(index, "transition", code.call(obj))
                imports |= code.imports
            label = "Set transition"
        elif op == "duplicate":
            index, slide = self._deck_slide(deck, msg)
            overrides = self._copy_files(slide, deck, txn)
            source.duplicate_slide(index, overrides)
            duplicate = dataclasses.replace(
                slide,
                **{
                    name: ast.literal_eval(code) if code is not None else None
                    for name, code in overrides.items()
                    if name in ("src", "md", "id")
                },
            )
            slides_after = list(deck.slides)
            slides_after.insert(index + 1, duplicate)
            origins[id(duplicate)] = (slide, True)
            extra["select"] = index + 1
            label = "Duplicate slide"
        elif op == "new":
            after = int(cast("int", msg.get("after", len(deck.slides) - 1)))
            layout = msg.get("layout")
            if isinstance(msg.get("like"), int):
                # The same layout as that slide (Ctrl+M).
                _, model = self._deck_slide(deck, {"slide": msg.get("like")})
                layout = self._layout_of(model, deck, txn)
            name = self._new_slide_file(
                str(layout) if layout else None,
                str(msg.get("name") or "slide"),
                txn,
                deck,
            )
            args = [_py(name)]
            text = msg.get("md")
            if isinstance(text, str) and text.strip():
                # Its text from the start, in slides/<name>.md like a slide
                # whose text was typed in the editor (_md_text).
                md_path = _unique_path(
                    self.project_dir / "slides", Path(name).stem, ".md"
                )
                txn.write(md_path, text.encode("utf-8"))
                args.append(f"md={_py(md_path.name)}")
            source.insert_slide(after + 1, f"Slide({', '.join(args)})")
            imports.add("Slide")
            extra["select"] = after + 1
            label = "New slide"
        elif op == "detach":
            index, slide = self._deck_slide(deck, msg)
            name = self._new_slide_file(
                slide.src,
                str(msg.get("name") or slide.id or Path(slide.src).stem),
                txn,
                deck,
            )
            source.set_slide_arg(index, "src", _py(name))
            slides_after = list(deck.slides)
            slides_after[index] = dataclasses.replace(slide, src=name)
            origins[id(slides_after[index])] = (slide, False)
            label = "Give slide its own drawing"
        elif op == "layout":
            index, slide = self._deck_slide(deck, msg)
            layout = str(msg.get("layout"))
            src_path = resolve_slide_src(slide.src, self.project_dir, deck.theme)
            if self._is_own(src_path, deck):
                svg = SvgFile.from_bytes(src_path, txn.read(src_path))
                svg.root.set("{urn:inkflow}parent", layout)
                txn.write(src_path, svg.to_bytes())
            else:
                source.set_slide_arg(index, "src", _py(layout))
                slides_after = list(deck.slides)
                slides_after[index] = dataclasses.replace(slide, src=layout)
                origins[id(slides_after[index])] = (slide, False)
            label = "Change layout"
        else:
            raise EditError(f"unknown slide operation {op!r}")
        self._save_deck(txn, source, imports)
        follow = msg.get("follow")
        # Where the slide the editor shows ends up, for it to stay on it.
        if (
            slides_after is not None
            and isinstance(follow, int)
            and 0 <= follow < len(deck.slides)
        ):
            kept = [i for i, s in enumerate(slides_after) if s is deck.slides[follow]]
            extra["select"] = kept[0] if kept else min(follow, len(slides_after) - 1)
        if slides_after is not None:
            self._follow_ink(deck, slides_after, origins, txn)
        if relink is not None:
            extra["links"] = self._relink(*relink, deck, txn)
        return label

    @staticmethod
    def _section_groups(source: DeckSource, deck: Deck) -> list[Group]:
        """deck.py's slide list as sections, checked against the built deck."""
        groups = source.groups()
        built = [len(deck.slides) - sum(len(s.slides) for s in deck.sections)]
        built += [len(s.slides) for s in deck.sections]
        if groups is None or [len(g.slides) for g in groups] != built:
            raise EditError(
                "deck.py builds its sections in code; edit them by hand or with Claude"
            )
        return groups

    def _section_op(
        self, op: str, msg: dict[str, object], deck: Deck, source: DeckSource
    ) -> tuple[str, list[Group]]:
        """A section edit (``section-add``/``-rename``/``-remove``/``-move``):
        its label and the slide list it leaves, as groups of deck indices."""
        groups = self._section_groups(source, deck)
        sections = len(groups) - 1

        def section_index() -> int:
            k = msg.get("section")
            if not isinstance(k, int) or not 0 <= k < sections:
                raise EditError("no such section")
            return k

        def section_name() -> str:
            name = " ".join(str(msg.get("name") or "").split())
            if not name:
                raise EditError("a section needs a name")
            return name

        try:
            if op == "section-add":
                at = msg.get("slide")
                if at is not None and not (
                    isinstance(at, int) and 0 <= at < len(deck.slides)
                ):
                    raise EditError("no such slide")
                name = section_name()
                return f"Add section {name}", add_section(groups, name, at)
            if op == "section-rename":
                k, name = section_index(), section_name()
                after = [g.with_slides(list(g.slides)) for g in groups]
                after[k + 1].name = name
                return "Rename section", after
            if op == "section-remove":
                k = section_index()
                with_slides = bool(msg.get("slides"))
                after = remove_section(groups, k, with_slides)
                if not flatten(after):
                    raise EditError("a deck needs at least one slide")
                label = (
                    "Remove section and its slides" if with_slides else "Remove section"
                )
                return label, after
            if op == "section-move":
                k = section_index()
                to = msg.get("to")
                if not isinstance(to, int) or not 0 <= to < sections:
                    raise EditError("no such place for the section")
                return "Move section", move_section(groups, k, to)
        except DeckEditError as exc:
            raise EditError(str(exc)) from exc
        raise EditError(f"unknown slide operation {op!r}")

    def _check_new_id(self, new_id: str, slide: Slide, deck: Deck) -> None:
        if not re.fullmatch(r"\w[\w.-]*", new_id):
            raise EditError(
                f"{new_id!r} is not a slide id: use letters, digits, - _ and ."
            )
        visible = [s for s in deck.slides if s.visible]
        for other, other_id in zip(visible, slide_ids(visible), strict=True):
            if other is not slide and new_id in (other_id, slide_ids([other])[0]):
                raise EditError(f"another slide is already called {new_id!r}")

    def _slide_files(self, slide: Slide, deck: Deck, ancestors: bool) -> set[Path]:
        """The project files a slide is made of: its drawing (not a shared
        layout or overlay), Markdown, notes and a named ink file. With
        ``ancestors``, also every drawing its own one is built on."""
        found: set[Path] = set()
        try:
            src = resolve_slide_src(slide.src, self.project_dir, deck.theme).resolve()
        except (ValueError, OSError):
            src = None
        if (
            src is not None
            and src.is_relative_to(self.project_dir)
            and not {"layouts", "overlays"} & set(src.parts)
        ):
            found.add(src)
            if ancestors:
                with contextlib.suppress(ValueError, OSError):
                    chain = resolve_chain(src, self.project_dir, deck.theme)
                    found |= {p.resolve() for p in chain}
        if slide.md is not None and not isinstance(slide.md, Inline):
            with contextlib.suppress(EditError, OSError, ValueError):
                found.add(self._md_path(slide).resolve())
        for named in (slide.notes, slide.ink):
            if named and not isinstance(named, Inline):
                path = Path(str(named))
                path = path if path.is_absolute() else self.project_dir / path
                found.add(path.resolve())
        return {p for p in found if p.is_relative_to(self.project_dir)}

    def _drop_slide_files(
        self, gone: list[Slide], kept: list[Slide], deck: Deck, txn: _Txn
    ) -> None:
        """Delete the files only the deleted slides were made of; whatever a
        remaining slide still uses (or is built on) stays."""
        in_use: set[Path] = set()
        for slide in kept:
            in_use |= self._slide_files(slide, deck, ancestors=True)
        for slide in gone:
            for path in sorted(self._slide_files(slide, deck, ancestors=False)):
                if path not in in_use and txn.read_optional(path) is not None:
                    txn.write(path, None)

    def _relink(self, old: str, new: str, deck: Deck, txn: _Txn) -> int:
        """Point ``slide:<old>`` links at ``slide:<new>`` in deck.py and the
        slides' own files; returns how many were rewritten."""
        if old == new:
            return 0
        link = re.compile(rf"(?<=slide:){re.escape(old)}(?![\w.-])")
        files = {self.deck_path.resolve()}
        for slide in deck.slides:
            files |= self._slide_files(slide, deck, ancestors=False)
        count = 0
        for path in sorted(files):
            if path.suffix not in (".py", ".md", ".svg"):
                continue
            data = txn.read_optional(path)
            if data is None:
                continue
            text, n = link.subn(new, data.decode("utf-8", errors="surrogateescape"))
            if n:
                count += n
                txn.write(path, text.encode("utf-8", errors="surrogateescape"))
        return count

    # ── Renaming files ──

    def _rename(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """Rename or move a file (``from``/``to``), or a slide's own files to a
        new stem (``slide``/``stem``), with every reference following; with
        ``dryRun``, only say what would change (``rename`` in the result)."""
        _ = self._deck_source(txn)  # refused when deck.py changed since the build
        if "slide" in msg:
            index, _slide = self._deck_slide(deck, msg)
            stem = str(msg.get("stem") or "")
            plan = plan_slide_rename(
                self.project_dir,
                self.deck_path,
                deck,
                index,
                stem,
                keep_id=bool(msg.get("keepId")),
            )
            label = f"Rename slide files to {stem.strip()}"
        else:
            old, new = msg.get("from"), msg.get("to")
            if not isinstance(old, str) or not isinstance(new, str):
                raise EditError("name the file to rename and its new name")
            plan = plan_rename(self.project_dir, self.deck_path, deck, {old: new})
            label = f"Rename {Path(old).name} to {new.strip()}"
        extra["rename"] = plan.summary(self.project_dir)
        extra["links"] = plan.links
        if msg.get("dryRun"):
            return label
        moved = {new for _, new in plan.moves}
        for old_path, new_path in plan.moves:
            txn.move(old_path, new_path, plan.writes.get(new_path))
        for path, data in plan.writes.items():
            if path not in moved:
                txn.write(path, data)
        txn.prune = True
        extra["structural"] = True
        return label

    def _file_list(self, deck: Deck) -> list[dict[str, object]]:
        """The project's files a deck may use (pictures, videos, data, PDFs,
        diagrams, drawings, Markdown), each with how many references name it."""
        counts = reference_counts(self.project_dir, self.deck_path, deck)
        out: list[dict[str, object]] = []
        for path in project_files(self.project_dir, self.deck_path):
            rel = path.relative_to(self.project_dir).as_posix()
            out.append(
                {"path": rel, "uses": counts.get(rel, 0), "size": path.stat().st_size}
            )
        return out

    def _delete_files(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, _extra: dict[str, object]
    ) -> str:
        """Delete project files nothing refers to (the Files view's "Delete
        unused"); a file still in use is refused."""
        raw = msg.get("paths")
        if not isinstance(raw, list) or not raw:
            raise EditError("no files to delete")
        counts = reference_counts(self.project_dir, self.deck_path, deck)
        listed = {
            p.relative_to(self.project_dir).as_posix()
            for p in project_files(self.project_dir, self.deck_path)
        }
        names = [str(p) for p in cast("list[object]", raw)]
        for rel in names:
            if rel not in listed:
                raise EditError(f"{rel} is not a deck file inkflow manages")
            if counts.get(rel):
                raise EditError(f"{rel} is in use ({counts[rel]} references)")
            txn.write(self.project_dir / rel, None)
        txn.prune = True
        return f"Delete {names[0]}" if len(names) == 1 else f"Delete {len(names)} files"

    # ── Ink ──

    def _ink_slide(self, deck: Deck, msg: dict[str, object]) -> tuple[Slide, str]:
        """The slide an ink request draws on and its id: by ``slideId`` (the
        presenter knows slides by id) or by deck index ``slide`` (the editor)."""
        visible = [s for s in deck.slides if s.visible]
        ids = slide_ids(visible)
        wanted = msg.get("slideId")
        if not isinstance(wanted, str):
            _, slide = self._deck_slide(deck, msg)
            wanted = next(
                (i for s, i in zip(visible, ids, strict=True) if s is slide), None
            )
            if wanted is None:
                raise EditError("a hidden slide has no ink to draw on")
        for slide, slide_id in zip(visible, ids, strict=True):
            if slide_id == wanted:
                return slide, slide_id
        raise EditError(f"no slide {wanted!r}")

    def _canvas(self, slide: Slide, deck: Deck) -> tuple[float, float, float, float]:
        """The slide's canvas, which a new ink file takes as its own."""
        try:
            src = resolve_slide_src(slide.src, self.project_dir, deck.theme)
            box = view_box(parse_svg_file(src))
        except (OSError, ValueError):
            box = None
        return box or (0.0, 0.0, *deck.effective_size.canvas)

    def _ink(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        # Set by the server from the connection, never by the page: an audience
        # screen on another machine sees the ink but never writes the deck.
        self._local_only(msg, "save ink")
        slide, slide_id = self._ink_slide(deck, msg)
        path = ink_path(slide, slide_id, self.project_dir)
        data = txn.read_optional(path)
        extra["ink"] = self._deck_rel(path)
        op = msg.get("op")
        if op == "add":
            raw = msg.get("strokes")
            if not isinstance(raw, list) or not raw:
                raise EditError("no strokes to save")
            strokes = [Stroke.from_json(r) for r in cast("list[object]", raw)]
            txn.write(path, add_strokes(data, strokes, self._canvas(slide, deck)))
            return "Draw" if len(strokes) == 1 else f"Draw {len(strokes)} strokes"
        if op == "erase":
            raw_ids = msg.get("ids")
            if not isinstance(raw_ids, list):
                raise EditError("no strokes to erase")
            ids = {str(i) for i in cast("list[object]", raw_ids)}
            if data is not None:
                txn.write(path, erase_strokes(data, ids))
            return "Erase ink"
        if op == "clear":
            if data is not None:
                txn.write(path, None)
            return "Clear ink"
        raise EditError(f"unknown ink operation {op!r}")

    def _ink_files(self, slides: list[Slide]) -> dict[int, Path]:
        """Each shown slide's ink file by the id the slide gets from its place
        in ``slides``; a slide that names its own (``ink=``) is left out, since
        that path does not follow the slide's id."""
        visible = [s for s in slides if s.visible]
        return {
            id(s): ink_path(s, slide_id, self.project_dir)
            for s, slide_id in zip(visible, slide_ids(visible), strict=True)
            if s.ink is None
        }

    def _follow_ink(
        self,
        deck: Deck,
        after: list[Slide],
        origins: dict[int, tuple[Slide, bool]],
        txn: _Txn,
    ) -> None:
        """Keep each slide's saved ink with it through a slide-list edit.

        A slide's ink file is named after its id, and an id is inferred from
        the slide's files and its place among same-named slides, so moving,
        detaching or re-laying-out a slide can change it: the file is renamed
        in the same step. A duplicate gets a copy; a deleted slide's ink goes
        with it. A file in the way that nothing vacates is never overwritten
        (two slides that only differ by an inferred ``-2``): that ink stays put.
        """
        before = self._ink_files(deck.slides)
        now = self._ink_files(after)
        kept: set[int] = set()
        plans: list[tuple[Path, Path, bool]] = []
        for slide in after:
            origin, copy = origins.get(id(slide), (slide, False))
            if not copy:
                kept.add(id(origin))
            src, dst = before.get(id(origin)), now.get(id(slide))
            if src is not None and dst is not None and src != dst:
                plans.append((src, dst, copy))
        vacated = {src for src, _, copy in plans if not copy}
        vacated |= {p for key, p in before.items() if key not in kept}
        contents = {src: txn.read_optional(src) for src, _, _ in plans}
        for path in vacated:
            if txn.read_optional(path) is not None:
                txn.write(path, None)
        for src, dst, _ in plans:
            data = contents[src]
            if data is None:
                continue
            if dst not in vacated and dst.exists():
                logger.warning(f"ink: {dst.name} already exists; {src.name} kept")
                if src in vacated:
                    txn.write(src, data)
                continue
            txn.write(dst, data)

    def _layout_of(self, slide: Slide, deck: Deck, txn: _Txn) -> str | None:
        """The layout a slide is built on: the one its own drawing names
        (``inkflow:parent``), or the shared layout it shows directly."""
        src_path = resolve_slide_src(slide.src, self.project_dir, deck.theme)
        if not self._is_own(src_path, deck):
            return slide.src
        svg = SvgFile.from_bytes(src_path, txn.read(src_path))
        return svg.root.get("{urn:inkflow}parent")

    def _is_own(self, path: Path, deck: Deck) -> bool:
        resolved = path.resolve()
        if "layouts" in resolved.parts or not resolved.is_relative_to(self.project_dir):
            return False
        users = 0
        for s in deck.slides:
            try:
                if (
                    resolve_slide_src(s.src, self.project_dir, deck.theme).resolve()
                    == resolved
                ):
                    users += 1
            except Exception:
                continue
        return users == 1

    def _new_slide_file(
        self, parent: str | None, stem: str, txn: _Txn, deck: Deck
    ) -> str:
        slides_dir = self.project_dir / "slides"
        slides_dir.mkdir(exist_ok=True)
        # A bare Slide("name") looks in slides/ before the layouts, so a file
        # named like a layout would silently replace it for every other slide.
        taken = {p.stem for _, p in discover_layouts(self.project_dir, deck.theme)}
        slug = _slug(stem)
        if slug in taken:
            slug = f"{slug}-slide"
        path = _unique_path(slides_dir, slug, ".svg")
        if parent is not None:
            parent = self._parent_ref(parent, slides_dir, deck)
        # create_slide resolves the parent and injects the Inkscape preview
        # layers; it writes to disk, so its file only becomes the transaction's.
        try:
            create_slide(
                parent, path, self.project_dir, deck.theme, deck.effective_size.canvas
            )
            # Layout layers and theme colours, so it looks right in Inkscape.
            text = self._inkscape_preview(path, deck)
            data = text.encode("utf-8") if text is not None else path.read_bytes()
        except (ValueError, OSError) as exc:
            raise EditError(str(exc)) from exc
        finally:
            path.unlink(missing_ok=True)
        txn.write(path, data)
        return path.name

    def _parent_ref(self, src: str, slides_dir: Path, deck: Deck) -> str:
        """``src`` as an ``inkflow:parent`` written in a file in ``slides/``.

        A Slide src is relative to deck.py, a parent to the file that names it;
        a layout name or a ``builtin:``/``theme:`` reference means the same from
        both, a path does not and is rewritten relative to ``slides/``.
        """
        target = resolve_slide_src(src, self.project_dir, deck.theme).resolve()
        try:
            same = (
                resolve_parent_path(
                    src, slides_dir, self.project_dir, deck.theme
                ).resolve()
                == target
            )
        except (ValueError, OSError):
            same = False
        if same:
            return src
        return Path(os.path.relpath(target, slides_dir)).as_posix()

    def _copy_files(self, slide: Slide, deck: Deck, txn: _Txn) -> dict[str, str | None]:
        """Copy the slide's own files so the duplicate can diverge from it."""
        overrides: dict[str, str | None] = {}
        src_path = resolve_slide_src(slide.src, self.project_dir, deck.theme)
        if self._is_own(src_path, deck):
            new = _unique_path(
                src_path.parent, f"{src_path.stem}-copy", src_path.suffix
            )
            txn.write(new, txn.read(src_path))
            overrides["src"] = _py(
                new.name if src_path.parent.name == "slides" else self._deck_rel(new)
            )
        if slide.md is not None and not isinstance(slide.md, Inline):
            md_path = self._md_path(slide)
            new = _unique_path(md_path.parent, f"{md_path.stem}-copy", md_path.suffix)
            txn.write(new, txn.read(md_path))
            written = Path(str(slide.md))
            overrides["md"] = _py(
                new.name
                if len(written.parts) == 1
                else str(written.with_name(new.name))
            )
        if slide.notes and not isinstance(slide.notes, Inline):
            path = Path(str(slide.notes))
            path = path if path.is_absolute() else self.project_dir / path
            if path.is_file():
                new = _unique_path(path.parent, f"{path.stem}-copy", path.suffix)
                txn.write(new, txn.read(path))
                overrides["notes"] = _py(self._deck_rel(new))
        if slide.ink is not None:
            # A file the slide names itself; ink at the default place follows
            # the copy's id instead (_follow_ink).
            path = ink_path(slide, "", self.project_dir)
            if path.is_file():
                new = _unique_path(path.parent, f"{path.stem}-copy", path.suffix)
                txn.write(new, txn.read(path))
                overrides["ink"] = _py(self._deck_rel(new))
        if slide.id:
            overrides["id"] = _py(f"{slide.id}-copy")
        return overrides

    # ── Animations ──

    def _build(self, spec: dict[str, object], base: type) -> object:
        cls = self._deck_class(str(spec.get("type")), base)
        fields = coerce_fields(cls, cast("dict[str, object]", spec.get("fields") or {}))
        if issubclass(cls, Cue):
            fields["element"] = str(spec.get("element") or "")
            if not fields["element"]:
                raise EditError("an animation needs a target element")
        try:
            return cast("Callable[..., object]", cls)(**fields)
        except TypeError as exc:
            raise EditError(str(exc)) from exc

    def _anim(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        index, slide = self._deck_slide(deck, msg)
        op = msg.get("op")
        spec = cast("dict[str, object] | None", msg.get("spec"))
        target = cast("dict[str, object] | None", msg.get("target"))
        if spec is not None and target is not None and not spec.get("element"):
            # The element has no id yet: give it one in its SVG, in the same step.
            path = Path(str(target.get("file")))
            svg = SvgFile.from_bytes(path, txn.read(path))
            result = apply_ops(
                svg,
                [
                    {
                        "kind": "ensure-id",
                        "loc": target.get("loc"),
                        "key": "target",
                        "base": target.get("base"),
                    }
                ],
            )
            txn.write(path, svg.to_bytes())
            spec = {**spec, "element": result.ids["target"]}
            extra["ids"] = result.ids
        source = self._deck_source(txn)
        code = Code()
        n = len(slide.animations)
        position = int(cast("int", msg.get("index", n)))
        if op == "insert":
            assert spec is not None
            obj = self._build(spec, Cue)
            source.edit_animations(index, insert=(position, code.call(obj)))
            label = "Add animation"
        elif op == "replace":
            assert spec is not None
            obj = self._build(spec, Cue)
            source.edit_animations(index, replace=(position, code.call(obj)))
            label = "Edit animation"
        elif op == "remove":
            # Several at once (``indices``, an agent's `inkflow anim remove`):
            # from the last, so each index still names the same animation.
            raw = msg.get("indices")
            positions = (
                sorted({int(cast("int", i)) for i in cast("list[object]", raw)})
                if isinstance(raw, list) and raw
                else [position]
            )
            for at in reversed(positions):
                source.edit_animations(index, remove=at)
            label = (
                "Remove animation"
                if len(positions) == 1
                else f"Remove {len(positions)} animations"
            )
        elif op == "move":
            to = int(cast("int", msg.get("to")))
            source.edit_animations(index, move=(position, to))
            label = "Reorder animation"
        else:
            raise EditError(f"unknown animation operation {op!r}")
        self._save_deck(txn, source, code.imports)
        return label

    # ── Copy and paste between decks ──

    def _paste_slides(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        after = int(cast("int", msg.get("after", len(deck.slides) - 1)))
        plan = plan_slide_paste(self.project_dir, deck, msg.get("bundle"))
        source = self._deck_source(txn)
        if source.slide_calls(expected=len(deck.slides)) is None:
            raise EditError(
                "deck.py builds its slide list in code; paste slides there by hand"
            )
        for rel, data in plan.writes.items():
            txn.write(self.project_dir / rel, data)
        for i, code in enumerate(plan.calls):
            source.insert_slide(after + 1 + i, code)
        self._save_deck(txn, source, plan.imports)
        extra["select"] = after + 1
        extra["pasted"] = len(plan.calls)
        extra["written"] = sorted(plan.writes)
        n = len(plan.calls)
        return f"Paste {n} slide{'s' if n != 1 else ''}"

    def _compare_take(
        self, msg: dict[str, object], deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        """The compare view's "Take this slide": the other side's version of a
        slide replaces this deck's (its files at their own paths) or, when this
        deck lacks it, is inserted where it stands there (files placed like a
        paste). ``_take`` is put on the request by the server, from the
        compared deck (editor/comparehub.py), never by the page."""
        take = msg.get("_take")
        if not isinstance(take, dict):
            raise EditError("there is no slide to take")
        data = cast("dict[str, object]", take)
        source = self._deck_source(txn)
        if source.slide_calls(expected=len(deck.slides)) is None:
            raise EditError(
                "deck.py builds its slide list in code; copy the slide by hand"
            )
        replace = data.get("replace")
        if isinstance(replace, int):
            if not 0 <= replace < len(deck.slides):
                raise EditError("no such slide")
            plan = plan_slide_replace(self.project_dir, data.get("bundle"))
            at = replace
        else:
            after = data.get("after")
            at = (after if isinstance(after, int) else -1) + 1
            plan = (
                plan_slide_replace(self.project_dir, data.get("bundle"))
                if data.get("inPlace") is True
                else plan_slide_paste(self.project_dir, deck, data.get("bundle"))
            )
        for rel, payload in plan.writes.items():
            txn.write(self.project_dir / rel, payload)
        if isinstance(replace, int):
            # In its place: its section and the comments above it stay.
            source.replace_slide(at, plan.calls[0])
        else:
            source.insert_slide(at, plan.calls[0])
        self._save_deck(txn, source, plan.imports)
        ink = data.get("ink")
        mine = data.get("liveInk")
        if isinstance(ink, dict) and isinstance(replace, int):
            entry = cast("dict[str, object]", ink)
            rel = str(entry.get("rel", ""))
            if rel and not rel.startswith(("/", "..")) and ".." not in rel.split("/"):
                txn.write(
                    self.project_dir / rel,
                    base64.b64decode(str(entry.get("data", ""))),
                )
        elif isinstance(mine, str) and isinstance(replace, int):
            # That version has no ink: neither does this slide now.
            path = Path(mine)
            if path.is_file() and path.resolve().is_relative_to(
                self.project_dir.resolve()
            ):
                txn.write(path, None)
        extra["select"] = at
        extra["written"] = sorted(plan.writes)
        name = data.get("id") or "slide"
        where = data.get("from") or "the other deck"
        return f"Take {name} from {where}"

    def _paste_objects(
        self, msg: dict[str, object], _deck: Deck, txn: _Txn, extra: dict[str, object]
    ) -> str:
        path = Path(cast("str", msg.get("file")))
        data = txn.read(path)
        expected = msg.get("hash")
        if isinstance(expected, str) and expected and file_hash(data) != expected:
            raise EditError(f"{path.name} changed on disk; wait for the reload")
        writes, targets = plan_asset_paste(self.project_dir, msg.get("files"))
        for rel, payload in writes.items():
            txn.write(self.project_dir / rel, payload)
        file_rel = path.resolve().relative_to(self.project_dir).as_posix()
        svg = SvgFile.from_bytes(path, data)
        fragments = cast("list[object]", msg.get("fragments") or [])
        offset = msg.get("offset")
        ops: list[dict[str, object]] = [
            {
                "kind": "insert",
                "parent": msg.get("parent") or "0:",
                "xml": retarget_fragment(str(xml), file_rel, targets),
                "offset": offset,
                "key": f"paste{i}",
            }
            for i, xml in enumerate(fragments)
        ]
        result = apply_ops(svg, ops)
        txn.write(path, svg.to_bytes())
        extra["ids"] = result.ids
        extra["structural"] = True
        return "Paste"

    # ── Export ──

    def _export(self, msg: dict[str, object]) -> dict[str, object]:
        """Build the deck as a web page, a single HTML file or a PDF.

        Not an edit (nothing to undo): the result is written where asked, by
        default where the ``inkflow build`` / ``export`` commands put it, and a
        download token is handed back for the browser.
        """
        if self.exporters is None:
            raise EditError("export is not available here; use inkflow build / export")
        build_static_html = self.exporters.html
        build_pdf = self.exporters.pdf
        fmt = msg.get("format")
        raw = msg.get("output")
        stem = self.deck_path.stem
        defaults = {
            "html": "build",
            "single": f"{stem}.html",
            "pdf": f"{stem}.pdf",
        }
        if fmt not in defaults:
            raise EditError(f"unknown export format {fmt!r}")
        fmt = cast("str", fmt)
        out = Path(str(raw).strip()) if isinstance(raw, str) and raw.strip() else None
        out = out if out is None or out.is_absolute() else self.project_dir / out
        out = (out or self.project_dir / defaults[fmt]).resolve()
        if (
            out == self.project_dir.resolve()
            or out in self.project_dir.resolve().parents
        ):
            raise EditError("pick an output inside the project, not the project itself")
        try:
            if fmt == "html":
                build_static_html(self.deck_path, out)
                result = out
            elif fmt == "single":
                if out.suffix.lower() != ".html":
                    out = out.with_suffix(".html")
                with tempfile.TemporaryDirectory() as tmp:
                    build_static_html(self.deck_path, Path(tmp), inline_assets=True)
                    out.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(Path(tmp) / "index.html", out)
                result = out
            else:
                if out.suffix.lower() != ".pdf":
                    out = out.with_suffix(".pdf")
                root = hasattr(os, "geteuid") and os.geteuid() == 0
                # Print marks, for a print shop that asks for them: 3 mm bleed.
                marks = bool(msg.get("printMarks"))
                build_pdf(
                    self.deck_path,
                    out,
                    no_sandbox=root,
                    bleed="3mm" if marks else None,
                    crop_marks=marks,
                )
                result = out
        except (RuntimeError, ValueError, OSError) as exc:
            raise EditError(str(exc)) from exc
        token = secrets.token_urlsafe(12)
        self.exports[token] = result
        size = (
            sum(p.stat().st_size for p in result.rglob("*") if p.is_file())
            if result.is_dir()
            else result.stat().st_size
        )
        return {
            "ok": True,
            "path": str(result),
            "rel": self._deck_rel(result)
            if result.is_relative_to(self.project_dir)
            else str(result),
            "download": f"/_export/{token}/{result.name}"
            + (".zip" if result.is_dir() else ""),
            "size": size,
        }

    # ── Uploads ──

    def _upload(self, msg: dict[str, object]) -> dict[str, object]:
        """A whole file in one message (the editor sends chunks: upload-chunk)."""
        try:
            data = base64.b64decode(str(msg.get("data") or ""), validate=True)
        except ValueError as exc:
            raise EditError("upload is not valid base64") from exc
        name = Path(str(msg.get("name") or "upload")).name
        try:
            arrival = self.uploads.chunk(secrets.token_hex(8), name, data, last=True)
        except media.MediaError as exc:
            raise EditError(str(exc)) from exc
        assert arrival is not None
        return self._placed(arrival)


def _on_deck_slide(
    segments: list[Segment], kind: str, msg: dict[str, object]
) -> list[Segment]:
    """deck.py's text limited to one ``Slide(...)`` (``deckSlide``: its deck
    index), for a search of one slide; other files' segments as they are."""
    only = msg.get("deckSlide")
    if kind != "deck" or not isinstance(only, int) or isinstance(only, bool):
        return segments
    return [s for s in segments if s.slide == only]
