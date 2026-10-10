// The editing canvas: renders the current slide, picks what a click selects,
// draws selection handles, and turns drags into move / resize / rotate edits.
//
// Every rendered element carries a `data-ink` locator ("<source>:<path>") that
// names the file and position it came from (inkflow/editor/provenance.py). A
// drag previews by setting attributes on the live DOM, then sends the same
// attribute plan to the server, which writes it into that source file. The
// rebuild that follows replaces the DOM with the authoritative render.

import { scrollCorrection, ZoomAnchor } from "../shared/gestures";
import { applyStepInstant } from "../shared/step";
import { parseViewBox } from "../shared/viewbox";
import {
    type Bend,
    type ConnectorStyle,
    type End,
    endpointsOf,
    formatBend,
    MAX_SITES,
    nearestSite,
    type Pt,
    parseBend,
    parseConnection,
    pathData,
    route,
    type Site,
    siteByName,
    sitesFromCorners,
} from "./connectors";
import { h, svgEl, toast } from "./dom";
import {
    attachableCell,
    attachableCells,
    cellShape,
    isDiagramCell,
    pageBox,
    pageOffset,
    shapesEditable,
} from "./drawioshapes";
import {
    type AttrPlan,
    apply,
    type Box,
    type ElementGeom,
    IDENTITY,
    invert,
    type Mat,
    mat,
    multiply,
    parseTransform,
    planCrop,
    planMove,
    planResize,
    planRotate,
    transformBox,
    unionBoxes,
} from "./geom";
import { edit } from "./net";
import { type SnapTargets, snapBox, snapEdges, targetsFor } from "./snap";
import {
    CONNECTOR_TOOLS,
    currentRendered,
    currentSlide,
    ed,
    emit,
    on,
    sourceOf,
} from "./state";
import type { Selected, SvgOp } from "./types";

const canvas = document.getElementById("canvas")!;
const paper = document.getElementById("paper")!;
const host = document.getElementById("slide-host")!;
const overlay = document.getElementById("overlay") as unknown as SVGSVGElement;

const NON_ZONES = new Set(["zone-slide-number", "zone-slide-total"]);
const DRAG_THRESHOLD = 3;
const SNAP_PX = 6;

// Hooks other modules install (kept as callbacks to avoid import cycles).
export const hooks = {
    editText: (_el: SVGGraphicsElement): void => {},
    editZone: (
        _zone: string,
        _el: Element | null,
        _at?: { x: number; y: number },
    ): void => {},
    // The element being edited in place (clicks inside it place the caret),
    // and how to finish that edit when the pointer goes elsewhere.
    editingHost: (): Element | null => null,
    finishEditing: (): void => {},
    crop: (_el: SVGGraphicsElement): void => {},
    // Opens a draw.io diagram's editor; false when the picture is not one.
    diagram: (_el: SVGGraphicsElement): boolean => false,
    // A diagram shape's label, to be edited (its panel's Label field).
    cellLabel: (_el: SVGGraphicsElement): void => {},
    // Shapes of this drawn diagram were edited in its source (`step`: the
    // undo step): draw.io redraws its picture into that step.
    diagramEdited: (_diagram: Element, _step: string): void => {},
    typeInto: (_el: SVGGraphicsElement): void => {},
    zoneMedia: (_zone: string): void => {},
    zoneText: (_zone: string): void => {},
    // Select these ids once the rebuild that holds them has rendered.
    selectAfterRender: (_ids: string[]): void => {},
    toolDown: (_e: PointerEvent, _pt: { x: number; y: number }): boolean =>
        false,
};

// ── Rendering ──

export function slideRoot(): SVGSVGElement | null {
    return host.querySelector(":scope > svg");
}

function viewBoxSize(): { w: number; h: number } {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { w: vb.w, h: vb.h };
}

export function scale(): number {
    const { w, h } = viewBoxSize();
    if (ed.zoom > 0) return ed.zoom;
    const pad = 48;
    const availW = Math.max(100, canvas.clientWidth - pad);
    const availH = Math.max(100, canvas.clientHeight - pad);
    return Math.min(availW / w, availH / h);
}

export function layoutPaper(): void {
    const svg = slideRoot();
    const { w, h } = viewBoxSize();
    const s = scale();
    const pw = Math.round(w * s);
    const ph = Math.round(h * s);
    paper.style.width = `${pw}px`;
    paper.style.height = `${ph}px`;
    svg?.setAttribute("width", String(pw));
    svg?.setAttribute("height", String(ph));
    overlay.setAttribute("width", String(pw));
    overlay.setAttribute("height", String(ph));
    overlay.setAttribute("viewBox", `0 0 ${pw} ${ph}`);
    canvas.classList.toggle("zoomed", ed.zoom > 0);
    // Room to scroll the paper half out of view (see zoomTo).
    canvas.style.padding =
        ed.zoom > 0
            ? `${Math.round(canvas.clientHeight / 2)}px ${Math.round(canvas.clientWidth / 2)}px`
            : "";
    drawOverlay();
}

// Remembered across a re-render so the same objects stay selected.
interface SelKey {
    loc: string;
    id: string | null;
}

export function render(): void {
    if (ed.interacting || ed.richEditing) {
        ed.renderPending = true;
        return;
    }
    ed.renderPending = false;
    const keep: SelKey[] = ed.selection.map((s) => ({
        loc: s.loc,
        id: s.el.getAttribute("id"),
    }));
    const scopeKey = ed.scope?.getAttribute("data-ink") ?? null;
    // After a structural edit, positions shifted: re-select by id only.
    const trustLoc = !ed.structuralPending;
    if (ed.rebuilt) ed.structuralPending = false;
    ed.rebuilt = false;
    const data = currentRendered();
    host.innerHTML = data ? data.svg : "";
    const hidden = currentSlide();
    if (!data && hidden && !hidden.visible) {
        // Hidden slides are not built (the presenter skips them entirely).
        host.append(
            h(
                "div",
                { class: "hidden-note" },
                h("p", {}, "This slide is hidden: the presentation skips it."),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () =>
                            void edit({
                                action: "slide",
                                op: "hide",
                                slide: hidden.deckIndex,
                                hidden: false,
                            }),
                    },
                    "Show it again to edit",
                ),
            ),
        );
    }
    const svg = slideRoot();
    if (svg) {
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        svg.style.display = "block";
        prepareForEditing(svg);
    }
    ed.scope = scopeKey
        ? (host.querySelector(`[data-ink="${scopeKey}"]`) as SVGGElement | null)
        : null;
    ed.selection = [];
    for (const k of keep) {
        const el = findElement(k, trustLoc);
        // An object locked or hidden by the last edit is let go.
        if (el && selectable(el)) addToSelection(el, false);
    }
    layoutPaper();
    emit("render");
    emit("selection");
}

function findElement(k: SelKey, trustLoc: boolean): SVGGraphicsElement | null {
    const svg = slideRoot();
    if (!svg) return null;
    if (k.id) {
        const byId = svg.querySelector(`[id="${CSS.escape(k.id)}"]`);
        if (byId?.hasAttribute("data-ink")) return byId as SVGGraphicsElement;
    }
    if (!trustLoc) return null;
    return svg.querySelector(
        `[data-ink="${k.loc}"]`,
    ) as SVGGraphicsElement | null;
}

// The editor shows every element by default: build state (enter animations
// starting hidden) only applies when previewing a step.
function prepareForEditing(svg: SVGSVGElement): void {
    svg.querySelectorAll("video").forEach((v) => {
        v.pause();
        v.removeAttribute("autoplay");
        // An object to place, not a player: native controls would take the
        // clicks that select and drag it (see videopreview.ts).
        v.removeAttribute("controls");
        v.controls = false;
        // Show the frame a trimmed clip starts on, not its first one.
        const start = parseFloat(v.dataset.start ?? "");
        if (start > 0) v.currentTime = start;
    });
    if (ed.step == null) {
        svg.querySelectorAll(".anim-pending").forEach((el) => {
            el.classList.remove("anim-pending");
        });
    } else {
        applyStepInstant(svg, ed.step);
    }
    // Links in Markdown zones must not navigate away from the editor.
    svg.querySelectorAll("a").forEach((a) => {
        a.addEventListener("click", (e) => e.preventDefault());
    });
}

// ── Coordinates ──

function rootCTM(): Mat {
    const svg = slideRoot();
    const m = svg?.getScreenCTM();
    return m ? mat(m) : { ...IDENTITY };
}

function paperOrigin(): { x: number; y: number } {
    const r = paper.getBoundingClientRect();
    return { x: r.left, y: r.top };
}

// Slide user units → paper CSS px.
export function slideToPaper(): Mat {
    const o = paperOrigin();
    return multiply({ a: 1, b: 0, c: 0, d: 1, e: -o.x, f: -o.y }, rootCTM());
}

export function clientToSlide(x: number, y: number): { x: number; y: number } {
    const inv = invert(rootCTM());
    return {
        x: inv.a * x + inv.c * y + inv.e,
        y: inv.b * x + inv.d * y + inv.f,
    };
}

