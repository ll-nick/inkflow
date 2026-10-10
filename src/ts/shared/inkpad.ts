// Drawing with a pen on a slide: pointer input in, strokes out. Shared by the
// presenter (presenter/ink.ts) and the editor (editor/ink.ts), which decide
// which pointers draw and what happens to a finished stroke.
//
// Latency is what makes ink feel like ink, so the pointer path stays small:
// every coalesced sample of a move is kept (a pen reports far more often than
// the page paints), the stroke is drawn once per animation frame as a single
// path straight into the slide's own <svg> (its user units, so zoom, resizes
// and the slide's own transitions need nothing extra), and the predicted
// samples the browser offers extend the live stroke towards where the pen is
// now. A finished stroke is the same path with its final outline, so nothing
// jumps when the pen lifts.

import {
    type Box,
    bboxOf,
    eraserHits,
    finish,
    HIGHLIGHTER_OPACITY,
    type InkStroke,
    type InkTool,
    type InputPoint,
    type LiveStroke,
    newInkId,
    outlineOf,
    type PenTool,
    pathData,
    polygonOf,
    type StrokeStyle,
} from "./ink";

const SVG_NS = "http://www.w3.org/2000/svg";
const ERASER_RADIUS_PX = 10;
// A pen's palm: a touch that lands while a pen is near the screen is a hand
// resting on it, not a tap, so it neither draws nor navigates.
const PALM_MS = 1500;
// The click a stroke ends with (and a swallowed palm's) must not reach the
// page, where it would advance the slide or select something.
const SWALLOW_MS = 400;

export interface PadHost {
    // Pointer events are taken from here (capture phase, before the page).
    surface: HTMLElement;
    // Ink is on (the presenter's ink mode, the editor's pen tool).
    active(): boolean;
    // A mouse and a finger draw too, not only a pen.
    fingers(): boolean;
    // The palette's tool; a pen's eraser end erases whatever this says.
    tool(): InkTool;
    // The page's veto for this pointer (a zoom gesture, an open dialog).
    allows?(e: PointerEvent): boolean;
    // The slide to draw on; null while there is none (or it is mid-transition).
    svg(): SVGSVGElement | null;
    style(tool: PenTool, svg: SVGSVGElement): StrokeStyle;
    // Strokes the eraser may take: paths whose id is a stroke id.
    erasables(svg: SVGSVGElement): Iterable<SVGGraphicsElement>;
    // The live stroke's new samples, once per frame (for relays).
    onDraw?(live: LiveStroke, from: number, points: InputPoint[]): void;
    onStroke(stroke: InkStroke, live: LiveStroke): void;
    // A stroke abandoned (pointercancel, a slide change): relays drop it.
    onAbandon?(live: LiveStroke): void;
    // The eraser's gesture ended having touched these (already hidden).
    onErase(ids: string[], hidden: SVGGraphicsElement[]): void;
}

// A stroke as an element: the same shape whether live, finished, relayed or
// read back from an ink file (inkflow/ink.py writes these attributes).
export function paintStroke(
    el: SVGPathElement,
    s: StrokeStyle & { id?: string; d?: string; opacity?: number },
): SVGPathElement {
    if (s.id) el.id = s.id;
    if (s.d !== undefined) el.setAttribute("d", s.d);
    el.setAttribute("fill", s.fill);
    const classes = [
        ...(s.token ? [`inkflow-fill-${s.token}`] : []),
        ...(s.tool === "highlighter" ? ["inkflow-highlighter"] : []),
    ];
    el.setAttribute("class", classes.join(" "));
    const opacity =
        s.opacity ??
        (s.tool === "highlighter" ? HIGHLIGHTER_OPACITY : undefined);
    if (opacity !== undefined && opacity < 1)
        el.setAttribute("fill-opacity", String(opacity));
    else el.removeAttribute("fill-opacity");
    el.setAttribute("inkflow:tool", s.tool);
    el.setAttribute("inkflow:size", String(Math.round(s.size * 100) / 100));
    return el;
}

export function strokeElement(stroke: InkStroke): SVGPathElement {
    return paintStroke(
        document.createElementNS(SVG_NS, "path") as SVGPathElement,
        stroke,
    );
}

// A saved stroke read back from the DOM, so an erased one can be put back.
export function strokeOf(el: Element): InkStroke | null {
    const d = el.getAttribute("d");
    const fill = el.getAttribute("fill");
    if (!el.id || !d || !fill) return null;
    const token =
        (el.getAttribute("class") ?? "")
            .split(/\s+/)
            .find((c) => c.startsWith("inkflow-fill-"))
            ?.slice("inkflow-fill-".length) ?? null;
    const tool =
        el.getAttribute("inkflow:tool") === "highlighter"
            ? "highlighter"
            : "pen";
    const stroke: InkStroke = {
        id: el.id,
        tool,
        fill,
        token,
        size: Number(el.getAttribute("inkflow:size")) || 1,
        d,
    };
    const opacity = Number(el.getAttribute("fill-opacity"));
    if (opacity > 0 && opacity < 1) stroke.opacity = opacity;
    return stroke;
}

