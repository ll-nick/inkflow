import type { LogEntry, NotifyStyle } from "../shared/types";

const curtain = document.getElementById("curtain")!;
const help = document.getElementById("help")!;
const errorOverlay = document.getElementById("error-overlay")!;
const errorMsg = document.getElementById("error-msg")!;
const logBanner = document.getElementById("log-banner")!;
const logList = document.getElementById("log-list")!;
const logClose = document.getElementById("log-close")!;
const logIndicator = document.getElementById("log-indicator")!;
const statusBarEl = document.getElementById("statusbar")!;
const notify = document.getElementById("notify")!;
const notifyText = document.getElementById("notify-text")!;
const notifyClose = document.getElementById("notify-close")!;
const notifyHistoryBtn = document.getElementById("notify-history-btn")!;
const notifyHistoryEl = document.getElementById("notify-history")!;
const notifyHistoryList = document.getElementById("notify-history-list")!;
const notifyHistoryClose = document.getElementById("notify-history-close")!;

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

// ── Log banner + status-bar indicator ──
// The banner is non-modal and dismissible. Every rebuild re-sends the current logs, so
// we track a signature of the shown set: an identical set refreshes the content but
// respects a dismissal the user already made, while a changed set (or a newly-appearing
// entry) re-opens the banner. Whenever any messages exist the status-bar indicator
// stays lit (its icon/colour track the highest level), so a dismissed banner can be
// reopened by clicking it. An empty set hides both and clears the signature. Each entry
// is styled by its level via a `log-<level>` class; fatal build errors are not logs and
// use the full-screen error overlay instead.
const LOG_LEVEL_ORDER: Record<string, number> = {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3,
};

// Same glyphs as the terminal UI. The U+FE0E text-presentation selector keeps the
// emoji-capable ones monochrome so they take the level colour via CSS.
const LOG_ICON: Record<string, string> = {
    debug: "◦",
    info: "ℹ︎",
    warning: "⚠︎",
    error: "✖︎",
};

function highestLevel(logs: LogEntry[]): string {
    return logs.reduce(
        (top, e) =>
            (LOG_LEVEL_ORDER[e.level] ?? 0) > (LOG_LEVEL_ORDER[top] ?? 0)
                ? e.level
                : top,
        logs[0].level,
    );
}

let logSignature = "";
export function showLogs(logs: LogEntry[]): void {
    if (logs.length === 0) {
        hideLogs();
        logSignature = "";
        logIndicator.removeAttribute("data-level");
        return;
    }
    const signature = JSON.stringify(logs);
    const changed = signature !== logSignature;
    logSignature = signature;
    logList.replaceChildren(
        ...logs.map((entry) => {
            const li = document.createElement("li");
            li.className = `log-${entry.level}`;
            const ico = document.createElement("span");
            ico.className = "log-ico";
            ico.textContent = LOG_ICON[entry.level] ?? LOG_ICON.warning;
            const msg = document.createElement("span");
            msg.textContent = entry.message;
            li.append(ico, msg);
            return li;
        }),
    );
    logIndicator.dataset.level = highestLevel(logs);
    if (changed) logBanner.classList.add("visible");
}

// Dismissing hides only the banner; the indicator persists so it can be reopened.
export function hideLogs(): void {
    logBanner.classList.remove("visible");
}

// Keyboard toggle: close the banner if shown, else open it when there are messages
// (the indicator carries a level only while messages exist). A no-op otherwise.
export function toggleLogs(): void {
    if (logBanner.classList.contains("visible")) {
        hideLogs();
    } else if (logIndicator.hasAttribute("data-level")) {
        logBanner.classList.add("visible");
    }
}

// ── Notification toast ──
// A transient, self-dismissing confirmation/warning/error, styled by the same
// green/yellow/red vocabulary as inkflow.logging's report(). Pushed by the server
// (websocket.ts's "notify" message) or called directly by a client-only action
// (edit.ts's clipboard-copy confirmation, which never touches the server). Every
// call is also recorded to the message history below, so a toast that
// auto-dismissed unseen can still be found.

