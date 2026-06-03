import { buildStepRing } from "../shared/ring";
import { state } from "./state";

// ── DOM refs ──
const pvPanel = document.getElementById("pv")!;
const pvClock = document.getElementById("pv-clock")!;
const pvElapsed = document.getElementById("pv-elapsed")!;
const pvSlideInfo = document.getElementById("pv-slide-info")!;
const pvStepRing = document.getElementById("pv-step-ring")!;
const pvNextInner = document.getElementById("pv-next-inner")!;
const pvNotes = document.getElementById("pv-notes")!;

const _startTime = Date.now();

function _pad2(n: number): string {
    return String(n).padStart(2, "0");
}

export function updatePvClock(): void {
    const now = new Date();
    pvClock.textContent = `${_pad2(now.getHours())}:${_pad2(now.getMinutes())}:${_pad2(now.getSeconds())}`;
    const secs = Math.floor((Date.now() - _startTime) / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    pvElapsed.textContent =
        h > 0
            ? `${_pad2(h)}:${_pad2(m)}:${_pad2(s)}`
            : `${_pad2(m)}:${_pad2(s)}`;
}

function _pvMaxStep(): number {
    return state._maxStepCache ?? 0;
}

export function updatePvInfo(): void {
    const total = state.slides.length;
    pvSlideInfo.innerHTML = `<span class="slide-current">${total ? state.slideIndex + 1 : "–"}</span> / ${total || "–"}`;
    pvStepRing.innerHTML = buildStepRing(state.step, _pvMaxStep());
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
    const curMax = _pvMaxStep();
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
    if (svg) {
        svg.querySelectorAll("[data-step]").forEach((el) => {
            el.classList.toggle(
                "active",
                +(el.getAttribute("data-step") ?? "0") <= revealStep,
            );
        });
    }
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
