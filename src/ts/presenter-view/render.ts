import { applyStep, maxStep as computeMaxStep } from "../shared/step";
import { state } from "./state";

const currentPane = document.getElementById("pv-current-inner")!;
const nextPane = document.getElementById("pv-next-inner")!;
const notesPane = document.getElementById("pv-notes")!;
const slideEl = document.getElementById("pv-slide")!;
const stepEl = document.getElementById("pv-step")!;

export function maxStep(): number {
    if (state._maxStepCache !== null) return state._maxStepCache;
    state._maxStepCache = computeMaxStep(currentPane);
    return state._maxStepCache;
}

export function applyCurrentStep(): void {
    applyStep(currentPane, state.step);
}

export function updateInfo(): void {
    const total = state.slides.length;
    slideEl.innerHTML = `Slide <span class="pv-num">${total ? state.slideIndex + 1 : "–"}</span> / ${total || "–"}`;
    stepEl.innerHTML = `Step <span class="pv-num">${state.step}</span> / ${maxStep()}`;
}

export function scaleNext(): void {
    const svg = nextPane.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") || "")
        .split(/[\s,]+/)
        .map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2];
    const vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const scale = Math.min(
        nextPane.clientWidth / vbW,
        nextPane.clientHeight / vbH,
    );
    const tx = (nextPane.clientWidth - vbW * scale) / 2;
    const ty = (nextPane.clientHeight - vbH * scale) / 2;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

export function renderCurrent(): void {
    currentPane.innerHTML = state.slides[state.slideIndex]?.svg ?? "";
    state._maxStepCache = null;
    applyCurrentStep();
    updateInfo();
}

// The "next click" preview: current slide +1 step, or next slide at step 0.
export function renderNext(): void {
    const curMax = maxStep();
    let previewSvg: string | null = null;
    let revealStep = 0;
    if (state.step < curMax) {
        previewSvg = state.slides[state.slideIndex]?.svg ?? null;
        revealStep = state.step + 1;
    } else if (state.slideIndex + 1 < state.slides.length) {
        previewSvg = state.slides[state.slideIndex + 1].svg;
    }
    if (previewSvg === null) {
        nextPane.innerHTML = '<div id="pv-next-empty">END</div>';
        return;
    }
    nextPane.innerHTML = previewSvg;
    const svg = nextPane.querySelector("svg");
    if (svg) {
        svg.querySelectorAll("[data-step]").forEach((el) => {
            el.classList.toggle(
                "active",
                +el.getAttribute("data-step") <= revealStep,
            );
        });
    }
    requestAnimationFrame(scaleNext);
}

export function renderNotes(): void {
    notesPane.innerHTML = state.slides[state.slideIndex]?.notes ?? "";
    notesPane.scrollTop = 0;
}

export function renderAll(): void {
    renderCurrent();
    renderNext();
    renderNotes();
}

window.addEventListener("resize", () => {
    scaleNext();
});