interface Shape {
    d: string;
    poly: number[];
    box: Box;
}

const shapes = new WeakMap<Element, Shape>();

function shapeOf(el: Element): Shape {
    const d = el.getAttribute("d") ?? "";
    let shape = shapes.get(el);
    if (!shape || shape.d !== d) {
        const poly = polygonOf(d);
        shape = { d, poly, box: bboxOf(poly) };
        shapes.set(el, shape);
    }
    return shape;
}

interface DrawGesture {
    kind: "draw";
    pointerId: number;
    inv: DOMMatrix;
    minDist: number;
    live: LiveStroke;
    points: InputPoint[];
    predicted: InputPoint[];
    sent: number;
    path: SVGPathElement;
}

interface EraseGesture {
    kind: "erase";
    pointerId: number;
    svg: SVGSVGElement;
    inv: DOMMatrix;
    last: { x: number; y: number };
    hits: Map<string, SVGGraphicsElement>;
    // Each candidate's client → local matrix, measured once per gesture.
    local: Map<SVGGraphicsElement, DOMMatrix>;
    cursor: SVGCircleElement;
}

export class InkPad {
    private host: PadHost;
    private gesture: DrawGesture | EraseGesture | null = null;
    private frame = 0;
    private lastPenAt = -Infinity;
    private swallowUntil = -Infinity;
    private swallowAt = { x: Number.NaN, y: Number.NaN };

    constructor(host: PadHost) {
        this.host = host;
        const s = host.surface;
        s.addEventListener("pointerdown", (e) => this.down(e), {
            capture: true,
        });
        s.addEventListener("pointermove", (e) => this.move(e), {
            capture: true,
        });
        s.addEventListener("pointerup", (e) => this.up(e, false), {
            capture: true,
        });
        s.addEventListener("pointercancel", (e) => this.up(e, true), {
            capture: true,
        });
        // Touch events still fire for a pointer that draws; the page's own
        // swipe handling must not see them (it would turn a stroke into a
        // slide change).
        for (const type of ["touchstart", "touchmove", "touchend"]) {
            s.addEventListener(type, (e) => this.claimTouch(e), {
                capture: true,
                passive: false,
            });
        }
        window.addEventListener("click", (e) => this.claimClick(e), true);
        s.addEventListener("contextmenu", (e) => this.claimClick(e), true);
    }

    // A stroke or an erase is in progress.
    get busy(): boolean {
        return this.gesture !== null;
    }

    // Drop the gesture in progress (the slide is going away).
    cancel(): void {
        const g = this.gesture;
        if (!g) return;
        this.gesture = null;
        cancelAnimationFrame(this.frame);
        if (g.kind === "draw") {
            g.path.remove();
            this.host.onAbandon?.(g.live);
        } else {
            for (const el of g.hits.values())
                el.style.removeProperty("display");
            g.cursor.remove();
        }
    }

    private claimTouch(e: Event): void {
        if (this.gesture || performance.now() < this.swallowUntil) {
            e.stopPropagation();
            if (e.cancelable && e.type !== "touchstart") e.preventDefault();
        }
    }

    // Only the click the browser makes of a gesture's own press and release
    // (where the pointer let go, just after): a click elsewhere, such as on
    // the palette right after a stroke, is the user's.
    private claimClick(e: MouseEvent): void {
        const near =
            Math.hypot(
                e.clientX - this.swallowAt.x,
                e.clientY - this.swallowAt.y,
            ) < 16;
        if (this.gesture || (performance.now() < this.swallowUntil && near)) {
            e.stopPropagation();
            e.preventDefault();
        }
    }

    private swallow(e: PointerEvent): void {
        e.preventDefault();
        e.stopPropagation();
        this.swallowUntil = performance.now() + SWALLOW_MS;
        this.swallowAt = { x: e.clientX, y: e.clientY };
    }

