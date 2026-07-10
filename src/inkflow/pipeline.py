from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict, cast

from inkflow import ns
from inkflow.clean import clean_inkscape_tree
from inkflow.content import (
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
)
from inkflow.enums import ColorMode
from inkflow.layout import resolve_chain, resolve_default_zone, resolve_parent_path
from inkflow.loaders import load_md, load_notes, load_style
from inkflow.manifest import (
    Animation,
    Deck,
    Inline,
    Media,
    Slide,
    TextBox,
    Transition,
)
from inkflow.svg import compose_with_ancestors
from inkflow.svgio import SvgElement, serialize_svg
from inkflow.zones import ParsedMarkdown, build_slide_content, parse_markdown_zones

# ── Slide wire format ────────────────────────────────────────────────────────


class SlideData(TypedDict):
    id: str
    svg: str
    title: str
    notes: str


# ── Path conventions ─────────────────────────────────────────────────────────


def _infer_slide_id(slide: Slide) -> str:
    if slide.id:
        return slide.id
    if slide.md is not None and not isinstance(slide.md, Inline):
        return Path(slide.md).stem
    src = Path(slide.src)
    return src.stem if src.suffix else slide.src.replace("/", "-").replace(":", "-")


def _deduplicate_ids(raw_ids: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    result: list[str] = []
    for raw in raw_ids:
        if raw not in seen:
            seen[raw] = 1
            result.append(raw)
        else:
            seen[raw] += 1
            result.append(f"{raw}-{seen[raw]}")
    return result


def _infer_slide_title(
    slide: Slide, slide_id: str, parsed: ParsedMarkdown | None
) -> str:
    if slide.title:
        return slide.title
    if parsed is not None:
        chunks = parsed.zones.get("title", [])
        if chunks and isinstance(chunks[0], str):
            return chunks[0].lstrip("#").strip()
    stem = re.sub(r"^\d+-", "", slide_id)
    return stem.replace("-", " ").replace("_", " ").title()


def resolve_slide_src(src: str, project_dir: Path, theme: str | None = None) -> Path:
    """Resolve a Slide.src string to an absolute Path.

    Single-part names (no directory separator, no scheme prefix) are checked
    against slides/ first: bare names get .svg appended, names that already
    carry an extension are tried as-is. If the slides/ candidate does not
    exist, the 3-level layout search runs (project layouts/ → theme layouts/
    → builtin layouts/). Everything else delegates directly to resolve_parent_path.
    """
    p = Path(src)
    if (
        not p.is_absolute()
        and len(p.parts) == 1
        and not src.startswith(("local:", "theme:", "builtin:", "./", "../"))
    ):
        name = src if p.suffix else src + ".svg"
        slides_candidate = project_dir / "slides" / name
        if slides_candidate.exists():
            return slides_candidate
    return resolve_parent_path(src, project_dir, project_dir, theme)


# ── Animation / transition serialization ──────────────────────────────────────

# Fields that map to a modifier class instead of a CSS custom property, because
# CSS cannot branch on a custom-property *value* (e.g. pick a slide axis).
_ANIM_MODIFIER_FIELDS: frozenset[str] = frozenset({"direction"})

# Per-field unit suffix for the emitted `--anim-<field>` custom properties. The
# single place value formatting lives: times are seconds, distances are user
# units (px == SVG user units here), everything else is emitted raw.
_ANIM_UNIT: dict[str, str] = {"duration": "s", "delay": "s", "distance": "px"}


def _set_fields(obj: object) -> dict[str, object]:
    """Dataclass fields whose value is not None (None means 'defer to the default')."""
    fields = cast("dict[str, object]", vars(obj))
    return {k: v for k, v in fields.items() if v is not None}


def _anim_classes(anim: Animation) -> list[str]:
    """CSS classes for an animation: a name-derived base plus modifier classes."""
    classes = [f"anim-{anim.slug()}"]
    direction = getattr(anim, "direction", None)
    if direction is not None:
        classes.append(f"anim-from-{direction}")
    return classes


def _anim_style(anim: Animation) -> str:
    """Inline `--anim-<field>` custom properties for an animation's set params.

    Generic over fields: anything beyond `element`/`step`/modifier fields that is
    not `None` becomes a custom property. `None` means "let the CSS default win".
    """
    decls: list[str] = []
    for name, value in _set_fields(anim).items():
        if name in ("element", "step") or name in _ANIM_MODIFIER_FIELDS:
            continue
        decls.append(f"--anim-{name}: {value}{_ANIM_UNIT.get(name, '')}")
    return "; ".join(decls)


def annotate_svg(root: SvgElement, animations: list[Animation]) -> SvgElement:
    for anim in animations:
        eid = anim.element.lstrip("#")
        el = root.find(f'.//*[@id="{eid}"]')
        if el is None:
            print(f"[inkflow] warning: element #{eid} not found in SVG")
            continue

        existing_class = el.get("class", "")
        classes = [c for c in [existing_class, *_anim_classes(anim)] if c]
        el.set("class", " ".join(classes))
        el.set("data-step", str(anim.step))

        style = _anim_style(anim)
        if style:
            existing_style = el.get("style", "").strip().rstrip(";")
            el.set("style", f"{existing_style}; {style}" if existing_style else style)

    return root


def _serialize_transition(t: Transition | None) -> dict[str, object]:
    if t is None:
        return {"type": "cut", "duration": 0.0}
    return {"type": t.slug(), **_set_fields(t)}


def resolve_transitions(deck: Deck) -> list[dict[str, object]]:
    return [
        _serialize_transition(
            slide.transition if slide.transition is not None else deck.transition
        )
        for slide in deck.slides
        if slide.visible
    ]


def _scope_slide_styles(root: SvgElement, slide_number: int) -> SvgElement:
    """Assign a unique ID to the SVG root and wrap any inline <style> in @scope.

    SVG style blocks would bleed onto adjacent slides
    during CSS transitions without this guard.
    """
    slide_id = f"inkflow-slide-{slide_number}"
    root.set("id", slide_id)
    for style_el in root.findall(f".//{{{ns.SVG}}}style"):
        css = style_el.text
        if not css or not css.strip():
            continue
        style_el.text = f"@scope(#{slide_id}) {{\n{css}\n}}"
    return root


def _add_layout_classes(root: SvgElement, chain: list[Path], src: Path) -> SvgElement:
    """Add layout-<stem> classes to the SVG root for every entry in [*chain, src].

    This scopes CSS rules in styles.css to a slide type
    (e.g. `.layout-cover #zone-title`)
    """
    existing = [c for c in root.get("class", "").split() if not c.startswith("layout-")]
    new_classes = [f"layout-{p.stem}" for p in [*chain, src]]
    root.set("class", " ".join(existing + new_classes))
    return root


# ── Per-slide pipeline ────────────────────────────────────────────────────────


@dataclass
class SlideSvg:
    """A slide's SVG tree as it moves through the per-slide pipeline.

    Each method mutates the tree in place (like ``list.sort()``) and returns ``None``;
    the DOM work is delegated to the content/svg modules, which take and return the root
    element. This keeps the pipeline a single parse and a single serialize with a
    readable sequence of commands in ``process_slide``.
    """

    root: SvgElement

    @classmethod
    def cleaned(cls, src: Path) -> SlideSvg:
        return cls(clean_inkscape_tree(src))

    def compose_ancestors(self, chain: list[Path]) -> None:
        if chain:
            self.root = compose_with_ancestors(self.root, chain)

    def tag_layout(self, chain: list[Path], src: Path) -> None:
        self.root = _add_layout_classes(self.root, chain, src)

    def number_slides(self, slide_number: int, total: int) -> None:
        self.root = substitute_zone_numbers(self.root, slide_number, total)

    def zone_ids(self) -> set[str]:
        return {
            eid
            for el in self.root.iter()
            if (eid := el.get("id")) is not None and eid.startswith("zone-")
        }

    def inject_content(
        self, content: dict[str, TextBox | Media], font_size: int, dark_mode: bool
    ) -> None:
        self.root = substitute_content(self.root, content, font_size, dark_mode)

    def annotate(self, animations: list[Animation]) -> None:
        self.root = annotate_svg(self.root, animations)

    def add_style(self, css: str) -> None:
        self.root = inject_style(self.root, css)

    def prune_zones(self) -> None:
        self.root = remove_unreferenced_zones(self.root)

    def scope_styles(self, slide_number: int) -> None:
        self.root = _scope_slide_styles(self.root, slide_number)

    def to_svg(self) -> str:
        return serialize_svg(self.root)


@dataclass(frozen=True)
class DeckContext:
    """Loop-invariant deck params, built once per rebuild and shared by every slide."""

    project_dir: Path
    theme: str | None
    deck_style: str
    font_size: int  # deck default; a slide may override via Slide.font_size
    mode: ColorMode
    total_slides: int


def process_slide(
    slide: Slide,
    ctx: DeckContext,
    slide_number: int,
    parsed: ParsedMarkdown | None,
) -> tuple[str, str]:
    """Return the processed SVG string and the slide's markdown-derived notes."""
    src = resolve_slide_src(slide.src, ctx.project_dir, ctx.theme)
    chain = resolve_chain(src, ctx.project_dir, ctx.theme)

    doc = SlideSvg.cleaned(src)
    doc.compose_ancestors(chain)
    doc.tag_layout(chain, src)
    doc.number_slides(slide_number, ctx.total_slides)

    md_notes = ""
    if parsed is not None or slide.zones:
        zone_ids = doc.zone_ids()
        default_zone = resolve_default_zone(doc.root, zone_ids)
        result = build_slide_content(
            parsed,
            slide.zones,
            available_zones=zone_ids,
            default_zone=default_zone,
        )
        md_notes = result.notes
        if result.content:
            font_size = (
                slide.font_size if slide.font_size is not None else ctx.font_size
            )
            doc.inject_content(result.content, font_size, ctx.mode == ColorMode.DARK)

    if slide.animations:
        doc.annotate(slide.animations)

    slide_style_css = load_style(slide.extra_style, ctx.project_dir)
    combined_css = "\n".join(filter(None, [ctx.deck_style, slide_style_css]))
    if combined_css:
        doc.add_style(combined_css)

    doc.prune_zones()
    doc.scope_styles(slide_number)
    return doc.to_svg(), md_notes


def process_deck(deck: Deck, project_dir: Path) -> list[SlideData]:
    visible_slides = [s for s in deck.slides if s.visible]
    ctx = DeckContext(
        project_dir=project_dir,
        theme=deck.theme,
        deck_style=load_style(deck.style, project_dir),
        font_size=deck.font_size,
        mode=deck.mode,
        total_slides=len(visible_slides),
    )
    raw_ids = [_infer_slide_id(s) for s in visible_slides]
    slide_ids = _deduplicate_ids(raw_ids)
    results: list[SlideData] = []
    for i, (slide, slide_id) in enumerate(zip(visible_slides, slide_ids, strict=True)):
        md_text = load_md(slide.md, project_dir) if slide.md is not None else None
        parsed = parse_markdown_zones(md_text) if md_text is not None else None
        title = _infer_slide_title(slide, slide_id, parsed)
        explicit_notes = load_notes(slide.notes, project_dir)
        svg, md_notes = process_slide(slide, ctx, i + 1, parsed)
        notes = "\n".join(filter(None, [explicit_notes, md_notes]))
        results.append({"id": slide_id, "svg": svg, "title": title, "notes": notes})
    return results
