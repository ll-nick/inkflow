// Ink: strokes drawn with a pen on a slide, as numbers and strings only.
//
// A stroke is the polygon perfect-freehand computes around the pen's track,
// written as one filled SVG path, so a saved stroke needs nothing of inkflow's
// to render (inkflow/ink.py writes it). The pointer handling around this lives
// in inkpad.ts; this module stays pure so every rule here is unit-tested.

import { getStroke, type StrokeOptions } from "perfect-freehand";

export type PenTool = "pen" | "highlighter";
export type InkTool = PenTool | "eraser";

// An input sample: slide x, slide y, pressure 0..1.
export type InputPoint = [number, number, number];

// How a stroke is drawn, fixed when the pen goes down.
export interface StrokeStyle {
    tool: PenTool;
    fill: string; // #rrggbb, what any renderer shows
    token: string | null; // theme colour, which inkflow paints instead
    size: number; // diameter in slide units
}

// A stroke as it is drawn: what a relay sends while the pen is still down.
export interface LiveStroke extends StrokeStyle {
    id: string;
    // Pen pressure is not real (a mouse, a finger, a pen without it):
    // perfect-freehand derives it from the speed instead.
    simulate: boolean;
}

// A finished stroke: what is shown, relayed and saved.
export interface InkStroke extends StrokeStyle {
    id: string;
    d: string;
    opacity?: number;
}

export const HIGHLIGHTER_OPACITY = 0.35;

// Sizes are given for a 1920 x 1080 slide and scaled to the canvas actually
// drawn on, by the larger of the two ratios: a slide is shown fitted to a
// screen, so a preset looks the same on screen on a 16:9 slide, a phone-shaped
// one or an A0 poster (shown at a quarter of its width's scale).
export const REFERENCE_WIDTH = 1920;
export const REFERENCE_HEIGHT = 1080;

/** How much larger than on a 1920 x 1080 slide a stroke is drawn on a view
 * `width` x `height` slide units (0 or less: not known). */
export function inkScale(width: number, height = 0): number {
    const w = width > 0 ? width / REFERENCE_WIDTH : 0;
    const h = height > 0 ? height / REFERENCE_HEIGHT : 0;
    return Math.max(w, h) || 1;
}
export const PEN_SIZES = [3, 6, 12];
export const HIGHLIGHTER_SIZES = [20, 36, 60];

export interface Swatch {
    label: string;
    token: string | null;
    hex: string; // fallback when the theme does not define the token
}

// The theme's palette (painted through its tokens, so ink follows a light /
// dark switch) plus plain black and white, which mean the same in any theme.
export const SWATCHES: Swatch[] = [
    { label: "Black", token: null, hex: "#000000" },
    { label: "White", token: null, hex: "#ffffff" },
    { label: "Red", token: "red", hex: "#e64553" },
    { label: "Orange", token: "orange", hex: "#fe640b" },
    { label: "Yellow", token: "yellow", hex: "#df8e1d" },
    { label: "Green", token: "green", hex: "#40a02b" },
    { label: "Blue", token: "blue", hex: "#1e66f5" },
    { label: "Purple", token: "purple", hex: "#8839ef" },
];

const easeOutSine = (t: number) => Math.sin((t * Math.PI) / 2);

// perfect-freehand's settings per tool. The pen thins with pressure (real or
// simulated) like a fountain pen; the highlighter keeps one width and flat
// ends, like a chisel marker. A low streamline keeps the line close behind
// the pen, which reads as low latency; smoothing rounds the outline itself.
export function strokeOptions(
    style: Pick<StrokeStyle, "tool" | "size">,
    simulate: boolean,
    last: boolean,
): StrokeOptions {
    if (style.tool === "highlighter") {
        return {
            size: style.size,
            thinning: 0,
            smoothing: 0.5,
            streamline: 0.4,
            simulatePressure: false,
            start: { cap: false },
            end: { cap: false },
            last,
        };
    }
    return {
        size: style.size,
        thinning: 0.6,
        smoothing: 0.5,
        streamline: simulate ? 0.5 : 0.35,
        easing: easeOutSine,
        simulatePressure: simulate,
        last,
    };
}

export function outlineOf(
    points: InputPoint[],
    style: Pick<StrokeStyle, "tool" | "size">,
    simulate: boolean,
    last: boolean,
): number[][] {
    return getStroke(points, strokeOptions(style, simulate, last));
}

function round(v: number, decimals: number): string {
    const f = 10 ** decimals;
    const r = Math.round(v * f) / f;
    return String(Object.is(r, -0) ? 0 : r);
}

