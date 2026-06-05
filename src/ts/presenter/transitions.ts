import type { TransitionData } from "../shared/types";
import { morphToNextSlide } from "./morph";
import { state } from "./state";
import { updateStatus } from "./status";

const stage = document.getElementById("stage")!;

const HANDLERS: Partial<
    Record<
        TransitionData["type"],
        (swap: () => void, t: TransitionData, then: (() => void) | null) => void
    >
> = {
    morph(swap, transition, then) {
        if (transition.duration <= 0 || !state.slides.length) {
            swap();
            if (then) then();
            return;
        }
        morphToNextSlide(swap, transition, then);
    },
    crossfade(swap, t, then) {
        if (t.duration <= 0) {
            swap();
            if (then) then();
            return;
        }
        stage.style.transition = `opacity ${t.duration}s ease`;
        stage.style.opacity = "0";
        setTimeout(() => {
            swap();
            requestAnimationFrame(() => {
                stage.style.opacity = "1";
                if (then) then();
            });
        }, t.duration * 1000);
    },
};

// Replace innerHTML with new slide content. Does NOT call applyCurrentStep() —
// elements start in their pre-transition state so the next advance() triggers
// a real animated transition. Optional `then` runs after content is swapped.
// Pass `transition` to override the destination slide's declared transition (used
// when navigating backward so the outgoing slide's transition plays in reverse).
export function loadSlide(
    then: (() => void) | null = null,
    transition: TransitionData | null = null,
): void {
    const swap = () => {
        stage.innerHTML = state.slides.length
            ? state.slides[state.slideIndex].svg
            : '<p style="color:var(--accent);padding:2rem">No slides.</p>';
        state._maxStepCache = null;
        updateStatus();
    };

    const t = transition ??
        state.transitions[state.slideIndex] ?? { type: "cut", duration: 0 };
    const handler = HANDLERS[t.type];
    if (handler) {
        handler(swap, t, then);
        return;
    }

    stage.style.transition = "none";
    stage.style.opacity = "1";
    swap();
    if (then) then();
}
