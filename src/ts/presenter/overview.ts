import { applyStepInstant, maxStep as computeMaxStep } from "../shared/step";
import { renderPv } from "./pv";
import { state } from "./state";
import { maxStep } from "./status";
import { loadSlide } from "./transitions";
import { sendNav } from "./websocket";

const overview = document.getElementById("overview")!;
const overviewGrid = document.getElementById("overview-grid")!;
const stage = document.getElementById("stage")!;

function firstSlideViewBox(): [number, number] {
    const svg = state.slides[0]?.svg ?? "";
    const m = svg.match(/viewBox="[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)"/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : [1920, 1080];
}

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
    const [vbW, vbH] = firstSlideViewBox();
    const ratio = vbH / vbW;

    let cols = n;
    for (let c = 1; c <= n; c++) {
        const thumbW = (availW - (c - 1) * gap) / c;
        const rows = Math.ceil(n / c);
        if (rows * (thumbW * ratio + gap) - gap <= availH) {
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
    closeOverview();
    // Jump straight to the slide's final step (build animations complete).
    state.step = maxStep();
    loadSlide(null, { type: "cut", duration: 0 });
    renderPv();
    sendNav();
}

function computeStageFlip(): { s: number; ox: number; oy: number } | null {
    const activeCell = overviewGrid.children[
        state._overviewActive
    ] as HTMLElement;
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

export function openOverview(): void {
    overviewGrid.innerHTML = "";
    overviewGrid.style.cssText = "";
    const [vbW, vbH] = firstSlideViewBox();
    overview.style.setProperty("--thumb-ar", `${vbW} / ${vbH}`);
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
    // Layout computation runs while the overlay is still hidden (visibility:hidden
    // preserves dimensions). The overlay is revealed only once the FLIP snap is
    // committed, so there is no black flash and no grid-at-full-scale flicker.
    overviewGrid.querySelectorAll(".overview-thumb").forEach((thumb) => {
        applyStepInstant(thumb, computeMaxStep(thumb));
    });
    requestAnimationFrame(() => {
        applyOptimalCols();
        requestAnimationFrame(() => {
            overviewGrid
                .querySelectorAll(".overview-thumb")
                .forEach(scaleThumb);
            computeCols();
            overviewSetActive(state._overviewActive);
            // Snap to the same FLIP transform used by close, so open/close are mirrors
            const flip = computeStageFlip();
            const activeCell = overviewGrid.children[
                state._overviewActive
            ] as HTMLElement;
            const activeThumb =
                activeCell?.querySelector<HTMLElement>(".overview-thumb");
            const activeNum =
                activeCell?.querySelector<HTMLElement>(".overview-num");
            if (flip) {
                overviewGrid.style.transformOrigin = `${flip.ox}px ${flip.oy}px`;
                overviewGrid.style.transition = "none";
                overviewGrid.style.transform = `scale(${flip.s})`;
            }
            if (activeThumb) activeThumb.style.outlineColor = "transparent";
            if (activeNum) activeNum.style.color = "transparent";
            requestAnimationFrame(() => {
                // Snap is committed — reveal the overlay instantly and start zoom-out.
                overview.style.transition = "none";
                overview.classList.add("visible");
                overviewGrid.style.transition =
                    "transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)";
                overviewGrid.style.transform = "scale(1)";
                if (activeThumb) {
                    activeThumb.style.transition = "outline-color 0.6s ease";
                    activeThumb.style.outlineColor = "";
                }
                if (activeNum) {
                    activeNum.style.transition = "color 0.6s ease";
                    activeNum.style.color = "";
                }
                const cleanup = (e: TransitionEvent) => {
                    if (e.propertyName !== "transform") return;
                    overviewGrid.removeEventListener("transitionend", cleanup);
                    overviewGrid.style.cssText = overviewGrid.style
                        .gridTemplateColumns
                        ? `grid-template-columns:${overviewGrid.style.gridTemplateColumns}`
                        : "";
                    if (activeThumb) activeThumb.style.transition = "";
                    if (activeNum) activeNum.style.transition = "";
                    overview.style.transition = "";
                };
                overviewGrid.addEventListener("transitionend", cleanup);
            });
        });
    });
}

function zoomGridToStage(): void {
    const activeCell = overviewGrid.children[
        state._overviewActive
    ] as HTMLElement;
    if (!activeCell) return;
    const thumb = activeCell.querySelector<HTMLElement>(".overview-thumb");
    const num = activeCell.querySelector<HTMLElement>(".overview-num");
    const flip = computeStageFlip();
    if (!flip) return;
    if (thumb) {
        thumb.style.transition = "outline-color 0.35s ease";
        thumb.style.outlineColor = "transparent";
    }
    if (num) {
        num.style.transition = "color 0.35s ease";
        num.style.color = "transparent";
    }
    overviewGrid.style.transformOrigin = `${flip.ox}px ${flip.oy}px`;
    overviewGrid.style.transition =
        "transform 0.35s cubic-bezier(0.55, 0, 1, 0.45)";
    overviewGrid.style.transform = `scale(${flip.s})`;
}

export function closeOverview(): void {
    zoomGridToStage();
    setTimeout(() => {
        overview.style.transition = "opacity 0.28s ease, visibility 0s 0.28s";
        overview.classList.remove("visible");
        setTimeout(() => {
            overview.style.transition = "";
            if (!overview.classList.contains("visible")) {
                overviewGrid.innerHTML = "";
                overviewGrid.style.cssText = "";
            }
        }, 300);
    }, 370);
}

export function toggleOverview(): void {
    overview.classList.contains("visible") ? closeOverview() : openOverview();
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