// An element's box in its own user space and the matrix to the screen. A
// nested <svg> (a cropped picture's frame) is measured by its viewport, not by
// its contents, which is what getBBox() would give.
function measure(el: Element): { bbox: Box; ctm: DOMMatrix } | null {
    const g = el as SVGGraphicsElement;
    if (typeof g.getBBox !== "function") return null;
    // A draw.io shape is its shape, not its label (whose frame spans the
    // whole diagram), in the shape's own space.
    if (isDiagramCell(el)) {
        const shape = cellShape(el) as SVGGraphicsElement;
        const a = shape.getScreenCTM?.();
        const c = g.getScreenCTM();
        if (shape !== el && a && c) {
            const m = c.inverse().multiply(a);
            const b = shape.getBBox();
            const pts = [
                [b.x, b.y],
                [b.x + b.width, b.y],
                [b.x, b.y + b.height],
                [b.x + b.width, b.y + b.height],
            ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
            const xs = pts.map((p) => p.x);
            const ys = pts.map((p) => p.y);
            return {
                bbox: {
                    x: Math.min(...xs),
                    y: Math.min(...ys),
                    width: Math.max(...xs) - Math.min(...xs),
                    height: Math.max(...ys) - Math.min(...ys),
                },
                ctm: c,
            };
        }
    }
    if (el.localName === "svg" && el !== slideRoot()) {
        const s = el as SVGSVGElement;
        const ctm = (
            el.parentElement as unknown as SVGGraphicsElement | null
        )?.getScreenCTM?.();
        if (!ctm) return null;
        return {
            bbox: {
                x: s.x.baseVal.value,
                y: s.y.baseVal.value,
                width: s.width.baseVal.value,
                height: s.height.baseVal.value,
            },
            ctm,
        };
    }
    const b = g.getBBox();
    const ctm = g.getScreenCTM();
    if (!ctm) return null;
    return { bbox: { x: b.x, y: b.y, width: b.width, height: b.height }, ctm };
}

export function slideBox(el: Element): Box | null {
    try {
        const m = measure(el);
        if (!m) return null;
        const { bbox, ctm } = m;
        const toSlide = multiply(invert(rootCTM()), mat(ctm));
        return transformBox(toSlide, {
            x: bbox.x,
            y: bbox.y,
            width: bbox.width,
            height: bbox.height,
        });
    } catch {
        return null;
    }
}

export function slideSize(): Box {
    const svg = slideRoot();
    const vb = parseViewBox(svg?.getAttribute("viewBox") ?? null);
    return { x: vb.x, y: vb.y, width: vb.w, height: vb.h };
}

const GEOM_ATTRS = [
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
    // A connector's route and its attachments.
    "d",
    "inkflow:connect-start",
    "inkflow:connect-end",
    "inkflow:bend",
];

export function elementGeom(el: SVGGraphicsElement): ElementGeom {
    const parent = el.parentElement as unknown as SVGGraphicsElement | null;
    const parentCTM = parent?.getScreenCTM?.();
    const attrs: Record<string, string | null> = {};
    for (const a of GEOM_ATTRS) attrs[a] = el.getAttribute(a);
    let box = { x: 0, y: 0, width: 0, height: 0 };
    try {
        box = measure(el)?.bbox ?? box;
    } catch {
        // not rendered
    }
    return {
        tag: el.localName,
        sourceTag: el.getAttribute("data-ink-tag") ?? el.localName,
        attrs,
        own: parseTransform(el.getAttribute("transform")),
        parentToSlide: parentCTM
            ? multiply(invert(rootCTM()), mat(parentCTM))
            : { ...IDENTITY },
        localBox: box,
    };
}

// ── What a click may select ──

export function isZone(el: Element): boolean {
    const id = el.getAttribute("id") ?? "";
    return id.startsWith("zone-") && !NON_ZONES.has(id);
}

export function zoneName(el: Element): string {
    return (el.getAttribute("id") ?? "").replace(/^zone-/, "");
}

// The media zone under a point, empty (its placeholder) or holding an image or
// video already: where a dropped file fills the zone instead of floating free.
export function mediaZoneAt(clientX: number, clientY: number): string | null {
    const inside = (r: DOMRect) =>
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom;
    for (const el of overlay.querySelectorAll("[data-media-zone]")) {
        if (inside(el.getBoundingClientRect()))
            return el.getAttribute("data-media-zone");
    }
    const slide = currentSlide();
    const svg = slideRoot();
    if (!slide || !svg) return null;
    for (const el of svg.querySelectorAll('[id^="zone-"]')) {
        const name = zoneName(el);
        const kind = slide.zones[name]?.kind;
        if (
            (kind === "image" || kind === "video") &&
            inside(el.getBoundingClientRect())
        )
            return name;
    }
    return null;
}

export function keyOf(el: Element): number {
    const loc = el.getAttribute("data-ink") ?? "";
    return parseInt(loc.split(":")[0] ?? "", 10);
}

// A locked layer or object (inkflow:locked), or anything inside one.
export function isLocked(el: Element): boolean {
    return el.closest("[data-ink-locked]") !== null;
}

// The slide's own drawing (not a layout, overlay, or a file other slides share).
export function isOwn(el: Element): boolean {
    const src = sourceOf(keyOf(el));
    const slide = currentSlide();
    return (
        !!src &&
        src.role === "slide" &&
        !!slide &&
        !slide.srcShared &&
        src.writable
    );
}

// A shape of a drawn-in draw.io diagram whose shapes are edited here (its
// "Edit shapes here"), on a diagram this slide may change.
function editableCell(el: Element): boolean {
    const diagram = el.closest("svg[data-drawio]");
    return (
        isDiagramCell(el) &&
        !!diagram &&
        shapesEditable(diagram) &&
        canTransform(diagram)
    );
}

export function selectable(el: Element): boolean {
    if (!el.hasAttribute("data-ink") || isLocked(el)) return false;
    const src = sourceOf(keyOf(el));
    if (!src) return false;
    if (src.role === "diagram") return src.writable && editableCell(el);
    // A stroke of the slide's own ink file: drawn on this slide alone.
    if (src.role === "ink") return src.writable;
    if (ed.layoutMode) return src.writable;
    return isOwn(el) || (el.hasAttribute("data-ink-top") && isZone(el));
}

// May the element be moved/resized here (vs. only its content edited)?
export function canTransform(el: Element): boolean {
    const src = sourceOf(keyOf(el));
    if (!src?.writable) return false;
    if (src.role === "diagram") return editableCell(el);
    if (src.role === "ink") return true;
    return ed.layoutMode || isOwn(el);
}

// The object a click at a point selects: inside an entered group, its child;
// otherwise the top-level object (or zone) under the pointer.
export function pick(x: number, y: number): SVGGraphicsElement | null {
    const svg = slideRoot();
    if (!svg) return null;
    for (const hit of document.elementsFromPoint(x, y)) {
        if (!svg.contains(hit)) continue;
        let node: Element | null = hit;
        // HTML inside a filled zone: climb to the foreignObject.
        if (!(node instanceof SVGElement)) node = node.closest("foreignObject");
        while (node && node !== svg) {
            if (ed.scope) {
                if (
                    (node.parentElement as Element | null) === ed.scope &&
                    node.hasAttribute("data-ink")
                ) {
                    return selectable(node)
                        ? (node as SVGGraphicsElement)
                        : null;
                }
            } else if (node.hasAttribute("data-ink-top") && selectable(node)) {
                return node as SVGGraphicsElement;
            }
            node = node.parentElement;
        }
    }
    return pickByBox(svg, x, y);
}

/**
 * A rectangle or ellipse of the slide's own drawing that text can be typed
 * into (it becomes a text zone that keeps its look), or a shown zone box that
 * is still empty.
 */
export function canTypeInto(el: Element): boolean {
    if (!["rect", "ellipse", "circle"].includes(el.localName)) return false;
    if (!canTransform(el) || ed.layoutMode || !isOwn(el)) return false;
    return !isZone(el) || el.hasAttribute("inkflow:show-shape");
}

// Lines and connectors are picked by their stroke only: their box (a long
// diagonal, an elbow) covers empty slide that clicks must still reach.
function isLineLike(el: Element): boolean {
    return el.localName === "line" || isConnector(el);
}

// A click that lands in a gap of a shape (between a logo's strokes, inside an
// unfilled outline) still selects it, as slide editors do: the topmost
// selectable object whose box contains the point. Slide-sized boxes are left
// out so clicking an empty area still clears the selection.
function pickByBox(
    svg: SVGSVGElement,
    x: number,
    y: number,
): SVGGraphicsElement | null {
    const pt = clientToSlide(x, y);
    const slide = slideSize();
    const pool = ed.scope
        ? [...ed.scope.children].filter((el) => el.hasAttribute("data-ink"))
        : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i = pool.length - 1; i >= 0; i--) {
        const el = pool[i];
        if (!selectable(el) || isLineLike(el)) continue;
        const b = slideBox(el);
        if (!b || b.width * b.height > slide.width * slide.height * 0.8)
            continue;
        if (
            pt.x >= b.x &&
            pt.x <= b.x + b.width &&
            pt.y >= b.y &&
            pt.y <= b.y + b.height
        ) {
            return el as SVGGraphicsElement;
        }
    }
    return null;
}

// Every object a click at a point could mean, topmost first: what is drawn
// there, then objects whose box contains it. Middle-click (or Alt+click)
// steps through them, to reach an object hidden under another.
export function candidatesAt(x: number, y: number): SVGGraphicsElement[] {
    const svg = slideRoot();
    if (!svg) return [];
    const out: SVGGraphicsElement[] = [];
    const add = (el: Element | null) => {
        if (el && !out.includes(el as SVGGraphicsElement) && selectable(el)) {
            out.push(el as SVGGraphicsElement);
        }
    };
    const owner = (node: Element | null): Element | null => {
        while (node && node !== svg) {
            if (ed.scope) {
                if (node.parentElement === (ed.scope as Element)) return node;
            } else if (node.hasAttribute("data-ink-top")) return node;
            node = node.parentElement;
        }
        return null;
    };
    for (const hit of document.elementsFromPoint(x, y)) {
        if (!svg.contains(hit)) continue;
        const node =
            hit instanceof SVGElement ? hit : hit.closest("foreignObject");
        add(owner(node));
    }
    const pt = clientToSlide(x, y);
    const pool = ed.scope
        ? [...ed.scope.children]
        : [...svg.querySelectorAll("[data-ink-top]")];
    for (let i = pool.length - 1; i >= 0; i--) {
        if (isLineLike(pool[i])) continue;
        const b = slideBox(pool[i]);
        if (
            b &&
            pt.x >= b.x &&
            pt.x <= b.x + b.width &&
            pt.y >= b.y &&
            pt.y <= b.y + b.height
        ) {
            add(pool[i]);
        }
    }
    return out;
}

