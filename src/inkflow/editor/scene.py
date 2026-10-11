"""A slide as the visual editor sees it, and its connector logic, in Python.

``Scene.compose`` builds the tree the editor's canvas renders, the same way the
pipeline does: the slide's own SVG (from bytes not yet written, during a
request), its layout chain behind it, its overlays and saved ink above, and
draw.io diagrams drawn in, every element stamped with its ``data-ink``
locator. On it, ``Scene`` ports what ``src/ts/editor/canvas.ts`` does with
connectors: an object's corners and connection sites, the route of an attached
arrow, whether an arrow still meets its shapes (``is_stale``), re-routing the
arrows attached to shapes that move (``with_connectors``) and a move as the
attribute changes the editor writes (``move_ops``). Boxes come from
``bbox.Geometry`` (``getBBox``/``getScreenCTM`` without a browser); routes and
plans from ``routing`` and ``geometry``, the ports of connectors.ts and geom.ts.

Two things the editor's canvas has that a source composition does not: zone
content (a filled zone is a ``<foreignObject>`` with the zone shape's box,
which ``Geometry`` uses directly) and empty zones being pruned (here they stay;
an arrow attached to one routes to its box, where the editor leaves the end
where it was drawn).
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from inkflow import ns
from inkflow.assets import AssetRoots, AssetSource, read_resolved_svg
from inkflow.backgrounds import picture_backgrounds
from inkflow.clean import clean_inkscape_root
from inkflow.drawio_inline import inline_diagrams
from inkflow.editor.bbox import Geometry, local
from inkflow.editor.geometry import (
    IDENTITY,
    AttrPlan,
    Box,
    ElementGeom,
    Mat,
    apply,
    invert,
    multiply,
    parse_transform,
    plan_move,
    transform_box,
)
from inkflow.editor.provenance import INK, INK_LAYER, INK_LOCKED, INK_TAG, is_element
from inkflow.editor.routing import (
    Bend,
    End,
    Pt,
    Route,
    Site,
    endpoints_of,
    format_bend,
    js_number,
    parse_bend,
    parse_connection,
    path_data,
    per_side,
    route,
    site_by_name,
    sites_from_corners,
)
from inkflow.ink import compose_ink, ink_path
from inkflow.layout import resolve_chain
from inkflow.manifest import Deck, Slide
from inkflow.pipeline import SourceTable, resolve_overlay_chains, resolve_slide_src
from inkflow.svg import compose_overlays, compose_with_ancestors
from inkflow.svgio import SvgElement, parse_svg

CONNECTOR = f"{{{ns.INKFLOW}}}connector"
CONNECT = {
    "start": f"{{{ns.INKFLOW}}}connect-start",
    "end": f"{{{ns.INKFLOW}}}connect-end",
}
BEND = f"{{{ns.INKFLOW}}}bend"
SITES = ns.INKFLOW_SITES
NON_ZONES = frozenset({"zone-slide-number", "zone-slide-total"})

GEOM_ATTRS = (
    "x",
    "y",
    "width",
    "height",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x1",
    "y1",
    "x2",
    "y2",
    "transform",
    "viewBox",
    # A connector's route and its attachments.
    "d",
    "inkflow:connect-start",
    "inkflow:connect-end",
    "inkflow:bend",
)
_GEOMETRY = frozenset({*GEOM_ATTRS, "points"})


def attr_name(name: str) -> str:
    """``inkflow:bend`` → its lxml name; other names unchanged."""
    if name.startswith("inkflow:"):
        return f"{{{ns.INKFLOW}}}{name.removeprefix('inkflow:')}"
    if name == "xlink:href":
        return f"{{{ns.XLINK}}}href"
    return name


def get_attr(el: SvgElement, name: str) -> str | None:
    return el.get(attr_name(name))


def set_plan(el: SvgElement, plan: AttrPlan) -> None:
    """``applyPlanToDom``: set (or, for None, remove) attributes."""
    for name, value in plan.items():
        key = attr_name(name)
        if value is None:
            if key in el.attrib:
                del el.attrib[key]
        else:
            el.set(key, value)


def own_file(slide: Slide, deck: Deck, project_dir: Path) -> Path | None:
    """The slide's own drawing (``EditorSession._is_own``): its SVG when no
    other slide shows it and it is not a layout; None for a slide drawn
    straight from a shared layout."""
    try:
        path = resolve_slide_src(slide.src, project_dir, deck.theme).resolve()
    except ValueError:
        return None
    if "layouts" in path.parts or not path.is_relative_to(project_dir.resolve()):
        return None
    users = 0
    for s in deck.slides:
        try:
            if resolve_slide_src(s.src, project_dir, deck.theme).resolve() == path:
                users += 1
        except ValueError:
            continue
    return path if users == 1 else None


@dataclass
class Op:
    """One svgops operation on an element of the slide's own file."""

    el: SvgElement
    ops: list[dict[str, object]]


