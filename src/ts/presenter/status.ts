import { buildStepRing } from "../shared/ring";
import { applyStep, maxStep as computeMaxStep } from "../shared/step";
import { state } from "./state";

const stage = document.getElementById("stage")!;
const slideInfo = document.getElementById("slide-info")!;
const stepInfo = document.getElementById("step-info")!;

export function maxStep(): number {
    if (state._maxStepCache !== null) return state._maxStepCache;
    state._maxStepCache = computeMaxStep(stage);
    return state._maxStepCache;
}

// Toggle .active on already-loaded SVG elements — triggers CSS transitions.
// Never touches innerHTML, so transitions fire correctly.
export function applyCurrentStep(): void {
    applyStep(stage, state.step);
    updateStatus();
}

export function syncURL(): void {
    const params = new URLSearchParams(window.location.search);
    if (state.step > 0) params.set("steps", String(state.step));
    else params.delete("steps");
    const search = params.size > 0 ? `?${params.toString()}` : "";
    const base = window.location.pathname.replace(/\/[^/]*$/, "");
    try {
        history.replaceState(
            null,
            "",
            `${base}/${state.slideIndex + 1}${search}`,
        );
    } catch (_) {}
}

export function readURL(): void {
    const seg = window.location.pathname.replace(/^.*\//, "");
    const n = parseInt(seg, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= state.slides.length)
        state.slideIndex = n - 1;
    const steps = parseInt(
        new URLSearchParams(window.location.search).get("steps") ?? "0",
        10,
    );
    if (!Number.isNaN(steps) && steps >= 0) state.step = steps;
}

export function updateStatus(): void {
    slideInfo.innerHTML = `<span class="slide-current">${state.slideIndex + 1}</span> / ${state.slides.length}`;
    stepInfo.innerHTML = buildStepRing(state.step, maxStep());
    syncURL();
}