let cycle: { x: number; y: number; index: number } | null = null;

function cycleSelect(e: PointerEvent): void {
    const near =
        cycle !== null &&
        Math.hypot(cycle.x - e.clientX, cycle.y - e.clientY) < 6;
    const all = candidatesAt(e.clientX, e.clientY);
    if (!all.length) {
        clearSelection();
        return;
    }
    const current = ed.selection.length === 1 ? ed.selection[0].el : null;
    let index = near && cycle ? cycle.index + 1 : 0;
    if (!near && current && all[0] === current) index = 1;
    index %= all.length;
    cycle = { x: e.clientX, y: e.clientY, index };
    select([all[index]]);
    if (all.length > 1) {
        const name = all[index].getAttribute("id") ?? all[index].localName;
        toast(`${index + 1} of ${all.length} here: ${name}`);
    }
}

export function setHover(el: Element | null): void {
    if (el !== hoverEl) {
        hoverEl = el;
        drawOverlay();
    }
}

// ── Selection ──

function toSelected(el: SVGGraphicsElement): Selected {
    const loc = el.getAttribute("data-ink") ?? "";
    return { el, key: keyOf(el), loc };
}

export function addToSelection(el: SVGGraphicsElement, notify = true): void {
    if (ed.selection.some((s) => s.el === el)) return;
    ed.selection.push(toSelected(el));
    if (notify) {
        drawOverlay();
        emit("selection");
    }
}

export function select(els: SVGGraphicsElement[]): void {
    ed.selection = els.map(toSelected);
    drawOverlay();
    emit("selection");
}

export function clearSelection(): void {
    if (!ed.selection.length) return;
    ed.selection = [];
    drawOverlay();
    emit("selection");
}

export function selectAll(): void {
    const svg = slideRoot();
    if (!svg) return;
    const scope = ed.scope ?? svg;
    const els = [...scope.querySelectorAll("[data-ink]")].filter(
        (el) =>
            (ed.scope
                ? (el.parentElement as Element | null) === ed.scope
                : el.hasAttribute("data-ink-top")) &&
            selectable(el) &&
            (canTransform(el) || ed.scope !== null),
    ) as SVGGraphicsElement[];
    select(els);
}

export function enterGroup(g: SVGGElement | null): void {
    ed.scope = g;
    clearSelection();
    drawOverlay();
    emit("selection");
}

// ── Overlay ──

let hoverEl: Element | null = null;
let guides: { xs: number[]; ys: number[] } = { xs: [], ys: [] };
let marquee: Box | null = null;

function poly(
    points: { x: number; y: number }[],
    cls: string,
): SVGPolygonElement {
    return svgEl("polygon", {
        points: points.map((p) => `${p.x},${p.y}`).join(" "),
        class: cls,
    });
}

function elementCorners(
    el: SVGGraphicsElement,
): { x: number; y: number }[] | null {
    try {
        const measured = measure(el);
        if (!measured) return null;
        const b = measured.bbox;
        const ctm = measured.ctm;
        const o = paperOrigin();
        const m = mat(ctm);
        return [
            { x: b.x, y: b.y },
            { x: b.x + b.width, y: b.y },
            { x: b.x + b.width, y: b.y + b.height },
            { x: b.x, y: b.y + b.height },
        ].map((p) => ({
            x: m.a * p.x + m.c * p.y + m.e - o.x,
            y: m.b * p.x + m.d * p.y + m.f - o.y,
        }));
    } catch {
        return null;
    }
}

function toPaperBox(b: Box): Box {
    return transformBox(slideToPaper(), b);
}

export function selectionBox(): Box | null {
    return unionBoxes(
        ed.selection
            .map((s) => slideBox(s.el))
            .filter((b): b is Box => b !== null),
    );
}

export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number] | "rot" | "c-start" | "c-end" | "c-bend";

function handlePoint(h: Handle, b: Box): { x: number; y: number } {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const r = b.x + b.width;
    const btm = b.y + b.height;
    switch (h) {
        case "nw":
            return { x: b.x, y: b.y };
        case "n":
            return { x: cx, y: b.y };
        case "ne":
            return { x: r, y: b.y };
        case "e":
            return { x: r, y: cy };
        case "se":
            return { x: r, y: btm };
        case "s":
            return { x: cx, y: btm };
        case "sw":
            return { x: b.x, y: btm };
        case "w":
            return { x: b.x, y: cy };
        case "rot":
            return { x: cx, y: b.y - 28 };
        default:
            return { x: cx, y: cy };
    }
}

export function drawOverlay(): void {
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    const svg = slideRoot();
    if (!svg) return;
    drawPlaceholders();
    if (ed.scope) {
        const c = elementCorners(ed.scope);
        if (c) overlay.append(poly(c, "scope-outline"));
    }
    if (hoverEl && !ed.selection.some((s) => s.el === hoverEl)) {
        const c = elementCorners(hoverEl as SVGGraphicsElement);
        if (c) overlay.append(poly(c, "hover-outline"));
    }
    for (const s of ed.selection) {
        const c = elementCorners(s.el);
        if (c) {
            overlay.append(
                poly(
                    c,
                    canTransform(s.el)
                        ? "sel-outline"
                        : "sel-outline content-only",
                ),
            );
        }
    }
    if (ed.cropMode) drawCropGhost();
    drawSiteHints();
    const transformable = ed.selection.filter((s) => canTransform(s.el));
    const lone = ed.selection.length === 1 ? ed.selection[0].el : null;
    // A connector is reshaped by its two ends, not by a box.
    const connector =
        lone && isConnector(lone) && canTransform(lone) ? lone : null;
    const box =
        !connector && transformable.length === ed.selection.length
            ? selectionBox()
            : null;
    if (connector && ed.step == null) {
        const m = slideToPaper();
        for (const which of ["start", "end"] as const) {
            const end = connectorEnd(connector, which);
            if (!end) continue;
            const p = apply(m, end);
            const attached = connector.hasAttribute(ENDS[which]);
            const handle = svgEl("circle", {
                cx: p.x,
                cy: p.y,
                r: 6,
                class: `handle endpoint${attached ? " attached" : ""}`,
            });
            handle.dataset.handle = `c-${which}`;
            overlay.append(handle);
        }
        const bend = connectorRoute(connector)?.bend;
        if (bend) {
            // The elbow's adjustable segment: drag it to reshape the route.
            const p = apply(m, bend.mid);
            const handle = svgEl("rect", {
                x: p.x - 5,
                y: p.y - 5,
                width: 10,
                height: 10,
                transform: `rotate(45 ${p.x} ${p.y})`,
                class: `handle bend ${bend.axis === "x" ? "ew" : "ns"}`,
            });
            handle.dataset.handle = "c-bend";
            overlay.append(handle);
        }
    }
    if (box && ed.step == null) {
        const pb = toPaperBox(box);
        if (ed.selection.length > 1) {
            overlay.append(
                svgEl("rect", {
                    x: pb.x,
                    y: pb.y,
                    width: pb.width,
                    height: pb.height,
                    class: "group-outline",
                }),
            );
        }
        const top = handlePoint("n", pb);
        const rot = handlePoint("rot", pb);
        overlay.append(
            svgEl("line", {
                x1: top.x,
                y1: top.y,
                x2: rot.x,
                y2: rot.y,
                class: "rot-stem",
            }),
        );
        const rh = svgEl("circle", {
            cx: rot.x,
            cy: rot.y,
            r: 6,
            class: "handle rot",
        });
        rh.dataset.handle = "rot";
        // A cropped picture's frame is kept unrotated (see planCrop).
        // (A drawn-in draw.io diagram or a chart is a nested <svg> too, but
        // rotates.)
        // (Nor do a diagram's shapes edited here: draw.io would not follow.)
        const frames = ed.selection.some(
            (s) =>
                (s.el.localName === "svg" &&
                    !s.el.hasAttribute("data-drawio") &&
                    !s.el.classList.contains("inkflow-chart")) ||
                isDiagramCell(s.el),
        );
        if (!ed.cropMode && !frames) overlay.append(rh);
        for (const h of HANDLES) {
            const p = handlePoint(h, pb);
            const r = svgEl("rect", {
                x: p.x - 5,
                y: p.y - 5,
                width: 10,
                height: 10,
                class: `handle h-${h}`,
            });
            r.dataset.handle = h;
            overlay.append(r);
        }
    }
    for (const x of guides.xs) {
        const p = toPaperBox({ x, y: 0, width: 0, height: slideSize().height });
        overlay.append(
            svgEl("line", {
                x1: p.x,
                y1: p.y,
                x2: p.x,
                y2: p.y + p.height,
                class: "guide",
            }),
        );
    }
    for (const y of guides.ys) {
        const p = toPaperBox({ x: 0, y, width: slideSize().width, height: 0 });
        overlay.append(
            svgEl("line", {
                x1: p.x,
                y1: p.y,
                x2: p.x + p.width,
                y2: p.y,
                class: "guide",
            }),
        );
    }
    if (marquee) {
        const p = toPaperBox(marquee);
        overlay.append(
            svgEl("rect", {
                x: p.x,
                y: p.y,
                width: p.width,
                height: p.height,
                class: "marquee",
            }),
        );
    }
}

