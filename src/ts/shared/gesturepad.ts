// Zoom and pan gestures, the DOM half (the maths and the touch state machine
// are gestures.ts). One GesturePad per page, over the surface it zooms:
//
//   Ctrl/⌘ + wheel, trackpad pinch  → zoom about the pointer
//   Safari's gesturestart/-change   → the same (its trackpad pinch)
//   plain wheel, two-finger scroll  → the page's pan, when it wants one
//   two fingers                     → pinch-zoom about their midpoint and pan
//                                     with it, at once
//   one finger                      → the page's own (passed through)
//   double tap                      → the page's (reset, fit)
//
// Every zoom is batched to one call per animation frame. Touch pointers are
// read in the capture phase on the window, ahead of every other handler, so
// a finger that belongs to a pinch is never seen by the page at all; the
// first finger, which the page did see, is taken back with `cancelSingle`.
// A page that cannot take its one-finger action back (the editor: selection,
// drags, insert tools) asks for it to be deferred instead: the finger's
// events are held until it commits (gestures.ts) and then replayed, or
// dropped when it turns out to be half of a pinch.

import {
    type Pt,
    TouchTracker,
    type TouchVerdict,
    wheelPixels,
    wheelZoomLog,
} from "./gestures";

// After a gesture with two fingers, the click a browser may still make of
// the last finger's release is not a tap.
const CLICK_AFTER_MS = 400;
// A touch this soon after a pen was near the screen is the hand holding it.
const PALM_MS = 1500;
// Wheel zooming counts as one gesture until the wheel rests this long.
const WHEEL_END_MS = 160;

export type ZoomSource = "wheel" | "pinch" | "gesture";

export interface GestureHost {
    // Where gestures happen: wheel and Safari gesture events are taken here,
    // and a touch sequence starts only on a finger landing inside it.
    surface: HTMLElement;
    // A finger landing on this target starts a sequence (false: leave the
    // touch to whatever is there, a palette or a scrolling list).
    accepts?(e: PointerEvent): boolean;
    // A wheel event over this target is the gesture's.
    acceptsWheel?(e: WheelEvent): boolean;
    // Hold this lone finger back until it commits (or lifts), instead of
    // passing it through and calling `cancelSingle` if a pinch follows.
    defer?(e: PointerEvent): boolean;
    // A pinch is starting: undo what the first finger began, leaving no
    // trace (no stroke, no trail, nothing sent anywhere).
    cancelSingle?(): void;
    // Zoom by `factor` about client point `from`, which then moves to `to`
    // (a pinch's midpoint pans as it zooms). Once per animation frame.
    zoom(factor: number, from: Pt, to: Pt, source: ZoomSource): void;
    // The zoom gesture is over (fingers lifted, the wheel at rest).
    zoomEnd?(source: ZoomSource): void;
    // A plain wheel's pixels, when `canPan` says the page pans with it now;
    // otherwise the wheel scrolls natively. Once per animation frame.
    canPan?(e: WheelEvent): boolean;
    pan?(dx: number, dy: number): void;
    doubleTap?(at: Pt, target: Element): void;
}

// Safari's GestureEvent (not in the DOM typings).
interface GestureEvent extends UIEvent {
    scale: number;
    clientX: number;
    clientY: number;
}

interface Deferred {
    target: Element;
    down: PointerEvent;
    last: PointerEvent;
}

function at(e: { clientX: number; clientY: number }): Pt {
    return { x: e.clientX, y: e.clientY };
}

// A copy of a held-back pointer event, to replay it where it was aimed.
function replica(
    type: string,
    src: PointerEvent,
    pos: PointerEvent = src,
): PointerEvent {
    return new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: src.pointerId,
        pointerType: src.pointerType,
        isPrimary: src.isPrimary,
        clientX: pos.clientX,
        clientY: pos.clientY,
        screenX: pos.screenX,
        screenY: pos.screenY,
        width: pos.width,
        height: pos.height,
        pressure: type === "pointerup" ? 0 : pos.pressure || 0.5,
        button: type === "pointermove" ? -1 : 0,
        buttons: type === "pointerup" ? 0 : 1,
        ctrlKey: pos.ctrlKey,
        shiftKey: pos.shiftKey,
        altKey: pos.altKey,
        metaKey: pos.metaKey,
    });
}

function stop(e: Event): void {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
}