// The outline as path data: a closed curve through the midpoints of the
// outline's edges, each outline point the control point between two of them
// (the smoothest reading of the polygon perfect-freehand returns). Rounded to
// `decimals`: a tenth of a slide unit is well under a pixel, and every digit
// dropped shrinks the saved file.
export function pathData(outline: number[][], decimals = 1): string {
    const n = outline.length;
    if (n < 2) return "";
    const mid = (a: number[], b: number[]) => [
        (a[0] + b[0]) / 2,
        (a[1] + b[1]) / 2,
    ];
    const pt = (p: number[]) =>
        `${round(p[0], decimals)} ${round(p[1], decimals)}`;
    const parts = [`M${pt(mid(outline[n - 1], outline[0]))}Q`];
    for (let i = 0; i < n; i++) {
        const next = outline[(i + 1) % n];
        parts.push(`${pt(outline[i])} ${pt(mid(outline[i], next))}`);
    }
    return `${parts[0]}${parts.slice(1).join(" ")}Z`;
}

// The outline with every point dropped that lies within `tolerance` of the
// line its neighbours would draw instead (Douglas-Peucker). perfect-freehand
// places outline points far closer together than a smooth edge needs, so a
// finished stroke keeps a fraction of them at a tolerance well under a pixel.
export function simplify(outline: number[][], tolerance: number): number[][] {
    if (outline.length < 4 || tolerance <= 0) return outline;
    const keep = new Uint8Array(outline.length);
    keep[0] = 1;
    keep[outline.length - 1] = 1;
    const t2 = tolerance * tolerance;
    const stack: [number, number][] = [[0, outline.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop()!;
        const [ax, ay] = outline[first];
        const [bx, by] = outline[last];
        let worst = -1;
        let index = -1;
        for (let i = first + 1; i < last; i++) {
            const d = pointSegment2(
                outline[i][0],
                outline[i][1],
                ax,
                ay,
                bx,
                by,
            );
            if (d > worst) {
                worst = d;
                index = i;
            }
        }
        if (worst > t2) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }
    return outline.filter((_, i) => keep[i]);
}

// ── Hit testing (the eraser) ─────────────────────────────────────────────────

// A stroke's shape as a flat [x0, y0, x1, y1, …] polygon read straight from
// its path data: every coordinate pair of a stroke's path is an outline point
// or an edge midpoint, so the polygon through them is the stroke's shape. A
// path written by anything else still yields its control polygon, which is
// close enough to erase by.
export function polygonOf(d: string): number[] {
    const nums = d.match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? [];
    const out: number[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
        out.push(Number(nums[i]), Number(nums[i + 1]));
    }
    return out;
}

export interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export function bboxOf(poly: number[]): Box {
    const box = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
    };
    for (let i = 0; i + 1 < poly.length; i += 2) {
        box.minX = Math.min(box.minX, poly[i]);
        box.maxX = Math.max(box.maxX, poly[i]);
        box.minY = Math.min(box.minY, poly[i + 1]);
        box.maxY = Math.max(box.maxY, poly[i + 1]);
    }
    return box;
}

// Non-zero winding, the SVG default fill rule: where a stroke crosses itself
// (a loop, a scribble), the overlap is filled, so it is part of the stroke.
export function insidePolygon(poly: number[], x: number, y: number): boolean {
    let winding = 0;
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
        const x1 = poly[2 * i];
        const y1 = poly[2 * i + 1];
        const x2 = poly[(2 * i + 2) % poly.length];
        const y2 = poly[(2 * i + 3) % poly.length];
        const cross = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
        if (y1 <= y) {
            if (y2 > y && cross > 0) winding++;
        } else if (y2 <= y && cross < 0) {
            winding--;
        }
    }
    return winding !== 0;
}

function pointSegment2(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
        len2 === 0
            ? 0
            : Math.max(
                  0,
                  Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2),
              );
    const ex = ax + t * dx - px;
    const ey = ay + t * dy - py;
    return ex * ex + ey * ey;
}

function segmentsCross(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number,
): boolean {
    const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    return d1 * d2 < 0 && d3 * d4 < 0;
}