// In crop mode, the whole picture shows faded around the frame being cropped.
function drawCropGhost(): void {
    const frame = ed.selection[0]?.el;
    const image = frame
        ? ([...frame.children].find((c) => c.localName === "image") as
              | SVGGraphicsElement
              | undefined)
        : undefined;
    if (!image) return;
    const c = elementCorners(image);
    if (!c) return;
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    const ghost = svgEl("image", {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        href:
            image.getAttribute("href") ??
            image.getAttribute("xlink:href") ??
            "",
        preserveAspectRatio:
            image.getAttribute("preserveAspectRatio") ?? "xMidYMid meet",
        class: "crop-ghost",
    });
    overlay.append(ghost, poly(c, "crop-extent"));
}

const MEDIA_ZONES = /media|image|img|picture|photo|figure|video|logo/;

function drawPlaceholders(): void {
    const slide = currentSlide();
    if (!slide?.emptyZones || ed.step != null) return;
    for (const z of slide.emptyZones) {
        const key = parseInt(z.locator.split(":")[0] ?? "", 10);
        const src = sourceOf(key);
        if (!src || z.zone === "slide-number" || z.zone === "slide-total")
            continue;
        const own = parseTransform(z.transform);
        const box = transformBox(own, z);
        const pb = toPaperBox(box);
        // The dashed outline is only a hint and lets clicks through, so a zone
        // a drawing deliberately covers stays out of the way; the small label
        // in its corner is what adds content.
        const media = MEDIA_ZONES.test(z.zone);
        const outline = svgEl("rect", {
            x: pb.x,
            y: pb.y,
            width: pb.width,
            height: pb.height,
            rx: 4,
            class: "placeholder-outline",
        });
        if (media) outline.setAttribute("data-media-zone", z.zone);
        overlay.append(outline);
        const g = svgEl("g", { class: "placeholder" });
        const text = media ? `+ media · ${z.zone}` : `+ ${z.zone}`;
        const w = 14 + text.length * 7.2;
        const tx = pb.x + 6;
        const ty = pb.y + 6;
        g.append(svgEl("rect", { x: tx, y: ty, width: w, height: 22, rx: 11 }));
        const label = svgEl("text", {
            x: tx + w / 2,
            y: ty + 15,
            "text-anchor": "middle",
        });
        label.textContent = text;
        g.append(label);
        const title = svgEl("title");
        title.textContent = media
            ? `Add an image or video to the ${z.zone} zone`
            : `Add ${z.zone} text`;
        g.append(title);
        g.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (media) hooks.zoneMedia(z.zone);
            else hooks.zoneText(z.zone);
        });
        overlay.append(g);
    }
}

// ── Connectors ──
//
// Arrows that stay attached (see connectors.ts for the geometry): a connector
// end names "<id>:<site>", and whenever an attached shape moves in the editor
// the connector is re-routed in the same edit.

const CONNECTOR = "inkflow:connector";
const ENDS = { start: "inkflow:connect-start", end: "inkflow:connect-end" };
const SNAP_SITE_PX = 14;

export function isConnector(el: Element): boolean {
    return el.hasAttribute(CONNECTOR);
}

export function connectorStyle(el: Element): ConnectorStyle {
    const v = el.getAttribute(CONNECTOR);
    return v === "elbow" || v === "curved" ? v : "straight";
}

function toSlideMat(el: Element): Mat | null {
    const ctm = (el as SVGGraphicsElement).getScreenCTM?.();
    return ctm ? multiply(invert(rootCTM()), mat(ctm)) : null;
}

const SITES = "inkflow:sites";

/** How many connection points per side an object offers (inkflow:sites). */
export function sitesPerSide(el: Element): number {
    const n = Number(el.getAttribute(SITES) ?? 1);
    return Number.isFinite(n)
        ? Math.max(1, Math.min(MAX_SITES, Math.round(n)))
        : 1;
}

// An object's corners in slide units, and whether it is round (its sites
// then sit on the ellipse rather than the box around it).
function cornersOf(el: Element): { corners: Pt[]; round: boolean } | null {
    try {
        const m = measure(attachableCell(el) ? cellShape(el) : el);
        if (!m) return null;
        const toSlide = multiply(invert(rootCTM()), mat(m.ctm));
        const b = m.bbox;
        if (b.width <= 0 && b.height <= 0) return null;
        const tag = el.getAttribute("data-ink-tag") ?? el.localName;
        return {
            corners: [
                { x: b.x, y: b.y },
                { x: b.x + b.width, y: b.y },
                { x: b.x + b.width, y: b.y + b.height },
                { x: b.x, y: b.y + b.height },
            ].map((p) => apply(toSlide, p)),
            round: tag === "ellipse" || tag === "circle",
        };
    } catch {
        return null;
    }
}

/** An object's connection sites, in slide units. */
export function sitesOf(el: Element): Site[] | null {
    const c = cornersOf(el);
    return c ? sitesFromCorners(c.corners, sitesPerSide(el), c.round) : null;
}

/** One named site of an object (offered or not: a connection keeps its
 * place when the object offers fewer points later). */
function siteOf(el: Element, name: string): Site | null {
    const c = cornersOf(el);
    return c ? siteByName(c.corners, name, c.round) : null;
}

function byId(id: string): Element | null {
    return slideRoot()?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;
}

// What a connector end can attach to: objects on the slide (not connectors),
// in the entered group when there is one.
function attachables(except: Element | null): Element[] {
    const svg = slideRoot();
    if (!svg) return [];
    const pool = ed.scope
        ? [...ed.scope.children]
        : [...svg.querySelectorAll("[data-ink-top]")];
    const area = slideSize();
    const objects = pool.filter((el) => {
        if (el === except || isConnector(el) || !el.hasAttribute("data-ink"))
            return false;
        const b = slideBox(el);
        // Full-slide backgrounds are not something an arrow points at.
        return !!b && b.width * b.height < area.width * area.height * 0.8;
    });
    // And the shapes of a diagram drawn into the slide (draw.io cells).
    const cells = objects.flatMap((el) =>
        el.hasAttribute("data-drawio") ? attachableCells(el) : [],
    );
    return [...objects, ...cells];
}

/** What a line or arrow would attach to under the pointer: a diagram's shape
 * before the diagram, else the topmost object that is not a connector. */
export function attachTargetAt(
    x: number,
    y: number,
    except: Element | null = null,
): Element | null {
    const svg = slideRoot();
    for (const hit of document.elementsFromPoint(x, y)) {
        if (!svg?.contains(hit)) continue;
        const cell = attachableCell(hit);
        if (cell) return cell;
    }
    return (
        candidatesAt(x, y).find((el) => el !== except && !isConnector(el)) ??
        null
    );
}

/** The site nearest to a slide point (within a few screen pixels), if any. */
export function siteAt(
    p: { x: number; y: number },
    except: Element | null,
): { el: Element; site: Site } | null {
    const within = SNAP_SITE_PX / (scale() || 1);
    let best: { el: Element; site: Site } | null = null;
    let bestD = within;
    for (const el of attachables(except)) {
        const s = nearestSite(sitesOf(el) ?? [], p, bestD);
        if (s) {
            best = { el, site: s };
            bestD = Math.hypot(s.x - p.x, s.y - p.y);
        }
    }
    return best;
}

// Sites drawn while connecting: of the object under the pointer and the one
// being snapped to.
let siteHints: { el: Element; active: Site | null }[] = [];

export function showSites(hints: { el: Element; active: Site | null }[]): void {
    siteHints = hints;
    drawOverlay();
}

function drawSiteHints(): void {
    const m = slideToPaper();
    for (const { el, active } of siteHints) {
        for (const s of sitesOf(el) ?? []) {
            const p = apply(m, s);
            const on =
                active?.name === s.name &&
                Math.hypot(active.x - s.x, active.y - s.y) < 0.5;
            overlay.append(
                svgEl("circle", {
                    cx: p.x,
                    cy: p.y,
                    r: on ? 6 : 4,
                    class: `site${on ? " on" : ""}`,
                }),
            );
        }
    }
}

/** A connector end in slide units: its site when attached, else its point. */
function connectorEnd(conn: Element, which: "start" | "end"): End | null {
    const c = parseConnection(conn.getAttribute(ENDS[which]));
    if (c) {
        const target = byId(c.id);
        const site = target ? siteOf(target, c.site) : null;
        if (site) return site;
    }
    const pts = endpointsOf(conn.getAttribute("d") ?? "");
    const m = toSlideMat(conn);
    if (!pts || !m) return null;
    return apply(m, which === "start" ? pts.start : pts.end);
}

/**
 * Whether an attached connector's drawn ends no longer meet its shapes (they
 * moved in draw.io, Inkscape or another editor since it was routed).
 */
export function isStale(conn: Element): boolean {
    const pts = endpointsOf(conn.getAttribute("d") ?? "");
    const m = toSlideMat(conn);
    if (!pts || !m) return false;
    for (const which of ["start", "end"] as const) {
        const c = parseConnection(conn.getAttribute(ENDS[which]));
        const target = c ? byId(c.id) : null;
        const site = c && target ? siteOf(target, c.site) : null;
        if (!site) continue;
        const drawn = apply(m, which === "start" ? pts.start : pts.end);
        if (Math.hypot(drawn.x - site.x, drawn.y - site.y) > 1) return true;
    }
    return false;
}

/** The slide's connectors attached to `id` or, for a diagram, its shapes. */
export function connectorsTo(id: string): Element[] {
    const svg = slideRoot();
    if (!svg) return [];
    return [
        ...svg.querySelectorAll(`[${CSS.escape(CONNECTOR)}][data-ink]`),
    ].filter(
        (conn) =>
            canTransform(conn) &&
            (["start", "end"] as const).some((w) => {
                const c = parseConnection(conn.getAttribute(ENDS[w]));
                return !!c && (c.id === id || c.id.startsWith(`${id}-`));
            }),
    );
}

