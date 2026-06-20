import { buildStepRing } from "../shared/ring";
import {
    applyStep,
    applyStepInstant,
    maxStep as computeMaxStep,
} from "../shared/step";
import { state } from "./state";

const stage = document.getElementById("stage")!;
const slideInfo = document.getElementById("slide-info")!;
const stepInfo = document.getElementById("step-info")!;
const mhudSlideInfo = document.getElementById("mhud-slide-info")!;
const mhudStepRing = document.getElementById("mhud-step-ring")!;

// maxStep is a pure function of the current slide's markup (its data-step and
// code-highlight attributes), so it is derived from the slide data rather than the
// live stage DOM. During a transition the stage briefly holds two slides at once
// (as layers), which would corrupt a DOM-based count; reading the data keeps the
// value correct mid-flight and lets navigation settle the step synchronously.
// Cached until the slide index or the slide set changes.
let maxStepSlides: typeof state.slides | null = null;
let maxStepIndex = -1;
let maxStepValue = 0;

export function maxStep(): number {
    if (maxStepSlides === state.slides && maxStepIndex === state.slideIndex)
        return maxStepValue;
    const scratch = document.createElement("div");
    scratch.innerHTML = state.slides[state.slideIndex]?.svg ?? "";
    maxStepValue = computeMaxStep(scratch);
    maxStepSlides = state.slides;
    maxStepIndex = state.slideIndex;
    return maxStepValue;
}

// Toggle .active on already-loaded SVG elements — triggers CSS transitions.
// Never touches innerHTML, so transitions fire correctly.
export function applyCurrentStep(): void {
    applyStep(stage, state.step);
    updateStatus();
}

// Like applyCurrentStep but lands the step with no animation playback. Used when
// entering a slide from ahead so its build animations appear already complete
// instead of replaying. See applyStepInstant.
export function applyCurrentStepInstant(): void {
    applyStepInstant(stage, state.step);
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
    const infoHtml = `<span class="slide-current">${state.slideIndex + 1}</span> / ${state.slides.length}`;
    const ringHtml = buildStepRing(state.step, maxStep());
    slideInfo.innerHTML = infoHtml;
    stepInfo.innerHTML = ringHtml;
    mhudSlideInfo.innerHTML = infoHtml;
    mhudStepRing.innerHTML = ringHtml;
    syncURL();
}