interface NotifyHistoryEntry {
    message: string;
    style: NotifyStyle;
    time: number;
}

const notifyHistory: NotifyHistoryEntry[] = [];

// Must match the CSS animation duration on #notify-progress (overlays.css).
const NOTIFY_DURATION_MS = 3000;

let notifyTimeout: ReturnType<typeof setTimeout> | null = null;

export function hideNotify(): void {
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notify.classList.remove("visible");
    notifyTimeout = null;
}

export function showNotify(
    message: string,
    style: NotifyStyle = "green",
): void {
    notifyHistory.push({ message, style, time: Date.now() });
    notifyText.textContent = message;
    notify.dataset.style = style;
    // Drop .visible and force a reflow before re-adding it, even if a notification
    // is already showing (two in quick succession) — otherwise the browser never
    // sees the class go away and won't restart the progress-bar animation.
    notify.classList.remove("visible");
    void notify.offsetWidth;
    notify.classList.add("visible");
    if (notifyTimeout) clearTimeout(notifyTimeout);
    notifyTimeout = setTimeout(hideNotify, NOTIFY_DURATION_MS);
}

// ── Messages (notification history) ──
// An append-only record of every showNotify() call, in memory only (cleared on
// reload — this answers "what did I just miss", not "what happened yesterday").
// Deliberately named and keybound apart from #log-banner ("Diagnostics", d) so
// the two don't read as the same feature: diagnostics are current build health
// (repopulated wholesale each rebuild, only exist in relation to one that just
// ran), this is a history of what *you* did (repopulated never — only grows),
// and its own status-bar button is always visible rather than appearing on the
// first message — it's a plain utility, not an alert.

const NOTIFY_HISTORY_ICON: Record<NotifyStyle, string> = {
    green: "✓",
    yellow: "⚠︎",
    red: "✖︎",
};

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function formatHistoryTime(time: number): string {
    const d = new Date(time);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function renderNotifyHistory(): void {
    if (notifyHistory.length === 0) {
        const empty = document.createElement("li");
        empty.id = "notify-history-empty";
        empty.className = "nh-row";
        empty.textContent = "No messages yet.";
        notifyHistoryList.replaceChildren(empty);
        return;
    }
    notifyHistoryList.replaceChildren(
        ...notifyHistory
            .slice()
            .reverse()
            .map((entry) => {
                const li = document.createElement("li");
                li.className = "nh-row";
                const time = document.createElement("span");
                time.className = "nh-time";
                time.textContent = formatHistoryTime(entry.time);
                const ico = document.createElement("span");
                ico.className = `nh-ico nh-${entry.style}`;
                ico.textContent = NOTIFY_HISTORY_ICON[entry.style];
                const msg = document.createElement("span");
                msg.className = "nh-message";
                msg.textContent = entry.message;
                li.append(time, ico, msg);
                return li;
            }),
    );
}

export function openNotifyHistory(): void {
    renderNotifyHistory();
    notifyHistoryEl.classList.add("visible");
}

export function closeNotifyHistory(): void {
    notifyHistoryEl.classList.remove("visible");
}

export function toggleNotifyHistory(): void {
    if (notifyHistoryEl.classList.contains("visible")) closeNotifyHistory();
    else openNotifyHistory();
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
logClose.addEventListener("click", hideLogs);
logIndicator.addEventListener("click", () => {
    logBanner.classList.add("visible");
});
notifyClose.addEventListener("click", hideNotify);
notifyHistoryBtn.addEventListener("click", toggleNotifyHistory);
notifyHistoryClose.addEventListener("click", closeNotifyHistory);
notifyHistoryEl.addEventListener("click", (e) => {
    if (e.target === notifyHistoryEl) closeNotifyHistory();
});
curtain.addEventListener("click", hideCurtain);
help.addEventListener("click", (e) => {
    if (e.target === help) toggleHelp();
});
