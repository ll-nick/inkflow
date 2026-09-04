import { cubicBezierEasing } from "../shared/easing";
import { applyStepInstant, commitStepStyles } from "../shared/step";
import type { TransitionData } from "../shared/types";
import { formatViewBox, parseViewBox } from "../shared/viewbox";
import { MorphTransition } from "./morph";
import { ProgressDriver } from "./progress-driver";
import { state } from "./state";
import {
    applyCurrentStep,
    applyCurrentStepInstant,
    settleStepRun,
    updateStatus,
} from "./status";
import {
    cameraIsZoomed,
    cancelPendingNav,
    resetCamera,
    resetCameraThen,
} from "./zoom";

const stage = document.getElementById("stage")!;

// ── Transition interface ───────────────────────────────────────────────────────

// The low-level contract the framework drives. Most built-ins (and custom
// transitions) are written as a one-function `Render` and wrapped by
// `ProgressTransition` via registerProgressTransition() — see below. `cut` and
// `morph` implement this interface directly. The framework instantiates a fresh
// transition per invocation (via the registry factory) so instance state lives on
// `this` with no globals.
//
// Lifecycle (all methods receive named context objects — no positional args):
//   prepare   optional; called while the outgoing DOM is still live, before the
//             framework swaps in the new slide. Capture anything the animation
//             needs from the old slide here. Store results on `this`.
//   start     required, async. The framework has already swapped the new slide
//             into the stage by the time this runs, so it only animates. The
//             framework aborts `signal` when the transition is superseded.
//   cancel    optional; called when the framework aborts the transition to let it
//             clean up any DOM it owns. The framework always fires `then`.
//   reverse   optional; called instead of cancel+restart when the user reverses
//             direction mid-flight into the same transition type. Receives a fresh
//             signal. Implement only for transitions that can smoothly un-play.

export interface Transition {
    prepare?(ctx: { stage: HTMLElement; params: TransitionData }): void;
    start(ctx: {
        stage: HTMLElement;
        params: TransitionData;
        signal: AbortSignal;
    }): Promise<void>;
    cancel?(ctx: { stage: HTMLElement; params: TransitionData }): void;
    reverse?(ctx: {
        stage: HTMLElement;
        params: TransitionData;
        signal: AbortSignal;
    }): Promise<void>;
}

export type TransitionFactory = () => Transition;

// The layers handed to a Render each frame. `oldLayer` sits on top of `newLayer`.
export interface RenderContext {
    stage: HTMLElement;
    oldLayer: HTMLElement;
    newLayer: HTMLElement;
}

// A progress-driven transition: paint the two layers for a given eased progress
// (0 = old slide shown, 1 = new shown). Pure per-frame styling, no lifecycle.
export type Render = (
    context: RenderContext,
    progress: number,
    params: TransitionData,
) => void;

// An instant switch. Used for non-sequential jumps (picker, overview, first/last)
// where no transition should play — locally and, by sending it over the wire, on
// other connected screens too.
export const CUT: TransitionData = { type: "cut", duration: 0 };

// ── Registry ──────────────────────────────────────────────────────────────────

const registry = new Map<string, TransitionFactory>();

export function registerTransition(
    name: string,
    factory: TransitionFactory,
): void {
    registry.set(name, factory);
}

function reportTransitionFailure(error: unknown): void {
    console.error("inkflow: transition failed", error);
}

// ── In-flight state ───────────────────────────────────────────────────────────

let liveInstance: Transition | null = null;
let liveController: AbortController | null = null;
let liveParams: TransitionData | null = null;
let liveSettle: ((callThen: boolean) => void) | null = null;

// Abort the in-flight transition, clean up its DOM, and call its `then` if
// callThen is true. Safe to call when nothing is in flight.
function cancelInflight(callThen: boolean): void {
    if (!liveController) return;
    const ctrl = liveController;
    const inst = liveInstance;
    const params = liveParams!;
    const settle = liveSettle!;
    liveController = null;
    liveInstance = null;
    liveParams = null;
    liveSettle = null;
    ctrl.abort();
    inst?.cancel?.({ stage, params });
    settle(callThen);
}

// The direction of the currently animating slide transition (forward navigation
// vs backward), or null if none is in flight. Navigation reads this to snap an
// in-flight transition to its end on a same-direction press.
export function inflightDirection(): "forward" | "backward" | null {
    if (!liveParams) return null;
    return liveParams.reverse ? "backward" : "forward";
}

