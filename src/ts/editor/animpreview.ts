// Playing a slide's animations on the canvas, as the presenter plays them:
// the same step engine (shared/step.ts), step by step from the start or from
// one animation's step, a short pause between steps. The canvas is in
// preview mode meanwhile (ed.step); a click on the slide, Escape, or an
// update of the slide stops it and the editor shows the slide as before.

import {
    applyStepInstant,
    buildStepRun,
    maxStep,
    seekStepRun,
} from "../shared/step";
import { render, slideRoot } from "./canvas";
import { toast } from "./dom";
import { ed, emit } from "./state";

export { cueSteps } from "./animsteps";

let current: { cancel: () => void } | null = null;

export function previewPlaying(): boolean {
    return current !== null;
}

export function stopPreview(): void {
    current?.cancel();
}

function wait(ms: number, cancelled: () => boolean): Promise<void> {
    return new Promise((resolve) => {
        const t0 = performance.now();
        const tick = (now: number) => {
            if (cancelled() || now - t0 >= ms) resolve();
            else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}

// One step's animations, played over their own length.
function playRun(
    root: Element,
    from: number,
    to: number,
    cancelled: () => boolean,
): Promise<void> {
    const run = buildStepRun(root, from, to);
    if (!run.totalMs) return Promise.resolve();
    return new Promise((resolve) => {
        const t0 = performance.now();
        const tick = (now: number) => {
            if (cancelled()) {
                resolve();
                return;
            }
            const v = Math.min(1, (now - t0) / run.totalMs);
            seekStepRun(run, v);
            if (v < 1) requestAnimationFrame(tick);
            else resolve();
        };
        requestAnimationFrame(tick);
    });
}

function showStep(step: number | null): void {
    const sel = document.getElementById("step-select") as HTMLSelectElement;
    if (sel) sel.value = step == null ? "" : String(step);
    for (const row of document.querySelectorAll<HTMLElement>(
        ".anim-row[data-step]",
    )) {
        row.classList.toggle(
            "playing",
            step != null && row.dataset.step === String(step),
        );
    }
}

/** Play the slide's animations from step `from` (1 = the start) to the end. */
export async function playAnimations(from = 1): Promise<void> {
    stopPreview();
    const first = slideRoot();
    const last = first ? maxStep(first) : 0;
    if (!first || last === 0) {
        toast("Nothing on this slide is animated yet");
        return;
    }
    const before = ed.step;
    let cancelled = false;
    const run = { cancel: () => (cancelled = true) };
    current = run;
    const stopOnClick = (e: Event) => {
        if (!(e.target as Element).closest?.(".anim-preview-ctl")) run.cancel();
    };
    const stopOnKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") run.cancel();
    };
    document.addEventListener("pointerdown", stopOnClick, true);
    document.addEventListener("keydown", stopOnKey, true);
    document.body.classList.add("previewing", "anim-playing");
    emit("preview");
    // From the resting state just before `from`.
    ed.step = Math.max(0, Math.min(from, last) - 1);
    render();
    const root = slideRoot();
    // A rebuild re-renders the slide: that ends the preview.
    const gone = () => cancelled || slideRoot() !== root;
    if (root) {
        for (let s = ed.step + 1; s <= last && !gone(); s++) {
            showStep(s);
            await playRun(root, s - 1, s, gone);
            if (gone()) break;
            applyStepInstant(root, s);
            ed.step = s;
            await wait(s < last ? 450 : 900, gone);
        }
    }
    document.removeEventListener("pointerdown", stopOnClick, true);
    document.removeEventListener("keydown", stopOnKey, true);
    if (current === run) current = null;
    document.body.classList.remove("anim-playing");
    document.body.classList.toggle("previewing", before != null);
    ed.step = before;
    showStep(null);
    render();
    emit("preview");
}