/** Re-route connectors along their shapes (`coalesce`: into that step). */
export function rerouteConnectors(
    conns: Element[],
    label = "Re-route arrows",
    coalesce?: string,
): Promise<unknown> | null {
    const plans = conns.flatMap((el) => {
        const d = connectorPath(el);
        const sel = toSelected(el as SVGGraphicsElement);
        return d
            ? [{ sel, ops: [{ kind: "attrs", loc: sel.loc, set: { d } }] }]
            : [];
    });
    return plans.length ? sendSvgOps(plans, label, coalesce) : null;
}

const BEND = "inkflow:bend";

/** A connector's route in slide units (its elbow bend as set on it). */
function connectorRoute(
    conn: Element,
    ends: { start?: End; end?: End } = {},
    style: ConnectorStyle = connectorStyle(conn),
    bend: Bend | null = parseBend(conn.getAttribute(BEND)),
): ReturnType<typeof route> | null {
    const a = ends.start ?? connectorEnd(conn, "start");
    const b = ends.end ?? connectorEnd(conn, "end");
    if (!a || !b) return null;
    return route(style, a, b, bend);
}

/** The path data for a connector in its own user space. */
export function connectorPath(
    conn: Element,
    ends: { start?: End; end?: End } = {},
    style: ConnectorStyle = connectorStyle(conn),
    bend: Bend | null = parseBend(conn.getAttribute(BEND)),
): string | null {
    const r = connectorRoute(conn, ends, style, bend);
    const toSlide = toSlideMat(conn);
    if (!r || !toSlide) return null;
    const local = invert(toSlide);
    return pathData({ ...r, points: r.points.map((p) => apply(local, p)) });
}

/** Route a new connector between slide-unit ends into some element's space. */
export function newConnectorPath(
    style: ConnectorStyle,
    a: End,
    b: End,
    parent: Element | null,
): string {
    const svg = slideRoot();
    const pm = (parent as SVGGraphicsElement | null)?.getScreenCTM?.();
    const local = pm && svg ? multiply(invert(mat(pm)), rootCTM()) : IDENTITY;
    const r = route(style, a, b);
    return pathData({ ...r, points: r.points.map((p) => apply(local, p)) });
}

const GEOMETRY = new Set([...GEOM_ATTRS, "points"]);

function geometryChanged(ops: SvgOp[]): boolean {
    return ops.some(
        (op) =>
            op.kind === "attrs" &&
            Object.keys((op.set as Record<string, unknown>) ?? {}).some((k) =>
                GEOMETRY.has(k),
            ),
    );
}

/**
 * Add, to plans that move or reshape objects, the re-routing of every
 * connector attached to them (and preview it on the slide).
 */
export function withConnectors(
    plans: { sel: Selected; ops: SvgOp[] }[],
): { sel: Selected; ops: SvgOp[] }[] {
    const svg = slideRoot();
    if (!svg) return plans;
    const moved = plans
        .filter((p) => geometryChanged(p.ops))
        .map((p) => p.sel.el as Element);
    if (!moved.length) return plans;
    // The plans' attributes are on the slide already for a drag; for other
    // edits (the geometry fields) put them there, so routing reads them.
    for (const p of plans) {
        for (const op of p.ops) {
            if (op.kind === "attrs" && op.loc === p.sel.loc) {
                applyPlanToDom(p.sel.el, op.set as AttrPlan);
            }
        }
    }
    const touches = (conn: Element) =>
        (["start", "end"] as const).some((w) => {
            const c = parseConnection(conn.getAttribute(ENDS[w]));
            const target = c ? byId(c.id) : null;
            return (
                !!target &&
                moved.some((m) => m === target || m.contains(target))
            );
        });
    const out = [...plans];
    for (const conn of svg.querySelectorAll(`[${CSS.escape(CONNECTOR)}]`)) {
        if (
            !conn.hasAttribute("data-ink") ||
            !canTransform(conn) ||
            !touches(conn)
        )
            continue;
        const d = connectorPath(conn);
        if (!d) continue;
        applyPlanToDom(conn, { d });
        const loc = conn.getAttribute("data-ink") ?? "";
        const existing = out.find((p) => p.sel.el === conn);
        const op: SvgOp = { kind: "attrs", loc, set: { d } };
        if (existing) existing.ops = [...existing.ops, op];
        else
            out.push({
                sel: toSelected(conn as SVGGraphicsElement),
                ops: [op],
            });
    }
    return out;
}

// Elements moving together in the current move (a connector keeps an end
// attached only when the shape at that end moves with it).
let movingTogether: Element[] = [];

function connectorMoveOps(sel: Selected, dx: number, dy: number): SvgOp[] {
    const conn = sel.el;
    const set: AttrPlan = {};
    const ends: { start?: End; end?: End } = {};
    for (const w of ["start", "end"] as const) {
        const c = parseConnection(conn.getAttribute(ENDS[w]));
        const target = c ? byId(c.id) : null;
        const kept =
            !!target &&
            movingTogether.some((m) => m === target || m.contains(target));
        const here = connectorEnd(conn, w);
        if (!kept) {
            if (c) set[ENDS[w]] = null; // dragged away from its shape: detach
            if (here) ends[w] = { x: here.x + dx, y: here.y + dy };
        }
    }
    for (const [k, v] of Object.entries(set)) {
        if (v === null) conn.removeAttribute(k);
    }
    // A moved elbow keeps its shape: its bend moves along.
    let bend = parseBend(conn.getAttribute(BEND));
    if (bend) {
        bend = { ...bend, at: bend.at + (bend.axis === "x" ? dx : dy) };
        set[BEND] = formatBend(bend);
    }
    const d = connectorPath(conn, ends, connectorStyle(conn), bend);
    if (d) set.d = d;
    applyPlanToDom(conn, { d: set.d ?? null });
    return [{ kind: "attrs", loc: sel.loc, set }];
}

function freshId(base: string): string {
    const svg = slideRoot();
    let n = 1;
    while (svg?.querySelector(`[id="${base}-${n}"]`)) n++;
    return `${base}-${n}`;
}

/**
 * Drag one end of a connector: it snaps to the nearest connection site (and
 * attaches there) or stays a free point where it is dropped.
 */
function endpointPlans(
    drag: { which: "start" | "end"; snaps: Snapshot[] },
    p: { x: number; y: number },
    e: DragInput,
): { sel: Selected; ops: SvgOp[] }[] {
    const sel = drag.snaps[0].sel;
    const conn = sel.el;
    const hit = e.altKey ? null : siteAt(p, conn);
    const under = attachTargetAt(e.clientX, e.clientY, conn);
    siteHints = [
        ...(under
            ? [
                  {
                      el: under as Element,
                      active: hit?.el === under ? hit.site : null,
                  },
              ]
            : []),
        ...(hit && hit.el !== under ? [{ el: hit.el, active: hit.site }] : []),
    ];
    const ops: SvgOp[] = [];
    let attach: string | null = null;
    if (hit) {
        let id = hit.el.getAttribute("id");
        if (!id && keyOf(hit.el) === sel.key) {
            // Give the shape an id to attach to (same file only).
            id = freshId(hit.el.localName);
            hit.el.setAttribute("id", id);
            ops.push({ kind: "id", loc: hit.el.getAttribute("data-ink"), id });
        }
        if (id) attach = `${id}:${hit.site.name}`;
    }
    const end: End = attach && hit ? hit.site : p;
    const d = connectorPath(conn, { [drag.which]: end });
    if (!d) return [];
    applyPlanToDom(conn, { d });
    ops.push({
        kind: "attrs",
        loc: sel.loc,
        set: { d, [ENDS[drag.which]]: attach },
    });
    return [{ sel, ops }];
}

/** Drag an elbow's adjustable segment along its axis. */
function bendPlans(
    drag: { snaps: Snapshot[] },
    p: { x: number; y: number },
): { sel: Selected; ops: SvgOp[] }[] {
    const sel = drag.snaps[0].sel;
    const conn = sel.el;
    const current = connectorRoute(conn)?.bend;
    if (!current) return [];
    const bend: Bend = {
        axis: current.axis,
        at: Math.round(current.axis === "x" ? p.x : p.y),
    };
    const d = connectorPath(conn, {}, "elbow", bend);
    if (!d) return [];
    applyPlanToDom(conn, { d });
    return [
        {
            sel,
            ops: [
                {
                    kind: "attrs",
                    loc: sel.loc,
                    set: { d, [BEND]: formatBend(bend) },
                },
            ],
        },
    ];
}

// ── Sending plans ──

function opsByFile(
    plans: { sel: Selected; ops: SvgOp[] }[],
): Map<string, SvgOp[]> {
    const out = new Map<string, SvgOp[]>();
    for (const { sel, ops } of plans) {
        const src = sourceOf(sel.key);
        if (!src) continue;
        const list = out.get(src.path) ?? [];
        list.push(...ops);
        out.set(src.path, list);
    }
    return out;
}

export async function sendSvgOps(
    plans: { sel: Selected; ops: SvgOp[] }[],
    label: string,
    coalesce?: string,
    ids?: Record<string, string>,
): Promise<boolean> {
    const slide = currentSlide();
    if (!slide) return false;
    if (ed.structuralPending) {
        toast("One moment: the last change is still being applied");
        return false;
    }
    // One request at a time, each with the hash the previous one returned
    // (held arrow keys send nudges faster than results come back).
    const run = queue.then(() => sendQueued(plans, label, coalesce, ids));
    queue = run.catch(() => false);
    return run;
}

