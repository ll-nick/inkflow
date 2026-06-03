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
import { state } from "./state";
import {
    hideCurtain,
    toggleCurtain,
    toggleFullscreen,
    toggleHelp,
    toggleTheme,
} from "./ui";

// ── Stage click and status bar buttons ──
document.getElementById("stage")!.addEventListener("click", advance);
document.getElementById("btn-prev")!.addEventListener("click", retreat);
document.getElementById("btn-next")!.addEventListener("click", advance);
document
    .getElementById("btn-fullscreen")!
    .addEventListener("click", toggleFullscreen);
document.getElementById("btn-theme")!.addEventListener("click", toggleTheme);
document
    .getElementById("btn-overview")!
    .addEventListener("click", openOverview);
document
    .getElementById("btn-presenter")!
    .addEventListener("click", () =>
        window.open("/presenter", "_blank", "noopener"),
    );

const KEYBINDINGS: Record<
    string,
    { action: () => void; preventDefault?: boolean }
> = {
    ArrowRight: { action: advance, preventDefault: true },
    " ": { action: advance, preventDefault: true },
    l: { action: advance, preventDefault: true },
    ArrowLeft: { action: retreat, preventDefault: true },
    Backspace: { action: retreat, preventDefault: true },
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
    p: { action: () => window.open("/presenter", "_blank", "noopener") },
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
