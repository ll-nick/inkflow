import { state } from "./state";

const SVG_NS = "http://www.w3.org/2000/svg";
const stageWrap = document.getElementById("stage-wrap") as HTMLElement;
const overlay = document.getElementById(
    "laser-overlay",
) as unknown as SVGSVGElement;
const dot = document.getElementById("laser-dot") as HTMLElement;

const DOT_RADIUS = 8; // px, matches CSS width/height / 2

let isDrawing = false;
let currentPath: SVGPathElement | null = null;
let currentPoints: string[] = [];

// Raw client coords of latest pointer event, flushed to DOM in rAF.
let pendingClientX = 0;
let pendingClientY = 0;
let rafId: number | null = null;

// Cached bounding rect — recomputed on resize only, not on every pointermove.
let stageRect = stageWrap.getBoundingClientRect();
new ResizeObserver(() => {
    stageRect = stageWrap.getBoundingClientRect();
}).observe(stageWrap);

function flushFrame(): void {
    rafId = null;
    const x = pendingClientX - stageRect.left;
    const y = pendingClientY - stageRect.top;
    dot.style.transform = `translate(${x - DOT_RADIUS}px, ${y - DOT_RADIUS}px)`;
    if (isDrawing && currentPath && currentPoints.length > 0) {
        currentPath.setAttribute("d", currentPoints.join(" "));
    }
}

stageWrap.addEventListener("pointermove", (e) => {
    if (!state._laserMode) return;
    pendingClientX = e.clientX;
    pendingClientY = e.clientY;
    if (isDrawing) {
        const x = e.clientX - stageRect.left;
        const y = e.clientY - stageRect.top;
        currentPoints.push(`L ${x} ${y}`);
    }
    if (rafId === null) rafId = requestAnimationFrame(flushFrame);
});

stageWrap.addEventListener("pointerdown", (e) => {
    if (!state._laserMode) return;
    // Ctrl+drag is the zoom camera's pan gesture; the dot still tracks on move.
    if (e.ctrlKey) return;
    if ((e.target as Element).closest("#overview")) return;
    stageWrap.setPointerCapture(e.pointerId);
    const x = e.clientX - stageRect.left;
    const y = e.clientY - stageRect.top;
    currentPath = document.createElementNS(SVG_NS, "path");
    currentPoints = [`M ${x} ${y}`];
    currentPath.classList.add("laser-trail");
    overlay.appendChild(currentPath);
    isDrawing = true;
});

stageWrap.addEventListener("pointerup", finalizeDraw);
stageWrap.addEventListener("pointercancel", finalizeDraw);

function finalizeDraw(): void {
    if (!isDrawing || !currentPath) return;
    isDrawing = false;
    if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        flushFrame();
    }
    currentPath.classList.add("trail");
    const path = currentPath;
    path.addEventListener("animationend", () => path.remove(), { once: true });
    currentPath = null;
    currentPoints = [];
}

export function toggleLaser(): void {
    state._laserMode = !state._laserMode;
    document.body.classList.toggle("laser-mode", state._laserMode);
    if (!state._laserMode) finalizeDraw();
}
