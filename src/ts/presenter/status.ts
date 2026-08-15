import { buildStepRing } from "../shared/ring";
import {
    appliedStep,
    applyCodeHighlights,
    applyStepInstant,
    buildStepRun,
    maxStep as computeMaxStep,
    type StepRun,
    seekStepRun,
} from "../shared/step";
import { ProgressDriver } from "./progress-driver";
import { state } from "./state";
import { syncVideos } from "./video";

const stage = document.getElementById("stage")!;
const slideInfo = document.getElementById("slide-info")!;
const stepInfo = document.getElementById("step-info")!;
const mhudSlideInfo = document.getElementById("mhud-slide-info")!;
const mhudStepRing = document.getElementById("mhud-step-ring")!;

// maxStep is a pure function of the current slide's markup (its data-cues, video
// play-on-step, and code-highlight attributes), derived from the slide data rather than the
// live stage DOM. During a transition the stage briefly holds two slides at once
// (as layers), which would corrupt a DOM-based count; reading the data keeps the
// value correct mid-flight and lets navigation settle the step synchronously.
// Cached until the slide index or the slide set changes.
let maxStepSlides: typeof state.slides | null = null;
let maxStepIndex = -1;
let maxStepValue = 0;

export function maxStep(): number {
    if (maxStepSlides === state.slides && maxStepIndex === state.slideIndex)
        return maxStepValue;
    const scratch = document.createElement("div");
    scratch.innerHTML = state.slides[state.slideIndex]?.svg ?? "";
    maxStepValue = computeMaxStep(scratch);
    maxStepSlides = state.slides;
    maxStepIndex = state.slideIndex;
    return maxStepValue;
}

// ── Progress-driven step run ─────────────────────────────────────────────────
// A step advance plays as one run driven by a single 0→1 progress value that seeks its cues
// (the same primitive as a slide transition, ProgressDriver). The whole in-flight state is
// that value, so a reverse is the value gliding back and a snap is the value jumping to its
// end.
// At most one run is in flight; a new run (or a slide transition) lands the previous one
// first via landRun().

let runController: AbortController | null = null;
let runDriver: ProgressDriver | null = null;
let runRun: StepRun | null = null;
let runTo = 0; // the in-flight run's destination step
let runForward = true;

// The direction of the in-flight step run, or null if none. Navigation reads this to decide
// a nav press: same direction snaps the run to its end, opposite direction reverses it.
export function inflightStepDirection(): "forward" | "backward" | null {
    if (!runController) return null;
    return runForward ? "forward" : "backward";
}

// Drive the ProgressDriver toward the current run's end (1 forward, 0 backward) and wire the
// settle. Shared by a fresh run and an in-place reversal: reversal reuses the same driver, so
// its persisted `value` makes the animation glide on from wherever it currently is.
function driveRun(): void {
    const ctrl = new AbortController();
    runController = ctrl;
    const driver = runDriver!;
    const run = runRun!;
    const to = runTo;
    void driver
        .animateTo(runForward ? 1 : 0, run.totalMs / 1000, ctrl.signal, (v) =>
            seekStepRun(run, v),
        )
        .then(() => {
            if (ctrl.signal.aborted) return; // superseded by a snap/reverse/new run
            if (runController === ctrl) {
                runController = null;
                runDriver = null;
                runRun = null;
            }
            applyStepInstant(stage, to); // land exact resting state
            updateStatus();
        });
}

// Land any in-flight run on its destination immediately: stop the driver, seek the cues to
// their resting state, and reconcile videos. The step number is already settled, so this
// only collapses the visual.
function landRun(): void {
    if (!runController) return;
    runController.abort();
    runController = null;
    runDriver = null;
    runRun = null;
    applyStepInstant(stage, runTo);
    syncVideos(stage, runTo);
}

// Snap an in-flight run to its end (a nav press in the run's own direction) and refresh the
// status bar.
export function snapStepRun(): void {
    if (!runController) return;
    landRun();
    updateStatus();
}

