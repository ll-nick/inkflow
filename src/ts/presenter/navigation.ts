import { renderPv, renderPvNext, updatePvInfo } from "./pv";
import { state } from "./state";
import {
    applyCurrentStep,
    inflightStepDirection,
    maxStep,
    reverseStepRun,
    snapStepRun,
} from "./status";
import { CUT, inflightDirection, loadSlide, snapInflight } from "./transitions";
import { sendNav, sendSnap } from "./websocket";

export function gotoId(id: string): boolean {
    const idx = state.slides.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    history.pushState(null, "", window.location.href);
    state.slideIndex = idx;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
    return true;
}

export function advance(): void {
    // A step run still animating: a forward press in its own direction snaps it to the
    // end; a forward press against a backward run reverses it in place (glides forward).
    const runDir = inflightStepDirection();
    if (runDir === "forward") {
        snapStepRun();
        sendSnap();
        return;
    }
    if (runDir === "backward") {
        if (reverseStepRun()) {
            renderPvNext();
            updatePvInfo();
            sendNav();
        } else {
            snapStepRun();
            sendSnap();
        }
        return;
    }
    // A forward slide transition still animating: snap it to its end instead of
    // playing the next step. The following forward press does the normal action.
    if (inflightDirection() === "forward") {
        snapInflight();
        sendSnap();
        return;
    }
    if (state.step < maxStep()) {
        state.step++;
        applyCurrentStep();
        renderPvNext();
        updatePvInfo();
    } else if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        loadSlide(null, null, true); // play the entry step after the transition
        renderPv();
    }
    sendNav();
}

export function retreat(): void {
    // A step run still animating: a back press in its own direction snaps it; a back press
    // against a forward run reverses it in place (glides back).
    const runDir = inflightStepDirection();
    if (runDir === "backward") {
        snapStepRun();
        sendSnap();
        return;
    }
    if (runDir === "forward") {
        if (reverseStepRun()) {
            renderPvNext();
            updatePvInfo();
            sendNav();
        } else {
            // An entry-play run has no earlier stop to reverse onto: snap it, consume the
            // press, and let the next back press step back to the previous slide.
            snapStepRun();
            sendSnap();
        }
        return;
    }
    // A backward slide transition still animating: snap it to its end. The next
    // back press then undoes the slide's last build animation.
    if (inflightDirection() === "backward") {
        snapInflight();
        sendSnap();
        return;
    }
    if (state.step > 0) {
        state.step--;
        applyCurrentStep();
        renderPvNext();
        updatePvInfo();
    } else if (state.slideIndex > 0) {
        const t = state.transitions[state.slideIndex];
        state.slideIndex--;
        // Entering an earlier slide from ahead: land on its final step. maxStep is
        // derived from slide data, so this is correct synchronously even while a
        // transition is mid-flight — a key pressed during the animation then reads
        // the right step instead of mistaking it for 0 and skipping a slide.
        // loadSlide applies this step to the fresh content without replaying the
        // build animations; subsequent retreats animate in reverse.
        state.step = maxStep();
        const tReversed = t ? { ...t, reverse: true } : null;
        loadSlide(null, tReversed);
        renderPv();
        sendNav(tReversed);
        return;
    }
    sendNav();
}

export function nextSlide(): void {
    if (state.slideIndex < state.slides.length - 1) {
        state.slideIndex++;
        state.step = 0;
        loadSlide(null, null, true); // play the entry step after the transition
        renderPv();
    }
    sendNav();
}

export function prevSlide(): void {
    if (state.slideIndex > 0) {
        const t = state.transitions[state.slideIndex];
        state.slideIndex--;
        state.step = maxStep();
        const tReversed = t ? { ...t, reverse: true } : null;
        loadSlide(null, tReversed);
        renderPv();
        sendNav(tReversed);
        return;
    }
    sendNav();
}

export function gotoFirst(): void {
    history.pushState(null, "", window.location.href);
    state.slideIndex = 0;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
}

export function gotoLast(): void {
    history.pushState(null, "", window.location.href);
    state.slideIndex = state.slides.length - 1;
    state.step = 0;
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
}
