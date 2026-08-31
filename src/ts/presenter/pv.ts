import { buildStepRing } from "../shared/ring";
import { applyStepInstant } from "../shared/step";
import { state } from "./state";
import { maxStep } from "./status";

// ── DOM refs ──
const pvPanel = document.getElementById("pv")!;
const pvResizeHandle = document.getElementById("pv-resize-handle")!;
const pvStrip = document.getElementById("pv-strip")!;
const pvClock = document.getElementById("pv-clock")!;
const pvElapsed = document.getElementById("pv-elapsed")!;
const pvTimerToggle = document.getElementById("pv-timer-toggle")!;
const pvTimerReset = document.getElementById("pv-timer-reset")!;
const pvSlideInfo = document.getElementById("pv-slide-info")!;
const pvStepRing = document.getElementById("pv-step-ring")!;
const pvNextInner = document.getElementById("pv-next-inner")!;
const pvNotes = document.getElementById("pv-notes")!;

// Elapsed-time model: whole paused-off segments accumulate into `_elapsedAccumMs`,
// and `_runningSince` times the segment in progress (null while paused). The
// display then just reads `_elapsedMs()`, so a pause freezes it without touching
// the once-a-second interval.
let _elapsedAccumMs = 0;
let _runningSince: number | null = Date.now();

function _elapsedMs(): number {
    const running = _runningSince === null ? 0 : Date.now() - _runningSince;
    return _elapsedAccumMs + running;
}

function _setTimerPaused(paused: boolean): void {
    if (paused === (_runningSince === null)) return;
    if (paused) {
        _elapsedAccumMs = _elapsedMs();
        _runningSince = null;
    } else {
        _runningSince = Date.now();
    }
    pvStrip.classList.toggle("timer-paused", paused);
    const label = paused ? "Resume timer" : "Pause timer";
    pvTimerToggle.title = label;
    pvTimerToggle.setAttribute("aria-label", label);
    updatePvClock();
}

function _resetTimer(): void {
    _elapsedAccumMs = 0;
    if (_runningSince !== null) _runningSince = Date.now();
    updatePvClock();
}

pvTimerToggle.addEventListener("click", () => {
    _setTimerPaused(_runningSince !== null);
});
pvTimerReset.addEventListener("click", _resetTimer);

function _pad2(n: number): string {
    return String(n).padStart(2, "0");
}

export function updatePvClock(): void {
    const now = new Date();
    pvClock.textContent = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    const secs = Math.floor(_elapsedMs() / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    pvElapsed.textContent =
        h > 0
            ? `${_pad2(h)}:${_pad2(m)}:${_pad2(s)}`
            : `${_pad2(m)}:${_pad2(s)}`;
}

export function updatePvInfo(): void {
    const total = state.slides.length;
    pvSlideInfo.innerHTML = `<span class="slide-current">${total ? state.slideIndex + 1 : "–"}</span> / ${total || "–"}`;
    pvStepRing.innerHTML = buildStepRing(state.step, maxStep());
}

function _scalePvNext(): void {
    const svg = pvNextInner.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") ?? "")
        .split(/[\s,]+/)
        .map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2];
    const vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const scale = Math.min(
        pvNextInner.clientWidth / vbW,
        pvNextInner.clientHeight / vbH,
    );
    const tx = (pvNextInner.clientWidth - vbW * scale) / 2;
    const ty = (pvNextInner.clientHeight - vbH * scale) / 2;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

export function renderPvNext(): void {
    const curMax = maxStep();
    let previewSvg: string | null = null;
    let revealStep = 0;
    if (state.step < curMax) {
        previewSvg = state.slides[state.slideIndex]?.svg ?? null;
        revealStep = state.step + 1;
    } else if (state.slideIndex + 1 < state.slides.length) {
        previewSvg = state.slides[state.slideIndex + 1].svg;
    }
    if (previewSvg === null) {
        pvNextInner.innerHTML = '<div id="pv-next-empty">END</div>';
        return;
    }
    pvNextInner.innerHTML = previewSvg;
    const svg = pvNextInner.querySelector("svg");
    if (svg) applyStepInstant(svg, revealStep);
    requestAnimationFrame(_scalePvNext);
}

export function renderPvNotes(): void {
    pvNotes.innerHTML = state.slides[state.slideIndex]?.notes ?? "";
    pvNotes.scrollTop = 0;
}

export function renderPv(): void {
    updatePvInfo();
    renderPvNext();
    renderPvNotes();
}

export function togglePv(): void {
    document.body.classList.toggle("pv-open");
    pvPanel.addEventListener("transitionend", _scalePvNext, { once: true });
}

window.addEventListener("resize", _scalePvNext);

// ── Resize handle ──
// The panel is anchored to the right edge, so its width is just the distance
// from the pointer to the viewport's right edge. This feeds the --pv-width
// custom property that the open state reads (pv.css); min/max-width there clamp
// it, so a raw value is fine, and it persists across open/close since only the
// open rule consumes it. The open/close CSS transition on `width` would ease
// every intermediate width during a drag, lagging the pointer — so it's
// disabled for the drag's duration and restored on release.
function _onPvResizeMove(e: PointerEvent): void {
    pvPanel.style.setProperty(
        "--pv-width",
        `${window.innerWidth - e.clientX}px`,
    );
    _scalePvNext();
}

function _onPvResizeUp(e: PointerEvent): void {
    pvResizeHandle.releasePointerCapture(e.pointerId);
    pvResizeHandle.removeEventListener("pointermove", _onPvResizeMove);
    pvResizeHandle.removeEventListener("pointerup", _onPvResizeUp);
    pvPanel.style.transition = "";
}

pvResizeHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pvPanel.style.transition = "none";
    pvResizeHandle.setPointerCapture(e.pointerId);
    pvResizeHandle.addEventListener("pointermove", _onPvResizeMove);
    pvResizeHandle.addEventListener("pointerup", _onPvResizeUp);
});
