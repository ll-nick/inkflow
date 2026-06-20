// CSS easing evaluated in JS. Transitions are driven by a requestAnimationFrame
// loop over a linear progress value, so the easing curve has to be sampled here
// rather than handed to the browser as a `transition-timing-function` string.
//
// `cubicBezierEasing(spec)` turns a CSS easing spec into a function mapping linear
// progress (0..1) to eased progress (0..1). It accepts the named curves and any
// `cubic-bezier(x1, y1, x2, y2)`. Anything it cannot parse falls back to linear.

type ControlPoints = [number, number, number, number];

const NAMED_CURVES: Record<string, ControlPoints> = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
};

const CUBIC_BEZIER_PATTERN =
    /^cubic-bezier\(\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*\)$/;

function parseControlPoints(spec: string | undefined): ControlPoints | null {
    if (!spec) return null;
    const trimmed = spec.trim();
    if (trimmed in NAMED_CURVES) return NAMED_CURVES[trimmed];
    const match = CUBIC_BEZIER_PATTERN.exec(trimmed);
    if (!match) return null;
    const points = [match[1], match[2], match[3], match[4]].map(Number);
    return points.every(Number.isFinite) ? (points as ControlPoints) : null;
}

const identity = (progress: number): number => progress;

// A cubic-bezier timing function is two cubic curves of a shared parameter t:
// x(t) is the time axis, y(t) the eased output, both with implicit endpoints
// (0,0) and (1,1). To ease an input we invert x(t) for the given progress, then
// evaluate y(t) — Newton-Raphson with a bisection fallback, the standard approach.
function makeCubicBezier(points: ControlPoints): (progress: number) => number {
    const [x1, y1, x2, y2] = points;

    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;

    const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
    const sampleSlopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

    const solveForT = (x: number): number => {
        let t = x;
        for (let iteration = 0; iteration < 8; iteration++) {
            const error = sampleX(t) - x;
            if (Math.abs(error) < 1e-6) return t;
            const slope = sampleSlopeX(t);
            if (Math.abs(slope) < 1e-6) break;
            t -= error / slope;
        }
        let lower = 0;
        let upper = 1;
        t = x;
        while (lower < upper) {
            const value = sampleX(t);
            if (Math.abs(value - x) < 1e-6) return t;
            if (x > value) lower = t;
            else upper = t;
            t = (lower + upper) / 2;
        }
        return t;
    };

    return (progress: number) => {
        if (progress <= 0) return 0;
        if (progress >= 1) return 1;
        return sampleY(solveForT(progress));
    };
}

export function cubicBezierEasing(
    spec: string | undefined,
): (progress: number) => number {
    const points = parseControlPoints(spec);
    if (!points) return identity;
    const [x1, y1, x2, y2] = points;
    if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return identity;
    return makeCubicBezier(points);
}
