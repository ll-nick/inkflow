"""What an op wants written, and the one place that writes it."""

from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from inkflow.svgio import SvgElement, serialize_svg_for, svg_matches_file

__all__ = ["ChangeSet", "ConflictError", "FileEdit", "OpError", "file_hash"]


class OpError(Exception):
    """An op cannot run as requested; the message is meant for the user."""


class ConflictError(OpError):
    """A file changed between computing a change set and applying it."""

    def __init__(self, paths: list[Path]) -> None:
        self.paths: list[Path] = paths
        listed = ", ".join(str(path) for path in paths)
        super().__init__(f"changed on disk since the edit was planned: {listed}")


def file_hash(path: Path) -> str | None:
    """SHA-256 of the file's bytes, or None when it does not exist."""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


@dataclass(frozen=True)
class FileEdit:
    """Replace ``path`` with ``new_content`` if it still hashes to ``before_hash``.

    ``before_hash`` is None for a file that must not exist yet.
    """

    path: Path
    before_hash: str | None
    new_content: str
    detail: str = ""
    """What changes in this file, for ops that touch several (empty: say nothing)."""

    @property
    def after_hash(self) -> str:
        return hashlib.sha256(self.new_content.encode()).hexdigest()


@dataclass(frozen=True)
class ChangeSet:
    """Every file an op would write, plus a one-line description of the change.

    Computing one touches nothing on disk, which is what makes a dry run exact:
    `apply` writes precisely what was previewed, or nothing.
    """

    summary: str
    edits: tuple[FileEdit, ...] = ()

    @classmethod
    def from_contents(
        cls,
        summary: str,
        contents: Mapping[Path, str],
        details: Mapping[Path, str] | None = None,
    ) -> ChangeSet:
        """Pin each file's current hash, dropping files whose content would not change.

        Dropping them keeps a no-op from rewriting files (and from bumping their
        mtime, which a running server would rebuild on).
        """
        details = details or {}
        edits: list[FileEdit] = []
        for path, content in contents.items():
            before = file_hash(path)
            edit = FileEdit(path, before, content, details.get(path, ""))
            if before != edit.after_hash:
                edits.append(edit)
        return cls(summary, tuple(edits))

    @classmethod
    def from_svgs(
        cls,
        summary: str,
        documents: Mapping[Path, SvgElement],
        details: Mapping[Path, str] | None = None,
    ) -> ChangeSet:
        """Like `from_contents` for SVG trees, dropping each one already on disk.

        Whether a file changes is decided on the document, not on its serialized
        text (see ``svg_matches_file``), so a no-op never reformats a file.
        """
        changed = {
            path: serialize_svg_for(root, path)
            for path, root in documents.items()
            if not svg_matches_file(root, path)
        }
        return cls.from_contents(summary, changed, details)

    @property
    def changed(self) -> bool:
        return bool(self.edits)

    def apply(self) -> None:
        """Write every edit, or none if any file changed since it was planned.

        All new contents are staged next to their targets before any target is
        replaced, so a failure while writing leaves every file untouched. Each
        replacement is an atomic rename.
        """
        conflicts = [
            edit.path for edit in self.edits if file_hash(edit.path) != edit.before_hash
        ]
        if conflicts:
            raise ConflictError(conflicts)

        staged: list[tuple[Path, Path]] = []
        try:
            for edit in self.edits:
                staged.append((_stage(edit), edit.path))
        except BaseException:
            for temporary, _ in staged:
                temporary.unlink(missing_ok=True)
            raise
        for temporary, target in staged:
            os.replace(temporary, target)


def _stage(edit: FileEdit) -> Path:
    """Write the new content to a sibling file that keeps the target's permissions."""
    edit.path.parent.mkdir(parents=True, exist_ok=True)
    temporary = edit.path.with_name(f".{edit.path.name}.{uuid.uuid4().hex}.tmp")
    # Exact bytes, so `after_hash` is what lands on disk on every platform.
    try:
        with temporary.open("x", encoding="utf-8", newline="") as stream:
            stream.write(edit.new_content)
        if edit.path.exists():
            shutil.copymode(edit.path, temporary)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return temporary
