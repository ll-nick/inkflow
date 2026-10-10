import { describe, expect, test } from "vitest";
import {
    bboxOf,
    eraserHits,
    finish,
    flatten,
    HIGHLIGHTER_OPACITY,
    type InputPoint,
    inkScale,
    insidePolygon,
    type LiveStroke,
    newInkId,
    outlineOf,
    pathData,
    polygonOf,
    simplify,
    strokeFrom,
    strokeOptions,
    styleFrom,
    unflatten,
} from "./ink";

const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
];

const line: InputPoint[] = Array.from({ length: 30 }, (_, i) => [
    100 + i * 10,
    200,
    0.5,
]);

const pen: LiveStroke = {
    id: "ink-abc",
    tool: "pen",
    fill: "#ff0000",
    token: "red",
    size: 8,
    simulate: true,
};

describe("pathData", () => {
    test("is a closed curve through the edge midpoints", () => {
        expect(pathData(square)).toBe(
            "M0 5Q0 0 5 0 10 0 10 5 10 10 5 10 0 10 0 5Z",
        );
    });

    test("rounds to the given decimals, with no negative zero", () => {
        const d = pathData(
            [
                [1.234, -0.0001],
                [2.2, 0],
            ],
            1,
        );
        expect(d).toBe("M1.7 0Q1.2 0 1.7 0 2.2 0 1.7 0Z");
        expect(d).not.toContain("-0");
    });

    test("an outline too short to be a shape draws nothing", () => {
        expect(pathData([[1, 1]])).toBe("");
    });
});

