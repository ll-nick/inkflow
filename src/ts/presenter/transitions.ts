import type { TransitionData } from "../shared/types";
import { morphToNextSlide } from "./morph";
import { state } from "./state";
import { applyCurrentStepInstant, updateStatus } from "./status";

const stage = document.getElementById("stage")!;

// ── Registry ──────────────────────────────────────────────────────────────────

export type TransitionHandler = (
    swap: () => void,
    t: TransitionData,
    then: (() => void) | null,
) => void;

const registry = new Map<string, TransitionHandler>();

export function registerTransition(
    name: string,
    handler: TransitionHandler,
): void {
    registry.set(name, handler);
}

// ── Layer helper ────────────────────────────────────────────────────────────

// A transition layer is an absolutely-positioned div the size of the stage that
// holds one slide's content. Both the outgoing and incoming slides go in a layer
// so handlers only ever transform plain divs — a percentage transform on a raw
// <svg> root resolves against its viewBox (user units), not the CSS box, so the
// svg must never be transformed directly. Reading computed padding at call time
// handles the fullscreen case (padding: 0).
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

// Shared setup for all CSS-based transitions:
//   1. Capture the current stage HTML, then swap() in the new slide.
//   2. Wrap the new slide in `newLayer` and the old slide in `oldLayer` (on top).
//   3. Call animate(oldLayer, newLayer, t, done) — the handler drives the divs.
//   4. done() unwraps the new slide back into the stage and removes both layers.
function cssTransition(
    animate: (
        oldLayer: HTMLDivElement,
        newLayer: HTMLDivElement,
        t: TransitionData,
        done: () => void,
    ) => void,
): TransitionHandler {
    return (swap, t, then) => {
        if (t.duration <= 0) {
            swap();
            then?.();
            return;
        }

        const oldHTML = stage.innerHTML;
        swap();

        // Move the freshly-swapped new content into its own layer div.
        const newLayer = makeLayer();
        while (stage.firstChild) newLayer.appendChild(stage.firstChild);
        sizeLayerChild(newLayer);
        stage.appendChild(newLayer);

        // Clone of the outgoing slide, layered on top.
        const oldLayer = makeLayer();
        oldLayer.innerHTML = oldHTML;
        sizeLayerChild(oldLayer);
        stage.appendChild(oldLayer);

        animate(oldLayer, newLayer, t, () => {
            // Unwrap: return the new content to the stage, drop both layers.
            while (newLayer.firstChild)
                stage.insertBefore(newLayer.firstChild, newLayer);
            newLayer.remove();
            oldLayer.remove();
            then?.();
        });
    };
}

// ── Direction helpers ─────────────────────────────────────────────────────────

type Axis = "X" | "Y";

function dirAxis(dir: string): Axis {
    return dir === "up" || dir === "down" ? "Y" : "X";
}

// Sign for the incoming slide's start offset: it enters from the opposite edge.
// "left" → new enters from the right (+100%), "up" → new enters from the bottom (+100%).
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

// Force a synchronous style/layout flush. Called between writing a transition's
// "from" value and its "to" value so the browser registers two distinct states
// and animates between them, instead of coalescing both writes into one paint.
// Without this the transition only fires if some other code happened to flush
// styles in between — fragile, and broken by an instant step applied on swap.
function reflow(): void {
    void stage.offsetHeight;
}

// ── Built-in handlers ─────────────────────────────────────────────────────────

registerTransition("cut", (swap, _t, then) => {
    swap();
    then?.();
});

registerTransition(
    "crossfade",
    cssTransition((oldLayer, _newLayer, t, done) => {
        const easing = t.easing ?? "ease";
        oldLayer.style.transition = `opacity ${t.duration}s ${easing}`;
        reflow();
        requestAnimationFrame(() => {
            oldLayer.style.opacity = "0";
            setTimeout(done, t.duration * 1000);
        });
    }),
);

registerTransition(
    "push",
    cssTransition((oldLayer, newLayer, t, done) => {
        const dir = t.reverse
            ? flipDir(t.direction ?? "left")
            : (t.direction ?? "left");
        const axis = dirAxis(dir);
        const sign = incomingSign(dir);
        const easing = t.easing ?? "ease-in-out";
        const ms = t.duration * 1000;

        // Both layers move together: outgoing exits in the travel direction while
        // incoming enters from the opposite edge.
        oldLayer.style.transition = `transform ${t.duration}s ${easing}`;
        newLayer.style.transform = `translate${axis}(${sign * 100}%)`;
        newLayer.style.transition = `transform ${t.duration}s ${easing}`;

        reflow();
        requestAnimationFrame(() => {
            oldLayer.style.transform = `translate${axis}(${-sign * 100}%)`;
            newLayer.style.transform = `translate${axis}(0)`;
            setTimeout(done, ms);
        });
    }),
);

