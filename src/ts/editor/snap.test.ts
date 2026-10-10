import { describe, expect, test } from "vitest";
import { distribute, snapBox, snapEdges, targetsFor } from "./snap";

const slide = { x: 0, y: 0, width: 1000, height: 500 };

describe("snapBox", () => {
    test("pulls a centre onto the slide centre", () => {
        const targets = targetsFor(slide, []);
        const r = snapBox(
            { x: 447, y: 10, width: 100, height: 50 },
            targets,
            6,
        );
        expect(r.dx).toBe(3);
        expect(r.guidesX).toEqual([500]);
    });

    test("leaves a box alone beyond the threshold", () => {
        const targets = targetsFor(slide, []);
        const r = snapBox(
            { x: 300, y: 100, width: 100, height: 50 },
            targets,
            6,
        );
        expect(r).toEqual({ dx: 0, dy: 0, guidesX: [], guidesY: [] });
    });

    test("aligns edges with other objects", () => {
        const targets = targetsFor(slide, [
            { x: 600, y: 300, width: 50, height: 50 },
        ]);
        const r = snapBox(
            { x: 598, y: 120, width: 30, height: 30 },
            targets,
            6,
        );
        expect(r.dx).toBe(2);
        expect(r.guidesX).toContain(600);
    });
});

test("snapEdges only moves the dragged edges", () => {
    const targets = targetsFor(slide, []);
    const r = snapEdges([996], [], targets, 6);
    expect(r.dx).toBe(4);
    expect(r.dy).toBe(0);
});

test("distribute spaces boxes evenly", () => {
    const xs = distribute(
        [
            { x: 0, y: 0, width: 10, height: 10 },
            { x: 15, y: 0, width: 10, height: 10 },
            { x: 90, y: 0, width: 10, height: 10 },
        ],
        "x",
    );
    expect(xs).toEqual([0, 45, 90]);
});
