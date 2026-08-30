"""Where an asset reference resolves, and what it looks like in the output.

A reference is written relative to **the file it appears in**: an ``<image>`` href
relative to its SVG, a Markdown ``![](…)`` relative to its ``.md``, an ``Image``/
``Video`` src relative to ``deck.py``. That is what every editor assumes and the
only rule an author can hold in their head.

The pipeline canonicalises each reference exactly once, while the file it was
written in is still known, into a path relative to the presentation root. That
canonical form is what ``serve`` answers over HTTP and what ``build``/``export``
copy assets to, so the two cannot disagree about what a reference means.

An asset must live under an allowed root: the project directory, or the active
theme's asset directory, so a theme can ship its own branding. Anything else is
unreachable. Symlink the directory into the project to bring it back inside;
the containment check collapses ``..`` without resolving symlinks precisely
so that works.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from inkflow import ns
from inkflow.clean import clean_inkscape_tree
from inkflow.logging import logger
from inkflow.svgio import SvgElement

THEME_PREFIX = "_theme/"
"""Canonical-ref namespace for assets that live in the theme rather than the project."""

# HTML <img>/<video> (markdown- and Media-injected) and SVG <image>. Both the
# scan in export.py and the rewrite below go through these, so a new reference
# kind is added in exactly one place.
_HTML_SRC_RE = re.compile(r'<(?:img|video)\b[^>]*?\bsrc="([^"]*)"', re.IGNORECASE)
_HTML_POSTER_RE = re.compile(r'<video\b[^>]*?\bposter="([^"]*)"', re.IGNORECASE)
_SVG_HREF_RE = re.compile(r'<image\b[^>]*?\b(?:xlink:)?href="([^"]*)"', re.IGNORECASE)

REFERENCE_PATTERNS = (_HTML_SRC_RE, _HTML_POSTER_RE, _SVG_HREF_RE)

_HTML_REF_TAGS = (f"{{{ns.XHTML}}}img", f"{{{ns.XHTML}}}video")
_SVG_HREF_ATTRIBUTES = ("href", f"{{{ns.XLINK}}}href")

MIME_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "video/ogg",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}
"""Media type per asset suffix: what ``serve`` sends on the wire and what an
inlining ``build`` stamps into its data URIs, so the two describe a file alike."""


def is_local_ref(ref: str) -> bool:
    """Whether a reference names a file to copy rather than a remote or inline URI."""
    return bool(ref) and not ref.startswith(("http://", "https://", "//", "data:"))


def rewrite_references(text: str, resolve: Callable[[str], str | None]) -> str:
    """Replace asset references in a produced SVG or notes fragment.

    ``resolve`` maps one reference to what should stand in its place, or to
    ``None`` to leave it as written. Goes through `REFERENCE_PATTERNS`, so a new
    reference kind reaches this rewrite and the scan in export.py together.
    """

    def substitute(match: re.Match[str]) -> str:
        ref = match.group(1)
        replacement = resolve(ref)
        if replacement is None:
            return match.group(0)
        return match.group(0).replace(f'"{ref}"', f'"{replacement}"')

    for pattern in REFERENCE_PATTERNS:
        text = pattern.sub(substitute, text)
    return text


def _absolute(path: Path) -> Path:
    """Absolute and ``..``-free, without resolving symlinks."""
    return Path(os.path.abspath(path))


@dataclass(frozen=True)
class AssetRoots:
    """The directories an asset may live under, each mapped to a canonical prefix."""

    project_dir: Path
    theme_dir: Path | None = None

    def canonicalize(self, absolute: Path) -> str | None:
        """Canonical ref for an absolute path, or ``None`` if it escapes every root.

        The project is checked first, so a theme that lives *inside* the project
        stays part of the project tree the build mirrors rather than picking up a
        namespace of its own.
        """
        project = _absolute(self.project_dir)
        if absolute.is_relative_to(project):
            return absolute.relative_to(project).as_posix()
        if self.theme_dir is not None:
            theme = _absolute(self.theme_dir)
            if absolute.is_relative_to(theme):
                return THEME_PREFIX + absolute.relative_to(theme).as_posix()
        return None

    def locate(self, ref: str) -> Path | None:
        """Source file for a canonical ref, or ``None`` if it names nothing legal.

        The inverse of `canonicalize`, and the single answer to "what file does
        this reference mean" for both the HTTP server and the copy step.

        The theme is checked first because the project's prefix is empty and so
        matches everything. That reserves ``_theme/`` at the project root: a
        project file there is shadowed by the theme while one is active.
        """
        if self.theme_dir is not None and ref.startswith(THEME_PREFIX):
            root, rest = _absolute(self.theme_dir), ref[len(THEME_PREFIX) :]
        else:
            root, rest = _absolute(self.project_dir), ref
        candidate = _absolute(root / rest)
        return candidate if candidate.is_relative_to(root) else None


@dataclass(frozen=True)
class AssetSource:
    """Resolves the references written in one file."""

    roots: AssetRoots
    base_dir: Path
    label: str

    @classmethod
    def for_file(cls, roots: AssetRoots, path: Path) -> AssetSource:
        return cls(roots, path.parent, _label(path, roots.project_dir))

    @classmethod
    def for_deck(cls, roots: AssetRoots) -> AssetSource:
        """References written in ``deck.py`` itself, including ``Inline`` content."""
        return cls(roots, roots.project_dir, "deck.py")

    def ref(self, ref: str) -> str:
        if not is_local_ref(ref):
            return ref
        canonical = self.roots.canonicalize(_absolute(self.base_dir / ref))
        if canonical is None:
            logger.warning(
                f"{self.label}: asset lives outside the project and cannot be served "
                + f"or exported, symlink it in to use it: {ref}"
            )
            return ref
        return canonical

    def html(self, html: str) -> str:
        """Canonicalise every ``<img>``/``<video>`` reference in an HTML fragment."""

        def replace(match: re.Match[str]) -> str:
            return match.group(0).replace(
                f'"{match.group(1)}"', f'"{self.ref(match.group(1))}"'
            )

        for pattern in (_HTML_SRC_RE, _HTML_POSTER_RE):
            html = pattern.sub(replace, html)
        return html

    def svg(self, root: SvgElement) -> SvgElement:
        """Canonicalise every ``<image>``/``<img>``/``<video>`` reference in a tree."""
        for el in root.iter(f"{{{ns.SVG}}}image", *_HTML_REF_TAGS):
            attributes = (
                _SVG_HREF_ATTRIBUTES if el.tag.endswith("}image") else ("src", "poster")
            )
            for attribute in attributes:
                value = el.get(attribute)
                if value is not None:
                    el.set(attribute, self.ref(value))
        return root


def _label(path: Path, project_dir: Path) -> str:
    absolute = _absolute(path)
    root = _absolute(project_dir)
    if absolute.is_relative_to(root):
        return absolute.relative_to(root).as_posix()
    return str(path)


def read_resolved_svg(path: Path, roots: AssetRoots) -> SvgElement:
    """Parse an SVG and canonicalise its references against its own directory.

    Every SVG the presentation pipeline composes is read through this, because
    composition merges files into a tree that no longer remembers where each part
    came from. Authoring paths (preview injection, `verify`) read the file plainly
    with `clean_inkscape_tree` instead, so the author's own paths survive.
    """
    return AssetSource.for_file(roots, path).svg(clean_inkscape_tree(path))
