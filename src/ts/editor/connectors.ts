// Connector geometry: where a shape's connection sites are, and the path an
// arrow takes between two points (straight, elbow or curved). Pure, so the
// routing is unit-tested; canvas.ts supplies the shapes' corners.
//
// A connector is a <path> carrying inkflow:connector="straight|elbow|curved"
// and, for each connected end, inkflow:connect-start / -end = "<id>:<site>",
// a site being a side ("top") or a point along one ("top@0.25"); a shape's
// inkflow:sites="3" offers that many points per side. An elbow moved off its
// default shape carries inkflow:bend="x:640" (its adjustable segment).
// Its `d` always starts with "M x y" and ends with the end point's own
// coordinates, so a free end is read back from the path itself.

export interface Pt {
    x: number;
    y: number;
}

export type Side = "top" | "right" | "bottom" | "left";

export interface Site extends Pt {
    // "<side>" for the middle of a side, "<side>@<fraction>" anywhere along
    // it (from its first corner, clockwise): "top@0.25".
    name: string;
    // Outward direction (unit vector): where the line leaves the shape.
    dx: number;
    dy: number;
}

export type ConnectorStyle = "straight" | "elbow" | "curved";

export const SIDES: Side[] = ["top", "right", "bottom", "left"];

/** Connection points per side a shape offers, at most. */
export const MAX_SITES = 9;

export function siteName(side: Side, t: number): string {
    return Math.abs(t - 0.5) < 1e-9
        ? side
        : `${side}@${Math.round(t * 1000) / 1000}`;
}

export function parseSite(name: string): { side: Side; t: number } | null {
    const [side, frac] = name.split("@");
    if (!SIDES.includes(side as Side)) return null;
    const t = frac === undefined ? 0.5 : Number(frac);
    return Number.isFinite(t) && t >= 0 && t <= 1
        ? { side: side as Side, t }
        : null;
}

/**
 * A site from a shape's corners (top-left, top-right, bottom-right,
 * bottom-left, as transformed): the point a fraction `t` along one side,
 * facing out of it, so sites follow rotation. On a round shape the point is
 * moved in onto the ellipse the corners enclose.
 */
export function siteOnCorners(
    c: Pt[],
    side: Side,
    t: number,
    round = false,
): Site {
    // Where the point is in the box's own (u, v) square, 0..1 each way.
    const along: Record<Side, [number, number]> = {
        top: [t, 0],
        right: [1, t],
        bottom: [1 - t, 1],
        left: [0, 1 - t],
    };
    let [u, v] = along[side];
    if (round) {
        const off = Math.sqrt(Math.max(0, 0.25 - (t - 0.5) ** 2));
        if (side === "top") v = 0.5 - off;
        else if (side === "bottom") v = 0.5 + off;
        else if (side === "right") u = 0.5 + off;
        else u = 0.5 - off;
    }
    const ex = { x: c[1].x - c[0].x, y: c[1].y - c[0].y };
    const ey = { x: c[3].x - c[0].x, y: c[3].y - c[0].y };
    const x = c[0].x + u * ex.x + v * ey.x;
    const y = c[0].y + u * ex.y + v * ey.y;
    // The side's outward normal.
    const i = SIDES.indexOf(side);
    const a = c[i];
    const b = c[(i + 1) % 4];
    let nx = b.y - a.y;
    let ny = -(b.x - a.x);
    const centre = {
        x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
        y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
    };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (nx * (mid.x - centre.x) + ny * (mid.y - centre.y) < 0) {
        nx = -nx;
        ny = -ny;
    }
    const len = Math.hypot(nx, ny) || 1;
    const clean = (n: number) => (Math.abs(n) < 1e-12 ? 0 : n);
    return {
        name: siteName(side, t),
        x,
        y,
        dx: clean(nx / len),
        dy: clean(ny / len),
    };
}

/** The `perSide` evenly spaced sites on each side of a shape. */
export function sitesFromCorners(c: Pt[], perSide = 1, round = false): Site[] {
    const n = Math.max(1, Math.min(MAX_SITES, Math.round(perSide)));
    return SIDES.flatMap((side) =>
        Array.from({ length: n }, (_, k) =>
            siteOnCorners(c, side, (k + 1) / (n + 1), round),
        ),
    );
}

/** A named site, whether or not the shape currently offers it. */
export function siteByName(c: Pt[], name: string, round = false): Site | null {
    const s = parseSite(name);
    return s ? siteOnCorners(c, s.side, s.t, round) : null;
}

