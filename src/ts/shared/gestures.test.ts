import { describe, expect, test } from "vitest";
import {
    DELTA_LINE,
    DELTA_PAGE,
    DELTA_PIXEL,
    distance,
    LINE_PX,
    MAX_WHEEL_STEP,
    midpoint,
    PAGE_PX,
    type Pt,
    scrollCorrection,
    TouchTracker,
    wheelPixels,
    wheelZoomFactor,
    wheelZoomLog,
    ZoomAnchor,
} from "./gestures";

describe("wheel", () => {
    test("pixels pass through; lines and pages are scaled", () => {
        expect(wheelPixels(7, DELTA_PIXEL)).toBe(7);
        expect(wheelPixels(3, DELTA_LINE)).toBe(3 * LINE_PX);
        expect(wheelPixels(-1, DELTA_PAGE)).toBe(-PAGE_PX);
        expect(wheelPixels(1, DELTA_PAGE, 500)).toBe(500);
    });

    test("a trackpad pinch's small deltas follow exp(-deltaY / 100)", () => {
        expect(wheelZoomFactor(-5, DELTA_PIXEL)).toBeCloseTo(Math.exp(0.05));
        expect(wheelZoomFactor(3, DELTA_PIXEL)).toBeCloseTo(Math.exp(-0.03));
        expect(wheelZoomFactor(0, DELTA_PIXEL)).toBe(1);
    });

    test("negative deltaY zooms in, positive zooms out", () => {
        expect(wheelZoomFactor(-2, DELTA_PIXEL)).toBeGreaterThan(1);
        expect(wheelZoomFactor(2, DELTA_PIXEL)).toBeLessThan(1);
    });

    test("many small deltas add up to the same zoom as one", () => {
        let log = 0;
        for (let i = 0; i < 10; i++) log += wheelZoomLog(-1.5, DELTA_PIXEL);
        expect(Math.exp(log)).toBeCloseTo(wheelZoomFactor(-15, DELTA_PIXEL));
    });

    test("a mouse notch is one bounded step in every delta mode", () => {
        const step = Math.exp(MAX_WHEEL_STEP);
        expect(wheelZoomFactor(-100, DELTA_PIXEL)).toBeCloseTo(step);
        expect(wheelZoomFactor(120, DELTA_PIXEL)).toBeCloseTo(1 / step);
        expect(wheelZoomFactor(-3, DELTA_LINE)).toBeCloseTo(step);
        expect(wheelZoomFactor(1, DELTA_PAGE)).toBeCloseTo(1 / step);
    });

    test("a pinch flicked faster than a notch per event is still bounded", () => {
        // 30 events of 40 px each: 30 bounded steps, never a jump of e^-12.
        let log = 0;
        for (let i = 0; i < 30; i++) log += wheelZoomLog(40, DELTA_PIXEL);
        expect(log).toBeCloseTo(-30 * MAX_WHEEL_STEP);
    });
});

// A 1-D model of the editor's canvas: the paper is laid out in whole pixels
// and scrolled in whole pixels, as a browser does.
function simulate(useAnchor: boolean): number {
    const W = 1920; // slide units
    let width = 730; // paper width in px
    let origin = 224; // paper's left edge, client px
    const focus = { x: 517, y: 0 };
    const start = (focus.x - origin) * (W / width);
    const anchor = new ZoomAnchor();
    for (let i = 0; i < 40; i++) {
        const measure = (c: Pt) => ({ x: (c.x - origin) * (W / width), y: 0 });
        const p = useAnchor ? anchor.point(focus, measure) : measure(focus);
        width = Math.round(width * 1.031);
        const now = { x: origin + (p.x * width) / W, y: 0 };
        origin -= Math.round(scrollCorrection(now, focus).x);
        anchor.settle(focus, p);
    }
    const end = (focus.x - origin) * (W / width);
    return Math.abs(end - start) * (width / W); // drift in client px
}