    private down(e: PointerEvent): void {
        if (e.pointerType === "pen") this.lastPenAt = performance.now();
        if (this.gesture) {
            // A second finger or a palm while drawing: ignored entirely.
            if (e.pointerId !== this.gesture.pointerId) this.swallow(e);
            return;
        }
        if (!this.host.active() || this.host.allows?.(e) === false) return;
        if (e.pointerType !== "pen" && !this.host.fingers()) {
            if (
                e.pointerType === "touch" &&
                performance.now() - this.lastPenAt < PALM_MS
            ) {
                this.swallow(e);
            }
            return;
        }
        // Button 5 is a pen's eraser end; any other button but the main one
        // (a right click, a pen's barrel button) stays the page's.
        if (e.button !== 0 && e.button !== 5) return;
        const tool = e.button === 5 ? "eraser" : this.host.tool();
        const svg = this.host.svg();
        const ctm = svg?.getScreenCTM();
        if (!svg || !ctm) return;
        this.swallow(e);
        try {
            this.host.surface.setPointerCapture(e.pointerId);
        } catch {
            // A pointer the browser already let go of; it simply ends early.
        }
        const inv = ctm.inverse();
        const unitsPerPx = Math.hypot(inv.a, inv.b);
        const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(inv);
        if (tool === "eraser") {
            const cursor = document.createElementNS(
                SVG_NS,
                "circle",
            ) as SVGCircleElement;
            cursor.setAttribute("class", "inkflow-eraser-cursor");
            cursor.setAttribute("r", String(ERASER_RADIUS_PX * unitsPerPx));
            cursor.setAttribute("cx", String(at.x));
            cursor.setAttribute("cy", String(at.y));
            cursor.setAttribute("stroke-width", String(1.5 * unitsPerPx));
            svg.appendChild(cursor);
            this.gesture = {
                kind: "erase",
                pointerId: e.pointerId,
                svg,
                inv,
                last: { x: e.clientX, y: e.clientY },
                hits: new Map(),
                local: new Map(),
                cursor,
            };
            this.erase(e.clientX, e.clientY);
            return;
        }
        const pen = e.pointerType === "pen";
        const style = this.host.style(tool, svg);
        // A pen without pressure reports a constant 0.5 (0 when it has
        // none at all): its strokes thin with speed, like a mouse's.
        const simulate =
            tool === "pen" && (!pen || e.pressure === 0 || e.pressure === 0.5);
        const live: LiveStroke = { ...style, id: newInkId(), simulate };
        const path = paintStroke(
            document.createElementNS(SVG_NS, "path") as SVGPathElement,
            live,
        );
        path.classList.add("inkflow-live-stroke");
        svg.appendChild(path);
        this.gesture = {
            kind: "draw",
            pointerId: e.pointerId,
            inv,
            minDist: 0.4 * unitsPerPx,
            live,
            points: [[at.x, at.y, simulate ? 0.5 : e.pressure]],
            predicted: [],
            sent: 0,
            path,
        };
        this.schedule();
    }

    private move(e: PointerEvent): void {
        if (e.pointerType === "pen") this.lastPenAt = performance.now();
        const g = this.gesture;
        if (!g || e.pointerId !== g.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        const samples = e.getCoalescedEvents?.() ?? [];
        const events = samples.length ? samples : [e];
        if (g.kind === "erase") {
            for (const s of events) this.erase(s.clientX, s.clientY);
            return;
        }
        for (const s of events) this.sample(g, s, g.points);
        g.predicted = [];
        for (const p of e.getPredictedEvents?.() ?? []) {
            this.sample(g, p, g.predicted);
        }
        this.schedule();
    }

    private sample(g: DrawGesture, e: PointerEvent, into: InputPoint[]): void {
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(g.inv);
        const prev = into[into.length - 1] ?? g.points[g.points.length - 1];
        if (prev && Math.hypot(p.x - prev[0], p.y - prev[1]) < g.minDist)
            return;
        into.push([p.x, p.y, g.live.simulate ? 0.5 : e.pressure]);
    }

    private schedule(): void {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            const g = this.gesture;
            if (g?.kind !== "draw") return;
            const pts = g.predicted.length
                ? g.points.concat(g.predicted)
                : g.points;
            g.path.setAttribute(
                "d",
                pathData(outlineOf(pts, g.live, g.live.simulate, false), 2),
            );
            if (g.points.length > g.sent) {
                this.host.onDraw?.(g.live, g.sent, g.points.slice(g.sent));
                g.sent = g.points.length;
            }
        });
    }

    private erase(clientX: number, clientY: number): void {
        const g = this.gesture;
        if (g?.kind !== "erase") return;
        const at = new DOMPoint(clientX, clientY).matrixTransform(g.inv);
        g.cursor.setAttribute("cx", String(at.x));
        g.cursor.setAttribute("cy", String(at.y));
        const a = new DOMPoint(g.last.x, g.last.y);
        const b = new DOMPoint(clientX, clientY);
        g.last = { x: clientX, y: clientY };
        for (const el of this.host.erasables(g.svg)) {
            if (g.hits.has(el.id) || el.style.display === "none") continue;
            let local = g.local.get(el);
            if (!local) {
                const m = el.getScreenCTM();
                if (!m) continue;
                local = m.inverse();
                g.local.set(el, local);
            }
            const shape = shapeOf(el);
            const r = ERASER_RADIUS_PX * Math.hypot(local.a, local.b);
            if (
                eraserHits(
                    shape.poly,
                    shape.box,
                    a.matrixTransform(local),
                    b.matrixTransform(local),
                    r,
                )
            ) {
                el.style.display = "none";
                g.hits.set(el.id, el);
            }
        }
    }

    private up(e: PointerEvent, cancelled: boolean): void {
        const g = this.gesture;
        if (!g || e.pointerId !== g.pointerId) return;
        this.swallow(e);
        // The browser took the pointer back (a system gesture): nothing was
        // meant, so a stroke is dropped and what the eraser hid comes back.
        if (cancelled) {
            this.cancel();
            return;
        }
        this.gesture = null;
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        if (g.kind === "erase") {
            g.cursor.remove();
            if (g.hits.size)
                this.host.onErase([...g.hits.keys()], [...g.hits.values()]);
            return;
        }
        const stroke = finish(g.live, g.points);
        g.path.remove();
        if (stroke.d) this.host.onStroke(stroke, g.live);
        else this.host.onAbandon?.(g.live);
    }
}