registerTransition(
    "slide",
    cssTransition((oldLayer, _newLayer, t, done) => {
        const dir = t.direction ?? "left";
        const axis = dirAxis(dir);
        const sign = incomingSign(dir);
        const easing = t.easing ?? "ease-in-out";
        const ms = t.duration * 1000;

        // Old slides away, revealing the new one (which stays put) underneath.
        // Reverse: exits the opposite way to visually undo the forward motion.
        const exitPct = t.reverse ? sign * 100 : -sign * 100;
        oldLayer.style.transition = `transform ${t.duration}s ${easing}`;

        reflow();
        requestAnimationFrame(() => {
            oldLayer.style.transform = `translate${axis}(${exitPct}%)`;
            setTimeout(done, ms);
        });
    }),
);

registerTransition(
    "zoom",
    cssTransition((oldLayer, newLayer, t, done) => {
        const easing = t.easing ?? "ease-in-out";
        const ms = t.duration * 1000;

        oldLayer.style.transformOrigin = "center";
        oldLayer.style.transition = `opacity ${t.duration}s ${easing}, transform ${t.duration}s ${easing}`;
        newLayer.style.opacity = "0";
        newLayer.style.transform = "scale(0.95)";
        newLayer.style.transformOrigin = "center";
        newLayer.style.transition = `opacity ${t.duration}s ${easing}, transform ${t.duration}s ${easing}`;

        reflow();
        requestAnimationFrame(() => {
            oldLayer.style.opacity = "0";
            oldLayer.style.transform = "scale(1.05)";
            newLayer.style.opacity = "1";
            newLayer.style.transform = "scale(1)";
            setTimeout(done, ms);
        });
    }),
);

registerTransition(
    "fade",
    cssTransition((oldLayer, newLayer, t, done) => {
        const color = t.color ?? "#000000";
        const easing = t.easing ?? "ease";
        const half = t.duration / 2;
        const halfMs = half * 1000;

        // Show the midpoint colour behind both slides.
        stage.style.backgroundColor = color;

        oldLayer.style.transition = `opacity ${half}s ${easing}`;
        newLayer.style.opacity = "0";

        reflow();
        requestAnimationFrame(() => {
            oldLayer.style.opacity = "0";
            setTimeout(() => {
                // Old layer faded out; now fade the new one in.
                newLayer.style.transition = `opacity ${half}s ${easing}`;
                reflow();
                requestAnimationFrame(() => {
                    newLayer.style.opacity = "1";
                    setTimeout(() => {
                        stage.style.backgroundColor = "";
                        done();
                    }, halfMs);
                });
            }, halfMs);
        });
    }),
);

registerTransition(
    "wipe",
    cssTransition((oldLayer, _newLayer, t, done) => {
        const dir = t.direction ?? "left";
        const easing = t.easing ?? "ease-in-out";
        const ms = t.duration * 1000;

        // Old layer is clipped away, revealing the new one underneath.
        // exitClip[d] = the clip-path that fully hides the old layer edge-first from d.
        // Reverse: flip the effective direction so the wipe goes the other way.
        const effectiveDir = t.reverse ? flipDir(dir) : dir;
        const exitClip =
            (
                {
                    left: "inset(0 0 0 100%)",
                    right: "inset(0 100% 0 0)",
                    up: "inset(0 0 100% 0)",
                    down: "inset(100% 0 0 0)",
                } as Record<string, string>
            )[effectiveDir] ?? "inset(0 0 0 100%)";

        oldLayer.style.clipPath = "inset(0)";
        oldLayer.style.transition = `clip-path ${t.duration}s ${easing}`;

        reflow();
        requestAnimationFrame(() => {
            oldLayer.style.clipPath = exitClip;
            setTimeout(done, ms);
        });
    }),
);

registerTransition("morph", (swap, transition, then) => {
    if (transition.duration <= 0 || !state.slides.length) {
        swap();
        then?.();
        return;
    }
    morphToNextSlide(swap, transition, then);
});

// ── loadSlide ─────────────────────────────────────────────────────────────────

// Replace stage content with the current slide. Does NOT call applyCurrentStep()
// — elements start in their pre-transition state so the next advance() triggers
// a real animated transition. Optional `then` runs after the content is swapped.
// Pass `transition` to override the destination slide's declared transition (used
// when navigating backward so the outgoing slide's transition plays in reverse).
// `onSwap` runs synchronously right after the new content is in the DOM but before
// the transition animates — i.e. before the browser paints the fresh elements.
// Applying a step here lands it without animation (no painted "from" state to
// transition from), which is how backward navigation shows a slide already built.
export function loadSlide(
    then: (() => void) | null = null,
    transition: TransitionData | null = null,
    onSwap: (() => void) | null = null,
): void {
    const swap = () => {
        stage.innerHTML = state.slides.length
            ? state.slides[state.slideIndex].svg
            : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
        state._maxStepCache = null;
        onSwap?.();
        applyCurrentStepInstant();
        updateStatus();
    };

    const t = transition ??
        state.transitions[state.slideIndex] ?? { type: "cut", duration: 0 };
    const handler = registry.get(t.type);
    if (handler) {
        handler(swap, t, then);
        return;
    }

    // Unknown transition type — fall back to instant swap.
    swap();
    then?.();
}