// Finish the in-flight transition immediately: stop its animation, fire its
// callback, and render the destination slide cleanly at the current step. The
// state (slideIndex, step) is already settled, so this only collapses the visual.
// Re-rendering covers transitions whose cancel() leaves the DOM mid-animation
// (morph's soft-cancel); for layer transitions it just repaints identical content.
export function snapInflight(): void {
    cancelInflight(true);
    stage.innerHTML = state.slides.length
        ? state.slides[state.slideIndex].svg
        : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
    applyCurrentStepInstant();
    updateStatus();
}

// ── Layer helpers ─────────────────────────────────────────────────────────────

// A transition layer is an absolutely-positioned div the size of the stage.
// Wrapping slide content in a div avoids transforming the SVG element directly
// (percentage CSS transforms on an SVG resolve in user units, not CSS pixels).
function makeLayer(): HTMLDivElement {
    const layer = document.createElement("div");
    layer.style.cssText =
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none";
    layer.style.padding = getComputedStyle(stage).padding;
    return layer;
}

function sizeLayerChild(layer: HTMLDivElement): void {
    const child = layer.firstElementChild as HTMLElement | null;
    if (child) {
        child.style.width = "100%";
        child.style.height = "100%";
    }
}

// ── Direction helpers ─────────────────────────────────────────────────────────

type Axis = "X" | "Y";

function dirAxis(dir: string): Axis {
    return dir === "up" || dir === "down" ? "Y" : "X";
}

// Sign for the incoming slide's start offset: enters from the opposite edge.
// "left" → new enters from the right (+100%); "up" → new from the bottom (+100%).
function incomingSign(dir: string): 1 | -1 {
    return dir === "left" || dir === "up" ? 1 : -1;
}

function flipDir(dir: string): string {
    return (
        (
            { left: "right", right: "left", up: "down", down: "up" } as Record<
                string,
                string
            >
        )[dir] ?? dir
    );
}

// ── Progress-driven host ──────────────────────────────────────────────────────

// Wraps a Render into a full Transition. It owns the layer lifecycle, composes a
// ProgressDriver, applies the easing curve, and re-glides the layers on reverse.
// The entire animation state is the driver's single progress value, so any number
// of mid-flight direction changes (reverse, reverse-of-a-reverse, …) compose
// without snapshotting.
class ProgressTransition implements Transition {
    private oldLayer!: HTMLDivElement;
    private newLayer!: HTMLDivElement;
    private outgoingHtml = "";
    private stageStyleText = "";
    private settled = false;
    private readonly driver = new ProgressDriver();
    private ease: (progress: number) => number = (progress) => progress;
    // Captured at start() and used for every frame, including reverse(). The
    // geometry must not change when direction flips — the progress value alone
    // carries the reversal — so reverse()'s own (direction-flipped) params are
    // ignored for painting.
    private startParams!: TransitionData;

    constructor(private readonly render: Render) {}

    prepare(): void {
        this.outgoingHtml = stage.innerHTML;
        // Snapshot so teardown can restore any stage-level style a render sets
        // (fade's background, flip's perspective) without knowing which.
        this.stageStyleText = stage.style.cssText;
    }

    async start({
        params,
        signal,
    }: {
        stage: HTMLElement;
        params: TransitionData;
        signal: AbortSignal;
    }): Promise<void> {
        if (params.duration <= 0) return;
        this.startParams = params;
        this.buildLayers();
        this.ease = cubicBezierEasing(params.easing);
        this.paint(0);
        await this.driver.animateTo(1, params.duration, signal, (value) =>
            this.paint(value),
        );
        if (!signal.aborted) this.settle();
    }

    async reverse({
        signal,
    }: {
        stage: HTMLElement;
        params: TransitionData;
        signal: AbortSignal;
    }): Promise<void> {
        // Only the progress direction changes; the geometry stays as the forward
        // play established it. Driving the same render with the original params
        // (via paint) makes the layers retrace their path instead of re-flipping.
        const target = this.driver.heading === 1 ? 0 : 1;
        await this.driver.animateTo(
            target,
            this.startParams.duration,
            signal,
            (value) => this.paint(value),
        );
        if (!signal.aborted) this.settle();
    }

    cancel(): void {
        this.teardown(this.newLayer);
    }

