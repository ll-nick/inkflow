// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { LogEntry } from "../shared/types";

// ui.ts captures DOM references and binds listeners at module-evaluation time, so the
// DOM must exist before it loads (see picker.test.ts). We import it dynamically after.
let showLogs: typeof import("./ui").showLogs;
let hideLogs: typeof import("./ui").hideLogs;
let toggleLogs: typeof import("./ui").toggleLogs;

const banner = () => document.getElementById("log-banner")!;
const indicator = () => document.getElementById("log-indicator")!;
const items = () => Array.from(document.querySelectorAll("#log-list li"));
const bannerOpen = () => banner().classList.contains("visible");

function log(level: string, message: string): LogEntry {
    return { level, message };
}

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
    `;
    vi.resetModules();
    ({ showLogs, hideLogs, toggleLogs } = await import("./ui"));
});

// Reset banner, indicator, and the dismissal signature between tests.
beforeEach(() => {
    showLogs([]);
});

describe("log banner + status-bar indicator", () => {
    test("no messages: indicator hidden and banner closed", () => {
        expect(indicator().hasAttribute("data-level")).toBe(false);
        expect(bannerOpen()).toBe(false);
    });

    test("a message lights the indicator and opens the banner", () => {
        showLogs([log("warning", "missing font")]);
        expect(indicator().getAttribute("data-level")).toBe("warning");
        expect(bannerOpen()).toBe(true);
        const li = items()[0];
        expect(li.className).toBe("log-warning");
        expect(li.querySelector(".log-ico")).not.toBeNull();
        expect(li.textContent).toContain("missing font");
    });

    test("indicator level tracks the highest message level", () => {
        showLogs([log("info", "a"), log("error", "b"), log("warning", "c")]);
        expect(indicator().getAttribute("data-level")).toBe("error");
    });

    test("dismissing hides the banner but keeps the indicator", () => {
        showLogs([log("warning", "x")]);
        document.getElementById("log-close")!.click();
        expect(bannerOpen()).toBe(false);
        expect(indicator().getAttribute("data-level")).toBe("warning");
    });

    test("clicking the indicator reopens a dismissed banner", () => {
        showLogs([log("warning", "x")]);
        hideLogs();
        expect(bannerOpen()).toBe(false);
        indicator().click();
        expect(bannerOpen()).toBe(true);
    });

    test("clearing messages hides the indicator", () => {
        showLogs([log("error", "x")]);
        showLogs([]);
        expect(indicator().hasAttribute("data-level")).toBe(false);
        expect(bannerOpen()).toBe(false);
    });

    test("toggleLogs opens then closes when messages exist", () => {
        showLogs([log("warning", "x")]);
        hideLogs();
        expect(bannerOpen()).toBe(false);
        toggleLogs();
        expect(bannerOpen()).toBe(true);
        toggleLogs();
        expect(bannerOpen()).toBe(false);
    });

    test("toggleLogs is a no-op when there are no messages", () => {
        toggleLogs();
        expect(bannerOpen()).toBe(false);
    });
});