export class GesturePad {
    readonly touch: TouchTracker;
    private host: GestureHost;
    // Touch pointers in the current sequence.
    private ours = new Set<number>();
    private deferred: Deferred | null = null;
    private replaying = false;
    private timer = 0;
    private clicksAfter = -Infinity;
    private penNear = -Infinity;
    private pensDown = new Set<number>();
    // This frame's batch.
    private frame = 0;
    private zoomLog = 0;
    private from: Pt | null = null;
    private to: Pt | null = null;
    private source: ZoomSource = "wheel";
    private panX = 0;
    private panY = 0;
    private wheelTimer = 0;
    private safariScale = 1;

    constructor(host: GestureHost, tracker = new TouchTracker()) {
        this.host = host;
        this.touch = tracker;
        const opts = { capture: true };
        window.addEventListener("pointerdown", (e) => this.down(e), opts);
        window.addEventListener("pointermove", (e) => this.move(e), opts);
        window.addEventListener("pointerup", (e) => this.up(e, false), opts);
        window.addEventListener("pointercancel", (e) => this.up(e, true), opts);
        window.addEventListener("click", (e) => this.claimClick(e), opts);
        window.addEventListener("dblclick", (e) => this.claimClick(e), opts);
        const s = host.surface;
        s.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
        s.addEventListener("gesturestart", (e) => this.gesture(e, "start"));
        s.addEventListener("gesturechange", (e) => this.gesture(e, "change"));
        s.addEventListener("gestureend", (e) => this.gesture(e, "end"));
    }

    // The touch sequence in progress (or the one that just ended) had a
    // second finger: it is no swipe and no tap.
    get multiTouch(): boolean {
        return this.touch.multiTouch;
    }

    // Two fingers are zooming, or one is left over from them.
    get claimed(): boolean {
        return this.touch.claimed;
    }

    // ── Touch ──

    private palm(): boolean {
        return (
            this.pensDown.size > 0 || performance.now() - this.penNear < PALM_MS
        );
    }

    private down(e: PointerEvent): void {
        if (e.pointerType === "pen") {
            this.penNear = performance.now();
            this.pensDown.add(e.pointerId);
            return;
        }
        if (e.pointerType !== "touch" || this.replaying) return;
        const target = e.target as Element | null;
        if (!target || !this.host.surface.contains(target)) return;
        if (!this.touch.active) {
            // A hand resting while a pen writes is the ink pad's to reject.
            if (this.palm() || this.host.accepts?.(e) === false) return;
        }
        const v = this.touch.down(e.pointerId, at(e), performance.now());
        this.ours.add(e.pointerId);
        if (v.cancelSingle) this.rollback();
        if (v.pinchStart) {
            this.source = "pinch";
            this.clicksAfter = Infinity;
        }
        if (!v.pass) {
            stop(e);
            return;
        }
        if (this.host.defer?.(e)) {
            this.deferred = { target, down: e, last: e };
            stop(e);
            clearTimeout(this.timer);
            this.timer = window.setTimeout(
                () => this.tick(),
                this.touch.opts.windowMs + 10,
            );
        }
    }

    private rollback(): void {
        if (this.deferred) {
            // Nothing reached the page: there is nothing to take back.
            this.deferred = null;
            clearTimeout(this.timer);
        } else {
            this.host.cancelSingle?.();
        }
    }

    private move(e: PointerEvent): void {
        if (e.pointerType === "pen") {
            this.penNear = performance.now();
            return;
        }
        if (this.replaying || !this.ours.has(e.pointerId)) return;
        const v = this.touch.move(e.pointerId, at(e), performance.now());
        this.queuePinch(v);
        if (!v.pass) {
            stop(e);
            return;
        }
        const d = this.deferred;
        if (d && d.down.pointerId === e.pointerId) {
            if (v.commit) {
                // Replayed before this very move goes on to the page.
                this.replayDown();
            } else {
                d.last = e;
                stop(e);
            }
        }
    }

    private tick(): void {
        const d = this.deferred;
        if (!d) return;
        const v = this.touch.tick(performance.now());
        if (!v.commit) {
            // It has not moved past the slop: wait for it to.
            return;
        }
        this.replayDown();
        this.replay(replica("pointermove", d.down, d.last), d.target);
    }

    private replayDown(): void {
        const d = this.deferred;
        if (!d) return;
        this.deferred = null;
        clearTimeout(this.timer);
        this.replay(replica("pointerdown", d.down), d.target);
    }