    private paint(value: number): void {
        this.render(
            { stage, oldLayer: this.oldLayer, newLayer: this.newLayer },
            this.ease(value),
            this.startParams,
        );
    }

    private buildLayers(): void {
        this.settled = false;
        const newLayer = makeLayer();
        while (stage.firstChild) newLayer.appendChild(stage.firstChild);
        sizeLayerChild(newLayer);
        stage.appendChild(newLayer);
        this.newLayer = newLayer;

        const oldLayer = makeLayer();
        oldLayer.innerHTML = this.outgoingHtml;
        sizeLayerChild(oldLayer);
        stage.appendChild(oldLayer);
        this.oldLayer = oldLayer;
    }

    private settle(): void {
        this.teardown(this.driver.value >= 1 ? this.newLayer : this.oldLayer);
    }

    // Replace the stage's content with just the shown slide, dropping both layers
    // and anything else a render added (the fade colour backdrop) in one step, and
    // restore the stage's pre-transition inline style. Idempotent; skipped when no
    // layers were built (duration 0), where the slide is already in place.
    private teardown(shownLayer: HTMLDivElement | undefined): void {
        if (this.settled) return;
        this.settled = true;
        if (shownLayer) stage.replaceChildren(...shownLayer.children);
        stage.style.cssText = this.stageStyleText;
    }
}

// Register a progress-driven transition by its per-frame render. The easing
// default lives in the Python transition subclass, so it always arrives on
// `params.easing`; there is no JS-side default.
export function registerProgressTransition(name: string, render: Render): void {
    registerTransition(name, () => new ProgressTransition(render));
}

// ── Built-in transitions ──────────────────────────────────────────────────────

// `cut` is instant: the framework already swapped the new slide in, so there is
// nothing to animate.
class CutTransition implements Transition {
    async start(): Promise<void> {}
}

// progress 0 → old shown, 1 → new shown. `progress` arrives already eased.

const crossfadeRender: Render = ({ oldLayer }, progress) => {
    oldLayer.style.opacity = String(1 - progress);
};

const pushRender: Render = ({ oldLayer, newLayer }, progress, params) => {
    const direction = params.reverse
        ? flipDir(params.direction ?? "left")
        : (params.direction ?? "left");
    const axis = dirAxis(direction);
    const sign = incomingSign(direction);
    oldLayer.style.transform = `translate${axis}(${-progress * 100 * sign}%)`;
    newLayer.style.transform = `translate${axis}(${(1 - progress) * 100 * sign}%)`;
};

const coverRender: Render = ({ oldLayer }, progress, params) => {
    // The old slide slides off, revealing the static new slide underneath.
    const direction = params.direction ?? "left";
    const axis = dirAxis(direction);
    const sign = incomingSign(direction);
    const exitSign = params.reverse ? sign : -sign;
    oldLayer.style.transform = `translate${axis}(${exitSign * 100 * progress}%)`;
};

const zoomRender: Render = ({ oldLayer, newLayer }, progress, params) => {
    // A zoom dissolve. Forward (zoom in): the new slide grows into place from
    // smaller while fading in, as the old slide keeps zooming past the viewer.
    // Backward (zoom out): the new slide settles in from larger while the old
    // shrinks away — the visual opposite, so the two directions read differently.
    // `amount` is how far the slides scale past 1 (from the Zoom dataclass).
    const amount = params.amount ?? 0.6;
    oldLayer.style.transformOrigin = "center";
    newLayer.style.transformOrigin = "center";
    oldLayer.style.opacity = String(1 - progress);
    newLayer.style.opacity = String(progress);
    if (params.reverse) {
        oldLayer.style.transform = `scale(${1 - amount * progress})`;
        newLayer.style.transform = `scale(${1 + amount - amount * progress})`;
    } else {
        oldLayer.style.transform = `scale(${1 + amount * progress})`;
        newLayer.style.transform = `scale(${1 - amount + amount * progress})`;
    }
};

// A constant colour backdrop the fade dips through. It is an SVG that copies the
// slide's viewBox/preserveAspectRatio, so it letterboxes exactly like the slide —
// the colour fills the slide area while the bars stay black. A plain rect would
// instead flood the whole stage, bars included.
const SVG_NS = "http://www.w3.org/2000/svg";

