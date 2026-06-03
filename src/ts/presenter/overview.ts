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
    svg.querySelectorAll("[data-step]").forEach((el) => {
        el.classList.add("active");
    });
}

function computeCols(): void {
    const cols =
        getComputedStyle(overviewGrid).gridTemplateColumns.split(" ").length;
    state._overviewCols = cols || 1;
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
    loadSlide(() => renderPv());
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
    overview.classList.add("visible");
    requestAnimationFrame(() => {
        overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
        computeCols();
        overviewSetActive(state._overviewActive);
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
    overviewGrid.querySelectorAll(".overview-thumb").forEach(scaleThumb);
    computeCols();
});
