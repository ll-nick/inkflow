import { describe, expect, it } from "vitest";
import {
    filterLabel,
    onlyStarred,
    starsOn,
    starTargets,
    starTitle,
} from "./starstext";

describe("starTargets", () => {
    it("is the slide being edited on the canvas", () => {
        expect(starTargets("canvas", new Set([3, 4]), 7)).toEqual([7]);
        expect(starTargets("sorter", new Set(), 7)).toEqual([7]);
    });

    it("is the picked slides in the list or the grid, in deck order", () => {
        expect(starTargets("sorter", new Set([9, 2, 5]), 7)).toEqual([2, 5, 9]);
    });
});

describe("starsOn", () => {
    const starred = new Set(["a", "b"]);

    it("stars when any of them is not starred yet", () => {
        expect(starsOn(["a", "c"], starred)).toBe(true);
        expect(starsOn(["c"], starred)).toBe(true);
        expect(starsOn([undefined], starred)).toBe(true);
    });

    it("takes the stars off when all of them are starred", () => {
        expect(starsOn(["a", "b"], starred)).toBe(false);
        expect(starsOn(["a"], starred)).toBe(false);
    });
});

describe("words", () => {
    it("names the key and counts the slides", () => {
        expect(starTitle(false)).toBe("Star this slide (S)");
        expect(starTitle(true)).toBe("Starred: take the star off (S)");
        expect(filterLabel(0)).toBe("Starred only (0)");
        expect(filterLabel(12)).toBe("Starred only (12)");
    });
});

describe("onlyStarred", () => {
    it("keeps the starred slides in their order", () => {
        const starred = new Set([4, 1]);
        expect(onlyStarred([0, 1, 2, 3, 4], (i) => starred.has(i))).toEqual([
            1, 4,
        ]);
        expect(onlyStarred([0, 2], (i) => starred.has(i))).toEqual([]);
    });
});
