// @vitest-environment happy-dom
import { beforeAll, beforeEach, expect, test, vi } from "vitest";

// ui.ts captures DOM references and binds listeners at module-evaluation time, so the
// DOM must exist before it loads (see logs.test.ts / picker.test.ts).
let showNotify: typeof import("./ui").showNotify;
let hideNotify: typeof import("./ui").hideNotify;

const notify = () => document.getElementById("notify")!;
const notifyText = () => document.getElementById("notify-text")!;
const notifyClose = () => document.getElementById("notify-close")!;
const visible = () => notify().classList.contains("visible");

beforeAll(async () => {
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
    `;
    vi.resetModules();
    ({ showNotify, hideNotify } = await import("./ui"));
});

beforeEach(() => {
    hideNotify();
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
