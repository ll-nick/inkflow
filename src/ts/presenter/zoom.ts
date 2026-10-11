// Zoom camera: a presenter-local pan/zoom of the mounted slide's `viewBox`.
//   Ctrl/⌘ + wheel, trackpad pinch → zoom toward the pointer (smoothly, per
//                                    frame: shared/gesturepad.ts)
//   two-finger scroll, wheel       → pan, while zoomed in (else nothing)
//   two fingers on a touchscreen   → pinch-zoom and pan at once
//   Ctrl + drag                    → pan
//   + / - / 0, double-click or tap → zoom in / out / reset (animated)
// A second finger landing soon after the first takes back whatever that
// finger began (an ink stroke, a laser trail: onTouchCancel), and the
// gesture ends with no click and no swipe.
// Purely client-side, never synced (followers keep their own view). Holding Ctrl
// also suppresses the laser draw, so the two never fight over a drag.
//
// Navigating while zoomed eases back to the full slide first (resetCameraThen),
// then the transition runs — so nothing here needs to know the transition type.
//
// Not the `transitions.Zoom` slide transition; the only shared word is "zoom".

import { cubicBezierEasing } from "../shared/easing";
import { GesturePad } from "../shared/gesturepad";
import type { Pt } from "../shared/gestures";
import { formatViewBox, parseViewBox, type ViewBox } from "../shared/viewbox";
import {
    isZoomedIn,
    lerpViewBox,
    panBy,
    type ScaleLimits,
    scaleOf,
    zoomAt,
} from "../shared/zoom-camera";
import { ProgressDriver } from "./progress-driver";

// Nullable: transitions.ts pulls this module into unit tests that build only a
// partial presenter DOM. The exported functions guard on currentSvg(), and the
// pointer listeners are only wired when the stage wrapper is present.
const stage = document.getElementById("stage");
const stageWrap = document.getElementById("stage-wrap");
const indicator = document.getElementById("zoom-indicator");

const LIMITS: ScaleLimits = { minScale: 1, maxScale: 8 };
const KEY_ZOOM_STEP = 1.4; // per +/- press
const KEY_ANIM_MS = 140;
const RESET_ANIM_MS = 240;
const NAV_RESET_MS = 150; // zoom-out before a slide change
const EASE = cubicBezierEasing("cubic-bezier(0.22, 1, 0.36, 1)");

// The authored viewBox of the current slide and the live camera. Both null when
// the camera has never been engaged on this slide (so navigation is a no-op).
let baseViewBox: ViewBox | null = null;
let camera: ViewBox | null = null;

// A slide load parked until the zoom-out ease finishes (see resetCameraThen).
let navReset: (() => void) | null = null;

// Drag state, captured once at pointerdown so the pan stays correct however many
// pointermove events fire between paints.
let dragStartCamera: ViewBox | null = null;
let dragStartInverse: DOMMatrix | null = null;
let dragStartClientX = 0;
let dragStartClientY = 0;

function currentSvg(): SVGSVGElement | null {
    return stage?.querySelector<SVGSVGElement>("svg") ?? null;
}

// Map a client point to slide user units through the live screen CTM, which
// already accounts for the current viewBox and preserveAspectRatio letterboxing.
function clientToUser(
    clientX: number,
    clientY: number,
    inverse?: DOMMatrix,
): { ux: number; uy: number } | null {
    const inv = inverse ?? currentSvg()?.getScreenCTM()?.inverse();
    if (!inv) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(inv);
    return { ux: p.x, uy: p.y };
}

// Populate baseViewBox/camera from the mounted slide if they are not set yet.
function ensureBase(): boolean {
    if (camera && baseViewBox) return true;
    const svg = currentSvg();
    if (!svg) return false;
    baseViewBox = parseViewBox(svg.getAttribute("viewBox"));
    camera = { ...baseViewBox };
    return true;
}

