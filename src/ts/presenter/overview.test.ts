// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

// overview.ts and its transitive imports (pv.ts, status.ts, transitions.ts,
// websocket.ts) capture DOM element references at module evaluation time via
// getElementById. The DOM must exist before those modules load, so we use
// vi.resetModules() + dynamic imports, mirroring transitions.test.ts.

let openOverview: typeof import("./overview").openOverview;
let closeOverview: typeof import("./overview").closeOverview;
let state: typeof import("./state").state;
let overview: HTMLElement;
let overviewGrid: HTMLElement;

beforeAll(async () => {
    // overview.ts's transitive imports (pv, status, transitions, websocket, ui)
    // need the same full DOM fixture as picker.test.ts.
    document.body.innerHTML = `
        <div id="stage"><svg><rect id="a"/></svg></div>
        <div id="slide-info"></div>
        <div id="step-info"></div>
        <div id="mhud-slide-info"></div>
        <div id="mhud-step-ring"></div>
        <div id="ws-dot"></div>
        <div id="overview">
            <div id="overview-grid"></div>
        </div>
        <div id="curtain"></div>
        <div id="help"></div>
        <div id="error-overlay"></div>
        <div id="error-msg"></div>
        <div id="log-banner"><ul id="log-list"></ul><button id="log-close"></button></div>
        <button id="log-indicator"></button>
        <div id="statusbar"></div>
        <div id="mobile-hud"></div>
        <aside id="pv">
            <div id="pv-resize-handle"></div>
            <div id="pv-clock"></div>
            <div id="pv-elapsed"></div>
            <div id="pv-slide-info"></div>
            <div id="pv-step-ring"></div>
            <div id="pv-next-inner"></div>
            <div id="pv-notes"></div>
        </aside>
    `;

    // computeStageFlip() divides stage/thumbnail rect sizes; happy-dom has no
    // layout engine and reports every rect as zero, which would divide by zero.
    // Give the stage a rect much larger than any other element's, matching how
    // a real presenter window dwarfs a grid thumbnail, so the FLIP scale factor
    // is a sane, non-degenerate number.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function (this: Element) {
            const isStage = this.id === "stage";
            const width = isStage ? 800 : 100;
            const height = isStage ? 450 : 60;
            return {
                x: 0,
                y: 0,
                width,
                height,
                top: 0,
                left: 0,
                right: width,
                bottom: height,
                toJSON() {
                    return this;
                },
            } as DOMRect;
        },
    );

    vi.resetModules();
    ({ openOverview, closeOverview } = await import("./overview"));
    ({ state } = await import("./state"));
    overview = document.getElementById("overview")!;
    overviewGrid = document.getElementById("overview-grid")!;
});

beforeEach(() => {
    state.slides = [
        {
            id: "a",
            svg: '<svg viewBox="0 0 1920 1080"><rect/></svg>',
            title: "A",
            notes: "",
        },
        {
            id: "b",
            svg: '<svg viewBox="0 0 1920 1080"><rect/></svg>',
            title: "B",
            notes: "",
        },
    ];
    state.slideIndex = 0;
    state._overviewActive = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

test("open reaches full scale and reveals the overlay", async () => {
    vi.useFakeTimers();

    const opened = openOverview();
    await vi.runAllTimersAsync();
    await opened;

    expect(overview.classList.contains("visible")).toBe(true);
    expect(overview.style.opacity).toBe("1");
    expect(overviewGrid.style.transform).toBe("scale(1)");
});

test("open reveals the backdrop instantly, not faded in alongside the zoom", async () => {
    vi.useFakeTimers();
    const opened = openOverview();
    // Advance past the two rAF-gated setup steps, landing right as the zoom
    // animation begins — well short of its 0.6s duration.
    await vi.advanceTimersByTimeAsync(32);
    expect(overview.style.opacity).toBe("1");
    expect(overviewGrid.style.transform).not.toBe("scale(1)");

    await vi.runAllTimersAsync();
    await opened;
});

test("close fades the backdrop only after the zoom lands, not alongside it", async () => {
    vi.useFakeTimers();
    const opened = openOverview();
    await vi.runAllTimersAsync();
    await opened;

    const closed = closeOverview();
    // Partway through the 0.35s zoom-to-stage phase: still fully visible, the
    // fade hasn't started.
    await vi.advanceTimersByTimeAsync(150);
    expect(overview.style.opacity).toBe("1");

    // Past the zoom phase and into the fade phase: now decreasing.
    await vi.advanceTimersByTimeAsync(250);
    expect(Number(overview.style.opacity)).toBeLessThan(1);

    await vi.runAllTimersAsync();
    await closed;
});

test("closing mid-open aborts cleanly and reverses instead of racing", async () => {
    vi.useFakeTimers();

    const opened = openOverview();
    // Let the setup phase (a couple of rAF ticks) run and the open animation
    // begin, but stop partway through its 0.6s duration.
    await vi.advanceTimersByTimeAsync(200);
    expect(overview.classList.contains("visible")).toBe(true);

    const closed = closeOverview();
    await vi.runAllTimersAsync();
    const results = await Promise.allSettled([opened, closed]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // The interrupted open never gets to leave stale visible/opacity/grid state
    // behind — closeOverview's own completion is what settles it.
    expect(overview.classList.contains("visible")).toBe(false);
    expect(overview.style.opacity).toBe("");
    expect(overviewGrid.innerHTML).toBe("");
});
