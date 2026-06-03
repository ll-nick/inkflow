import { applyStep, maxStep as computeMaxStep } from "../shared/step";
import { state } from "./state";

const stage = document.getElementById("stage");
const slideInfo = document.getElementById("slide-info");
const stepInfo = document.getElementById("step-info");

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
    const search = state.step > 0 ? `?clicks=${state.step}` : "";
    try {
        history.replaceState(null, "", `/${state.slideIndex + 1}${search}`);
    } catch (_) {}
}

export function readURL(): void {
    const seg = window.location.pathname.replace(/^\//, "");
    const n = parseInt(seg, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= state.slides.length)
        state.slideIndex = n - 1;
    const clicks = parseInt(
        new URLSearchParams(window.location.search).get("clicks") ?? "0",
        10,
    );
    if (!Number.isNaN(clicks) && clicks >= 0) state.step = clicks;
}

function buildStepRing(current: number, total: number): string {
    const size = 20,
        cx = 10,
        cy = 10,
        ro = 9,
        ri = 5;
    if (total === 0) {
        return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle"><circle cx="${cx}" cy="${cy}" r="${(ro + ri) / 2}" fill="none" stroke="var(--overlay)" stroke-width="${ro - ri}" opacity="0.2"/></svg>`;
    }
    const gap = total > 1 ? 0.15 : 0;
    const sweep = (2 * Math.PI) / total;
    let paths = "";
    for (let i = 0; i < total; i++) {
        const a1 = -Math.PI / 2 + i * sweep + gap / 2;
        const a2 = -Math.PI / 2 + (i + 1) * sweep - gap / 2;
        const ox1 = (cx + ro * Math.cos(a1)).toFixed(2),
            oy1 = (cy + ro * Math.sin(a1)).toFixed(2);
        const ox2 = (cx + ro * Math.cos(a2)).toFixed(2),
            oy2 = (cy + ro * Math.sin(a2)).toFixed(2);
        const ix1 = (cx + ri * Math.cos(a1)).toFixed(2),
            iy1 = (cy + ri * Math.sin(a1)).toFixed(2);
        const ix2 = (cx + ri * Math.cos(a2)).toFixed(2),
            iy2 = (cy + ri * Math.sin(a2)).toFixed(2);
        const large = a2 - a1 > Math.PI ? 1 : 0;
        const active = i < current;
        const d = `M${ox1},${oy1}A${ro},${ro},0,${large},1,${ox2},${oy2}L${ix2},${iy2}A${ri},${ri},0,${large},0,${ix1},${iy1}Z`;
        paths += `<path d="${d}" fill="${active ? "var(--text)" : "var(--overlay)"}" opacity="${active ? 1 : 0.3}"/>`;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="vertical-align:middle" aria-label="Step ${current} of ${total}">${paths}</svg>`;
}

export function updateStatus(): void {
    slideInfo.innerHTML = `<span class="slide-current">${state.slideIndex + 1}</span> / ${state.slides.length}`;
    stepInfo.innerHTML = buildStepRing(state.step, maxStep());
    syncURL();
}
