// Zoom and pan gestures, the pure half: wheel deltas → zoom factors, the
// anchor maths that keeps a point under the fingers, and the touch state
// machine deciding when one finger's action gives way to a two-finger pinch.
// The DOM half (gesturepad.ts) feeds it events and applies what it decides;
// the presenter (presenter/zoom.ts) and the editor (editor/touchzoom.ts) each
// say what a zoom, a pan and a cancelled finger mean on their page.

export interface Pt {
    x: number;
    y: number;
}

// ── Wheel ───────────────────────────────────────────────────────────────────

// WheelEvent.deltaMode values.
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;

// What a line and a page of wheel scrolling are worth in pixels: Firefox
// reports a mouse wheel's notch as 3 lines, some systems as a page.
export const LINE_PX = 40;
export const PAGE_PX = 800;

export function wheelPixels(
    delta: number,
    mode: number,
    pagePx = PAGE_PX,
): number {
    if (mode === DELTA_LINE) return delta * LINE_PX;
    if (mode === DELTA_PAGE) return delta * pagePx;
    return delta;
}

// Chrome (and Edge) report a trackpad pinch as Ctrl+wheel events with
// deltaY = -100·ln(scale), so a factor of exp(-deltaY / 100) follows the
// fingers exactly; Firefox's pinch deltas are of the same order.
export const PINCH_PER_PX = 0.01;
// A mouse wheel's notch (deltaY 100 or more in pixels, 3 lines, a page) is
// one step of this factor, not the jump exp(-1) its raw delta would make.
export const MAX_WHEEL_STEP = Math.log(1.2);

// The zoom of one Ctrl+wheel event as a natural log of the factor (logs add
// up, so a frame's events are summed): positive zooms in.
export function wheelZoomLog(deltaY: number, deltaMode: number): number {
    const z = -wheelPixels(deltaY, deltaMode) * PINCH_PER_PX;
    return Math.min(Math.max(z, -MAX_WHEEL_STEP), MAX_WHEEL_STEP);
}

export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
    return Math.exp(wheelZoomLog(deltaY, deltaMode));
}

// ── Anchoring ───────────────────────────────────────────────────────────────

// How far content sits from where it belongs: the editor lays the zoomed
// paper out, finds where the anchored point landed (`now`) and scrolls the
// canvas by the difference to where it should be (`want`).
export function scrollCorrection(now: Pt, want: Pt): Pt {
    return { x: now.x - want.x, y: now.y - want.y };
}

// The content point a zoom gesture holds under its focus. Layout and scroll
// offsets come in whole (device) pixels, so measuring the point under the
// focus afresh each frame would let that rounding add up over a gesture;
// while each frame starts where the last one put the focus, the point is
// reused instead, and every frame is off by one frame's rounding at most.
export class ZoomAnchor {
    private last: { client: Pt; content: Pt } | null = null;
    private readonly tolerance: number;

    constructor(tolerance = 0.5) {
        this.tolerance = tolerance;
    }

    // The content point to hold under `from`; `measure` reads the one under
    // a client point now.
    point(from: Pt, measure: (client: Pt) => Pt): Pt {
        const l = this.last;
        if (l && distance(l.client, from) <= this.tolerance) return l.content;
        return measure(from);
    }

    // This frame put `content` under `to`.
    settle(to: Pt, content: Pt): void {
        this.last = { client: to, content };
    }

    reset(): void {
        this.last = null;
    }
}

