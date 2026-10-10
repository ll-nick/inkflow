// Smart-guide snapping: pull a moving box onto the slide's edges and centre and
// onto the edges and centres of the other objects, the way slide editors do.
// Pure, so the rules are unit-tested; canvas.ts draws the returned guides.

import type { Box } from "./geom";

export interface SnapResult {
    dx: number;
    dy: number;
    guidesX: number[];
    guidesY: number[];
}

export interface SnapTargets {
    xs: number[];
    ys: number[];
}

export function targetsFor(slide: Box, others: Box[]): SnapTargets {
    const xs = [slide.x, slide.x + slide.width / 2, slide.x + slide.width];
    const ys = [slide.y, slide.y + slide.height / 2, slide.y + slide.height];
    for (const b of others) {
        xs.push(b.x, b.x + b.width / 2, b.x + b.width);
        ys.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    return { xs, ys };
}

function best(
    edges: number[],
    targets: number[],
    threshold: number,
): { delta: number; at: number[] } {
    let delta = 0;
    let dist = threshold + 1;
    for (const e of edges) {
        for (const t of targets) {
            const d = Math.abs(t - e);
            if (d < dist - 1e-9) {
                dist = d;
                delta = t - e;
            }
        }
    }
    if (dist > threshold) return { delta: 0, at: [] };
    // Every target the snapped edges now coincide with gets a guide.
    const at = new Set<number>();
    for (const e of edges) {
        for (const t of targets) {
            if (Math.abs(t - (e + delta)) < 1e-6) at.add(t);
        }
    }
    return { delta, at: [...at] };
}

// How far to nudge `box` (already moved) so an edge or its centre lands on a
// target within `threshold` slide units, per axis.
export function snapBox(
    box: Box,
    targets: SnapTargets,
    threshold: number,
): SnapResult {
    const x = best(
        [box.x, box.x + box.width / 2, box.x + box.width],
        targets.xs,
        threshold,
    );
    const y = best(
        [box.y, box.y + box.height / 2, box.y + box.height],
        targets.ys,
        threshold,
    );
    return { dx: x.delta, dy: y.delta, guidesX: x.at, guidesY: y.at };
}

// Snap only the moving edges of a resize (the opposite edges stay put).
export function snapEdges(
    edgesX: number[],
    edgesY: number[],
    targets: SnapTargets,
    threshold: number,
): SnapResult {
    const x = best(edgesX, targets.xs, threshold);
    const y = best(edgesY, targets.ys, threshold);
    return { dx: x.delta, dy: y.delta, guidesX: x.at, guidesY: y.at };
}

// Positions that spread boxes evenly between the outermost two along an axis.
export function distribute(boxes: Box[], axis: "x" | "y"): number[] {
    const size = axis === "x" ? "width" : "height";
    const order = boxes
        .map((b, i) => ({ b, i }))
        .sort((p, q) => p.b[axis] - q.b[axis]);
    const out = boxes.map((b) => b[axis]);
    if (order.length < 3) return out;
    const first = order[0].b;
    const last = order[order.length - 1].b;
    const total = order.reduce((s, o) => s + o.b[size], 0);
    const span = last[axis] + last[size] - first[axis];
    const gap = (span - total) / (order.length - 1);
    let pos = first[axis];
    for (const o of order) {
        out[o.i] = pos;
        pos += o.b[size] + gap;
    }
    return out;
}
