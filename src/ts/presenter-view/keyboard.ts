import {
    applyCurrentStep,
    maxStep,
    renderAll,
    renderNext,
    updateInfo,
} from "./render";
import { state } from "./state";
import { sendNav } from "./websocket";

function advance(): void {
    if (state.step < maxStep()) {
        state.step++;
        applyCurrentStep();
        updateInfo();
        renderNext();
    } else if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        renderAll();
    }
    sendNav();
}

function retreat(): void {
    if (state.step > 0) {
        state.step--;
        applyCurrentStep();
        updateInfo();
        renderNext();
    } else if (state.slideIndex > 0) {
        state.slideIndex--;
        state.step = 0;
        renderAll();
        // Reveal previous slide at its end-state, like the main presenter does
        state.step = maxStep();
        applyCurrentStep();
        updateInfo();
        renderNext();
    }
    sendNav();
}

function nextSlide(): void {
    if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        renderAll();
    }
    sendNav();
}

function prevSlide(): void {
    if (state.slideIndex > 0) {
        state.slideIndex--;
        state.step = 0;
        renderAll();
    }
    sendNav();
}

const KEYBINDINGS: Record<
    string,
    { action: () => void; preventDefault?: boolean }
> = {
    ArrowRight: { action: advance, preventDefault: true },
    " ": { action: advance, preventDefault: true },
    l: { action: advance, preventDefault: true },
    ArrowLeft: { action: retreat, preventDefault: true },
    Backspace: { action: retreat, preventDefault: true },
    h: { action: retreat, preventDefault: true },
    ArrowDown: { action: nextSlide, preventDefault: true },
    j: { action: nextSlide, preventDefault: true },
    ArrowUp: { action: prevSlide, preventDefault: true },
    k: { action: prevSlide, preventDefault: true },
};

document.addEventListener("keydown", (e) => {
    const binding = KEYBINDINGS[e.key];
    if (!binding) return;
    if (binding.preventDefault) e.preventDefault();
    binding.action();
});
