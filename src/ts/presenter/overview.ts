import { cubicBezierEasing } from "../shared/easing";
import { escapeHtml } from "../shared/escape";
import { gridRows, sectionRuns, verticalNeighbor } from "../shared/sections";
import { applyStepInstant, maxStep as computeMaxStep } from "../shared/step";
import { parseViewBox } from "../shared/viewbox";
import { ProgressDriver } from "./progress-driver";
import { renderPv } from "./pv";
import { state } from "./state";
import { maxStep } from "./status";
import { CUT, loadSlide } from "./transitions";
import { sendNav } from "./websocket";

const overview = document.getElementById("overview")!;
const overviewGrid = document.getElementById("overview-grid")!;
const stage = document.getElementById("stage")!;

function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function firstSlideViewBox(): [number, number] {
    const svg = state.slides[0]?.svg ?? "";
    const attr = svg.match(/viewBox="([^"]*)"/)?.[1] ?? null;
    const vb = parseViewBox(attr);
    return [vb.w, vb.h];
}

function scaleThumb(thumb: Element): void {
    const svg = thumb.querySelector("svg");
    if (!svg) return;
    const vb = parseViewBox(svg.getAttribute("viewBox"));
    svg.setAttribute("width", String(vb.w));
    svg.setAttribute("height", String(vb.h));
    svg.style.width = `${vb.w}px`;
    svg.style.height = `${vb.h}px`;
    const scale = Math.min(thumb.clientWidth / vb.w, thumb.clientHeight / vb.h);
    // A slide of another shape than the first is centred in its cell.
    const dx = (thumb.clientWidth - vb.w * scale) / 2;
    const dy = (thumb.clientHeight - vb.h * scale) / 2;
    svg.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
}

/** Slide `i`'s cell (section headings sit between the cells). */
function cellAt(i: number): HTMLElement | null {
    return overviewGrid.querySelector<HTMLElement>(
        `.overview-cell[data-index="${i}"]`,
    );
}

function computeCols(): void {
    const cols =
        getComputedStyle(overviewGrid).gridTemplateColumns.split(" ").length;
    state._overviewCols = cols || 1;
}