function makeFadeBackdrop(
    slideSvg: SVGSVGElement | null,
    color: string,
): HTMLDivElement {
    const layer = makeLayer();
    layer.dataset.fadeBackdrop = "1";
    const vb = parseViewBox(slideSvg?.getAttribute("viewBox") ?? null);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", formatViewBox(vb));
    svg.setAttribute(
        "preserveAspectRatio",
        slideSvg?.getAttribute("preserveAspectRatio") ?? "xMidYMid meet",
    );
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", String(vb.w));
    rect.setAttribute("height", String(vb.h));
    rect.setAttribute("fill", color);
    svg.appendChild(rect);
    layer.appendChild(svg);
    sizeLayerChild(layer);
    return layer;
}

const fadeRender: Render = (
    { stage: stageElement, oldLayer, newLayer },
    progress,
    params,
) => {
    // Place the colour backdrop behind both slides once, then fade the old slide
    // out over the first half and the new slide in over the second. The midpoint
    // shows the backdrop colour; the host's teardown removes it.
    const existing = newLayer.previousElementSibling;
    if (
        !(existing instanceof HTMLElement) ||
        existing.dataset.fadeBackdrop !== "1"
    ) {
        const backdrop = makeFadeBackdrop(
            newLayer.querySelector("svg"),
            params.color ?? "#000000",
        );
        stageElement.insertBefore(backdrop, newLayer);
    }
    oldLayer.style.opacity = String(Math.max(0, 1 - progress * 2));
    newLayer.style.opacity = String(Math.max(0, progress * 2 - 1));
};

const WIPE_CLIP: Record<string, (percent: number) => string> = {
    left: (percent) => `inset(0 0 0 ${percent}%)`,
    right: (percent) => `inset(0 ${percent}% 0 0)`,
    up: (percent) => `inset(0 0 ${percent}% 0)`,
    down: (percent) => `inset(${percent}% 0 0 0)`,
};

const wipeRender: Render = ({ oldLayer }, progress, params) => {
    const direction = params.reverse
        ? flipDir(params.direction ?? "left")
        : (params.direction ?? "left");
    const clip = WIPE_CLIP[direction] ?? WIPE_CLIP.left;
    oldLayer.style.clipPath = clip(progress * 100);
};

// ── Register built-ins ────────────────────────────────────────────────────────

registerTransition("cut", () => new CutTransition());
registerProgressTransition("crossfade", crossfadeRender);
registerProgressTransition("push", pushRender);
registerProgressTransition("cover", coverRender);
registerProgressTransition("zoom", zoomRender);
registerProgressTransition("fade", fadeRender);
registerProgressTransition("wipe", wipeRender);
registerTransition("morph", () => new MorphTransition());

// ── loadSlide ─────────────────────────────────────────────────────────────────

// Replace stage content with the current slide. Does NOT call applyCurrentStep()
// — elements start in their pre-transition state so the next advance() triggers
// a real animated transition.
//
// `then` runs after the transition completes (or on cancellation). It always
// runs exactly once so lifecycle callbacks (_syncingFromServer, sendNav) are
// never left dangling even during rapid navigation.
//
// Callers set state.step before calling (maxStep is data-derived, so it is known
// without the DOM); the step is then applied to the fresh content automatically.
//
// When the new transition is the exact reverse of the in-flight one (same type,
// opposite direction), and the in-flight handler implements reverse(), the
// framework calls reverse() on the existing instance instead of cancel+restart,
// giving smooth mid-flight direction change without a visible snap.
//
// If the zoom camera is engaged, the slide load waits for a short zoom-out ease
// (resetCameraThen) and then runs; otherwise it runs straight away. A second
// load arriving during that ease replaces the parked one (rapid navigation
// collapses to the final slide), so a parked `then` may be dropped before its
// body runs — fine, since the only `then` in play is idempotent sync cleanup
// the replacing load repeats.
export function loadSlide(
    then: (() => void) | null = null,
    transition: TransitionData | null = null,
    entryPlay = false,
): void {
    const body = () => loadSlideBody(then, transition, entryPlay);
    if (cameraIsZoomed()) {
        resetCameraThen(body);
    } else {
        cancelPendingNav();
        body();
    }
}