export function nearestSite(sites: Site[], p: Pt, within: number): Site | null {
    let best: Site | null = null;
    let bestD = within;
    for (const s of sites) {
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d <= bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}

export interface End extends Pt {
    // Outward direction at a connected site; absent at a free end.
    dx?: number;
    dy?: number;
}

// A free end's direction: back toward the other end, along its main axis.
function direction(end: End, other: Pt): Pt {
    if (end.dx !== undefined && end.dy !== undefined) {
        return { x: end.dx, y: end.dy };
    }
    const dx = other.x - end.x;
    const dy = other.y - end.y;
    return Math.abs(dx) >= Math.abs(dy)
        ? { x: Math.sign(dx) || 1, y: 0 }
        : { x: 0, y: Math.sign(dy) || 1 };
}

function horizontal(d: Pt): boolean {
    return Math.abs(d.x) >= Math.abs(d.y);
}

// Where an elbow's adjustable segment runs: the x of a vertical segment or
// the y of a horizontal one, in the units the ends are given in. Stored on the
// connector as inkflow:bend="x:640".
export interface Bend {
    axis: "x" | "y";
    at: number;
}

export function parseBend(value: string | null): Bend | null {
    const m = /^([xy]):(-?\d*\.?\d+(?:e[-+]?\d+)?)$/i.exec(value ?? "");
    if (!m) return null;
    const at = Number(m[2]);
    return Number.isFinite(at) ? { axis: m[1] as "x" | "y", at } : null;
}

export function formatBend(b: Bend): string {
    return `${b.axis}:${Math.round(b.at * 100) / 100}`;
}

export interface Route {
    // Points of a polyline, or [start, c1, c2, end] of one cubic curve.
    points: Pt[];
    curve: boolean;
    // An elbow's adjustable segment, and the middle of it (for a handle).
    bend?: Bend & { mid: Pt };
}

// How far an elbow runs straight out of a side before it may turn.
const STUB = 30;

/** The route between two ends, in the coordinates the ends are given in. */
export function route(
    style: ConnectorStyle,
    a: End,
    b: End,
    bend: Bend | null = null,
): Route {
    if (style === "curved") {
        const da = direction(a, b);
        const db = direction(b, a);
        const k = Math.max(30, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
        return {
            curve: true,
            points: [
                { x: a.x, y: a.y },
                { x: a.x + da.x * k, y: a.y + da.y * k },
                { x: b.x + db.x * k, y: b.y + db.y * k },
                { x: b.x, y: b.y },
            ],
        };
    }
    if (style === "straight") {
        return {
            curve: false,
            points: [a, b].map((p) => ({ x: p.x, y: p.y })),
        };
    }
    return elbow(a, b, bend);
}

// Elbow: leave and enter along each end's direction, turning at right
// angles. One segment is adjustable (the bend): between parallel ends the
// middle one, from a side to a top or bottom the one before the last turn.
function elbow(a: End, b: End, bend: Bend | null): Route {
    const da = direction(a, b);
    const db = direction(b, a);
    const ha = horizontal(da);
    const hb = horizontal(db);
    let axis: "x" | "y";
    let fallback: number;
    let build: (m: number) => { pts: Pt[]; mid: Pt };
    if (ha === hb) {
        axis = ha ? "x" : "y";
        const pa = ha ? a.x : a.y;
        const pb = ha ? b.x : b.y;
        const sa = Math.sign(ha ? da.x : da.y);
        const sb = Math.sign(ha ? db.x : db.y);
        // Both ends facing the same way: go round, past the further one.
        fallback =
            sa === sb
                ? sa > 0
                    ? Math.max(pa, pb) + STUB
                    : Math.min(pa, pb) - STUB
                : (pa + pb) / 2;
        build = (m) =>
            ha
                ? {
                      pts: [a, { x: m, y: a.y }, { x: m, y: b.y }, b],
                      mid: { x: m, y: (a.y + b.y) / 2 },
                  }
                : {
                      pts: [a, { x: a.x, y: m }, { x: b.x, y: m }, b],
                      mid: { x: (a.x + b.x) / 2, y: m },
                  };
    } else if (ha) {
        axis = "x";
        fallback = b.x;
        const k = b.y + Math.sign(db.y || 1) * STUB;
        build = (m) => ({
            pts: [a, { x: m, y: a.y }, { x: m, y: k }, { x: b.x, y: k }, b],
            mid: { x: m, y: (a.y + k) / 2 },
        });
    } else {
        axis = "y";
        fallback = b.y;
        const k = b.x + Math.sign(db.x || 1) * STUB;
        build = (m) => ({
            pts: [a, { x: a.x, y: m }, { x: k, y: m }, { x: k, y: b.y }, b],
            mid: { x: (a.x + k) / 2, y: m },
        });
    }
    const at = bend && bend.axis === axis ? bend.at : fallback;
    const { pts, mid } = build(at);
    return {
        curve: false,
        points: simplify(pts.map((p) => ({ x: p.x, y: p.y }))),
        bend: { axis, at, mid },
    };
}

// Drop repeated points and bends that are not bends (a straight run through
// them); a turn back along the same line is kept.
function simplify(pts: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of pts) {
        const last = out[out.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) continue;
        out.push(p);
        while (out.length >= 3) {
            const [p0, p1, p2] = out.slice(-3);
            const ux = p1.x - p0.x;
            const uy = p1.y - p0.y;
            const vx = p2.x - p1.x;
            const vy = p2.y - p1.y;
            if (Math.abs(ux * vy - uy * vx) < 1e-6 && ux * vx + uy * vy > 0) {
                out.splice(out.length - 2, 1);
            } else break;
        }
    }
    return out;
}

function n(v: number): string {
    return String(Math.round(v * 100) / 100);
}

export function pathData(r: Route): string {
    const [first, ...rest] = r.points;
    const head = `M${n(first.x)},${n(first.y)}`;
    if (r.curve) {
        return `${head} C${rest.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}`;
    }
    return `${head} ${rest.map((p) => `L${n(p.x)},${n(p.y)}`).join(" ")}`;
}

/** First and last point of a path's data (a connector's two ends). */
export function endpointsOf(d: string): { start: Pt; end: Pt } | null {
    const nums = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (nums.length < 4 || nums.some((v) => !Number.isFinite(v))) return null;
    return {
        start: { x: nums[0], y: nums[1] },
        end: { x: nums[nums.length - 2], y: nums[nums.length - 1] },
    };
}

export interface Connection {
    id: string;
    site: string;
}

export function parseConnection(value: string | null): Connection | null {
    if (!value) return null;
    const i = value.lastIndexOf(":");
    const site = value.slice(i + 1);
    if (i <= 0 || !parseSite(site)) return null;
    return { id: value.slice(0, i), site };
}
