const curtain = document.getElementById("curtain")!;
const help = document.getElementById("help")!;
const errorOverlay = document.getElementById("error-overlay")!;
const errorMsg = document.getElementById("error-msg")!;
const statusBarEl = document.getElementById("statusbar")!;

// biome-ignore lint/suspicious/noExplicitAny: webkit prefix not in TS DOM lib
const _doc = document as any;

let _fsHideTimer: ReturnType<typeof setTimeout> | undefined;

// ── Curtain ──
export function showCurtain(color: string): void {
    curtain.style.background = color;
    curtain.classList.add("visible");
}
export function hideCurtain(): void {
    curtain.classList.remove("visible");
}
export function toggleCurtain(color: string): void {
    curtain.classList.contains("visible") ? hideCurtain() : showCurtain(color);
}

// ── Help overlay ──
export function toggleHelp(): void {
    help.classList.toggle("visible");
}

// ── Error overlay ──
export function showError(msg: string): void {
    errorMsg.textContent = msg;
    errorOverlay.classList.add("visible");
}
export function hideError(): void {
    errorOverlay.classList.remove("visible");
}

// ── Theme ──
export function toggleTheme(): void {
    const html = document.documentElement;
    html.dataset.theme = html.dataset.theme === "light" ? "" : "light";
}

// ── Fullscreen ──
export function toggleFullscreen(): void {
    if (!document.fullscreenElement)
        document.documentElement.requestFullscreen();
    else document.exitFullscreen();
}

function showFsBar(): void {
    statusBarEl.classList.add("fs-visible");
    clearTimeout(_fsHideTimer);
    _fsHideTimer = undefined;
}
function scheduleFsHide(): void {
    if (_fsHideTimer) return;
    _fsHideTimer = setTimeout(() => {
        statusBarEl.classList.remove("fs-visible");
        _fsHideTimer = undefined;
    }, 600);
}

function handleFullscreenChange(): void {
    const isFS = !!(document.fullscreenElement || _doc.webkitFullscreenElement);
    document.body.classList.toggle("is-fullscreen", isFS);
    if (!isFS) {
        statusBarEl.classList.remove("fs-visible");
        clearTimeout(_fsHideTimer);
        _fsHideTimer = undefined;
    }
}

document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

// Hot zone: bottom-left corner, 20% wide × 10% tall
document.addEventListener("mousemove", (e) => {
    if (!document.fullscreenElement && !_doc.webkitFullscreenElement) return;
    const inZone =
        e.clientX < window.innerWidth * 0.2 &&
        e.clientY > window.innerHeight * 0.9;
    if (inZone) showFsBar();
    else scheduleFsHide();
});
statusBarEl.addEventListener("mouseenter", () => {
    if (document.fullscreenElement || _doc.webkitFullscreenElement) showFsBar();
});
statusBarEl.addEventListener("mouseleave", () => {
    if (document.fullscreenElement || _doc.webkitFullscreenElement)
        scheduleFsHide();
});

// ── Mobile HUD ──
let _mhudTimer: ReturnType<typeof setTimeout> | undefined;

export function showMobileHud(): void {
    document.body.classList.add("mobile-hud-visible");
    clearTimeout(_mhudTimer);
    _mhudTimer = setTimeout(() => {
        document.body.classList.remove("mobile-hud-visible");
        _mhudTimer = undefined;
    }, 3000);
}

export function toggleMobileHud(): void {
    if (document.body.classList.contains("mobile-hud-visible")) {
        document.body.classList.remove("mobile-hud-visible");
        clearTimeout(_mhudTimer);
        _mhudTimer = undefined;
    } else {
        showMobileHud();
    }
}

// Reset the auto-hide timer when the user interacts with the HUD itself
document
    .getElementById("mobile-hud")!
    .addEventListener("pointerdown", showMobileHud, { passive: true });

// ── Internal self-interaction listeners ──
curtain.addEventListener("click", hideCurtain);
help.addEventListener("click", (e) => {
    if (e.target === help) toggleHelp();
});
