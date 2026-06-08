import { applyStepInstant, maxStep as computeMaxStep } from "../shared/step";
import { renderPv } from "./pv";
import { state } from "./state";
import { loadSlide } from "./transitions";
import { sendNav } from "./websocket";

const overview = document.getElementById("overview")!;
const overviewGrid = document.getElementById("overview-grid")!;

function scaleThumb(thumb: Element): void {
    const svg = thumb.querySelector("svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") || "")
        .split(/[\s,]+/)
        .map(parseFloat);
    if (vb.length < 4) return;
    const vbW = vb[2],
        vbH = vb[3];
    svg.setAttribute("width", String(vbW));
    svg.setAttribute("height", String(vbH));
    svg.style.width = `${vbW}px`;
    svg.style.height = `${vbH}px`;
    const scale = Math.min(thumb.clientWidth / vbW, thumb.clientHeight / vbH);
    svg.style.transform = `scale(${scale})`;
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

    let cols = n;
    for (let c = 1; c <= n; c++) {
        const thumbW = (availW - (c - 1) * gap) / c;
        const rows = Math.ceil(n / c);
        if (rows * (thumbW * (9 / 16) + gap) - gap <= availH) {
            cols = Math.max(2, c);
            break;
        }
    }
    overviewGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

export function overviewSetActive(i: number): void {
    state._overviewActive = Math.max(0, Math.min(state.slides.length - 1, i));
    overviewGrid.querySelectorAll(".overview-cell").forEach((el, idx) => {
        el.classList.toggle("active", idx === state._overviewActive);
    });
    const active = overviewGrid.children[state._overviewActive];
    if (active) active.scrollIntoView({ block: "nearest" });
}

export function overviewCommit(): void {
    state.slideIndex = state._overviewActive;
    state.step = 0;
    closeOverview();
    loadSlide();
    renderPv();
    sendNav();
}

export function openOverview(): void {
    overviewGrid.innerHTML = "";
    state.slides.forEach((s, i) => {
        const cell = document.createElement("div");
        cell.className = "overview-cell";
        cell.dataset.index = String(i);
        cell.innerHTML =
            `<div class="overview-num">${i + 1}</div>` +
            `<div class="overview-thumb">${s.svg}</div>`;
        overviewGrid.appendChild(cell);
    });
    state._overviewActive = state.slideIndex;
    // Reveal the grid first so the thumbnails are laid out and their animations
    // are live, then land each one on its final step with no playback. Doing this
    // synchronously (before the next paint) means thumbnails never flash their
    // step-0 state or replay build animations.
    overview.classList.add("visible");
    overviewGrid.querySelectorAll(".overview-thumb").forEach((thumb) => {
        applyStepInstant(thumb, computeMaxStep(thumb));
    });
    requestAnimationFrame(() => {
        applyOptimalCols();
        requestAnimationFrame(() => {
            overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
            computeCols();
            overviewSetActive(state._overviewActive);
        });
    });
}

export function closeOverview(): void {
    overview.classList.remove("visible");
    overviewGrid.innerHTML = "";
}

overview.addEventListener("click", (e) => {
    const cell = (e.target as Element).closest(".overview-cell");
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