// Whether the eraser, swept from a to b with radius r, touches the stroke: it
// starts inside the shape, or passes within r of its outline. Testing the
// sweep (not just b) keeps a fast eraser from skipping a thin stroke between
// two pointer samples.
export function eraserHits(
    poly: number[],
    box: Box,
    a: { x: number; y: number },
    b: { x: number; y: number },
    r: number,
): boolean {
    if (
        Math.max(a.x, b.x) + r < box.minX ||
        Math.min(a.x, b.x) - r > box.maxX ||
        Math.max(a.y, b.y) + r < box.minY ||
        Math.min(a.y, b.y) - r > box.maxY
    ) {
        return false;
    }
    if (insidePolygon(poly, a.x, a.y) || insidePolygon(poly, b.x, b.y)) {
        return true;
    }
    const r2 = r * r;
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
        const cx = poly[2 * i];
        const cy = poly[2 * i + 1];
        const dx = poly[(2 * i + 2) % poly.length];
        const dy = poly[(2 * i + 3) % poly.length];
        if (
            segmentsCross(a.x, a.y, b.x, b.y, cx, cy, dx, dy) ||
            pointSegment2(cx, cy, a.x, a.y, b.x, b.y) <= r2 ||
            pointSegment2(a.x, a.y, cx, cy, dx, dy) <= r2 ||
            pointSegment2(b.x, b.y, cx, cy, dx, dy) <= r2
        ) {
            return true;
        }
    }
    return false;
}

// ── Identity and the wire ────────────────────────────────────────────────────

export function newInkId(): string {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return `ink-${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")}`;
}

const ID_RE = /^ink-[A-Za-z0-9_-]{1,64}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const TOKEN_RE = /^[a-z][a-z-]{0,31}$/;
const PATH_RE = /^M[MQLZ0-9eE.,\s+-]*$/;

function finite(v: unknown, low: number, high: number): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > low && v <= high;
}

// The style part of a stroke from another window, or null when anything in
// it is off: relayed ink is drawn into this page's DOM, so it is checked
// field by field the way the server checks a stroke it saves.
export function styleFrom(raw: unknown): (StrokeStyle & { id: string }) | null {
    if (typeof raw !== "object" || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== "string" || !ID_RE.test(s.id)) return null;
    if (s.tool !== "pen" && s.tool !== "highlighter") return null;
    if (typeof s.fill !== "string" || !HEX_RE.test(s.fill)) return null;
    if (
        s.token != null &&
        (typeof s.token !== "string" || !TOKEN_RE.test(s.token))
    )
        return null;
    if (!finite(s.size, 0, 2000)) return null;
    return {
        id: s.id,
        tool: s.tool,
        fill: s.fill,
        token: (s.token as string | null | undefined) ?? null,
        size: s.size,
    };
}

export function strokeFrom(raw: unknown): InkStroke | null {
    const style = styleFrom(raw);
    if (!style) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.d !== "string" || s.d.length > 2_000_000 || !PATH_RE.test(s.d))
        return null;
    const stroke: InkStroke = { ...style, d: s.d };
    if (s.opacity !== undefined) {
        if (!finite(s.opacity, 0, 1)) return null;
        stroke.opacity = s.opacity;
    }
    return stroke;
}

// Input points travel flat ([x, y, p, x, y, p, …]) and rounded, which keeps a
// relayed stroke's messages small while the pen moves.
export function flatten(points: InputPoint[]): number[] {
    const out: number[] = [];
    for (const [x, y, p] of points) {
        out.push(
            Math.round(x * 100) / 100,
            Math.round(y * 100) / 100,
            Math.round(p * 1000) / 1000,
        );
    }
    return out;
}

export function unflatten(flat: unknown): InputPoint[] | null {
    if (!Array.isArray(flat) || flat.length % 3 !== 0) return null;
    const out: InputPoint[] = [];
    for (let i = 0; i < flat.length; i += 3) {
        const [x, y, p] = [flat[i], flat[i + 1], flat[i + 2]];
        if (
            ![x, y, p].every((v) => typeof v === "number" && Number.isFinite(v))
        )
            return null;
        out.push([x, y, Math.max(0, Math.min(1, p))]);
    }
    return out;
}

// The finished stroke for a live one. `tolerance` is how far (in slide
// units) the saved outline may stray from the drawn one: by default a tenth
// of a unit, a fraction of a pixel on any screen a slide is shown on.
export function finish(
    live: LiveStroke,
    points: InputPoint[],
    tolerance = 0.1,
): InkStroke {
    const outline = outlineOf(points, live, live.simulate, true);
    const stroke: InkStroke = {
        id: live.id,
        tool: live.tool,
        fill: live.fill,
        token: live.token,
        size: live.size,
        d: pathData(simplify(outline, tolerance), 1),
    };
    if (live.tool === "highlighter") stroke.opacity = HIGHLIGHTER_OPACITY;
    return stroke;
}