describe("anchoring", () => {
    test("the scroll correction is how far the point landed from its place", () => {
        expect(scrollCorrection({ x: 120, y: 40 }, { x: 100, y: 60 })).toEqual({
            x: 20,
            y: -20,
        });
    });

    test("the anchor reuses its point while the focus stays put", () => {
        const a = new ZoomAnchor();
        let calls = 0;
        const measure = (c: Pt) => {
            calls++;
            return { x: c.x * 2, y: c.y * 2 };
        };
        expect(a.point({ x: 10, y: 10 }, measure)).toEqual({ x: 20, y: 20 });
        a.settle({ x: 10, y: 10 }, { x: 20, y: 20 });
        expect(a.point({ x: 10.3, y: 10 }, measure)).toEqual({ x: 20, y: 20 });
        expect(calls).toBe(1);
        // The focus moved elsewhere (a new pointer position): measured anew.
        expect(a.point({ x: 50, y: 10 }, measure)).toEqual({ x: 100, y: 20 });
        a.reset();
        a.point({ x: 10, y: 10 }, measure);
        expect(calls).toBe(3);
    });

    test("a pinch's moving focus carries the point along", () => {
        const a = new ZoomAnchor();
        a.settle({ x: 300, y: 200 }, { x: 7, y: 8 });
        // The next frame's `from` is where the last one left the midpoint.
        expect(a.point({ x: 300, y: 200 }, () => ({ x: 0, y: 0 }))).toEqual({
            x: 7,
            y: 8,
        });
    });

    test("whole-pixel rounding does not add up over a gesture", () => {
        expect(simulate(true)).toBeLessThan(1);
        // What it saves: measuring afresh each frame drifts.
        expect(simulate(false)).toBeGreaterThan(simulate(true));
    });

    test("midpoint and distance", () => {
        expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({
            x: 5,
            y: 10,
        });
        expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    });
});

const P = (x: number, y = 0) => ({ x, y });

describe("TouchTracker: one finger", () => {
    test("a lone finger passes through and lifts as a tap", () => {
        const t = new TouchTracker();
        expect(t.down(1, P(100), 0)).toEqual({ pass: true });
        expect(t.move(1, P(103), 50).pass).toBe(true);
        const up = t.up(1, P(103), 120);
        expect(up.pass).toBe(true);
        expect(up.release).toBe(true);
        expect(up.tap).toEqual(P(100));
        expect(t.active).toBe(false);
        expect(t.multiTouch).toBe(false);
    });

    test("moving past the slop commits only once the window passed", () => {
        const t = new TouchTracker({ windowMs: 200, slopPx: 10 });
        t.down(1, P(0), 0);
        expect(t.move(1, P(30), 50).commit).toBe(false);
        expect(t.isCommitted).toBe(false);
        expect(t.move(1, P(40), 210).commit).toBe(true);
        expect(t.isCommitted).toBe(true);
        // Committing is reported once.
        expect(t.move(1, P(50), 220).commit).toBe(false);
        const up = t.up(1, P(50), 300);
        expect(up.release).toBe(false);
        expect(up.tap).toBeUndefined();
    });

    test("tick commits a finger that moved early and then held still", () => {
        const t = new TouchTracker({ windowMs: 200, slopPx: 10 });
        t.down(1, P(0), 0);
        t.move(1, P(30), 40);
        expect(t.tick(100).commit).toBe(false);
        expect(t.tick(205).commit).toBe(true);
    });

    test("a still finger never commits, however long it rests", () => {
        const t = new TouchTracker({ windowMs: 200, slopPx: 10 });
        t.down(1, P(0), 0);
        t.move(1, P(4), 100);
        expect(t.tick(5000).commit).toBe(false);
        const up = t.up(1, P(4), 6000);
        expect(up.release).toBe(true);
        // Too long for a tap.
        expect(up.tap).toBeUndefined();
    });

    test("a drag is no tap", () => {
        const t = new TouchTracker();
        t.down(1, P(0), 0);
        t.move(1, P(60), 100);
        expect(t.up(1, P(0), 150).tap).toBeUndefined();
    });

    test("two quick taps in one place are a double tap", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        expect(t.up(1, P(100), 80).doubleTap).toBeUndefined();
        t.down(2, P(110), 200);
        expect(t.up(2, P(110), 260).doubleTap).toEqual(P(110));
        // A third tap starts over.
        t.down(3, P(110), 400);
        expect(t.up(3, P(110), 450).doubleTap).toBeUndefined();
    });

    test("taps too far apart in time or place are not", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        t.up(1, P(100), 50);
        t.down(2, P(100), 600);
        expect(t.up(2, P(100), 650).doubleTap).toBeUndefined();
        t.down(3, P(300), 700);
        expect(t.up(3, P(300), 750).doubleTap).toBeUndefined();
    });

    test("a cancelled pointer is no tap", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        const up = t.up(1, P(100), 50, true);
        expect(up.tap).toBeUndefined();
        expect(up.pass).toBe(true);
    });
});