function applyOptimalCols(): void {
    const n = state.slides.length;
    const gap = parseFloat(getComputedStyle(overviewGrid).gap) || 28;
    const availW = overviewGrid.clientWidth;
    const availH =
        overview.clientHeight -
        parseFloat(getComputedStyle(overview).paddingTop) -
        parseFloat(getComputedStyle(overview).paddingBottom);
    const [vbW, vbH] = firstSlideViewBox();
    const ratio = vbH / vbW;
    // Each section starts a row under its heading.
    const runs = sectionRuns(state.slides);
    const heading =
        overviewGrid.querySelector<HTMLElement>(".overview-section");
    const headings = runs.filter((r) => r.section).length;
    const headingH = heading ? heading.offsetHeight + gap : 0;

    // Tall slides (a phone deck, a poster) may need more columns than there
    // are slides for a row of them to fit the screen's height.
    const most = Math.max(n, 8);
    let cols = most;
    for (let c = 1; c <= most; c++) {
        const thumbW = (availW - (c - 1) * gap) / c;
        const rows = gridRows(runs, c);
        if (
            rows * (thumbW * ratio + gap) - gap + headings * headingH <=
            availH
        ) {
            cols = Math.max(2, c);
            break;
        }
    }
    overviewGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

export function overviewSetActive(i: number): void {
    state._overviewActive = Math.max(0, Math.min(state.slides.length - 1, i));
    overviewGrid
        .querySelectorAll<HTMLElement>(".overview-cell")
        .forEach((el) => {
            el.classList.toggle(
                "active",
                Number(el.dataset.index) === state._overviewActive,
            );
        });
    cellAt(state._overviewActive)?.scrollIntoView({ block: "nearest" });
}

/** Arrow up/down in the overview: the nearest cell of the row above/below,
 * across section headings. */
export function overviewMoveVertical(dir: 1 | -1): void {
    const cells = [
        ...overviewGrid.querySelectorAll<HTMLElement>(".overview-cell"),
    ];
    const boxes = cells.map((el) => ({
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
    }));
    const here = cells.findIndex(
        (el) => Number(el.dataset.index) === state._overviewActive,
    );
    if (here === -1) return;
    const next = cells[verticalNeighbor(boxes, here, dir)];
    overviewSetActive(Number(next.dataset.index));
}

export function overviewCommit(): void {
    history.pushState(null, "", window.location.href);
    state.slideIndex = state._overviewActive;
    closeOverview();
    // Jump straight to the slide's final step (build animations complete). CUT
    // both locally and over the wire so other screens snap too.
    state.step = maxStep();
    loadSlide(null, CUT);
    renderPv();
    sendNav(CUT);
}

function computeStageFlip(): { s: number; ox: number; oy: number } | null {
    const activeCell = cellAt(state._overviewActive);
    if (!activeCell) return null;
    const thumb = activeCell.querySelector<HTMLElement>(".overview-thumb");
    const el = thumb ?? activeCell;
    const gr = overviewGrid.getBoundingClientRect();
    const cr = el.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    // Thumbnail uses outline (not border), so cr is the pure content rect.
    // Scale so the content matches the stage's inner content area (inside padding).
    const sp = parseFloat(getComputedStyle(stage).paddingLeft) || 0;
    const s = Math.min(
        (sr.width - 2 * sp) / cr.width,
        (sr.height - 2 * sp) / cr.height,
    );
    const thumbCX = cr.left + cr.width / 2 - gr.left;
    const thumbCY = cr.top + cr.height / 2 - gr.top;
    const stageCX = sr.left + sr.width / 2 - gr.left;
    const stageCY = sr.top + sr.height / 2 - gr.top;
    // origin that maps thumbnail center → stage center under scale(s)
    const ox = (stageCX - thumbCX * s) / (1 - s);
    const oy = (stageCY - thumbCY * s) / (1 - s);
    return { s, ox, oy };
}

// ── Progress-driven open/close ──────────────────────────────────────────────
// Two ProgressDrivers (as in transitions.ts) own the grid-scale and
// backdrop-opacity animations. A reversal is another `animateTo` toward the
// other end, resuming from the current `.value`. Scale and opacity are driven
// separately so open can zoom the grid over an already-visible backdrop, and
// close can fade the backdrop out only after the zoom lands.

const scaleDriver = new ProgressDriver();
const fadeDriver = new ProgressDriver();
let controller: AbortController | null = null;
// Reused across a reversal so a mid-transform measurement never feeds back into
// the FLIP math.
let geometry: { s: number; ox: number; oy: number } | null = null;

function paintScale(progress: number): void {
    if (!geometry) return;
    const scale = geometry.s + (1 - geometry.s) * progress;
    overviewGrid.style.transformOrigin = `${geometry.ox}px ${geometry.oy}px`;
    overviewGrid.style.transform = `scale(${scale})`;
}

// Fades the active cell's highlight ring/number in/out over the zoom duration,
// so it doesn't show while the cell stands in for the stage. A plain CSS
// transition retargets correctly on interruption, so it needs no driving.
function setActiveHighlight(visible: boolean, durationSeconds: number): void {
    const activeCell = cellAt(state._overviewActive);
    const thumb = activeCell?.querySelector<HTMLElement>(".overview-thumb");
    const num = activeCell?.querySelector<HTMLElement>(".overview-num");
    if (thumb) {
        thumb.style.transition = `outline-color ${durationSeconds}s ease`;
        thumb.style.outlineColor = visible ? "" : "transparent";
    }
    if (num) {
        num.style.transition = `color ${durationSeconds}s ease`;
        num.style.color = visible ? "" : "transparent";
    }
}

export async function openOverview(): Promise<void> {
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
    const [vbW, vbH] = firstSlideViewBox();
    overview.style.setProperty("--thumb-ar", `${vbW} / ${vbH}`);
    for (const run of sectionRuns(state.slides)) {
        if (run.section) {
            // A heading across the grid: the section's slides start a new row.
            const head = document.createElement("div");
            head.className = "overview-section";
            head.dataset.index = String(run.start);
            const count = run.end - run.start;
            head.innerHTML =
                `<span class="overview-section-name">${escapeHtml(run.section.name)}</span>` +
                `<span class="overview-section-count">${count} slide${count === 1 ? "" : "s"}</span>`;
            overviewGrid.appendChild(head);
        }
        for (let i = run.start; i < run.end; i++) {
            const cell = document.createElement("div");
            cell.className = "overview-cell";
            cell.dataset.index = String(i);
            cell.innerHTML =
                `<div class="overview-num">${i + 1}</div>` +
                `<div class="overview-thumb">${state.slides[i].svg}</div>`;
            overviewGrid.appendChild(cell);
        }
    }
    state._overviewActive = state.slideIndex;
    // Layout computation runs while the overlay is still hidden (visibility:hidden
    // preserves dimensions). The overlay is revealed only once the FLIP snap is
    // committed, so there is no black flash and no grid-at-full-scale flicker.
    overviewGrid.querySelectorAll(".overview-thumb").forEach((thumb) => {
        applyStepInstant(thumb, computeMaxStep(thumb));
    });
    await nextFrame();
    applyOptimalCols();
    await nextFrame();
    overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
    computeCols();
    overviewSetActive(state._overviewActive);

    // The grid was just rebuilt, so recompute geometry from the fresh layout.
    geometry = computeStageFlip();
    const activeCell = cellAt(state._overviewActive);
    const activeThumb =
        activeCell?.querySelector<HTMLElement>(".overview-thumb");
    const activeNum = activeCell?.querySelector<HTMLElement>(".overview-num");
    if (activeThumb) activeThumb.style.outlineColor = "transparent";
    if (activeNum) activeNum.style.color = "transparent";

    // Snap to the stage-matched scale, so the zoom below starts from a frame
    // that looks identical to the stage.
    scaleDriver.value = 0;
    paintScale(0);
    await nextFrame();

    controller?.abort();
    const myController = new AbortController();
    controller = myController;

    // Backdrop is shown at once; only the grid zoom animates.
    overview.classList.add("visible");
    overview.style.opacity = "1";
    fadeDriver.value = 1;
    setActiveHighlight(true, 0.6);

    const ease = cubicBezierEasing("cubic-bezier(0.22, 1, 0.36, 1)");
    await scaleDriver.animateTo(1, 0.6, myController.signal, (v) =>
        paintScale(ease(v)),
    );
    if (controller === myController) controller = null;
}

export async function closeOverview(): Promise<void> {
    // Zoom back into the current slide, not whichever cell was last browsed to.
    state._overviewActive = state.slideIndex;
    // When settled, recompute against the current active cell; when interrupting
    // an in-flight animation, keep the captured geometry to avoid measuring a
    // grid that's mid-transform.
    if (controller === null) geometry = computeStageFlip();

    controller?.abort();
    const myController = new AbortController();
    controller = myController;
    const { signal } = myController;

    setActiveHighlight(false, 0.35);
    const ease = cubicBezierEasing("cubic-bezier(0.55, 0, 1, 0.45)");
    await scaleDriver.animateTo(0, 0.35, signal, (v) => paintScale(ease(v)));
    if (signal.aborted) return;

    // Fade the backdrop out only once the zoom has landed on the stage.
    await fadeDriver.animateTo(0, 0.28, signal, (v) => {
        overview.style.opacity = String(v);
    });
    if (signal.aborted) return;

    overview.classList.remove("visible");
    overview.style.opacity = "";
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
    if (controller === myController) controller = null;
}

export function toggleOverview(): void {
    overview.classList.contains("visible") ? closeOverview() : openOverview();
}

overview.addEventListener("click", (e) => {
    // A section heading jumps to the section's first slide.
    const cell = (e.target as Element).closest(
        ".overview-cell, .overview-section",
    );
    if (cell) {
        state._overviewActive = +(cell as HTMLElement).dataset.index!;
        overviewCommit();
    } else if (e.target === overview) {
        closeOverview();
    }
});

window.addEventListener("resize", () => {
    if (!overview.classList.contains("visible")) return;
    applyOptimalCols();
    requestAnimationFrame(() => {
        overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
        computeCols();
    });
});
