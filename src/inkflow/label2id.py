"""Promote each element's ``inkscape:label`` to its SVG ``id``.

Inkscape's Layers & Objects panel only ever edits ``inkscape:label``; the inkflow
pipeline targets elements by ``id``. This bridges the two: name a group "headline"
in the panel, run ``inkflow label2id``, and ``deck.py`` can animate ``#headline``
or Morph can match it across slides.

A label that is already a valid XML id becomes the id verbatim; anything else is
slugified (ASCII, spaces to ``-``, other characters dropped). Labels are not
required to be unique but ids are, so a collision is reported and skipped.

Elements inside injected inkflow preview layers (the layout/overlay chrome added
by ``inkflow sync``) are left untouched — the pipeline regenerates those ids, and
renaming an ancestor's copy here would only make the slide read as stale.

Ids are rewritten by surgical text substitution rather than a full re-serialize,
so Inkscape's per-attribute line formatting survives and the change stays a
handful of lines in ``git diff`` instead of a whole-file reflow.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from lxml import etree

from inkflow import ns
from inkflow.clean import is_preview_layer
from inkflow.svgio import SvgElement, parse_svg

_VALID_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]*$")
_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9_.\-]+")

# The tags Inkscape's Layers & Objects panel actually surfaces. Renaming a <stop>
# or a raw <tspan> id is noise; --all-tags lifts the filter.
_RENAMABLE_TAGS: frozenset[str] = frozenset(
    f"{{{ns.SVG}}}{tag}"
    for tag in (
        "g",
        "rect",
        "circle",
        "ellipse",
        "path",
        "polygon",
        "polyline",
        "line",
        "image",
        "text",
        "use",
        "foreignObject",
    )
)


@dataclass(frozen=True)
class Rename:
    """One element whose ``id`` should become (a slug of) its ``inkscape:label``."""

    element: SvgElement
    old_id: str | None
    new_id: str
    label: str


@dataclass(frozen=True)
class Skip:
    """An element that carried a label but was left alone, with the reason why."""

    tag: str
    label: str
    reason: str


@dataclass
class RenamePlan:
    renames: list[Rename] = field(default_factory=list)
    skips: list[Skip] = field(default_factory=list)


@dataclass
class Label2IdResult:
    """Outcome of `promote_labels_to_ids` for a single SVG document."""

    text: str
    renames: list[Rename] = field(default_factory=list)
    skips: list[Skip] = field(default_factory=list)
    reference_edits: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.renames)


def slugify_label(label: str) -> str:
    """A conservative id derived from a free-form label: ASCII, no spaces."""
    ascii_label = (
        unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode()
    )
    slug = _UNSAFE_ID_CHARS.sub("-", ascii_label).strip("-.")
    if slug[:1].isdigit():
        slug = f"_{slug}"
    return slug


def _preview_descendants(root: SvgElement) -> set[SvgElement]:
    """Every element at or below an injected inkflow layout/overlay layer."""
    blocked: set[SvgElement] = set()
    for element in root.iter():
        if is_preview_layer(element):
            blocked.update(element.iter())
    return blocked


def plan_renames(root: SvgElement, *, all_tags: bool = False) -> RenamePlan:
    """Decide which elements adopt their label as an id, and why the rest don't."""
    blocked = _preview_descendants(root)
    used_ids = {e.get("id") for e in root.iter() if e.get("id") is not None}
    plan = RenamePlan()

    for element in root.iter():
        if element is root or element in blocked:
            continue
        raw_label = element.get(ns.INKSCAPE_LABEL)
        if raw_label is None or not raw_label.strip():
            continue
        if not all_tags and element.tag not in _RENAMABLE_TAGS:
            continue

        label = raw_label.strip()
        tag = etree.QName(element).localname
        current_id = element.get("id")

        candidate = label if _VALID_ID.match(label) else slugify_label(label)
        if not candidate or not _VALID_ID.match(candidate):
            plan.skips.append(Skip(tag, label, "no usable id after slugify"))
            continue
        if candidate == current_id:
            continue
        if candidate in used_ids:
            plan.skips.append(Skip(tag, label, f"id {candidate!r} already in use"))
            continue

        used_ids.discard(current_id)
        used_ids.add(candidate)
        plan.renames.append(Rename(element, current_id, candidate, label))

    return plan


def _apply_renames(
    text: str, renames: list[Rename], *, rewrite_refs: bool
) -> tuple[str, int, list[Skip]]:
    """Rewrite planned ids in ``text`` by substitution; return new text, ref-edit
    count, and any elements that turned out to have no id to rewrite.
    """
    applied = [rename for rename in renames if rename.old_id is not None]
    skips = [
        Skip(
            etree.QName(r.element).localname,
            r.label,
            "element has no id to rewrite — assign one in Inkscape, then rerun",
        )
        for r in renames
        if r.old_id is None
    ]
    if not applied:
        return text, 0, skips

    old_to_new = {rename.old_id: rename.new_id for rename in applied}
    old_alternation = "|".join(re.escape(old) for old in old_to_new if old)

    # Every substitution runs once against the original text, so an a->b, b->c run
    # (or an a<->b swap) cannot cascade.
    id_declaration = re.compile(rf"""(?<![\w:.-])id=(["'])({old_alternation})\1""")
    text, id_hits = id_declaration.subn(
        lambda m: f"id={m.group(1)}{old_to_new[m.group(2)]}{m.group(1)}", text
    )
    if id_hits != len(applied):
        raise RuntimeError(
            f"planned {len(applied)} id rewrites but matched {id_hits} in the file"
        )

    reference_edits = 0
    if rewrite_refs:
        url_reference = re.compile(rf"url\(\s*#({old_alternation})\s*\)")
        text, url_hits = url_reference.subn(
            lambda m: f"url(#{old_to_new[m.group(1)]})", text
        )
        href_reference = re.compile(rf"""(\bhref=(["']))#({old_alternation})\2""")
        text, href_hits = href_reference.subn(
            lambda m: f"{m.group(1)}#{old_to_new[m.group(3)]}{m.group(2)}", text
        )
        reference_edits = url_hits + href_hits

    return text, reference_edits, skips


def promote_labels_to_ids(
    svg_text: str, *, all_tags: bool = False, rewrite_refs: bool = True
) -> Label2IdResult:
    """Promote ``inkscape:label`` to ``id`` throughout an SVG document.

    ``svg_text`` is parsed with the hardened parser to build the plan, then the
    ids are rewritten in the original text so formatting is preserved. The
    returned ``renames`` are only those actually applied (an element with a label
    but no existing id is reported in ``skips`` instead).
    """
    root = parse_svg(svg_text)
    plan = plan_renames(root, all_tags=all_tags)

    if not plan.renames:
        return Label2IdResult(svg_text, skips=plan.skips)

    new_text, reference_edits, extra_skips = _apply_renames(
        svg_text, plan.renames, rewrite_refs=rewrite_refs
    )
    return Label2IdResult(
        text=new_text,
        renames=[r for r in plan.renames if r.old_id is not None],
        skips=[*plan.skips, *extra_skips],
        reference_edits=reference_edits,
    )