// Reverse an in-flight run in place (a nav press opposite the run's direction): the same run
// glides back from its current progress to the opposite stop. Mirrors ProgressTransition's
// reverse(). Returns false when there is no real stop to reverse onto — an entry-play run
// starts from a synthetic pre-entry step (-1), so it cannot be un-played into place; the
// caller snaps it instead. On success the caller sends the new position over the wire.
export function reverseStepRun(): boolean {
    if (!runController || !runDriver || !runRun) return false;
    const nextTo = runForward ? runTo - 1 : runTo + 1; // the run's other stop
    if (nextTo < 0) return false;
    runController.abort(); // stop the current leg; its settle bails on the aborted signal
    runForward = !runForward;
    runTo = nextTo;
    state.step = runTo;
    applyCodeHighlights(stage, runTo);
    syncVideos(stage, runTo);
    updateStatus();
    driveRun();
    return true;
}

// Settle any in-flight run before a slide transition captures the outgoing slide. Same as a
// snap without the status refresh (loadSlide handles status itself).
export function settleStepRun(): void {
    landRun();
}

// Animate from the last applied step to state.step by seeking that step's run. Code
// highlights and videos switch at the step change (the run's destination); the run itself
// only drives the WAAPI cues. An empty run (no cues at the destination) lands instantly.
export function applyCurrentStep(): void {
    landRun();
    const from = appliedStep(stage);
    const to = state.step;
    applyCodeHighlights(stage, to);
    syncVideos(stage, to);

    const run = buildStepRun(stage, from, to);
    if (run.totalMs <= 0 || from === to) {
        applyStepInstant(stage, to);
        updateStatus();
        return;
    }

    runRun = run;
    runDriver = new ProgressDriver();
    runDriver.value = run.forward ? 0 : 1;
    runTo = to;
    runForward = run.forward;
    updateStatus();
    driveRun();
}

// Like applyCurrentStep but lands the step with no animation playback. Used when
// entering a slide from ahead so its build animations appear already complete
// instead of replaying. See applyStepInstant.
export function applyCurrentStepInstant(): void {
    landRun();
    applyStepInstant(stage, state.step);
    syncVideos(stage, state.step);
    updateStatus();
}

export function syncURL(): void {
    const params = new URLSearchParams(window.location.search);
    if (state.step > 0) params.set("steps", String(state.step));
    else params.delete("steps");
    const search = params.size > 0 ? `?${params.toString()}` : "";
    const base = window.location.pathname.replace(/\/[^/]*$/, "");
    try {
        history.replaceState(
            null,
            "",
            `${base}/${state.slideIndex + 1}${search}`,
        );
    } catch (_) {}
}

// Returns whether the path carried an explicit, valid slide segment (a "deep
// link"). The caller captures this at boot before loadSlide() rewrites the URL,
// to decide sync-handshake authority: a deliberate URL must not be overridden by
// the server's stored position.
export function readURL(): boolean {
    const seg = window.location.pathname.replace(/^.*\//, "");
    const n = parseInt(seg, 10);
    const deepLinked = !Number.isNaN(n) && n >= 1 && n <= state.slides.length;
    if (deepLinked) state.slideIndex = n - 1;
    const steps = parseInt(
        new URLSearchParams(window.location.search).get("steps") ?? "0",
        10,
    );
    if (!Number.isNaN(steps) && steps >= 0) state.step = steps;
    return deepLinked;
}

export function updateStatus(): void {
    const infoHtml = `<span class="slide-current">${state.slideIndex + 1}</span> / ${state.slides.length}`;
    const ringHtml = buildStepRing(state.step, maxStep());
    slideInfo.innerHTML = infoHtml;
    stepInfo.innerHTML = ringHtml;
    mhudSlideInfo.innerHTML = infoHtml;
    mhudStepRing.innerHTML = ringHtml;
    syncURL();
}
