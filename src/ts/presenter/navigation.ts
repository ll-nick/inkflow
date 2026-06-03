import { renderPv, renderPvNext, updatePvInfo } from "./pv";
import { state } from "./state";
import { applyCurrentStep, maxStep } from "./status";
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
        state.step = 0;
        loadSlide(() => {
            state.step = maxStep();
            applyCurrentStep();
            sendNav();
        }, t ?? null);
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
        state.step = 0;
        loadSlide(null, t ?? null);
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
