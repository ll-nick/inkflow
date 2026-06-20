// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { TransitionData } from "../shared/types";

// transitions.ts and its transitive imports (morph.ts, status.ts) capture DOM
// element references at module evaluation time via getElementById. The DOM must
// exist before those modules load. We use vi.resetModules() + dynamic imports so
// the module evaluation happens after the DOM is ready.

type LoadSlide = (
    then?: (() => void) | null,
    transition?: TransitionData | null,
) => void;

let loadSlide: LoadSlide;
let registerProgressTransition: typeof import("./transitions").registerProgressTransition;
let inflightDirection: typeof import("./transitions").inflightDirection;
let snapInflight: typeof import("./transitions").snapInflight;
let maxStep: typeof import("./status").maxStep;
let state: typeof import("./state").state;

beforeAll(async () => {
    document.body.innerHTML = `
        <div id="stage"><svg><rect id="a"/></svg></div>
        <div id="slide-info"></div>
        <div id="step-info"></div>
        <div id="mhud-slide-info"></div>
        <div id="mhud-step-ring"></div>
    `;
    vi.resetModules();
    ({
        loadSlide,
        registerProgressTransition,
        inflightDirection,
        snapInflight,
    } = await import("./transitions"));
    ({ maxStep } = await import("./status"));
    ({ state } = await import("./state"));
});

beforeEach(() => {
    state.slides = [
        { svg: "<svg><rect id='a'/></svg>", title: "S1", notes: "" },
    ];
    state.slideIndex = 0;
    state.step = 0;
    state.transitions = [];
    state._syncingFromServer = false;
    // Clear any pending cancel from a previous test.
    loadSlide(null, { type: "cut", duration: 0 });
});

describe("reverse", () => {
    test("push reverse: forward then fires on abort, backward then fires on completion", async () => {
        vi.useFakeTimers();
        state.slides = [
            { svg: "<svg><rect id='a'/></svg>", title: "S1", notes: "" },
            { svg: "<svg><rect id='b'/></svg>", title: "S2", notes: "" },
        ];
        state.slideIndex = 1;
        let fwdCount = 0;
        let bwdCount = 0;

        // Forward push (index already at 1).
        loadSlide(
            () => {
                fwdCount++;
            },
            { type: "push", duration: 0.5 },
        );
        // Immediately reverse — same type, opposite direction flag.
        state.slideIndex = 0;
        loadSlide(
            () => {
                bwdCount++;
            },
            { type: "push", duration: 0.5, reverse: true },
        );

        // Forward settle fires synchronously when the signal is aborted.
        expect(fwdCount).toBe(1);
        // Backward settle fires when the reverse animation completes.
        expect(bwdCount).toBe(0);

        await vi.runAllTimersAsync();
        expect(bwdCount).toBe(1);
        expect(fwdCount).toBe(1); // exactly once throughout

        vi.useRealTimers();
    });

    test("maxStep reads the destination slide through a mid-flight reverse, not the slide left behind", async () => {
        vi.useFakeTimers();
        // Slide A has no steps (maxStep 0); slide B has a step-2 element (maxStep 2).
        state.slides = [
            { svg: "<svg><rect id='a'/></svg>", title: "A", notes: "" },
            {
                svg: "<svg><rect id='b' data-step='2'/></svg>",
                title: "B",
                notes: "",
            },
        ];
        state.transitions = [
            { type: "cut", duration: 0 },
            { type: "push", duration: 0.5 },
        ];

        // Forward into slide B (maxStep 2).
        state.slideIndex = 1;
        state.step = 0;
        loadSlide(null, { type: "push", duration: 0.5 });
        expect(maxStep()).toBe(2);

        // Reverse back into stepless slide A mid-flight. Mirroring retreat(), the
        // step is set before loadSlide (to the destination's final step).
        state.slideIndex = 0;
        state.step = maxStep();
        loadSlide(null, { type: "push", duration: 0.5, reverse: true });

        await vi.runAllTimersAsync();

        // maxStep is derived from the destination slide's data, so the stepless
        // slide A reads 0 — not slide B's 2, which would push a bogus ?steps=2 into
        // the URL and desync navigation.
        expect(maxStep()).toBe(0);
        expect(state.step).toBe(0);

        vi.useRealTimers();
    });

    test("reverse-of-reverse lands on the new slide (symmetric push)", async () => {
        vi.useFakeTimers();
        state.slides = [
            { svg: "<svg><rect id='a'/></svg>", title: "A", notes: "" },
            { svg: "<svg><rect id='b'/></svg>", title: "B", notes: "" },
        ];
        state.transitions = [
            { type: "cut", duration: 0 },
            { type: "push", duration: 0.5 },
        ];
        let thenCount = 0;

        // Forward into B, reverse back toward A, then reverse the reverse toward B.
        state.slideIndex = 1;
        loadSlide(null, { type: "push", duration: 0.5 });
        state.slideIndex = 0;
        loadSlide(null, { type: "push", duration: 0.5, reverse: true });
        state.slideIndex = 1;
        loadSlide(
            () => {
                thenCount++;
            },
            { type: "push", duration: 0.5 },
        );

        await vi.runAllTimersAsync();

        // The third keypress re-targets the same instance forward, so it ends on the
        // new slide B (not back on A), and the final then fires exactly once.
        const stage = document.getElementById("stage")!;
        expect(stage.querySelector("#b")).not.toBeNull();
        expect(stage.querySelector("#a")).toBeNull();
        expect(thenCount).toBe(1);

        vi.useRealTimers();
    });

    test("reverse keeps the render's params stable (no mid-flight geometry flip)", async () => {
        vi.useFakeTimers();
        state.slides = [
            { svg: "<svg><rect id='a'/></svg>", title: "A", notes: "" },
            { svg: "<svg><rect id='b'/></svg>", title: "B", notes: "" },
        ];
        state.transitions = [
            { type: "cut", duration: 0 },
            { type: "probe", duration: 0.5 },
        ];
        const seenReverse: (boolean | undefined)[] = [];
        registerProgressTransition("probe", (_context, _progress, params) => {
            seenReverse.push(params.reverse);
        });

        // Forward into B (reverse:false), then reverse back toward A mid-flight.
        state.slideIndex = 1;
        loadSlide(null, { type: "probe", duration: 0.5 });
        state.slideIndex = 0;
        loadSlide(null, { type: "probe", duration: 0.5, reverse: true });

        await vi.runAllTimersAsync();

        // Every paint — forward and reverse — saw the forward params (reverse
        // falsy). If reverse() repainted with its own reversed params, push/cover/
        // wipe/flip would re-flip their geometry mid-flight.
        expect(seenReverse.length).toBeGreaterThan(1);
        expect(seenReverse.every((reverse) => !reverse)).toBe(true);

        vi.useRealTimers();
    });
});

