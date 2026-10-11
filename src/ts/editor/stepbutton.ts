// The toolbar's Steps button: each click shows the slide one click further,
// as the audience sees it (editing pauses meanwhile); after the last step it
// comes round to every object again, with a short flash. Shift+click or a
// right-click goes back. The cycle and its words are in stepcycle.ts.

import { maxStep } from "../shared/step";
import { render, slideRoot } from "./canvas";
import { ed, emit } from "./state";
import { nextStep, stepLabel, stepTitle, wrapped } from "./stepcycle";

let flash = 0;

function button(): HTMLButtonElement | null {
    return document.getElementById("btn-step") as HTMLButtonElement | null;
}

function slideMax(): number {
    const svg = slideRoot();
    return svg ? maxStep(svg) : 0;
}

/** Show `step` on the button (the animation preview plays through it). */
export function showStepLabel(step: number | null): void {
    const b = button();
    if (!b || flash) return;
    const max = slideMax();
    b.textContent = stepLabel(step, max);
    b.title = stepTitle(step, max);
    b.classList.toggle("on", step != null);
    b.disabled = max === 0 && step == null;
}

export function renderStepButton(): void {
    showStepLabel(ed.step);
}

/** Go to `step` (null: every object, editing). */
export function setStep(step: number | null): void {
    const from = ed.step;
    ed.step = step;
    document.body.classList.toggle("previewing", step != null);
    render();
    emit("step");
    if (wrapped(from, step)) cameRound();
}

function cameRound(): void {
    const b = button();
    if (!b) return;
    window.clearTimeout(flash);
    b.classList.remove("came-round");
    void b.offsetWidth; // restart the animation
    b.classList.add("came-round");
    b.textContent = "↺ All objects";
    flash = window.setTimeout(() => {
        flash = 0;
        b.classList.remove("came-round");
        renderStepButton();
    }, 900);
}

export function initStepButton(): void {
    const b = button();
    if (!b) return;
    b.addEventListener("click", (e) => {
        setStep(nextStep(ed.step, slideMax(), e.shiftKey));
    });
    b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        setStep(nextStep(ed.step, slideMax(), true));
    });
}