function loadSlideBody(
    then: (() => void) | null,
    transition: TransitionData | null,
    entryPlay: boolean,
): void {
    // The zoom-out ease (if any) has finished; settle the camera state and make
    // sure the outgoing <svg> carries its authored viewBox before it is captured.
    resetCamera();

    // A step run in flight (mid-chain when a slide change is triggered) is landed on its
    // destination before we capture and replace the outgoing slide.
    settleStepRun();

    const params: TransitionData =
        transition ?? state.transitions[state.slideIndex] ?? CUT;

    // Entry-play: a forward sequential entrance animates the entry step *after* the
    // transition settles, so its cues must stay hidden during the transition. A CUT or a
    // reversed (backward) entrance keeps the normal instant landing.
    const entering = entryPlay && params.type !== "cut" && !params.reverse;

    // Reconcile the visual + status with whatever content is now in the stage:
    // land the current step and sync the status bar + URL. swap() runs this after
    // writing fresh innerHTML; the reverse() path runs it after reverse() restores
    // the destination DOM, so both routes leave the DOM, the step, and the URL
    // consistent. (maxStep is data-derived, so it needs no cache invalidation here.)
    const settleContent = () => {
        applyCurrentStepInstant();
        updateStatus();
    };
    // For an entry-play entrance, land the pre-entry state (one below the entry step) so
    // the entry cues are hidden until applyCurrentStep() animates them after the transition.
    const initialLand = entering
        ? () => {
              applyStepInstant(stage, state.step - 1);
              updateStatus();
          }
        : settleContent;

    const swap = () => {
        stage.innerHTML = state.slides.length
            ? state.slides[state.slideIndex].svg
            : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
        initialLand();
    };

    // Smooth reversal: same transition type, opposite direction, handler has reverse().
    const canReverse =
        liveInstance?.reverse != null &&
        liveParams != null &&
        liveParams.type === params.type &&
        Boolean(liveParams.reverse) !== Boolean(params.reverse);

    if (canReverse) {
        const inst = liveInstance!;
        const ctrl = liveController!;
        const prevSettle = liveSettle!;

        // Abort the forward signal. Do NOT call cancel() — layers must survive
        // for the reverse animation to run on the same instance.
        ctrl.abort();
        liveController = null;
        liveInstance = null;
        liveParams = null;
        liveSettle = null;
        prevSettle(true); // forward then always fires (typically null)

        const newCtrl = new AbortController();
        let done = false;
        const settle = (callThen: boolean) => {
            if (done) return;
            done = true;
            if (liveController === newCtrl) {
                liveController = null;
                liveInstance = null;
                liveParams = null;
                liveSettle = null;
            }
            if (callThen) then?.();
        };

        liveController = newCtrl;
        liveInstance = inst;
        liveParams = params;
        liveSettle = settle;

        inst.reverse!({ stage, params, signal: newCtrl.signal })
            .then(() => {
                // reverse() restored the destination DOM into the stage but never
                // went through swap(), so run the same settle sequence here to
                // re-apply the step and sync the status bar + URL with the
                // destination slide.
                if (!newCtrl.signal.aborted) settleContent();
                settle(true);
            })
            .catch((error) => {
                reportTransitionFailure(error);
                settle(false);
            });

        return;
    }

    // Standard path: cancel in-flight (calls its then), start fresh.
    cancelInflight(true);

    const makeTransition = registry.get(params.type);
    if (!makeTransition) {
        // Unknown transition type — fall back to instant swap.
        swap();
        if (entering) applyCurrentStep(); // still play the entry step
        then?.();
        return;
    }

    const inst = makeTransition();
    // Bake the outgoing slide's held step state into inline styles so the transition's
    // snapshot (innerHTML / cloned nodes) keeps the current step instead of reverting to
    // the authored base — the WAAPI animations that hold that state do not serialize.
    commitStepStyles(stage);
    inst.prepare?.({ stage, params });

    const ctrl = new AbortController();
    let done = false;
    const settle = (callThen: boolean) => {
        if (done) return;
        done = true;
        if (liveController === ctrl) {
            liveController = null;
            liveInstance = null;
            liveParams = null;
            liveSettle = null;
        }
        if (callThen) then?.();
    };

    liveController = ctrl;
    liveInstance = inst;
    liveParams = params;
    liveSettle = settle;

    // The framework owns the swap: prepare() has captured whatever the outgoing
    // DOM was needed for, so the new slide goes in now and start() only animates.
    swap();

    inst.start({ stage, params, signal: ctrl.signal })
        .then(() => {
            // Entry-play: the transition has settled, so animate the entry step now.
            if (entering && !ctrl.signal.aborted) applyCurrentStep();
            settle(true);
        })
        .catch((error) => {
            reportTransitionFailure(error);
            settle(false);
        });
}