function renderIndicator(): void {
    if (!indicator) return;
    const factor = camera && baseViewBox ? scaleOf(camera, baseViewBox) : 1;
    indicator.textContent = `${factor.toFixed(1)}×`;
    indicator.toggleAttribute("data-active", factor > 1.01);
}

function applyCamera(): void {
    const svg = currentSvg();
    if (!svg || !camera) return;
    svg.setAttribute("viewBox", formatViewBox(camera));
    renderIndicator();
}

// One reusable driver for the camera's easing — only one camera animation ever
// runs at a time (a new call always aborts the previous one first).
const driver = new ProgressDriver();
let animController: AbortController | null = null;

function cancelAnim(): void {
    animController?.abort();
    animController = null;
}

// Ease the camera to `target` over `ms`, then call `onDone`. A newer
// animateCameraTo(), and a fresh wheel/drag, cancels it (and its `onDone` never
// fires — ProgressDriver resolves on abort too, so completion is distinguished
// by checking the controller's own signal).
function animateCameraTo(
    target: ViewBox,
    ms: number,
    onDone?: () => void,
): void {
    cancelAnim();
    if (!camera) {
        camera = { ...target };
        applyCamera();
        onDone?.();
        return;
    }
    const start = { ...camera };
    const controller = new AbortController();
    animController = controller;
    driver.value = 0;
    driver
        .animateTo(1, ms / 1000, controller.signal, (p) => {
            camera =
                p >= 1 ? { ...target } : lerpViewBox(start, target, EASE(p));
            applyCamera();
        })
        .then(() => {
            if (animController === controller) animController = null;
            if (!controller.signal.aborted) onDone?.();
        });
}

function endDrag(): void {
    dragStartCamera = null;
    dragStartInverse = null;
    document.body.classList.remove("zoom-grabbing");
}

// Snap the outgoing <svg> back to its authored viewBox and drop the camera.
// Called at the start of every slide load (transitions.ts) — by then the
// zoom-out ease (resetCameraThen) has already run, so this just settles state.
export function resetCamera(): void {
    cancelAnim();
    const svg = currentSvg();
    if (svg && baseViewBox) {
        svg.setAttribute("viewBox", formatViewBox(baseViewBox));
    }
    baseViewBox = null;
    camera = null;
    endDrag();
    renderIndicator();
}

export function cameraIsZoomed(): boolean {
    return !!camera && !!baseViewBox && isZoomedIn(camera, baseViewBox);
}

function runNavReset(): void {
    const fn = navReset;
    navReset = null;
    fn?.();
}

// Ease the zoomed slide back to full frame, then run `after` (the parked slide
// load). A newer call replaces `after`; the ease simply continues toward base.
// When not zoomed, `after` runs synchronously.
export function resetCameraThen(after: () => void): void {
    if (!cameraIsZoomed() || !baseViewBox) {
        navReset = null;
        after();
        return;
    }
    navReset = after;
    animateCameraTo({ ...baseViewBox }, NAV_RESET_MS, runNavReset);
}

// A non-deferred load supersedes a parked one without running it.
export function cancelPendingNav(): void {
    navReset = null;
}

// The user touched the camera mid-navigation: commit the parked load now.
function flushPendingNav(): void {
    if (navReset) runNavReset();
}

// User-initiated reset (0 / Esc / double-click): ease back to the full slide.
export function smoothResetCamera(): void {
    flushPendingNav();
    if (!ensureBase() || !camera || !baseViewBox) return;
    if (!isZoomedIn(camera, baseViewBox)) return;
    animateCameraTo({ ...baseViewBox }, RESET_ANIM_MS);
}

export function keyZoom(direction: "in" | "out"): void {
    flushPendingNav();
    if (!ensureBase() || !camera || !baseViewBox) return;
    const factor = direction === "in" ? KEY_ZOOM_STEP : 1 / KEY_ZOOM_STEP;
    const target = zoomAt(
        camera,
        baseViewBox,
        factor,
        { ux: camera.x + camera.w / 2, uy: camera.y + camera.h / 2 },
        LIMITS,
    );
    animateCameraTo(target, KEY_ANIM_MS);
}

