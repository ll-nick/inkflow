// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";

// ui.ts captures DOM references and binds listeners at module-evaluation time, and
// notifyHistory is a plain append-only in-memory array with no reset hook (by
// design — see ui.ts) — so unlike logs.test.ts, each test needs a fresh module
// instance via vi.resetModules() + dynamic import, mirroring edit.test.ts, rather
// than sharing one module across tests.
let showNotify: typeof import("./ui").showNotify;
let openNotifyHistory: typeof import("./ui").openNotifyHistory;
let closeNotifyHistory: typeof import("./ui").closeNotifyHistory;
let toggleNotifyHistory: typeof import("./ui").toggleNotifyHistory;

const notify = () => document.getElementById("notify")!;
const notifyText = () => document.getElementById("notify-text")!;
const notifyClose = () => document.getElementById("notify-close")!;
const visible = () => notify().classList.contains("visible");

const historyEl = () => document.getElementById("notify-history")!;
const historyList = () => document.getElementById("notify-history-list")!;
const historyBtn = () => document.getElementById("notify-history-btn")!;
const historyClose = () => document.getElementById("notify-history-close")!;
const historyOpen = () => historyEl().classList.contains("visible");
const historyRows = () =>
    Array.from(historyList().querySelectorAll("li")).filter(
        (li) => li.id !== "notify-history-empty",
    );

beforeEach(async () => {
    document.body.innerHTML = `
        <div id="curtain"></div>
        <div id="help"></div>
        <div id="error-overlay"></div>
        <div id="error-msg"></div>
        <div id="log-banner"><ul id="log-list"></ul><button id="log-close"></button></div>
        <button id="log-indicator"></button>
        <div id="statusbar"></div>
        <div id="mobile-hud"></div>
        <div id="notify">
            <div id="notify-body">
                <span id="notify-text"></span>
                <button id="notify-close"></button>
            </div>
            <div id="notify-progress"></div>
        </div>
        <div id="notify-history">
            <div id="notify-history-box">
                <button id="notify-history-close"></button>
                <ul id="notify-history-list"></ul>
            </div>
        </div>
        <button id="notify-history-btn"></button>
    `;
    vi.resetModules();
    ({
        showNotify,
        openNotifyHistory,
        closeNotifyHistory,
        toggleNotifyHistory,
    } = await import("./ui"));
});

test("shows the message and, by default, a green style", () => {
    showNotify("Copied /deck/slide.svg");
    expect(visible()).toBe(true);
    expect(notifyText().textContent).toBe("Copied /deck/slide.svg");
    expect(notify().dataset.style).toBe("green");
});

test("a warning or error notification carries its own style", () => {
    showNotify("missing font", "yellow");
    expect(notify().dataset.style).toBe("yellow");
    showNotify("failed to launch edit command 'nope': not found", "red");
    expect(notify().dataset.style).toBe("red");
});

test("clicking the close button dismisses it early", () => {
    vi.useFakeTimers();
    showNotify("Copied /deck/slide.svg");
    expect(visible()).toBe(true);
    notifyClose().click();
    expect(visible()).toBe(false);
    // The pending auto-hide timeout must also be cleared, not just overridden by
    // the manual dismiss, otherwise it could re-fire (harmlessly, but sloppily)
    // or clobber a *later* notification's own timer.
    vi.advanceTimersByTime(3000);
    expect(visible()).toBe(false);
    vi.useRealTimers();
});

test("every style auto-dismisses, including red/yellow — there is no manual-only state", () => {
    vi.useFakeTimers();
    showNotify("failed to launch edit command 'nope': not found", "red");
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(visible()).toBe(false);
    vi.useRealTimers();
});

test("a second notification in quick succession restarts the auto-hide timer", () => {
    vi.useFakeTimers();
    showNotify("Copied /deck/a.svg");
    vi.advanceTimersByTime(2000); // most of the way to the first one's timeout
    showNotify("Copied /deck/b.md");
    vi.advanceTimersByTime(2000); // would have closed the first one by now
    expect(visible()).toBe(true);
    expect(notifyText().textContent).toBe("Copied /deck/b.md");
    vi.advanceTimersByTime(1000); // completes the second one's own 3000ms
    expect(visible()).toBe(false);
    vi.useRealTimers();
});

// ── Message history ──

test("opens to an empty state before any notification has fired", () => {
    openNotifyHistory();
    expect(historyOpen()).toBe(true);
    expect(historyRows().length).toBe(0);
    expect(historyList().textContent).toContain("No messages yet");
});

test("every showNotify call is recorded, newest first", () => {
    showNotify("Copied /deck/a.svg");
    showNotify("missing font", "yellow");
    openNotifyHistory();
    const rows = historyRows();
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("missing font");
    expect(rows[1].textContent).toContain("Copied /deck/a.svg");
});

test("a dismissed or auto-dismissed notification stays in history", () => {
    vi.useFakeTimers();
    showNotify("Copied /deck/a.svg");
    vi.advanceTimersByTime(3000);
    expect(visible()).toBe(false);
    vi.useRealTimers();
    openNotifyHistory();
    expect(historyRows().length).toBe(1);
});

test("the history button toggles the dialog open and closed", () => {
    historyBtn().click();
    expect(historyOpen()).toBe(true);
    historyBtn().click();
    expect(historyOpen()).toBe(false);
});

test("the close button and clicking the backdrop both dismiss the dialog", () => {
    openNotifyHistory();
    historyClose().click();
    expect(historyOpen()).toBe(false);
    openNotifyHistory();
    historyEl().dispatchEvent(new Event("click", { bubbles: true }));
    expect(historyOpen()).toBe(false);
});

test("clicking inside the dialog box does not close it", () => {
    openNotifyHistory();
    historyList().dispatchEvent(new Event("click", { bubbles: true }));
    expect(historyOpen()).toBe(true);
    closeNotifyHistory();
});

test("toggleNotifyHistory is exported for the keyboard/click wiring", () => {
    expect(historyOpen()).toBe(false);
    toggleNotifyHistory();
    expect(historyOpen()).toBe(true);
});