let queue: Promise<unknown> = Promise.resolve();

async function sendQueued(
    plans: { sel: Selected; ops: SvgOp[] }[],
    label: string,
    coalesce?: string,
    ids?: Record<string, string>,
): Promise<boolean> {
    const slide = currentSlide();
    if (!slide) return false;
    let ok = true;
    plans = withConnectors(plans);
    const cells = diagramPlans(plans);
    plans = cells.plans;
    // draw.io's redraw of an edited diagram joins this step.
    if (cells.diagrams.size && !coalesce) coalesce = `diagram-${Date.now()}`;
    for (const [path, ops] of opsByFile(plans)) {
        const src = slide.sources?.find((s) => s.path === path);
        if (src && src.usedBy.length > 1 && ed.layoutMode) {
            // Layout edits change every slide built on the file; say so once.
            toast(`Edited ${src.rel}: affects ${src.usedBy.length} slides`);
        }
        const result = await edit({
            action: "svg",
            file: path,
            hash: src?.hash ?? "",
            ops,
            label,
            coalesce,
            // Deleting or duplicating a zone takes its content along (not in
            // layout mode: a layout's zones are filled by every slide).
            zoneSlide: ed.layoutMode ? undefined : slide.deckIndex,
        });
        ok = ok && result.ok;
        if (ids && result.ids) Object.assign(ids, result.ids);
    }
    if (ok && coalesce) {
        for (const diagram of cells.diagrams)
            hooks.diagramEdited(diagram, coalesce);
    }
    return ok;
}

export function applyPlanToDom(el: Element, plan: AttrPlan): void {
    for (const [k, v] of Object.entries(plan)) {
        if (v == null) el.removeAttribute(k);
        else el.setAttribute(k, v);
    }
}

function textChildren(el: Element): Element[] {
    return [...el.querySelectorAll("tspan")].filter(
        (t) => t.hasAttribute("x") || t.hasAttribute("y"),
    );
}

// A move as attribute ops for one element (and its positioned tspans).
export function moveOps(sel: Selected, dx: number, dy: number): SvgOp[] {
    if (isConnector(sel.el) && sel.el.getAttribute("d")) {
        return connectorMoveOps(sel, dx, dy);
    }
    const kids = textChildren(sel.el);
    const plan = planMove(
        elementGeom(sel.el),
        dx,
        dy,
        kids.map((k) => ({
            attrs: { x: k.getAttribute("x"), y: k.getAttribute("y") },
        })),
    );
    const ops: SvgOp[] = [{ kind: "attrs", loc: sel.loc, set: plan.attrs }];
    applyPlanToDom(sel.el, plan.attrs);
    plan.children?.forEach((p, i) => {
        const loc = kids[i].getAttribute("data-ink");
        if (loc && Object.keys(p).length) {
            ops.push({ kind: "attrs", loc, set: p });
            applyPlanToDom(kids[i], p);
        }
    });
    return ops;
}

export async function nudge(dx: number, dy: number): Promise<void> {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length) return;
    movingTogether = sels.map((s) => s.el);
    // Shapes first, then connectors, which route to where the shapes went.
    const ordered = [
        ...sels.filter((s) => !isConnector(s.el)),
        ...sels.filter((s) => isConnector(s.el)),
    ];
    const plans = ordered.map((sel) => ({ sel, ops: moveOps(sel, dx, dy) }));
    drawOverlay();
    await sendSvgOps(plans, "Nudge", "nudge");
}

// ── Pointer interaction ──

interface Snapshot {
    sel: Selected;
    attrs: Record<string, string | null>;
    kids: { el: Element; x: string | null; y: string | null }[];
    box: Box;
    geom: ElementGeom;
}

function snapshot(sel: Selected): Snapshot {
    const attrs: Record<string, string | null> = {};
    for (const a of GEOM_ATTRS) attrs[a] = sel.el.getAttribute(a);
    return {
        sel,
        attrs,
        kids: textChildren(sel.el).map((el) => ({
            el,
            x: el.getAttribute("x"),
            y: el.getAttribute("y"),
        })),
        box: slideBox(sel.el) ?? { x: 0, y: 0, width: 0, height: 0 },
        geom: elementGeom(sel.el),
    };
}

function restore(snaps: Snapshot[]): void {
    for (const s of snaps) {
        applyPlanToDom(s.sel.el, s.attrs);
        for (const k of s.kids) {
            applyPlanToDom(k.el, { x: k.x, y: k.y });
        }
    }
}

function snapTargets(exclude: Set<Element>): SnapTargets {
    const svg = slideRoot();
    const boxes: Box[] = [];
    if (svg) {
        for (const el of svg.querySelectorAll("[data-ink-top]")) {
            if (exclude.has(el) || [...exclude].some((x) => x.contains(el)))
                continue;
            const b = slideBox(el);
            // Skip full-bleed backgrounds: their edges are the slide's own.
            if (b && b.width > 0 && b.height > 0) boxes.push(b);
        }
    }
    return targetsFor(slideSize(), boxes);
}

type Drag =
    | { kind: "move"; snaps: Snapshot[]; start: Box; targets: SnapTargets }
    | {
          kind: "resize";
          handle: Handle;
          snaps: Snapshot[];
          start: Box;
          targets: SnapTargets;
      }
    | { kind: "rotate"; snaps: Snapshot[]; center: { x: number; y: number } }
    | { kind: "endpoint"; which: "start" | "end"; snaps: Snapshot[] }
    | { kind: "bend"; snaps: Snapshot[] }
    | { kind: "marquee"; additive: boolean };

let pointer: {
    id: number;
    x: number;
    y: number;
    started: boolean;
    drag: Drag | null;
    clickTarget: SVGGraphicsElement | null;
    shift: boolean;
    deselectOnClick: boolean;
} | null = null;

function beginDrag(handle: Handle | null): Drag | null {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    if (!sels.length || sels.length !== ed.selection.length || ed.step != null)
        return null;
    const snaps = sels.map(snapshot);
    const start = unionBoxes(snaps.map((s) => s.box));
    if (!start) return null;
    if (handle === "c-bend") return { kind: "bend", snaps };
    if (handle === "c-start" || handle === "c-end") {
        return {
            kind: "endpoint",
            which: handle === "c-start" ? "start" : "end",
            snaps,
        };
    }
    const targets = snapTargets(new Set(sels.map((s) => s.el)));
    if (handle === "rot") {
        return {
            kind: "rotate",
            snaps,
            center: {
                x: start.x + start.width / 2,
                y: start.y + start.height / 2,
            },
        };
    }
    if (handle) return { kind: "resize", handle, snaps, start, targets };
    return { kind: "move", snaps, start, targets };
}

function resizedBox(
    start: Box,
    handle: Handle,
    dx: number,
    dy: number,
    keepAspect: boolean,
): Box {
    let { x, y, width, height } = start;
    if (handle.includes("w")) {
        x += dx;
        width -= dx;
    }
    if (handle.includes("e")) width += dx;
    if (handle.includes("n")) {
        y += dy;
        height -= dy;
    }
    if (handle.includes("s")) height += dy;
    if (keepAspect && start.width > 0 && start.height > 0) {
        const ratio = start.width / start.height;
        const corner = handle.length === 2;
        if (corner || handle === "e" || handle === "w") {
            const h2 = width / ratio;
            if (handle.includes("n")) y += height - h2;
            else if (!corner) y = start.y + (start.height - h2) / 2;
            height = h2;
        } else {
            const w2 = height * ratio;
            x = start.x + (start.width - w2) / 2;
            width = w2;
        }
    }
    // Dragging past the opposite edge flips the box rather than inverting it.
    if (width < 0) {
        x += width;
        width = -width;
    }
    if (height < 0) {
        y += height;
        height = -height;
    }
    return { x, y, width: Math.max(width, 1), height: Math.max(height, 1) };
}

function keepsAspect(snaps: Snapshot[], shift: boolean): boolean {
    const natural = snaps.some((s) =>
        ["text", "image", "circle"].includes(s.geom.sourceTag),
    );
    return natural !== shift;
}

function mapBox(b: Box, from: Box, to: Box): Box {
    const sx = from.width ? to.width / from.width : 1;
    const sy = from.height ? to.height / from.height : 1;
    return {
        x: to.x + (b.x - from.x) * sx,
        y: to.y + (b.y - from.y) * sy,
        width: b.width * sx,
        height: b.height * sy,
    };
}

let lastPlans: { sel: Selected; ops: SvgOp[] }[] = [];

// What a drag reads from its pointer event; a modifier key pressed or let go
// mid-drag replays the last position with the new keys.
type DragInput = Pick<
    PointerEvent,
    "clientX" | "clientY" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
>;
let lastInput: DragInput | null = null;

// Ctrl (Cmd on a Mac) held while moving copies instead: the originals stay
// put (shown by stand-ins while dragging) and copies land where dropped.
let copying = false;
let ghosts: Element[] = [];

function showGhosts(snaps: Snapshot[]): void {
    if (ghosts.length) return;
    for (const s of snaps) {
        const ghost = s.sel.el.cloneNode(true) as Element;
        for (const node of [ghost, ...ghost.querySelectorAll("*")]) {
            for (const attr of [...node.attributes]) {
                if (attr.name === "id" || attr.name.startsWith("data-ink")) {
                    node.removeAttribute(attr.name);
                }
            }
        }
        ghost.setAttribute("pointer-events", "none");
        // Below the original, which is what moves (and becomes the copy).
        s.sel.el.before(ghost);
        ghosts.push(ghost);
    }
}

function dropGhosts(): void {
    for (const g of ghosts) g.remove();
    ghosts = [];
}