export function midpoint(a: Pt, b: Pt): Pt {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function distance(a: Pt, b: Pt): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// ── Touch ───────────────────────────────────────────────────────────────────

export interface TouchOptions {
    // A second finger landing this soon after the first makes a pinch, and
    // whatever the first finger began is taken back.
    windowMs: number;
    // ...as does one landing before the first moved this far (a resting
    // finger plus another is a pinch however long the first rested).
    slopPx: number;
    // A tap: down and up within this long, never past the slop.
    tapMs: number;
    // Two taps this close in time and place are a double tap.
    doubleTapMs: number;
    doubleTapPx: number;
}

export const TOUCH_DEFAULTS: TouchOptions = {
    windowMs: 200,
    slopPx: 10,
    tapMs: 300,
    doubleTapMs: 350,
    doubleTapPx: 30,
};

export interface PinchStep {
    // The change of the fingers' spread since the last step (1 = none).
    scale: number;
    // The fingers' midpoint before and after: the content under `from`
    // follows to `to`, so two fingers zoom and pan at once.
    from: Pt;
    to: Pt;
}

// What the page does with one touch pointer event.
export interface TouchVerdict {
    // The page's own handlers see this event (one finger doing what one
    // finger does); otherwise it belongs to the gesture and goes no further.
    pass: boolean;
    // The first finger's action is to be rolled back: a pinch is starting.
    cancelSingle?: boolean;
    // The first finger is now a deliberate one-finger action: it moved past
    // the slop and the window passed without a second finger.
    commit?: boolean;
    pinchStart?: boolean;
    pinch?: PinchStep;
    pinchEnd?: boolean;
    // The first finger lifted before it committed (a tap, a still press, or
    // a flick quicker than the window); `moved`: it went past the slop.
    release?: boolean;
    moved?: boolean;
    tap?: Pt;
    doubleTap?: Pt;
}

interface Finger {
    id: number;
    start: Pt;
    at: Pt;
    t0: number;
}

type Phase = "idle" | "single" | "pinch" | "spent";

// One sequence of touches, from the first finger down to the last one up.
//
//   idle ─first finger→ single ─second finger, uncommitted→ pinch
//                         │  ╰─second finger, committed→ (ignored)
//                         ╰─lift→ idle (a tap, maybe a double tap)
//   pinch ─either finger lifts→ spent ─last finger lifts→ idle
//   spent ─a finger lands beside the one left→ pinch (resumed)
//
// "Committed" means the first finger moved past the slop *and* the window
// passed: before that a second finger turns the touch into a pinch. In
// "spent" the finger left over is inert until it lifts: it neither drags
// nor swipes, and nothing it ends with is a tap.
export class TouchTracker {
    readonly opts: TouchOptions;
    private phase: Phase = "idle";
    private fingers = new Map<number, Finger>();
    private first: Finger | null = null;
    private moved = false;
    private committed = false;
    private pair: [number, number] | null = null;
    private last: { mid: Pt; dist: number } | null = null;
    private lastTap: { at: Pt; t: number } | null = null;
    // This sequence had a second finger: nothing it does is a swipe or tap.
    private multi = false;

    constructor(opts: Partial<TouchOptions> = {}) {
        this.opts = { ...TOUCH_DEFAULTS, ...opts };
    }

    // Fingers are down and at least one of them is the gesture's (a pinch,
    // or one left over from it): clicks and swipes are not the page's.
    get claimed(): boolean {
        return this.phase === "pinch" || this.phase === "spent";
    }

    get pinching(): boolean {
        return this.phase === "pinch";
    }

    // The sequence in progress has had more than one finger.
    get multiTouch(): boolean {
        return this.multi;
    }

    get active(): boolean {
        return this.phase !== "idle";
    }

    // The single finger's id while one finger acts alone.
    get single(): number | null {
        return this.phase === "single" ? (this.first?.id ?? null) : null;
    }

    get isCommitted(): boolean {
        return this.committed;
    }

    has(id: number): boolean {
        return this.fingers.has(id);
    }

    down(id: number, at: Pt, t: number): TouchVerdict {
        const finger: Finger = { id, start: at, at, t0: t };
        if (this.phase === "idle") {
            this.fingers.clear();
            this.fingers.set(id, finger);
            this.first = finger;
            this.moved = false;
            this.committed = false;
            this.multi = false;
            this.phase = "single";
            return { pass: true };
        }
        this.fingers.set(id, finger);
        this.multi = true;
        if (this.phase === "single" && this.first) {
            if (this.committed) return { pass: false };
            this.lastTap = null;
            this.startPinch(this.first.id, id);
            return { pass: false, cancelSingle: true, pinchStart: true };
        }
        if (this.phase === "spent" && this.fingers.size === 2) {
            const other = [...this.fingers.keys()].find((k) => k !== id);
            if (other !== undefined) {
                this.startPinch(other, id);
                return { pass: false, pinchStart: true };
            }
        }
        return { pass: false };
    }

    private startPinch(a: number, b: number): void {
        this.phase = "pinch";
        this.pair = [a, b];
        this.last = this.measure();
    }

    private measure(): { mid: Pt; dist: number } | null {
        if (!this.pair) return null;
        const a = this.fingers.get(this.pair[0]);
        const b = this.fingers.get(this.pair[1]);
        if (!a || !b) return null;
        return { mid: midpoint(a.at, b.at), dist: distance(a.at, b.at) };
    }

    move(id: number, at: Pt, t: number): TouchVerdict {
        const f = this.fingers.get(id);
        if (!f) return { pass: true };
        f.at = at;
        if (this.phase === "single" && f === this.first) {
            if (!this.moved && distance(at, f.start) > this.opts.slopPx)
                this.moved = true;
            return { pass: true, commit: this.tryCommit(t) };
        }
        if (this.phase === "pinch" && this.pair?.includes(id)) {
            const now = this.measure();
            const before = this.last;
            if (!now || !before) return { pass: false };
            this.last = now;
            const scale =
                before.dist > 0 && now.dist > 0 ? now.dist / before.dist : 1;
            return {
                pass: false,
                pinch: { scale, from: before.mid, to: now.mid },
            };
        }
        return { pass: false };
    }

    // Time passing with no event: a finger that moved past the slop early
    // commits once the window is over, even if it then holds still.
    tick(t: number): TouchVerdict {
        return { pass: true, commit: this.tryCommit(t) };
    }

    private tryCommit(t: number): boolean {
        if (this.phase !== "single" || this.committed || !this.first)
            return false;
        if (!this.moved || t - this.first.t0 < this.opts.windowMs) return false;
        this.committed = true;
        return true;
    }

    // `cancelled`: the browser took the pointer back (pointercancel).
    up(id: number, at: Pt, t: number, cancelled = false): TouchVerdict {
        const f = this.fingers.get(id);
        if (!f) return { pass: true };
        f.at = at;
        this.fingers.delete(id);
        if (this.phase === "single" && f === this.first) {
            const release = !this.committed;
            // Fingers it ignored are still down: inert until they lift.
            if (this.fingers.size) {
                this.phase = "spent";
                this.first = null;
            } else this.reset();
            const verdict: TouchVerdict = {
                pass: true,
                release,
                moved: this.moved,
            };
            if (
                !cancelled &&
                !this.moved &&
                distance(at, f.start) <= this.opts.slopPx &&
                t - f.t0 <= this.opts.tapMs
            ) {
                verdict.tap = f.start;
                const prev = this.lastTap;
                if (
                    prev &&
                    t - prev.t <= this.opts.doubleTapMs &&
                    distance(prev.at, f.start) <= this.opts.doubleTapPx
                ) {
                    verdict.doubleTap = f.start;
                    this.lastTap = null;
                } else {
                    this.lastTap = { at: f.start, t };
                }
            } else {
                this.lastTap = null;
            }
            return verdict;
        }
        const ended = this.phase === "pinch" && !!this.pair?.includes(id);
        if (ended) {
            this.phase = "spent";
            this.pair = null;
            this.last = null;
        }
        if (this.fingers.size === 0) this.reset();
        return ended ? { pass: false, pinchEnd: true } : { pass: false };
    }

    private reset(): void {
        this.phase = "idle";
        this.fingers.clear();
        this.first = null;
        this.pair = null;
        this.last = null;
        this.committed = false;
    }
}
