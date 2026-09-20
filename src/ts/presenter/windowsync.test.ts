// @vitest-environment happy-dom
import { beforeAll, describe, expect, test } from "vitest";

// windowsync.ts's transitive imports (websocket, ui) capture DOM element
// references at module evaluation time via getElementById, so the DOM must exist
// before it loads. Mirrors picker.test.ts / transitions.test.ts.

let isSyncPayload: typeof import("./windowsync").isSyncPayload;

beforeAll(async () => {
    document.body.innerHTML = `
        <div id="stage"></div>
        <div id="slide-info"></div>
        <div id="step-info"></div>
        <div id="mhud-slide-info"></div>
        <div id="mhud-step-ring"></div>
        <div id="ws-dot"></div>
        <button id="btn-presenter-view"></button>
        <div id="overview"></div>
        <div id="overview-grid"></div>
        <div id="curtain"></div>
        <div id="help"></div>
        <div id="error-overlay"></div>
        <div id="error-msg"></div>
        <div id="log-banner"><ul id="log-list"></ul><button id="log-close"></button></div>
        <button id="log-indicator"></button>
        <div id="statusbar"></div>
        <div id="mobile-hud"></div>
        <aside id="pv"></aside>
        <div id="pv-resize-handle"></div>
        <div id="pv-strip"></div>
        <div id="pv-clock"></div>
        <div id="pv-elapsed"></div>
        <button id="pv-timer-toggle"></button>
        <button id="pv-timer-reset"></button>
        <div id="pv-slide-info"></div>
        <div id="pv-step-ring"></div>
        <div id="pv-next-inner"></div>
        <div id="pv-notes"></div>
        <span class="edit-wrap">
            <button id="btn-edit"></button>
            <div id="edit-menu"></div>
        </span>
        <button id="edit-toast-close"></button>
    `;
    ({ isSyncPayload } = await import("./windowsync"));
});

describe("isSyncPayload", () => {
    test("accepts a well-formed nav message", () => {
        expect(isSyncPayload({ type: "nav", slideIndex: 2, step: 1 })).toBe(
            true,
        );
        expect(
            isSyncPayload({
                type: "nav",
                slideIndex: 0,
                step: 0,
                snap: true,
                transition: { type: "cut", duration: 0 },
            }),
        ).toBe(true);
    });

    test("rejects messages of the wrong shape or type", () => {
        expect(isSyncPayload(null)).toBe(false);
        expect(isSyncPayload(undefined)).toBe(false);
        expect(isSyncPayload("nav")).toBe(false);
        expect(
            isSyncPayload({ type: "position", slideIndex: 0, step: 0 }),
        ).toBe(false);
        expect(isSyncPayload({ type: "nav", slideIndex: "0", step: 0 })).toBe(
            false,
        );
        expect(isSyncPayload({ type: "nav", step: 0 })).toBe(false);
    });

    test("ignores unrelated postMessage traffic", () => {
        // e.g. a browser extension or an unrelated page broadcasting on the tab.
        expect(isSyncPayload({ source: "react-devtools", payload: {} })).toBe(
            false,
        );
    });
});