describe("TouchTracker: a second finger", () => {
    test("within the window it cancels the first and starts a pinch", () => {
        const t = new TouchTracker({ windowMs: 200, slopPx: 10 });
        t.down(1, P(100), 0);
        t.move(1, P(130), 50); // past the slop, inside the window
        const v = t.down(2, P(300), 120);
        expect(v).toEqual({
            pass: false,
            cancelSingle: true,
            pinchStart: true,
        });
        expect(t.pinching).toBe(true);
        expect(t.claimed).toBe(true);
        expect(t.multiTouch).toBe(true);
    });

    test("after the window, before the slop, it still makes a pinch", () => {
        const t = new TouchTracker({ windowMs: 200, slopPx: 10 });
        t.down(1, P(100), 0);
        t.move(1, P(105), 900);
        expect(t.down(2, P(300), 1000).cancelSingle).toBe(true);
    });

    test("after the first committed it is ignored", () => {
        const t = new TouchTracker({ windowMs: 200, slopPx: 10 });
        t.down(1, P(0), 0);
        t.move(1, P(50), 250);
        expect(t.isCommitted).toBe(true);
        expect(t.down(2, P(300), 300)).toEqual({ pass: false });
        expect(t.pinching).toBe(false);
        // The first finger still drags; the second's moves go nowhere.
        expect(t.move(1, P(80), 320).pass).toBe(true);
        expect(t.move(2, P(310), 320).pass).toBe(false);
        expect(t.multiTouch).toBe(true);
    });

    test("pinch steps report the spread's change and the midpoint's path", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        t.down(2, P(300), 10);
        const v = t.move(2, P(500), 30);
        expect(v.pass).toBe(false);
        expect(v.pinch?.scale).toBeCloseTo(2);
        expect(v.pinch?.from).toEqual(P(200));
        expect(v.pinch?.to).toEqual(P(300));
        const w = t.move(1, P(200), 40);
        expect(w.pinch?.scale).toBeCloseTo(300 / 400);
        expect(w.pinch?.from).toEqual(P(300));
        expect(w.pinch?.to).toEqual(P(350));
    });

    test("a pinch's first finger events no longer reach the page", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        t.down(2, P(300), 10);
        expect(t.move(1, P(90), 20).pass).toBe(false);
    });

    test("lifting either finger ends the pinch; the other stays inert", () => {
        for (const first of [1, 2]) {
            const t = new TouchTracker();
            t.down(1, P(100), 0);
            t.down(2, P(300), 10);
            expect(t.up(first, P(100), 300)).toEqual({
                pass: false,
                pinchEnd: true,
            });
            expect(t.pinching).toBe(false);
            expect(t.claimed).toBe(true);
            const other = first === 1 ? 2 : 1;
            // Neither a drag nor a swipe: nothing passes, no commit, no tap.
            const m = t.move(other, P(600), 400);
            expect(m.pass).toBe(false);
            expect(m.commit).toBeUndefined();
            const up = t.up(other, P(600), 450);
            expect(up).toEqual({ pass: false });
            expect(t.active).toBe(false);
            expect(t.claimed).toBe(false);
            // The ended sequence is still known to have been two fingers.
            expect(t.multiTouch).toBe(true);
        }
    });

    test("a finger landing beside the one left over resumes the pinch", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        t.down(2, P(300), 10);
        t.up(2, P(300), 100);
        const v = t.down(3, P(400), 200);
        expect(v).toEqual({ pass: false, pinchStart: true });
        expect(t.move(3, P(700), 220).pinch?.scale).toBeCloseTo(2);
    });

    test("a third finger during a pinch is ignored", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        t.down(2, P(300), 10);
        expect(t.down(3, P(500), 20)).toEqual({ pass: false });
        expect(t.move(3, P(520), 30)).toEqual({ pass: false });
        expect(t.up(3, P(520), 40)).toEqual({ pass: false });
        expect(t.pinching).toBe(true);
    });

    test("the first finger lifting before an ignored second leaves it inert", () => {
        const t = new TouchTracker({ windowMs: 200, slopPx: 10 });
        t.down(1, P(0), 0);
        t.move(1, P(50), 250);
        t.down(2, P(300), 300);
        expect(t.up(1, P(50), 350).pass).toBe(true);
        expect(t.claimed).toBe(true);
        expect(t.move(2, P(400), 360).pass).toBe(false);
        t.up(2, P(400), 380);
        expect(t.active).toBe(false);
    });

    test("a pinch forgets a pending tap", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        t.up(1, P(100), 50);
        t.down(2, P(100), 100);
        t.down(3, P(300), 110);
        t.up(2, P(100), 200);
        t.up(3, P(300), 210);
        t.down(4, P(100), 250);
        expect(t.up(4, P(100), 300).doubleTap).toBeUndefined();
    });

    test("a new sequence starts single again", () => {
        const t = new TouchTracker();
        t.down(1, P(100), 0);
        t.down(2, P(300), 10);
        t.up(1, P(100), 50);
        t.up(2, P(300), 60);
        expect(t.down(3, P(100), 1000)).toEqual({ pass: true });
        expect(t.multiTouch).toBe(false);
        expect(t.single).toBe(3);
    });
});