describe("polygonOf", () => {
    test("reads every coordinate pair of a stroke's path back", () => {
        const d = pathData(square);
        const poly = polygonOf(d);
        expect(poly.length).toBe(2 + 4 * 4);
        expect(poly.slice(0, 4)).toEqual([0, 5, 0, 0]);
        expect(bboxOf(poly)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    });

    test("reads exponents and negative numbers", () => {
        expect(polygonOf("M-1.5 2e1Q.5 -3 4 5Z")).toEqual([
            -1.5, 20, 0.5, -3, 4, 5,
        ]);
    });
});

describe("insidePolygon", () => {
    const flat = square.flat();

    test("inside and outside a simple shape", () => {
        expect(insidePolygon(flat, 5, 5)).toBe(true);
        expect(insidePolygon(flat, 15, 5)).toBe(false);
        expect(insidePolygon(flat, -1, 5)).toBe(false);
    });

    test("where a stroke crosses itself, the overlap is filled", () => {
        // Two laps around the same square, as a looping scribble makes.
        const twice = [...flat, ...flat];
        expect(insidePolygon(twice, 5, 5)).toBe(true);
    });
});

describe("eraserHits", () => {
    const stroke = polygonOf(pathData(outlineOf(line, pen, true, true)));
    const box = bboxOf(stroke);

    test("a sweep across a thin stroke hits it, even between samples", () => {
        expect(
            eraserHits(stroke, box, { x: 200, y: 100 }, { x: 200, y: 300 }, 2),
        ).toBe(true);
    });

    test("a sweep that passes within the radius hits", () => {
        expect(
            eraserHits(stroke, box, { x: 150, y: 220 }, { x: 250, y: 220 }, 20),
        ).toBe(true);
        expect(
            eraserHits(stroke, box, { x: 150, y: 220 }, { x: 250, y: 220 }, 5),
        ).toBe(false);
    });

    test("far away is a miss without looking at the outline", () => {
        expect(
            eraserHits(stroke, box, { x: 900, y: 900 }, { x: 950, y: 950 }, 10),
        ).toBe(false);
    });

    test("starting inside a wide stroke hits", () => {
        const wide = polygonOf(
            pathData(
                outlineOf(line, { tool: "highlighter", size: 60 }, false, true),
            ),
        );
        expect(
            eraserHits(
                wide,
                bboxOf(wide),
                { x: 300, y: 200 },
                { x: 300, y: 200 },
                1,
            ),
        ).toBe(true);
    });
});

describe("simplify", () => {
    test("drops points a straight edge does not need, keeps the corners", () => {
        const edge = [
            [0, 0],
            [1, 0.01],
            [2, 0],
            [3, -0.01],
            [4, 0],
            [4, 4],
        ];
        expect(simplify(edge, 0.1)).toEqual([
            [0, 0],
            [4, 0],
            [4, 4],
        ]);
    });

    test("keeps a point that strays further than the tolerance", () => {
        const bump = [
            [0, 0],
            [2, 1],
            [4, 0],
            [5, 5],
        ];
        expect(simplify(bump, 0.5)).toEqual(bump);
    });

    test("a finished stroke keeps its shape with fewer points", () => {
        const wavy: InputPoint[] = Array.from({ length: 200 }, (_, i) => [
            i * 3,
            40 * Math.sin(i / 15),
            0.5,
        ]);
        const outline = outlineOf(wavy, pen, true, true);
        const kept = simplify(outline, 0.1);
        expect(kept.length).toBeLessThan(outline.length);
        expect(kept[0]).toEqual(outline[0]);
        expect(kept[kept.length - 1]).toEqual(outline[outline.length - 1]);
    });
});

describe("strokes", () => {
    test("the highlighter keeps one width and flat ends", () => {
        const o = strokeOptions({ tool: "highlighter", size: 30 }, true, true);
        expect(o.thinning).toBe(0);
        expect(o.simulatePressure).toBe(false);
        expect(o.start?.cap).toBe(false);
        expect(strokeOptions(pen, false, true).thinning).toBeGreaterThan(0);
    });

    test("finishing a stroke gives its outline as path data", () => {
        const done = finish(pen, line);
        expect(done).toMatchObject({
            id: "ink-abc",
            fill: "#ff0000",
            token: "red",
            size: 8,
        });
        expect(done.d).toMatch(/^M[\d. ]+Q[\d. -]+Z$/);
        expect(done.opacity).toBeUndefined();
        const marker = finish({ ...pen, tool: "highlighter" }, line);
        expect(marker.opacity).toBe(HIGHLIGHTER_OPACITY);
    });

    test("a stroke id is unique and of the saved form", () => {
        const a = newInkId();
        expect(a).toMatch(/^ink-[a-z0-9]{12}$/);
        expect(newInkId()).not.toBe(a);
    });
});

describe("relayed strokes are checked", () => {
    const good = { ...finish(pen, line) };

    test("a well-formed stroke passes", () => {
        expect(strokeFrom(good)).toEqual(good);
        expect(styleFrom({ ...pen })).toMatchObject({ id: "ink-abc", size: 8 });
    });

    test.each([
        ["id", { id: "box" }],
        ["markup in the id", { id: 'ink-a"><script>' }],
        ["path", { d: "M0 0<script>" }],
        ["colour", { fill: "url(#x)" }],
        ["token", { token: "Red;}" }],
        ["tool", { tool: "laser" }],
        ["size", { size: -1 }],
        ["opacity", { opacity: 3 }],
    ])("a bad %s is refused", (_, bad) => {
        expect(strokeFrom({ ...good, ...bad })).toBeNull();
    });

    test("points travel flat and come back", () => {
        const pts: InputPoint[] = [
            [1.2345, 2.5, 0.33333],
            [3, 4, 1],
        ];
        expect(unflatten(flatten(pts))).toEqual([
            [1.23, 2.5, 0.333],
            [3, 4, 1],
        ]);
        expect(unflatten([1, 2])).toBeNull();
        expect(unflatten([1, 2, "x"])).toBeNull();
        expect(unflatten([1, 2, 5])).toEqual([[1, 2, 1]]);
    });
});

describe("inkScale", () => {
    test("is 1 on a 1920 x 1080 slide and follows its size", () => {
        expect(inkScale(1920, 1080)).toBe(1);
        expect(inkScale(960, 540)).toBe(0.5);
        expect(inkScale(1920)).toBe(1);
        expect(inkScale(0)).toBe(1);
    });

    test("uses the larger ratio, so a tall slide fitted to a screen matches", () => {
        // An A0 poster is shown fitted by its height.
        expect(inkScale(3179, 4494)).toBeCloseTo(4494 / 1080);
        // A phone-shaped slide likewise.
        expect(inkScale(1080, 1920)).toBeCloseTo(1920 / 1080);
    });
});