class Scene:
    root: SvgElement
    sources: list[Path]
    writable: bool
    """Whether the slide's own file (source 0) is the slide's alone."""
    geometry: Geometry
    moving_together: list[SvgElement]

    def __init__(self, root: SvgElement, sources: list[Path], writable: bool) -> None:
        self.root = root
        self.sources = sources
        self.writable = writable
        self.geometry = Geometry(root, self.by_id)
        self.moving_together = []

    @classmethod
    def compose(
        cls,
        project_dir: Path,
        deck: Deck,
        slide: Slide,
        slide_id: str,
        own: bytes | None = None,
    ) -> Scene:
        """The slide composed as the editor renders it; ``own`` stands in for
        the slide's SVG on disk (a request's staged bytes)."""
        theme = deck.theme
        src = resolve_slide_src(slide.src, project_dir, theme)
        roots = AssetRoots(project_dir, theme.asset_dir())
        table = SourceTable()
        stamp = table.stamp(src)
        if own is None:
            root = read_resolved_svg(src, roots, stamp)
        else:
            root = parse_svg(own)
            stamp(root)
            root = AssetSource.for_file(roots, src).svg(clean_inkscape_root(root))
        chain = resolve_chain(src, project_dir, theme)
        if chain:
            root = compose_with_ancestors(
                root, [read_resolved_svg(p, roots, table.stamp(p)) for p in chain]
            )
        overlays = (
            slide.overlays if slide.overlays is not None else deck.effective_overlays
        )
        chains = resolve_overlay_chains(overlays, project_dir, theme)
        if chains:
            root = compose_overlays(
                root,
                [
                    [read_resolved_svg(p, roots, table.stamp(p)) for p in c]
                    for c in chains
                ],
            )
        ink = ink_path(slide, slide_id, project_dir)
        if ink.is_file():
            with contextlib.suppress(ValueError):  # a broken ink file: no ink
                root = compose_ink(
                    root, read_resolved_svg(ink, roots, table.stamp(ink))
                )
        root = inline_diagrams(root, roots, table.key)
        root = picture_backgrounds(root)
        writable = own_file(slide, deck, project_dir) is not None
        return cls(root, table.paths, writable)

    # ── Lookups ──

    def by_id(self, element_id: str) -> SvgElement | None:
        """The first element with this id, in document order (querySelector)."""
        for el in self.root.iter():
            if is_element(el) and el.get("id") == element_id:
                return el
        return None

    @staticmethod
    def loc(el: SvgElement) -> str | None:
        return el.get(INK)

    def key(self, el: SvgElement) -> int | None:
        loc = el.get(INK) or ""
        head = loc.partition(":")[0]
        return int(head) if head.isdigit() else None

    def source(self, el: SvgElement) -> Path | None:
        key = self.key(el)
        return (
            self.sources[key] if key is not None and key < len(self.sources) else None
        )

    def is_own(self, el: SvgElement) -> bool:
        """In the slide's own drawing, which this slide may change
        (``canTransform`` outside "Edit layout")."""
        return self.writable and self.key(el) == 0 and not self.locator_is_cell(el)

    @staticmethod
    def locator_is_cell(el: SvgElement) -> bool:
        return "#" in (el.get(INK) or "")

    def own_ids(self) -> set[str]:
        return {
            i
            for el in self.root.iter()
            if is_element(el) and self.key(el) == 0 and (i := el.get("id"))
        }

    def all_ids(self) -> set[str]:
        return {i for el in self.root.iter() if is_element(el) and (i := el.get("id"))}

    @staticmethod
    def is_zone(el: SvgElement) -> bool:
        element_id = el.get("id") or ""
        return element_id.startswith("zone-") and element_id not in NON_ZONES

    def insert_parent(self) -> SvgElement | None:
        """Where new objects go: the topmost unlocked layer of the slide's own
        file, else its root (None)."""
        layers = [
            el
            for el in self.root.iter()
            if is_element(el)
            and el.get(INK_LAYER) is not None
            and self.key(el) == 0
            and el.get(INK_LOCKED) is None
        ]
        return layers[-1] if layers else None

    def insert_loc(self, parent: SvgElement | None) -> str:
        return (parent.get(INK) or "0:") if parent is not None else "0:"

    def to_parent(self, parent: SvgElement | None, p: Pt) -> Pt:
        """Slide units → the insertion parent's user space."""
        if parent is None:
            return p
        return apply(invert(self.geometry.content_ctm(parent)), p)

    # ── Boxes, corners and sites ──

    def slide_box(self, el: SvgElement) -> Box | None:
        if not self.geometry.rendered(el):
            return None
        return self.geometry.slide_box(el)

    def size(self) -> Box:
        return Box(0, 0, self.geometry.width, self.geometry.height)

    @staticmethod
    def is_connector(el: SvgElement) -> bool:
        return el.get(CONNECTOR) is not None

    @staticmethod
    def connector_style(el: SvgElement) -> str:
        value = el.get(CONNECTOR)
        return value if value in ("elbow", "curved") else "straight"

    @staticmethod
    def sites_per_side(el: SvgElement) -> int:
        n = js_number(el.get(SITES) or "1")
        return per_side(n) if n == n and abs(n) != float("inf") else 1

    def attachable_cell(self, el: SvgElement) -> SvgElement | None:
        """A shape of a drawn-in draw.io diagram, if ``el`` is (in) one."""
        node: SvgElement | None = el
        cell: SvgElement | None = None
        while node is not None:
            if (
                cell is None
                and local(node) == "g"
                and node.get("data-cell-kind") == "vertex"
                and node.get("id")
            ):
                cell = node
            if cell is not None and local(node) == "svg" and node.get("data-drawio"):
                return cell
            node = node.getparent()
        return None

    def is_diagram_cell(self, el: SvgElement) -> bool:
        if local(el) != "g" or el.get("data-cell-kind") != "vertex":
            return False
        if el.get(INK) is None:
            return False
        node = el.getparent()
        while node is not None:
            if local(node) == "svg" and node.get("data-drawio"):
                return True
            node = node.getparent()
        return False

    @staticmethod
    def cell_shape(cell: SvgElement) -> SvgElement:
        """What a cell's connection points sit on: its shape, not its label."""
        for kid in cell:
            if not is_element(kid):
                continue
            if kid.get("data-cell-id") is not None:
                continue
            if any(
                local(d) in ("foreignObject", "text", "switch")
                for d in kid.iterdescendants()
                if is_element(d)
            ):
                continue
            return kid
        return cell

    def measure(self, el: SvgElement) -> tuple[Box, Mat] | None:
        """``measure`` in canvas.ts: a box and the matrix to slide units."""
        g = self.geometry
        if not g.rendered(el):
            return None
        if self.is_diagram_cell(el):
            shape = self.cell_shape(el)
            if shape is not el:
                inner = g.bbox(shape)
                if inner is None:
                    return None
                m = multiply(invert(g.ctm(el)), g.ctm(shape))
                return transform_box(m, inner), g.ctm(el)
        if g.is_nested_svg(el):
            parent = el.getparent()
            return g.viewport(el), (
                g.content_ctm(parent) if parent is not None else IDENTITY
            )
        box = g.bbox(el)
        if box is None:
            return None
        return box, g.ctm(el)

    def corners_of(self, el: SvgElement) -> tuple[list[Pt], bool] | None:
        target = self.cell_shape(el) if self.attachable_cell(el) is not None else el
        m = self.measure(target)
        if m is None:
            return None
        box, ctm = m
        if box.width <= 0 and box.height <= 0:
            return None
        to_slide = ctm
        tag = el.get(INK_TAG) or local(el)
        corners = [
            apply(to_slide, p)
            for p in (
                Pt(box.x, box.y),
                Pt(box.x + box.width, box.y),
                Pt(box.x + box.width, box.y + box.height),
                Pt(box.x, box.y + box.height),
            )
        ]
        return corners, tag in ("ellipse", "circle")

    def sites_of(self, el: SvgElement) -> list[Site] | None:
        c = self.corners_of(el)
        return sites_from_corners(c[0], self.sites_per_side(el), c[1]) if c else None

    def site_of(self, el: SvgElement, name: str) -> Site | None:
        c = self.corners_of(el)
        return site_by_name(c[0], name, c[1]) if c else None

    # ── Connectors ──

    def connector_end(self, conn: SvgElement, which: str) -> End | None:
        c = parse_connection(conn.get(CONNECT[which]))
        if c is not None:
            target = self.by_id(c.id)
            site = self.site_of(target, c.site) if target is not None else None
            if site is not None:
                return site.end()
        pts = endpoints_of(conn.get("d") or "")
        if pts is None:
            return None
        p = apply(self.geometry.ctm(conn), pts[0] if which == "start" else pts[1])
        return End(p.x, p.y)

    def is_stale(self, conn: SvgElement) -> bool:
        """Whether an attached connector's drawn ends no longer meet its shapes."""
        pts = endpoints_of(conn.get("d") or "")
        if pts is None:
            return False
        m = self.geometry.ctm(conn)
        for which in ("start", "end"):
            c = parse_connection(conn.get(CONNECT[which]))
            target = self.by_id(c.id) if c is not None else None
            if c is None or target is None or local(target) == "text":
                continue  # a text's box is a browser's to measure
            site = self.site_of(target, c.site)
            if site is None:
                continue
            drawn = apply(m, pts[0] if which == "start" else pts[1])
            if ((drawn.x - site.x) ** 2 + (drawn.y - site.y) ** 2) ** 0.5 > 1:
                return True
        return False

    def stale_ends(self, conn: SvgElement) -> list[str]:
        """The shapes a connector's ends no longer meet."""
        out: list[str] = []
        pts = endpoints_of(conn.get("d") or "")
        if pts is None:
            return out
        m = self.geometry.ctm(conn)
        for which in ("start", "end"):
            c = parse_connection(conn.get(CONNECT[which]))
            target = self.by_id(c.id) if c is not None else None
            if c is None or target is None or local(target) == "text":
                continue
            site = self.site_of(target, c.site)
            if site is None:
                continue
            drawn = apply(m, pts[0] if which == "start" else pts[1])
            if ((drawn.x - site.x) ** 2 + (drawn.y - site.y) ** 2) ** 0.5 > 1:
                out.append(c.id)
        return out

    def ends_on_text(self, conn: SvgElement) -> bool:
        for which in ("start", "end"):
            c = parse_connection(conn.get(CONNECT[which]))
            target = self.by_id(c.id) if c is not None else None
            if target is not None and local(target) == "text":
                return True
        return False

    def connectors(self) -> list[SvgElement]:
        return [
            el
            for el in self.root.iter()
            if is_element(el) and el.get(CONNECTOR) is not None and el.get(INK)
        ]

    def attached(self) -> list[SvgElement]:
        """The slide's own connectors attached at either end (the editor's
        "Re-route all")."""
        return [
            el
            for el in self.connectors()
            if self.is_own(el)
            and (
                el.get(CONNECT["start"]) is not None
                or el.get(CONNECT["end"]) is not None
            )
        ]

    def connectors_to(self, element_id: str) -> list[SvgElement]:
        """The slide's connectors attached to ``element_id`` or, for a diagram,
        its shapes."""
        out: list[SvgElement] = []
        for conn in self.connectors():
            if not self.is_own(conn):
                continue
            for which in ("start", "end"):
                c = parse_connection(conn.get(CONNECT[which]))
                if c is not None and (
                    c.id == element_id or c.id.startswith(f"{element_id}-")
                ):
                    out.append(conn)
                    break
        return out

    def connector_route(
        self,
        conn: SvgElement,
        start: End | None = None,
        end: End | None = None,
        style: str | None = None,
        bend: Bend | bool | None = True,
    ) -> Route | None:
        a = start if start is not None else self.connector_end(conn, "start")
        b = end if end is not None else self.connector_end(conn, "end")
        if a is None or b is None:
            return None
        if bend is True:
            bend = parse_bend(conn.get(BEND))
        return route(
            style or self.connector_style(conn),
            a,
            b,
            bend if isinstance(bend, Bend) else None,
        )

    def connector_path(
        self,
        conn: SvgElement,
        start: End | None = None,
        end: End | None = None,
        style: str | None = None,
        bend: Bend | bool | None = True,
    ) -> str | None:
        """The path data for a connector in its own user space."""
        r = self.connector_route(conn, start, end, style, bend)
        if r is None:
            return None
        local_m = invert(self.geometry.ctm(conn))
        return path_data(
            Route([apply(local_m, p) for p in r.points], r.curve, r.bend, r.mid)
        )

    def new_connector_path(
        self,
        style: str,
        a: End,
        b: End,
        parent: SvgElement | None,
        bend: Bend | None = None,
    ) -> str:
        """Route a new connector between slide-unit ends into ``parent``'s space."""
        m = (
            invert(self.geometry.content_ctm(parent))
            if parent is not None
            else IDENTITY
        )
        r = route(style, a, b, bend)
        return path_data(Route([apply(m, p) for p in r.points], r.curve, r.bend, r.mid))

    @staticmethod
    def geometry_changed(ops: list[dict[str, object]]) -> bool:
        return any(
            op.get("kind") == "attrs"
            and any(
                k in _GEOMETRY for k in cast("dict[str, object]", op.get("set") or {})
            )
            for op in ops
        )

    def with_connectors(self, plans: list[Op]) -> list[Op]:
        """``withConnectors``: add, to plans that move or reshape objects, the
        re-routing of every connector attached to them."""
        moved = [p.el for p in plans if self.geometry_changed(p.ops)]
        if not moved:
            return plans
        for p in plans:
            for op in p.ops:
                if op.get("kind") == "attrs" and op.get("loc") == self.loc(p.el):
                    set_plan(p.el, cast("AttrPlan", op.get("set") or {}))

        def inside(m: SvgElement, target: SvgElement) -> bool:
            return any(node is target for node in m.iter())

        def touches(conn: SvgElement) -> bool:
            for which in ("start", "end"):
                c = parse_connection(conn.get(CONNECT[which]))
                target = self.by_id(c.id) if c is not None else None
                if target is not None and any(inside(m, target) for m in moved):
                    return True
            return False

        out = list(plans)
        for conn in self.connectors():
            if not self.is_own(conn) or not touches(conn):
                continue
            if self.ends_on_text(conn):
                continue  # left where it is: a text's box is a browser's to measure
            d = self.connector_path(conn)
            if d is None:
                continue
            set_plan(conn, {"d": d})
            op: dict[str, object] = {
                "kind": "attrs",
                "loc": self.loc(conn),
                "set": {"d": d},
            }
            existing = next((p for p in out if p.el is conn), None)
            if existing is not None:
                existing.ops = [*existing.ops, op]
            else:
                out.append(Op(conn, [op]))
        return out

    def _moving(self, target: SvgElement) -> bool:
        return any(
            any(node is target for node in m.iter()) for m in self.moving_together
        )

    def connector_move_ops(
        self, conn: SvgElement, dx: float, dy: float
    ) -> list[dict[str, object]]:
        """A connector dragged by (dx, dy): an end stays attached only when the
        shape at it moves along (``moving_together``)."""
        plan: AttrPlan = {}
        start: End | None = None
        end: End | None = None
        for which in ("start", "end"):
            c = parse_connection(conn.get(CONNECT[which]))
            target = self.by_id(c.id) if c is not None else None
            kept = target is not None and self._moving(target)
            here = self.connector_end(conn, which)
            if not kept:
                if c is not None:
                    plan[f"inkflow:connect-{which}"] = None  # dragged away: detach
                if here is not None:
                    moved = End(here.x + dx, here.y + dy)
                    if which == "start":
                        start = moved
                    else:
                        end = moved
        for name, value in plan.items():
            if value is None:
                set_plan(conn, {name: None})
        bend = parse_bend(conn.get(BEND))
        if bend is not None:
            bend = Bend(bend.axis, bend.at + (dx if bend.axis == "x" else dy))
            plan["inkflow:bend"] = format_bend(bend)
        d = self.connector_path(conn, start, end, self.connector_style(conn), bend)
        if d is not None:
            plan["d"] = d
        set_plan(conn, {"d": plan.get("d")})
        return [{"kind": "attrs", "loc": self.loc(conn), "set": plan}]

    def element_geom(self, el: SvgElement) -> ElementGeom:
        g = self.geometry
        m = self.measure(el)
        return ElementGeom(
            tag=local(el),
            source_tag=el.get(INK_TAG) or local(el),
            attrs={name: get_attr(el, name) for name in GEOM_ATTRS},
            own=parse_transform(el.get("transform")),
            parent_to_slide=g.parent_ctm(el),
            local_box=m[0] if m is not None else Box(0, 0, 0, 0),
        )

    @staticmethod
    def text_children(el: SvgElement) -> list[SvgElement]:
        return [
            t
            for t in el.iter(f"{{{ns.SVG}}}tspan")
            if t.get("x") is not None or t.get("y") is not None
        ]

    def move_ops(self, el: SvgElement, dx: float, dy: float) -> list[dict[str, object]]:
        """A move as attribute ops for one element (and its positioned tspans)."""
        if self.is_connector(el) and el.get("d"):
            return self.connector_move_ops(el, dx, dy)
        kids = self.text_children(el)
        plan = plan_move(
            self.element_geom(el),
            dx,
            dy,
            [{"x": k.get("x"), "y": k.get("y")} for k in kids],
        )
        ops: list[dict[str, object]] = [
            {"kind": "attrs", "loc": self.loc(el), "set": plan.attrs}
        ]
        set_plan(el, plan.attrs)
        for kid, child_plan in zip(kids, plan.children or [], strict=False):
            loc = kid.get(INK)
            if loc and child_plan:
                ops.append({"kind": "attrs", "loc": loc, "set": child_plan})
                set_plan(kid, child_plan)
        return ops

    def move_plans(self, els: list[SvgElement], dx: float, dy: float) -> list[Op]:
        """Several objects moved together: shapes first, then connectors (which
        route to where the shapes went), with every attached arrow following."""
        self.moving_together = list(els)
        ordered = [e for e in els if not self.is_connector(e)] + [
            e for e in els if self.is_connector(e)
        ]
        plans = [Op(e, self.move_ops(e, dx, dy)) for e in ordered]
        return self.with_connectors(plans)