function setCopying(on: boolean): void {
    copying = on;
    document.body.classList.toggle("drag-copy", on);
    if (!on) dropGhosts();
}

function updateDrag(drag: Drag, e: DragInput): void {
    lastInput = e;
    if (!pointer) return;
    const p0 = clientToSlide(pointer.x, pointer.y);
    const p1 = clientToSlide(e.clientX, e.clientY);
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const threshold = SNAP_PX / scale();
    guides = { xs: [], ys: [] };
    if (drag.kind === "move") {
        if (e.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
        }
        if (!e.altKey) {
            const moved = {
                ...drag.start,
                x: drag.start.x + dx,
                y: drag.start.y + dy,
            };
            const snap = snapBox(moved, drag.targets, threshold);
            dx += snap.dx;
            dy += snap.dy;
            guides = { xs: snap.guidesX, ys: snap.guidesY };
        }
        restore(drag.snaps);
        setCopying(e.ctrlKey || e.metaKey);
        if (copying) showGhosts(drag.snaps);
        movingTogether = drag.snaps.map((s) => s.sel.el);
        const ordered = [
            ...drag.snaps.filter((s) => !isConnector(s.sel.el)),
            ...drag.snaps.filter((s) => isConnector(s.sel.el)),
        ];
        const plans = ordered.map((s) => ({
            sel: s.sel,
            ops: moveOps(s.sel, dx, dy),
        }));
        // Arrows attached to the originals stay with the originals.
        lastPlans = copying ? plans : withConnectors(plans);
    } else if (drag.kind === "resize") {
        if (!e.altKey) {
            const h = drag.handle;
            const edgesX: number[] = [];
            const edgesY: number[] = [];
            if (h.includes("w")) edgesX.push(drag.start.x + dx);
            if (h.includes("e"))
                edgesX.push(drag.start.x + drag.start.width + dx);
            if (h.includes("n")) edgesY.push(drag.start.y + dy);
            if (h.includes("s"))
                edgesY.push(drag.start.y + drag.start.height + dy);
            const snap = snapEdges(edgesX, edgesY, drag.targets, threshold);
            dx += snap.dx;
            dy += snap.dy;
            guides = { xs: snap.guidesX, ys: snap.guidesY };
        }
        const cropping = ed.cropMode && drag.snaps.length === 1;
        const to = resizedBox(
            drag.start,
            drag.handle,
            dx,
            dy,
            !cropping && keepsAspect(drag.snaps, e.shiftKey),
        );
        restore(drag.snaps);
        lastPlans = drag.snaps.map((s) => {
            const target = mapBox(s.box, drag.start, to);
            const plan =
                (cropping && planCrop(s.geom, s.box, target)) ||
                planResize(s.geom, s.box, target);
            applyPlanToDom(s.sel.el, plan);
            return {
                sel: s.sel,
                ops: [{ kind: "attrs", loc: s.sel.loc, set: plan }],
            };
        });
    } else if (drag.kind === "rotate") {
        const c = drag.center;
        const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
        const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
        let deg = ((a1 - a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        restore(drag.snaps);
        lastPlans = drag.snaps.map((s) => {
            const plan = planRotate(s.geom, deg, c);
            applyPlanToDom(s.sel.el, plan);
            return {
                sel: s.sel,
                ops: [{ kind: "attrs", loc: s.sel.loc, set: plan }],
            };
        });
    } else if (drag.kind === "endpoint") {
        restore(drag.snaps);
        lastPlans = endpointPlans(drag, p1, e);
    } else if (drag.kind === "bend") {
        restore(drag.snaps);
        lastPlans = bendPlans(drag, p1);
    } else if (drag.kind === "marquee") {
        marquee = {
            x: Math.min(p0.x, p1.x),
            y: Math.min(p0.y, p1.y),
            width: Math.abs(p1.x - p0.x),
            height: Math.abs(p1.y - p0.y),
        };
    }
    drawOverlay();
}

async function endDrag(drag: Drag): Promise<void> {
    guides = { xs: [], ys: [] };
    if (drag.kind === "marquee") {
        const m = marquee;
        marquee = null;
        if (!m) return;
        const svg = slideRoot();
        if (!svg) return;
        const hits = [...svg.querySelectorAll("[data-ink-top]")].filter(
            (el) => {
                if (!selectable(el) || !canTransform(el)) return false;
                const b = slideBox(el);
                return (
                    !!b &&
                    b.x >= m.x &&
                    b.y >= m.y &&
                    b.x + b.width <= m.x + m.width &&
                    b.y + b.height <= m.y + m.height
                );
            },
        ) as SVGGraphicsElement[];
        if (drag.additive) {
            for (const el of hits) addToSelection(el, false);
            select(ed.selection.map((s) => s.el));
        } else select(hits);
        return;
    }
    const plans = lastPlans;
    lastPlans = [];
    if (drag.kind === "move" && copying) {
        setCopying(false);
        restore(drag.snaps);
        drawOverlay();
        await dropCopies(plans);
        return;
    }
    drawOverlay();
    if (!plans.length) return;
    if (siteHints.length) siteHints = [];
    const label =
        drag.kind === "endpoint"
            ? "Connect"
            : drag.kind === "bend"
              ? "Reshape arrow"
              : drag.kind === "move"
                ? "Move"
                : drag.kind === "resize"
                  ? ed.cropMode
                      ? "Crop"
                      : "Resize"
                  : "Rotate";
    const ok = await sendSvgOps(plans, label);
    if (!ok) restore(drag.snaps);
    drawOverlay();
}

// The moves a drag planned, sent as copies placed where the originals would
// have gone: each copy takes the attributes the move set on its original.
async function dropCopies(
    plans: { sel: Selected; ops: SvgOp[] }[],
): Promise<void> {
    const keys: string[] = [];
    const copies = plans.map((p, i) => {
        const set: AttrPlan = {};
        const kids: { loc: string; set: AttrPlan }[] = [];
        for (const op of p.ops) {
            if (op.kind !== "attrs") continue;
            if (op.loc === p.sel.loc) Object.assign(set, op.set);
            else kids.push({ loc: String(op.loc), set: op.set as AttrPlan });
        }
        keys.push(`copy${i}`);
        return {
            sel: p.sel,
            ops: [
                {
                    kind: "duplicate",
                    loc: p.sel.loc,
                    key: `copy${i}`,
                    set,
                    kids,
                },
            ],
        };
    });
    const ids: Record<string, string> = {};
    if (await sendSvgOps(copies, "Duplicate", undefined, ids)) {
        const made = keys.map((k) => ids[k]).filter(Boolean);
        if (made.length) hooks.selectAfterRender(made);
    }
}

function onPointerDown(e: PointerEvent): void {
    ed.focus = "canvas";
    if (ed.slideSelection.size) {
        ed.slideSelection.clear();
        emit("slide-selection");
    }
    const target = e.target as Element;
    const editing = hooks.editingHost();
    if (editing) {
        if (editing.contains(target)) return;
        hooks.finishEditing();
    }
    if (!slideRoot()) return;
    if (
        e.button === 1 ||
        (e.button === 0 && e.altKey && ed.tool === "select")
    ) {
        // Middle-click (no autoscroll) or Alt+click: the next object down.
        e.preventDefault();
        cycleSelect(e);
        return;
    }
    if (e.button !== 0) return;
    const handle = (target.closest("[data-handle]") as SVGElement | null)
        ?.dataset.handle as Handle | undefined;
    const pt = clientToSlide(e.clientX, e.clientY);
    if (!handle && ed.tool !== "select") {
        if (hooks.toolDown(e, pt)) return;
    }
    try {
        paper.setPointerCapture(e.pointerId);
    } catch {
        // A touch replayed as it lifts (editor/touchzoom.ts): no capture.
    }
    e.preventDefault();
    ed.interacting = true;
    let clickTarget: SVGGraphicsElement | null = null;
    let drag: Drag | null = null;
    let deselectOnClick = false;
    if (handle) {
        drag = beginDrag(handle);
    } else {
        clickTarget = pick(e.clientX, e.clientY);
        if (clickTarget) {
            const already = ed.selection.some((s) => s.el === clickTarget);
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                // Taken out of the selection on release, unless it was
                // dragged (Ctrl+drag copies, Shift+drag keeps to one axis).
                if (already) deselectOnClick = true;
                else addToSelection(clickTarget);
            } else if (!already) select([clickTarget]);
        } else {
            if (!e.shiftKey) {
                if (ed.scope && !ed.scope.contains(target)) enterGroup(null);
                clearSelection();
            }
            drag = { kind: "marquee", additive: e.shiftKey };
        }
    }
    pointer = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        started: false,
        drag,
        clickTarget,
        shift: e.shiftKey,
        deselectOnClick,
    };
}

function onPointerMove(e: PointerEvent): void {
    if (!pointer) {
        if (ed.tool === "select" && e.buttons === 0) {
            const el = pick(e.clientX, e.clientY);
            if (el !== hoverEl) {
                hoverEl = el;
                drawOverlay();
            }
        } else if (ed.tool in CONNECTOR_TOOLS && e.buttons === 0) {
            // The connection sites a line or arrow would attach to.
            const p = clientToSlide(e.clientX, e.clientY);
            const hit = e.altKey ? null : siteAt(p, null);
            const under = attachTargetAt(e.clientX, e.clientY);
            const hints = [
                ...(under
                    ? [
                          {
                              el: under as Element,
                              active: hit?.el === under ? hit.site : null,
                          },
                      ]
                    : []),
                ...(hit && hit.el !== under
                    ? [{ el: hit.el, active: hit.site }]
                    : []),
            ];
            if (hints.length || siteHints.length) showSites(hints);
        }
        return;
    }
    if (e.pointerId !== pointer.id) return;
    if (!pointer.started) {
        const dist = Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y);
        if (dist < DRAG_THRESHOLD) return;
        pointer.started = true;
        if (!pointer.drag && pointer.clickTarget)
            pointer.drag = beginDrag(null);
        if (
            pointer.drag?.kind === "move" &&
            !canTransform(pointer.clickTarget!)
        ) {
            pointer.drag = null;
        }
    }
    if (pointer.drag) updateDrag(pointer.drag, e);
}

