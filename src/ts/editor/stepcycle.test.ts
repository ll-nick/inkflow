import { describe, expect, it } from "vitest";
import { nextStep, stepLabel, stepTitle, wrapped } from "./stepcycle";

describe("nextStep", () => {
    it("cycles from everything through every step and back", () => {
        const seen: (number | null)[] = [];
        let s: number | null = null;
        for (let i = 0; i < 5; i++) {
            s = nextStep(s, 3);
            seen.push(s);
        }
        expect(seen).toEqual([0, 1, 2, 3, null]);
    });

    it("goes the other way round backwards", () => {
        expect(nextStep(null, 3, true)).toBe(3);
        expect(nextStep(1, 3, true)).toBe(0);
        expect(nextStep(0, 3, true)).toBeNull();
    });

    it("stays on everything when nothing is stepped", () => {
        expect(nextStep(null, 0)).toBeNull();
        expect(nextStep(2, 0)).toBeNull();
    });

    it("clamps a step beyond a slide that lost clicks", () => {
        expect(nextStep(5, 2)).toBeNull();
        expect(nextStep(5, 2, true)).toBe(1);
    });
});

describe("words", () => {
    it("labels the state", () => {
        expect(stepLabel(null, 3)).toBe("Steps");
        expect(stepLabel(2, 3)).toBe("Step 2/3");
        expect(stepLabel(7, 3)).toBe("Step 3/3");
    });

    it("explains where the preview is", () => {
        expect(stepTitle(null, 2)).toContain("Every object is shown");
        expect(stepTitle(0, 2)).toContain("before the first click");
        expect(stepTitle(2, 2)).toContain("after click 2 of 2");
        expect(stepTitle(null, 0)).toContain("Nothing");
    });

    it("knows when it came round", () => {
        expect(wrapped(3, null)).toBe(true);
        expect(wrapped(null, 0)).toBe(false);
        expect(wrapped(1, 2)).toBe(false);
    });
});