describe("snap in-flight", () => {
    beforeEach(() => {
        state.slides = [
            { svg: "<svg><rect id='a'/></svg>", title: "A", notes: "" },
            { svg: "<svg><rect id='b'/></svg>", title: "B", notes: "" },
        ];
    });

    test("inflightDirection reports a forward transition; snapInflight ends it and shows the slide", async () => {
        vi.useFakeTimers();
        state.slideIndex = 1;
        state.step = 0;

        loadSlide(null, { type: "push", duration: 0.5 });
        expect(inflightDirection()).toBe("forward");

        snapInflight();
        expect(inflightDirection()).toBeNull();
        const stage = document.getElementById("stage")!;
        expect(stage.querySelector("#b")).not.toBeNull();

        await vi.runAllTimersAsync();
        expect(inflightDirection()).toBeNull();

        vi.useRealTimers();
    });

    test("inflightDirection reflects a backward (reverse) transition", () => {
        state.slideIndex = 0;
        loadSlide(null, { type: "push", duration: 0.5, reverse: true });
        expect(inflightDirection()).toBe("backward");

        snapInflight();
        expect(inflightDirection()).toBeNull();
    });
});

describe("loadSlide interruption", () => {
    test("cancels an in-flight crossfade: the cancelled then fires once on snap, not again when the timer expires", async () => {
        vi.useFakeTimers();
        let crossfadeCount = 0;
        let cutCount = 0;

        // Start a crossfade (async — fires done via setTimeout).
        loadSlide(
            () => {
                crossfadeCount++;
            },
            { type: "crossfade", duration: 0.5 },
        );
        // Immediately supersede it with a cut (synchronous).
        loadSlide(
            () => {
                cutCount++;
            },
            { type: "cut", duration: 0 },
        );

        // Crossfade's then fires synchronously on cancel.
        expect(crossfadeCount).toBe(1);

        // Cut's start() is async, so its then fires after the next microtask tick.
        await Promise.resolve();
        expect(cutCount).toBe(1);

        // Advance past the crossfade's original timer — finish is idempotent, no second call.
        await vi.runAllTimersAsync();
        expect(crossfadeCount).toBe(1);

        vi.useRealTimers();
    });

    test("_syncingFromServer is cleared when a WS-initiated transition is superseded", () => {
        // Simulate the websocket position handler: set the flag, then call loadSlide
        // with a then that would clear it on completion.
        state._syncingFromServer = true;
        loadSlide(
            () => {
                state._syncingFromServer = false;
            },
            { type: "crossfade", duration: 0.5 },
        );

        // A user keypress supersedes it before the transition completes.
        loadSlide(null, { type: "cut", duration: 0 });

        // cancel-and-snap ran the crossfade's then, which cleared the flag.
        expect(state._syncingFromServer).toBe(false);
    });
});
