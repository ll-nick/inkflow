// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { elementActions, maxStep } from "./step";

function buildSvg(html: string): Element {
    const container = document.createElement("div");
    container.innerHTML = html;
    return container;
}

type Cue = { kind: "enter" | "exit" | "emphasis"; step: number };

// elementActions is the governing-cue rule at the heart of the engine: given all of an
// element's cues (in step order), the target step, the previously applied step, and
// whether this is an instant landing, it returns what to do with each cue. Only the
// governing enter/exit (last one reached) asserts visibility, so the result never depends
// on WAAPI composite order. Testing it directly pins the multi-cue lifecycle without a
// Web Animations API implementation.
describe("elementActions", () => {
    // One element's whole lifecycle: enter@1, emphasis@2, exit@3, re-enter@4.
    const hero: Cue[] = [
        { kind: "enter", step: 1 },
        { kind: "emphasis", step: 2 },
        { kind: "exit", step: 3 },
        { kind: "enter", step: 4 },
    ];
    const at = (step: number, prev: number) =>
        elementActions(hero, step, prev, false);

    test("forward: reveal, emphasize, exit, re-enter — one boundary at a time", () => {
        expect(at(1, 0)).toEqual(["forward", "idle", "cancel", "cancel"]);
        expect(at(2, 1)).toEqual(["hold", "emphasis", "cancel", "cancel"]);
        expect(at(3, 2)).toEqual(["cancel", "idle", "forward", "cancel"]);
        expect(at(4, 3)).toEqual(["cancel", "idle", "cancel", "forward"]);
    });

    test("backward: only the governing boundary reverses, the new governing holds", () => {
        expect(at(3, 4)).toEqual(["cancel", "idle", "hold", "reverse"]);
        expect(at(2, 3)).toEqual(["hold", "idle", "reverse", "cancel"]);
        expect(at(1, 2)).toEqual(["hold", "idle", "cancel", "cancel"]);
        expect(at(0, 1)).toEqual(["reverse", "idle", "cancel", "cancel"]);
    });

    test("instant landing holds only the governing cue, never reverses or emphasizes", () => {
        expect(elementActions(hero, 2, 2, true)).toEqual([
            "hold",
            "cancel",
            "cancel",
            "cancel",
        ]);
        expect(elementActions(hero, 4, 4, true)).toEqual([
            "cancel",
            "cancel",
            "cancel",
            "hold",
        ]);
        expect(elementActions(hero, 0, 0, true)).toEqual([
            "cancel",
            "cancel",
            "cancel",
            "cancel",
        ]);
    });

    test("an emphasis-only element stays put and fires once on its step", () => {
        const caption: Cue[] = [{ kind: "emphasis", step: 2 }];
        expect(elementActions(caption, 1, 0, false)).toEqual(["idle"]);
        expect(elementActions(caption, 2, 1, false)).toEqual(["emphasis"]);
        expect(elementActions(caption, 3, 2, false)).toEqual(["idle"]);
        expect(elementActions(caption, 2, 3, false)).toEqual(["idle"]); // backward
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
