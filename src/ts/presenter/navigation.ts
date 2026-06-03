import { state } from "./state";
import { applyCurrentStep, maxStep } from "./status";
import { loadSlide } from "./transitions";
import { sendNav } from "./websocket";

export function advance(): void {
    if (state.step < maxStep()) {
        state.step++;
        applyCurrentStep();
    } else if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        loadSlide();
    }
    sendNav();
}

export function retreat(): void {
    if (state.step > 0) {
        state.step--;
        applyCurrentStep();
    } else if (state.slideIndex > 0) {
        const t = state.transitions[state.slideIndex];
        state.slideIndex--;
        state.step = 0;
        loadSlide(() => {
            state.step = maxStep();
            applyCurrentStep();
            sendNav();
        }, t);
        return;
    }
    sendNav();
}

export function nextSlide(): void {
    if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        loadSlide();
    }
    sendNav();
}

export function prevSlide(): void {
    if (state.slideIndex > 0) {
        const t = state.transitions[state.slideIndex];
        state.slideIndex--;
        state.step = 0;
        loadSlide(null, t);
    }
    sendNav();
}

export function gotoFirst(): void {
    state.slideIndex = 0;
    state.step = 0;
    loadSlide();
    sendNav();
}

export function gotoLast(): void {
    state.slideIndex = state.slides.length - 1;
    state.step = 0;
    loadSlide();
    sendNav();
}
