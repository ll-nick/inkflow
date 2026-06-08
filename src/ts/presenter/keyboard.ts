import {
    advance,
    gotoFirst,
    gotoLast,
    nextSlide,
    prevSlide,
    retreat,
} from "./navigation";
import {
    closeOverview,
    openOverview,
    overviewCommit,
    overviewSetActive,
} from "./overview";
import { openPicker } from "./picker";
import { togglePv } from "./pv";
import { state } from "./state";
import {
    hideCurtain,
    toggleCurtain,
    toggleFullscreen,
    toggleHelp,
    toggleMobileHud,
    toggleTheme,
} from "./ui";

// ── Stage click and status bar buttons ──
const stageEl = document.getElementById("stage")!;
const isCoarse = () => window.matchMedia("(pointer: coarse)").matches;
stageEl.addEventListener("click", (e) => {
    if (isCoarse()) {
        const ratio = e.clientX / window.innerWidth;
        if (ratio < 0.2) retreat();
        else if (ratio > 0.8) advance();
        else toggleMobileHud();
    } else {
        advance();
    }
});
document.getElementById("btn-prev")!.addEventListener("click", retreat);
document.getElementById("btn-next")!.addEventListener("click", advance);
document
    .getElementById("btn-fullscreen")!
    .addEventListener("click", toggleFullscreen);
document.getElementById("btn-theme")!.addEventListener("click", toggleTheme);
document
    .getElementById("btn-overview")!
    .addEventListener("click", openOverview);
document.getElementById("btn-presenter")!.addEventListener("click", togglePv);
document.getElementById("mhud-theme")!.addEventListener("click", toggleTheme);
document
    .getElementById("mhud-fullscreen")!
    .addEventListener("click", toggleFullscreen);

// ── Touch / swipe navigation ──
{
    const SWIPE_MIN_PX = 50;
    let startX = 0;
    let startY = 0;

    stageEl.addEventListener(
        "touchstart",
        (e) => {
            if (e.touches.length !== 1) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        },
        { passive: true },
    );

    // Prevent page scroll when the finger is moving horizontally across the stage.
    stageEl.addEventListener(
        "touchmove",
        (e) => {
            if (e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (Math.abs(dx) > Math.abs(dy)) e.preventDefault();
        },
        { passive: false },
    );

    stageEl.addEventListener("touchend", (e) => {
        if (e.changedTouches.length !== 1) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy)) {
            e.preventDefault(); // block the synthetic click that would follow
            if (dx < 0) nextSlide();
            else prevSlide();
        }
    });
}

const KEYBINDINGS: Record<
    string,
    { action: () => void; preventDefault?: boolean }
> = {
    ArrowRight: { action: advance, preventDefault: true },
    " ": { action: advance, preventDefault: true },
    PageDown: { action: advance, preventDefault: true },
    l: { action: advance, preventDefault: true },
    ArrowLeft: { action: retreat, preventDefault: true },
    Backspace: { action: retreat, preventDefault: true },
    PageUp: { action: retreat, preventDefault: true },
    h: { action: retreat, preventDefault: true },
    ArrowDown: { action: nextSlide, preventDefault: true },
    j: { action: nextSlide, preventDefault: true },
    ArrowUp: { action: prevSlide, preventDefault: true },
    k: { action: prevSlide, preventDefault: true },
    Home: { action: gotoFirst },
    "^": { action: gotoFirst },
    End: { action: gotoLast },
    $: { action: gotoLast },
    g: { action: openPicker, preventDefault: true },
    o: { action: openOverview, preventDefault: true },
    f: { action: toggleFullscreen },
    b: { action: () => toggleCurtain("black") },
    ".": { action: () => toggleCurtain("black") },
    w: { action: () => toggleCurtain("white") },
    "?": { action: toggleHelp },
    t: { action: toggleTheme },
    p: { action: togglePv },
};

// DOM refs for visibility checks (avoid importing the modules that own them)
const helpEl = document.getElementById("help")!;
const overviewEl = document.getElementById("overview")!;
const pickerEl = document.getElementById("picker")!;
const curtainEl = document.getElementById("curtain")!;

document.addEventListener("keydown", (e) => {
    if (helpEl.classList.contains("visible")) {
        if (e.key === "?" || e.key === "Escape") {
            toggleHelp();
            return;
        }
        if (e.key !== "t") return;
    }
    if (overviewEl.classList.contains("visible")) {
        if (e.key === "Escape") {
            closeOverview();
            return;
        }
        if (e.key === "ArrowRight" || e.key === "l") {
            e.preventDefault();
            overviewSetActive(state._overviewActive + 1);
            return;
        }
        if (e.key === "ArrowLeft" || e.key === "h") {
            e.preventDefault();
            overviewSetActive(state._overviewActive - 1);
            return;
        }
        if (e.key === "ArrowDown" || e.key === "j") {
            e.preventDefault();
            overviewSetActive(state._overviewActive + state._overviewCols);
            return;
        }
        if (e.key === "ArrowUp" || e.key === "k") {
            e.preventDefault();
            overviewSetActive(state._overviewActive - state._overviewCols);
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            overviewCommit();
            return;
        }
        if (e.key !== "t" && e.key !== "?") return;
    }
    if (pickerEl.classList.contains("visible")) return;
    if (curtainEl.classList.contains("visible")) {
        hideCurtain();
        return;
    }

    const binding = KEYBINDINGS[e.key];
    if (binding) {
        if (binding.preventDefault) e.preventDefault();
        binding.action();
    }
});
