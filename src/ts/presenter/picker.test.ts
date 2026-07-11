// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// picker.ts and its transitive imports (pv, status, transitions, websocket, ui)
// capture DOM element references at module evaluation time via getElementById, so
// the DOM must exist before those modules load. We use vi.resetModules() + dynamic
// imports so evaluation happens after the DOM is ready. See transitions.test.ts.

let filterPicker: typeof import("./picker").filterPicker;
let state: typeof import("./state").state;

beforeAll(async () => {
    document.body.innerHTML = `
        <div id="picker"><input id="picker-input"/><ul id="picker-list"></ul></div>
        <div id="stage"></div>
        <div id="slide-info"></div>
        <div id="step-info"></div>
        <div id="mhud-slide-info"></div>
        <div id="mhud-step-ring"></div>
        <div id="ws-dot"></div>
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
        <div id="pv-clock"></div>
        <div id="pv-elapsed"></div>
        <div id="pv-slide-info"></div>
        <div id="pv-step-ring"></div>
        <div id="pv-next-inner"></div>
        <div id="pv-notes"></div>
    `;
    vi.resetModules();
    ({ filterPicker } = await import("./picker"));
    ({ state } = await import("./state"));
});

beforeEach(() => {
    state.slideIndex = 0;
    state.step = 0;
});

describe("picker title escaping (F-018)", () => {
    test("a malicious title renders inert instead of injecting a node", () => {
        const evil = `<img src=x onerror="window.__pwned=1">`;
        state.slides = [{ id: "a", svg: "<svg/>", title: evil, notes: "" }];

        filterPicker("");

        const list = document.getElementById("picker-list")!;
        // The title must not create a live <img> element.
        expect(list.querySelector("img")).toBeNull();
        // It round-trips as text, not mangled markup.
        expect(list.querySelector(".pk-title")?.textContent).toBe(evil);
    });
});
