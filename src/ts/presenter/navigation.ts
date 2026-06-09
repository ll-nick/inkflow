import { renderPv, renderPvNext, updatePvInfo } from "./pv";
import { state } from "./state";
import { applyCurrentStep, applyCurrentStepInstant, maxStep } from "./status";
import { loadSlide } from "./transitions";
import { sendNav } from "./websocket";

export function advance(): void {
    if (state.step < maxStep()) {
        state.step++;
        applyCurrentStep();
        renderPvNext();
        updatePvInfo();
    } else if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        loadSlide();
        renderPv();
    }
    sendNav();
}

export function retreat(): void {
    if (state.step > 0) {
        state.step--;
        applyCurrentStep();
        renderPvNext();
        updatePvInfo();
    } else if (state.slideIndex > 0) {
        const t = state.transitions[state.slideIndex];
        state.slideIndex--;
        // Entering an earlier slide from ahead: jump straight to its final step
        // inside the content swap (before the transition paints the fresh
        // elements) so its build animations show as already-complete instead of
        // replaying. Subsequent step-by-step retreats then animate in reverse.
        loadSlide(null, t ? { ...t, reverse: true } : null, () => {
            state.step = maxStep();
            applyCurrentStepInstant();
            sendNav();
        });
        renderPv();
        return;
    }
    sendNav();
}

export function nextSlide(): void {
    if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        loadSlide();
        renderPv();
    }
    sendNav();
}

export function prevSlide(): void {
    if (state.slideIndex > 0) {
        const t = state.transitions[state.slideIndex];
        state.slideIndex--;
        // Jumping back a whole slide enters it from ahead, so land on its final
        // step shown statically (same as a step-by-step retreat across the edge).
        loadSlide(null, t ? { ...t, reverse: true } : null, () => {
            state.step = maxStep();
            applyCurrentStepInstant();
        });
        renderPv();
    }
    sendNav();
}

export function gotoFirst(): void {
    state.slideIndex = 0;
    state.step = 0;
    loadSlide();
    renderPv();
    sendNav();
}

export function gotoLast(): void {
    state.slideIndex = state.slides.length - 1;
    state.step = 0;
    loadSlide();
    renderPv();
    sendNav();
}
