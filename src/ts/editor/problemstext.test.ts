import { describe, expect, it } from "vitest";
import {
    countMarked,
    layoutWords,
    marked,
    type Problem,
    problemTitle,
    slidesWithProblems,
    worst,
} from "./problemstext";

const err: Problem = {
    level: "error",
    message: "zone-nope is not on the slide",
    source: "verify",
    kind: "",
};
const warn: Problem = {
    level: "warn",
    message: "text overflows its zone",
    source: "layout",
    kind: "overflow",
};
const hint: Problem = {
    level: "hint",
    message: "text 12px tall",
    source: "layout",
    kind: "small-text",
};

describe("problems", () => {
    it("rank a slide by its worst one", () => {
        expect(worst([hint, warn])).toBe("warn");
        expect(worst([hint, err, warn])).toBe("error");
        expect(worst([hint])).toBe("hint");
        expect(worst([])).toBeNull();
        expect(worst(undefined)).toBeNull();
    });

    it("mark errors and warnings, list hints too when asked", () => {
        expect(marked([hint, warn])).toEqual([warn]);
        expect(countMarked([[err, hint], [hint], [warn]])).toBe(2);
        expect(slidesWithProblems([[hint], [], [warn]], false)).toEqual([2]);
        expect(slidesWithProblems([[hint], [], [warn]], true)).toEqual([0, 2]);
        expect(problemTitle([err, hint])).toBe(
            "● zone-nope is not on the slide",
        );
        expect(problemTitle([hint])).toBe("");
    });

    it("say how the layout check stands", () => {
        const state = {
            on: false,
            contrast: false,
            running: false,
            error: null,
        };
        expect(layoutWords(state)).toContain("turn it on");
        expect(layoutWords({ ...state, on: true })).toBe(
            "The layout is checked after every change (contrast is not).",
        );
        expect(layoutWords({ ...state, on: true, contrast: true })).toBe(
            "Layout and contrast are checked after every change.",
        );
        expect(layoutWords({ ...state, running: true })).toBe(
            "Checking the layout…",
        );
        expect(layoutWords({ ...state, error: "no Chromium" })).toBe(
            "The layout check failed: no Chromium",
        );
    });
});