// Zoom by `factor` about client point `from`, then pan so that the slide
// point under `from` sits under `to` (a pinch's midpoint moving).
function zoomAbout(factor: number, from: Pt, to: Pt): void {
    flushPendingNav();
    cancelAnim();
    if (!ensureBase() || !camera || !baseViewBox) return;
    const focus = clientToUser(from.x, from.y);
    if (!focus) return;
    camera = zoomAt(camera, baseViewBox, factor, focus, LIMITS);
    applyCamera();
    if (from.x === to.x && from.y === to.y) return;
    const a = clientToUser(from.x, from.y);
    const b = clientToUser(to.x, to.y);
    if (!a || !b) return;
    camera = panBy(camera, baseViewBox, a.ux - b.ux, a.uy - b.uy);
    applyCamera();
}

// Pan by screen pixels (a trackpad's two-finger scroll while zoomed in).
function panPixels(dx: number, dy: number): void {
    if (!camera || !baseViewBox) return;
    const inv = currentSvg()?.getScreenCTM()?.inverse();
    if (!inv) return;
    const units = Math.hypot(inv.a, inv.b);
    camera = panBy(camera, baseViewBox, dx * units, dy * units);
    applyCamera();
}

// What a finger began, to be taken back when a second one makes a pinch.
const touchCancels: (() => void)[] = [];
export function onTouchCancel(fn: () => void): void {
    touchCancels.push(fn);
}

let gestures: GesturePad | null = null;

// The touch sequence in progress (or just ended) had two fingers: its end is
// no swipe.
export function multiTouch(): boolean {
    return gestures?.multiTouch ?? false;
}

function overGrid(target: EventTarget | null): boolean {
    return Boolean((target as Element | null)?.closest?.("#overview"));
}

export function isCameraGesture(e: { ctrlKey: boolean }): boolean {
    return e.ctrlKey;
}

// Cursor affordance: while Ctrl is held the stage shows a grab cursor.
function setArmed(on: boolean): void {
    document.body.classList.toggle("camera-armed", on);
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Control") setArmed(true);
});
document.addEventListener("keyup", (e) => {
    if (e.key === "Control") setArmed(false);
});
window.addEventListener("blur", () => setArmed(false));

if (stageWrap) {
    const wrap = stageWrap;

    gestures = new GesturePad({
        surface: wrap,
        accepts: (e) =>
            !overGrid(e.target) &&
            !(e.target as Element).closest?.(".ink-palette"),
        acceptsWheel: (e) => !overGrid(e.target),
        cancelSingle: () => {
            for (const fn of touchCancels) fn();
        },
        zoom: zoomAbout,
        canPan: () => cameraIsZoomed(),
        pan: panPixels,
        doubleTap: smoothResetCamera,
    });

    wrap.addEventListener("pointerdown", (e) => {
        if (!isCameraGesture(e) || overGrid(e.target)) return;
        flushPendingNav();
        cancelAnim();
        if (!ensureBase() || !camera) return;
        const inverse = currentSvg()?.getScreenCTM()?.inverse();
        if (!inverse) return;
        wrap.setPointerCapture(e.pointerId);
        dragStartCamera = { ...camera };
        dragStartInverse = inverse;
        dragStartClientX = e.clientX;
        dragStartClientY = e.clientY;
        document.body.classList.add("zoom-grabbing");
    });

    wrap.addEventListener("pointermove", (e) => {
        if (!dragStartCamera || !dragStartInverse || !baseViewBox) return;
        const from = clientToUser(
            dragStartClientX,
            dragStartClientY,
            dragStartInverse,
        );
        const to = clientToUser(e.clientX, e.clientY, dragStartInverse);
        if (!from || !to) return;
        camera = panBy(
            dragStartCamera,
            baseViewBox,
            from.ux - to.ux,
            from.uy - to.uy,
        );
        applyCamera();
    });

    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);

    wrap.addEventListener("dblclick", smoothResetCamera);
}
