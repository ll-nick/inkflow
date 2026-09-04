// Pure camera math for the presenter's zoom mode. All values are in SVG user
// units; the DOM module maps client coordinates into this space with
// `svg.getScreenCTM().inverse()`, so `preserveAspectRatio` letterboxing never
// has to be handled here. `ViewBox` parsing/formatting itself lives in
// `viewbox.ts`, shared with the other modules that read a slide's viewBox.
//
// Unrelated to the `transitions.Zoom` slide-to-slide transition — this is a live
// pan/zoom camera driven by the `viewBox` attribute of the mounted slide.

import type { ViewBox } from "./viewbox";

export interface ScaleLimits {
    minScale: number;
    maxScale: number;
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(Math.max(n, lo), hi);
}

export function scaleOf(vb: ViewBox, base: ViewBox): number {
    return base.w / vb.w;
}

export function isZoomedIn(
    vb: ViewBox,
    base: ViewBox,
    epsilon = 1e-3,
): boolean {
    return scaleOf(vb, base) > 1 + epsilon;
}

// Keep the view within the slide canvas: never wider/taller than the base, and
// never panned past an edge. A box at (or above) full size is centred on the base.
export function clampToBounds(vb: ViewBox, base: ViewBox): ViewBox {
    const w = Math.min(vb.w, base.w);
    const h = Math.min(vb.h, base.h);
    const x =
        w >= base.w
            ? base.x + (base.w - w) / 2
            : clamp(vb.x, base.x, base.x + base.w - w);
    const y =
        h >= base.h
            ? base.y + (base.h - h) / 2
            : clamp(vb.y, base.y, base.y + base.h - h);
    return { x, y, w, h };
}

// Zoom `current` by `factor` (a multiplier on the current scale), keeping the
// user-space point `focus` fixed on screen. Scale is clamped to `limits`.
export function zoomAt(
    current: ViewBox,
    base: ViewBox,
    factor: number,
    focus: { ux: number; uy: number },
    limits: ScaleLimits,
): ViewBox {
    const targetScale = clamp(
        scaleOf(current, base) * factor,
        limits.minScale,
        limits.maxScale,
    );
    const w = base.w / targetScale;
    const h = base.h / targetScale;
    const fx = (focus.ux - current.x) / current.w;
    const fy = (focus.uy - current.y) / current.h;
    return clampToBounds(
        { x: focus.ux - fx * w, y: focus.uy - fy * h, w, h },
        base,
    );
}

export function panBy(
    current: ViewBox,
    base: ViewBox,
    dxUser: number,
    dyUser: number,
): ViewBox {
    return clampToBounds(
        { ...current, x: current.x + dxUser, y: current.y + dyUser },
        base,
    );
}

// Linear blend of two viewBoxes; `t` runs 0 (a) to 1 (b). Used by the animated
// reset / keyboard-step camera moves.
export function lerpViewBox(a: ViewBox, b: ViewBox, t: number): ViewBox {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        w: a.w + (b.w - a.w) * t,
        h: a.h + (b.h - a.h) * t,
    };
}
