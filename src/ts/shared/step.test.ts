// @vitest-environment happy-dom
import { beforeAll, describe, expect, test } from "vitest";
import { buildStepRun, maxStep, restingActions } from "./step";

// happy-dom does not implement the Web Animations API, so stub element.animate with an inert
// handle. buildStepRun only reads each cue's offset/span off `data-cues` — the layout it
// returns is independent of the animation object, so the stub is enough to exercise it.
beforeAll(() => {
    Element.prototype.animate = () =>
        ({
            pause() {},
            play() {},
            finish() {},
            cancel() {},
            currentTime: 0,
            playbackRate: 1,
        }) as unknown as Animation;
});

function buildSvg(html: string): Element {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container;
}

type Cue = { kind: "enter" | "exit" | "emphasis"; step: number };

// restingActions is the governing-cue rule: given all of an element's cues (in step order)
// and the step the slide sits at, it says which cue holds visibility (the last reached
// enter/exit) and which assert nothing. Testing it directly pins the multi-cue lifecycle
// without a Web Animations API implementation.
describe("restingActions", () => {
    // One element's whole lifecycle: enter@1, emphasis@2, exit@3, re-enter@4.
    const hero: Cue[] = [
        { kind: "enter", step: 1 },
        { kind: "emphasis", step: 2 },
        { kind: "exit", step: 3 },
        { kind: "enter", step: 4 },
    ];

    test("the last reached enter/exit holds; everything else cancels", () => {
        expect(restingActions(hero, 0)).toEqual([
            "cancel",
            "cancel",
            "cancel",
            "cancel",
        ]);
        expect(restingActions(hero, 1)).toEqual([
            "hold",
            "cancel",
            "cancel",
            "cancel",
        ]);
        // Emphasis is never the governing cue; the enter@1 still holds at step 2.
        expect(restingActions(hero, 2)).toEqual([
            "hold",
            "cancel",
            "cancel",
            "cancel",
        ]);
        expect(restingActions(hero, 3)).toEqual([
            "cancel",
            "cancel",
            "hold",
            "cancel",
        ]);
        expect(restingActions(hero, 4)).toEqual([
            "cancel",
            "cancel",
            "cancel",
            "hold",
        ]);
    });

    test("an emphasis-only element never holds", () => {
        const caption: Cue[] = [{ kind: "emphasis", step: 2 }];
        expect(restingActions(caption, 1)).toEqual(["cancel"]);
        expect(restingActions(caption, 2)).toEqual(["cancel"]);
        expect(restingActions(caption, 3)).toEqual(["cancel"]);
    });
});

// buildStepRun lays a step's cues onto a single seekable timeline. It reads each cue's
// `offset` and effect length (delay + duration·iterations) off `data-cues`; the run's cues
// are the ones introduced at the higher of {fromStep, toStep}. happy-dom stubs
// element.animate, so we can assert the layout (offsets, span, total, direction) without a
// real WAAPI. `totalMs` is the max over cues of offset+span, in ms.
describe("buildStepRun", () => {
    // A three-stage auto-advance cascade on step 1: offsets 0 / 0.6 / 1.2, each 0.6s.
    const cascade = `
        <rect id="a" data-cues='[{"step":1,"kind":"enter","name":"slide-in","offset":0,"opts":{"duration":0.6,"delay":0,"easing":"ease","iterations":1},"vars":{}}]'></rect>
        <rect id="b" data-cues='[{"step":1,"kind":"enter","name":"slide-in","offset":0.6,"opts":{"duration":0.6,"delay":0,"easing":"ease","iterations":1},"vars":{}}]'></rect>
        <rect id="c" data-cues='[{"step":1,"kind":"enter","name":"slide-in","offset":1.2,"opts":{"duration":0.6,"delay":0,"easing":"ease","iterations":1},"vars":{}}]'></rect>`;

    test("forward run gathers the destination step's cues with their slots", () => {
        const run = buildStepRun(buildSvg(cascade), 0, 1);
        expect(run.forward).toBe(true);
        expect(run.toStep).toBe(1);
        expect(run.items.map((it) => it.offsetMs)).toEqual([0, 600, 1200]);
        expect(run.items.every((it) => it.spanMs === 600)).toBe(true);
        // total = last slot start + its span.
        expect(run.totalMs).toBe(1800);
    });

    test("backward run over the same stop is marked not-forward", () => {
        const run = buildStepRun(buildSvg(cascade), 1, 0);
        expect(run.forward).toBe(false);
        expect(run.toStep).toBe(0);
        // Same cues (the ones at the higher stop, 1), same layout — direction differs.
        expect(run.totalMs).toBe(1800);
    });

    test("authored delay extends the cue's own span but not its offset", () => {
        const svg = `<rect id="a" data-cues='[{"step":1,"kind":"enter","name":"fade-in","offset":0,"opts":{"duration":0.8,"delay":0.2,"easing":"ease","iterations":1},"vars":{}}]'></rect>`;
        const run = buildStepRun(buildSvg(svg), 0, 1);
        expect(run.items[0].offsetMs).toBe(0);
        expect(run.items[0].spanMs).toBe(1000); // (0.2 + 0.8) * 1000
        expect(run.totalMs).toBe(1000);
    });

    test("a step with no cues yields an empty, zero-length run", () => {
        const run = buildStepRun(buildSvg(cascade), 1, 2);
        expect(run.items).toEqual([]);
        expect(run.totalMs).toBe(0);
    });
});

describe("maxStep", () => {
    test("returns the highest step across every element's data-cues", () => {
        const root = buildSvg(
            `<rect data-cues='[{"step":1},{"step":4}]'></rect>
             <rect data-cues='[{"step":2}]'></rect>`,
        );
        expect(maxStep(root)).toBe(4);
    });

    test("returns 0 when there are no cues", () => {
        expect(maxStep(buildSvg("<rect></rect>"))).toBe(0);
    });

    test("counts a video's data-play-on-step", () => {
        expect(maxStep(buildSvg(`<video data-play-on-step="3"></video>`))).toBe(
            3,
        );
    });

    test("unions cue steps with a later video step", () => {
        const root = buildSvg(
            `<rect data-cues='[{"step":1}]'></rect>
             <video data-play-on-step="3"></video>`,
        );
        expect(maxStep(root)).toBe(3);
    });
});