async function onPointerUp(e: PointerEvent): Promise<void> {
    if (!pointer || e.pointerId !== pointer.id) return;
    const p = pointer;
    pointer = null;
    lastInput = null;
    try {
        if (p.drag && p.started) await endDrag(p.drag);
        else if (p.drag?.kind === "marquee") marquee = null;
        if (!p.started && p.deselectOnClick && p.clickTarget) {
            ed.selection = ed.selection.filter((s) => s.el !== p.clickTarget);
            drawOverlay();
            emit("selection");
        }
    } finally {
        setCopying(false);
        ed.interacting = false;
        if (ed.renderPending) render();
        else drawOverlay();
    }
}

function textUnder(x: number, y: number): SVGGraphicsElement | null {
    const svg = slideRoot();
    for (const hit of document.elementsFromPoint(x, y)) {
        const t = hit.closest("text");
        if (t && svg?.contains(t) && t.hasAttribute("data-ink")) {
            return t as SVGGraphicsElement;
        }
    }
    return null;
}

function onDoubleClick(e: MouseEvent): void {
    if (hooks.editingHost()?.contains(e.target as Node)) return;
    const el = pick(e.clientX, e.clientY);
    if (!el) {
        // Nothing here: double-clicking the slide's empty area fits it.
        if (ed.tool === "select") setZoom(0);
        return;
    }
    if (canTypeInto(el)) {
        hooks.typeInto(el);
        return;
    }
    if (isZone(el)) {
        hooks.editZone(zoneName(el), el, { x: e.clientX, y: e.clientY });
        return;
    }
    // Text inside a group is edited straight away, as in any slide editor; the
    // group is entered so the selection shows what is being edited.
    const text = textUnder(e.clientX, e.clientY);
    if (text && el.contains(text)) {
        if (text !== el && !text.hasAttribute("data-ink-top")) {
            enterGroup(text.parentElement as unknown as SVGGElement);
        }
        select([text]);
        hooks.editText(text);
        return;
    }
    // A diagram's shape: its label (a shape holding others is entered).
    if (
        isDiagramCell(el) &&
        !el.querySelector('g[data-cell-kind="vertex"][data-ink]')
    ) {
        select([el]);
        hooks.cellLabel(el);
        return;
    }
    if (el.localName === "g") {
        enterGroup(el as unknown as SVGGElement);
        const inner = pick(e.clientX, e.clientY);
        if (inner) select([inner]);
        return;
    }
    // A diagram whose shapes are edited here is entered like a group (its
    // draw.io layer under the pointer); others open in draw.io.
    if (
        el.hasAttribute("data-drawio") &&
        shapesEditable(el) &&
        canTransform(el)
    ) {
        enterDiagram(el, e.clientX, e.clientY);
        return;
    }
    // A draw.io diagram opens in draw.io; any other picture crops.
    if (canTransform(el) && hooks.diagram(el)) return;
    // Double-clicking a picture crops it, as in Google Slides.
    if (
        canTransform(el) &&
        (el.localName === "image" ||
            (el.localName === "svg" &&
                [...el.children].some((c) => c.localName === "image")))
    ) {
        hooks.crop(el);
    }
}

function enterDiagram(diagram: Element, x: number, y: number): void {
    const layers = [
        ...diagram.querySelectorAll<SVGGElement>(
            'g[data-cell-kind="other"][data-ink]',
        ),
    ];
    const under = document
        .elementsFromPoint(x, y)
        .map((hit) => layers.find((l) => l.contains(hit)))
        .find((l) => !!l);
    const layer = under ?? layers[0];
    if (!layer) {
        toast("This diagram has no shapes to edit here", "error");
        return;
    }
    enterGroup(layer);
    const inner = pick(x, y);
    if (inner) select([inner]);
    else toast("Click a shape of the diagram; Esc leaves it");
}

/**
 * Plans on a diagram's shapes, as edits of the diagram's source
 * (editor/drawioedit.py): a move or resize becomes the shape's new box on
 * draw.io's page, a delete removes it; anything else is draw.io's to do.
 */
function diagramPlans(plans: { sel: Selected; ops: SvgOp[] }[]): {
    plans: { sel: Selected; ops: SvgOp[] }[];
    diagrams: Set<Element>;
} {
    const diagrams = new Set<Element>();
    const out: { sel: Selected; ops: SvgOp[] }[] = [];
    let refused = false;
    for (const plan of plans) {
        if (sourceOf(plan.sel.key)?.role !== "diagram") {
            out.push(plan);
            continue;
        }
        const el = plan.sel.el;
        const diagram = el.closest("svg[data-drawio]");
        const cell = el.getAttribute("data-cell-id");
        if (!diagram || !cell) continue;
        const ops: SvgOp[] = [];
        let moved = false;
        for (const op of plan.ops) {
            if (op.kind === "delete") ops.push({ kind: "cell-delete", cell });
            else if (String(op.kind).startsWith("cell-")) ops.push(op);
            else if (geometryChanged([op])) moved = true;
            else refused = true;
        }
        if (moved) {
            const offset = pageOffset(diagram);
            const box = offset ? pageBox(el, offset) : null;
            if (offset && box) {
                ops.push({
                    kind: "cell-geometry",
                    cell,
                    ...box,
                    offset: [offset.x, offset.y],
                });
            }
        }
        if (ops.length) {
            out.push({ sel: plan.sel, ops });
            diagrams.add(diagram);
        }
    }
    if (refused) {
        toast(
            "That change to a diagram's shapes is made in draw.io (Edit diagram)",
            "error",
        );
    }
    return { plans: out, diagrams };
}

export function initCanvas(): void {
    paper.addEventListener("pointerdown", onPointerDown);
    // No autoscroll or "open link in new tab" on the middle button.
    for (const type of ["mousedown", "auxclick"]) {
        paper.addEventListener(type, (e) => {
            if ((e as MouseEvent).button === 1) e.preventDefault();
        });
    }
    paper.addEventListener("pointermove", onPointerMove);
    for (const type of ["keydown", "keyup"] as const) {
        window.addEventListener(type, (e) => {
            if (!["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
            if (!pointer?.started || !pointer.drag || !lastInput) return;
            updateDrag(pointer.drag, {
                clientX: lastInput.clientX,
                clientY: lastInput.clientY,
                shiftKey: e.shiftKey,
                altKey: e.altKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
            });
        });
    }
    paper.addEventListener("pointerup", (e) => void onPointerUp(e));
    paper.addEventListener("pointercancel", (e) => void onPointerUp(e));
    paper.addEventListener("dblclick", onDoubleClick);
    paper.addEventListener("pointerleave", () => {
        if (siteHints.length) showSites([]);
        if (hoverEl) {
            hoverEl = null;
            drawOverlay();
        }
    });
    new ResizeObserver(() => layoutPaper()).observe(canvas);
    // Clicking the grey area around the slide clears the selection;
    // double-clicking it fits the slide.
    canvas.addEventListener("pointerdown", (e) => {
        if (e.target === canvas) {
            enterGroup(null);
            clearSelection();
        }
    });
    canvas.addEventListener("dblclick", (e) => {
        if (e.target === canvas) setZoom(0);
    });
    on("model", render);
    on("rerender", render);
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

function clampZoom(z: number): number {
    return z <= 0 ? 0 : Math.max(MIN_ZOOM, Math.min(z, MAX_ZOOM));
}

// Zoom to `z` (0: fit) keeping the slide point under `about` in place; by
// default the one at the canvas's centre (the zoom buttons and keys).
export function setZoom(z: number, about?: Pt): void {
    const c = canvas.getBoundingClientRect();
    const at = about ?? { x: c.left + c.width / 2, y: c.top + c.height / 2 };
    anchor.reset();
    zoomTo(clampZoom(z), at, at);
}

// Zoom by `factor` about client point `from`, then scroll so the slide point
// that was under `from` sits under `to` (a pinch's midpoint pans as it
// zooms). One call per frame of a gesture; zoomEnded() when it is over.
export function zoomAbout(factor: number, from: Pt, to: Pt): void {
    zoomTo(clampZoom(scale() * factor), from, to);
}

export function zoomEnded(): void {
    anchor.reset();
}

const anchor = new ZoomAnchor();

// The paper is laid out at the new size and the canvas scrolled by however
// far the anchored slide point landed from where it belongs. While zoomed,
// the canvas is padded by half its size on every side (layoutPaper), so the
// paper can sit off-centre and a zoom about any point over it holds that
// point; the slide still always covers the canvas's centre, so scrolling
// never loses it.
function zoomTo(z: number, from: Pt, to: Pt): void {
    const p =
        z > 0 && slideRoot()
            ? anchor.point(from, (c) => clientToSlide(c.x, c.y))
            : null;
    ed.zoom = z;
    layoutPaper();
    if (p) {
        const m = rootCTM();
        const now = {
            x: m.a * p.x + m.c * p.y + m.e,
            y: m.b * p.x + m.d * p.y + m.f,
        };
        const fix = scrollCorrection(now, to);
        if (fix.x) canvas.scrollLeft += fix.x;
        if (fix.y) canvas.scrollTop += fix.y;
        anchor.settle(to, p);
    } else anchor.reset();
    emit("zoom");
}