    private replay(e: PointerEvent, target: Element): void {
        const aim = target.isConnected
            ? target
            : document.elementFromPoint(e.clientX, e.clientY);
        if (!aim) return;
        this.replaying = true;
        try {
            aim.dispatchEvent(e);
        } finally {
            this.replaying = false;
        }
    }

    private up(e: PointerEvent, cancelled: boolean): void {
        if (e.pointerType === "pen") {
            this.penNear = performance.now();
            this.pensDown.delete(e.pointerId);
            return;
        }
        if (this.replaying || !this.ours.has(e.pointerId)) return;
        const v = this.touch.up(
            e.pointerId,
            at(e),
            performance.now(),
            cancelled,
        );
        this.ours.delete(e.pointerId);
        if (!this.touch.active) this.ours.clear();
        if (v.pinchEnd) {
            this.flush();
            this.host.zoomEnd?.("pinch");
        }
        if (this.touch.multiTouch) {
            this.clicksAfter = this.touch.active
                ? Infinity
                : performance.now() + CLICK_AFTER_MS;
        }
        if (!v.pass) {
            stop(e);
            return;
        }
        const d = this.deferred;
        if (d && d.down.pointerId === e.pointerId) {
            if (cancelled) {
                this.deferred = null;
                clearTimeout(this.timer);
                stop(e);
                return;
            }
            // A tap (or a still press): the page gets it whole, the press
            // replayed just before this release goes on; a flick quicker
            // than the window gets its move too.
            this.replayDown();
            if (v.moved)
                this.replay(replica("pointermove", d.down, e), d.target);
        }
        if (v.doubleTap) {
            this.host.doubleTap?.(v.doubleTap, e.target as Element);
        }
    }

    private claimClick(e: MouseEvent): void {
        if (this.touch.claimed || performance.now() < this.clicksAfter) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }

    // ── Wheel and Safari gestures ──

    private wheel(e: WheelEvent): void {
        if (this.host.acceptsWheel?.(e) === false) return;
        if (e.ctrlKey || e.metaKey) {
            // Over the surface the page zooms, not the browser.
            e.preventDefault();
            this.zoomLog += wheelZoomLog(e.deltaY, e.deltaMode);
            this.source = "wheel";
            this.from = at(e);
            this.to = at(e);
            clearTimeout(this.wheelTimer);
            this.wheelTimer = window.setTimeout(() => {
                this.flush();
                this.host.zoomEnd?.("wheel");
            }, WHEEL_END_MS);
            this.schedule();
            return;
        }
        if (!this.host.pan || !this.host.canPan?.(e)) return;
        e.preventDefault();
        const page = this.host.surface.clientHeight || undefined;
        this.panX += wheelPixels(e.deltaX, e.deltaMode, page);
        this.panY += wheelPixels(e.deltaY, e.deltaMode, page);
        this.schedule();
    }

    private gesture(raw: Event, phase: "start" | "change" | "end"): void {
        const e = raw as GestureEvent;
        // The page's pinch, not Safari's page zoom.
        e.preventDefault();
        // iOS sends these alongside the touches the pad already follows.
        if (this.touch.active) return;
        if (phase === "start") {
            this.safariScale = 1;
            return;
        }
        if (phase === "end") {
            this.flush();
            this.host.zoomEnd?.("gesture");
            return;
        }
        if (!(e.scale > 0)) return;
        this.zoomLog += Math.log(e.scale / this.safariScale);
        this.safariScale = e.scale;
        this.source = "gesture";
        this.from = at(e);
        this.to = at(e);
        this.schedule();
    }

    // ── Frames ──

    private queuePinch(v: TouchVerdict): void {
        if (!v.pinch) return;
        this.zoomLog += Math.log(v.pinch.scale);
        this.from ??= v.pinch.from;
        this.to = v.pinch.to;
        this.source = "pinch";
        this.schedule();
    }

    private schedule(): void {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => this.flush());
    }

    // Apply this frame's batch now.
    flush(): void {
        if (this.frame) cancelAnimationFrame(this.frame);
        this.frame = 0;
        const log = this.zoomLog;
        const from = this.from;
        const to = this.to;
        const dx = this.panX;
        const dy = this.panY;
        this.zoomLog = 0;
        this.from = null;
        this.to = null;
        this.panX = 0;
        this.panY = 0;
        if (from && to && (log !== 0 || from.x !== to.x || from.y !== to.y)) {
            this.host.zoom(Math.exp(log), from, to, this.source);
        }
        if (dx || dy) this.host.pan?.(dx, dy);
    }
}
