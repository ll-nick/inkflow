import { expect, test } from "vitest";
import {
    gridRows,
    sectionPosition,
    sectionRuns,
    verticalNeighbor,
} from "./sections";

const A = { name: "Part", index: 0 };
const B = { name: "Part", index: 1 }; // same name, another section
const SLIDES = [{}, { section: A }, { section: A }, { section: B }, {}];

test("runs keep sections apart by index, not name", () => {
    expect(sectionRuns(SLIDES)).toEqual([
        { section: null, start: 0, end: 1 },
        { section: A, start: 1, end: 3 },
        { section: B, start: 3, end: 4 },
        { section: null, start: 4, end: 5 },
    ]);
    expect(sectionRuns([])).toEqual([]);
});

test("a slide's place in its section", () => {
    expect(sectionPosition(SLIDES, 2)).toEqual({ name: "Part", at: 2, of: 2 });
    expect(sectionPosition(SLIDES, 0)).toBeNull();
});

test("each section starts a row of its own", () => {
    const runs = sectionRuns(SLIDES);
    expect(gridRows(runs, 2)).toBe(4);
    expect(gridRows(sectionRuns([{}, {}, {}]), 2)).toBe(2);
});

test("up and down in a wrapped grid pick the nearest box of the next row", () => {
    // Two rows of three, then a section's single box on its own row.
    const boxes = [
        { left: 0, top: 0, width: 10 },
        { left: 20, top: 0, width: 10 },
        { left: 40, top: 0, width: 10 },
        { left: 0, top: 30, width: 10 },
        { left: 20, top: 30, width: 10 },
        { left: 0, top: 80, width: 10 },
    ];
    expect(verticalNeighbor(boxes, 2, 1)).toBe(4);
    expect(verticalNeighbor(boxes, 4, 1)).toBe(5);
    expect(verticalNeighbor(boxes, 5, -1)).toBe(3);
    expect(verticalNeighbor(boxes, 0, -1)).toBe(0);
});
