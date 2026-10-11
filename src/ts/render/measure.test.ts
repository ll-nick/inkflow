import { describe, expect, test } from "vitest";
import {
    type Box,
    disjoint,
    type Finding,
    isVector,
    mergeFindings,
    overhang,
    PRINT_DPI_HINT,
    PRINT_DPI_PROBLEM,
    printedDpi,
    significant,
    snippet,
    spansCanvas,
    unevenFits,
    union,
} from "./measure";

const canvas: Box = { left: 0, top: 0, right: 1920, bottom: 1080 };
const box = (
    left: number,
    top: number,
    right: number,
    bottom: number,
): Box => ({
    left,
    top,
    right,
    bottom,
});

describe("overhang / significant", () => {
    test("measures how far a box reaches past each side", () => {
        expect(overhang(box(-10, 100, 1960, 1200), canvas)).toEqual({
            top: 0,
            right: 40,
            bottom: 120,
            left: 10,
        });
    });

    test("a box inside reaches past nothing", () => {
        expect(significant(overhang(box(10, 10, 100, 100), canvas))).toBeNull();
    });

    test("drops rounding-sized overhangs and rounds the rest", () => {
        expect(
            significant({ top: 1.5, right: 40.4, bottom: 0, left: 0 }),
        ).toEqual({
            top: 0,
            right: 40,
            bottom: 0,
            left: 0,
        });
    });
});

describe("spansCanvas / disjoint", () => {
    test("a background or a full-width band spans the canvas", () => {
        expect(spansCanvas(box(0, 0, 1920, 1080), canvas)).toBe(true);
        expect(spansCanvas(box(-20, 500, 1940, 600), canvas)).toBe(true);
        expect(spansCanvas(box(1800, 500, 1960, 600), canvas)).toBe(false);
    });

    test("a box wholly past an edge is disjoint from the canvas", () => {
        expect(disjoint(box(2460, 260, 2540, 340), canvas)).toBe(true);
        expect(disjoint(box(1800, 260, 1960, 340), canvas)).toBe(false);
    });
});

test("union grows a box to cover another", () => {
    expect(union(null, box(1, 2, 3, 4))).toEqual(box(1, 2, 3, 4));
    expect(union(box(0, 0, 10, 10), box(5, -5, 20, 8))).toEqual(
        box(0, -5, 20, 10),
    );
});

describe("mergeFindings", () => {
    test("one finding per target and kind, the furthest reach per side", () => {
        const found: Finding[] = [
            {
                kind: "outside",
                target: "#g",
                entirely: true,
                top: 0,
                right: 40,
                bottom: 0,
                left: 0,
            },
            {
                kind: "outside",
                target: "#g",
                entirely: false,
                top: 0,
                right: 10,
                bottom: 5,
                left: 0,
            },
            {
                kind: "overflow",
                target: "#g",
                top: 0,
                right: 0,
                bottom: 9,
                left: 0,
            },
        ];
        expect(mergeFindings(found)).toEqual([
            {
                kind: "outside",
                target: "#g",
                entirely: false,
                top: 0,
                right: 40,
                bottom: 5,
                left: 0,
            },
            {
                kind: "overflow",
                target: "#g",
                top: 0,
                right: 0,
                bottom: 9,
                left: 0,
            },
        ]);
    });

    test("small text keeps its smallest size and sample", () => {
        const found: Finding[] = [
            {
                kind: "small-text",
                target: "#z",
                size: 12,
                min: 13.5,
                text: "a",
            },
            { kind: "small-text", target: "#z", size: 9, min: 13.5, text: "b" },
        ];
        expect(mergeFindings(found)).toEqual([
            { kind: "small-text", target: "#z", size: 9, min: 13.5, text: "b" },
        ]);
    });
});

test("snippet flattens whitespace and shortens", () => {
    expect(snippet("  a\n  b  ")).toBe("a b");
    expect(snippet("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
});

describe("print checks", () => {
    test("printed resolution: pixels over inches, as the picture is fitted", () => {
        // 3000 px across 10 inches: 300 dpi.
        expect(
            printedDpi({ w: 3000, h: 2000 }, { w: 10, h: 10 }, "contain"),
        ).toBe(300);
        // Covering the box, the picture is drawn larger: fewer dots per inch.
        expect(
            printedDpi({ w: 3000, h: 2000 }, { w: 10, h: 10 }, "cover"),
        ).toBe(200);
        // Stretched: the coarser direction counts.
        expect(printedDpi({ w: 3000, h: 2000 }, { w: 10, h: 10 }, "fill")).toBe(
            200,
        );
        expect(printedDpi({ w: 0, h: 0 }, { w: 1, h: 1 }, "contain")).toBe(
            Number.POSITIVE_INFINITY,
        );
        expect(PRINT_DPI_PROBLEM).toBeLessThan(PRINT_DPI_HINT);
    });

    test("vector pictures are never low resolution", () => {
        expect(isVector("figures/plot.svg")).toBe(true);
        expect(isVector("figures/plot.SVG?v=3")).toBe(true);
        expect(isVector("paper.pdf#page=2")).toBe(true);
        expect(isVector("data:image/svg+xml;base64,AAA")).toBe(true);
        expect(isVector("photo.png")).toBe(false);
        expect(isVector("photo.jpg?v=1")).toBe(false);
    });

    test("a picture used twice keeps its lowest resolution", () => {
        const found: Finding[] = [
            {
                kind: "low-res",
                target: "#p",
                dpi: 140,
                min: 150,
                problem: false,
                text: "a.png",
            },
            {
                kind: "low-res",
                target: "#p",
                dpi: 80,
                min: 150,
                problem: true,
                text: "a.png",
            },
        ];
        expect(mergeFindings(found)).toEqual([found[1]]);
    });
});

describe("unevenFits", () => {
    const left = { target: "#zone-left", box: box(80, 200, 920, 980) };
    const right = { target: "#zone-right", box: box(1000, 200, 1840, 980) };
    const title = { target: "#zone-title", box: box(80, 60, 1840, 160) };

    test("names the column shrunk further than the one beside it", () => {
        const found = unevenFits([
            { ...title, scale: 1 },
            { ...left, scale: 1 },
            { ...right, scale: 0.72 },
        ]);
        expect(found).toEqual([
            {
                kind: "uneven-fit",
                target: "#zone-right",
                size: 0.72,
                min: 1,
                text: "#zone-left",
            },
        ]);
    });

    test("lets columns of nearly the same size be", () => {
        expect(
            unevenFits([
                { ...left, scale: 0.95 },
                { ...right, scale: 0.9 },
            ]),
        ).toEqual([]);
        expect(
            unevenFits([
                { ...left, scale: 0.7 },
                { ...right, scale: 0.7 },
            ]),
        ).toEqual([]);
    });

    test("only compares boxes that stand side by side", () => {
        // A shrunk title above full-size text, a box of another height, one
        // box inside another: not columns.
        expect(
            unevenFits([
                { ...title, scale: 0.6 },
                { ...left, scale: 1 },
                {
                    target: "#zone-note",
                    box: box(1000, 200, 1840, 500),
                    scale: 0.5,
                },
                {
                    target: "#zone-inner",
                    box: box(100, 200, 500, 980),
                    scale: 0.5,
                },
            ]),
        ).toEqual([]);
    });

    test("compares each of three columns with the largest", () => {
        const found = unevenFits([
            { target: "#a", box: box(0, 0, 600, 800), scale: 1 },
            { target: "#b", box: box(640, 0, 1240, 800), scale: 0.8 },
            { target: "#c", box: box(1280, 0, 1880, 800), scale: 0.6 },
        ]);
        expect(
            found.map((f) => [f.target, f.kind === "uneven-fit" && f.text]),
        ).toEqual([
            ["#b", "#a"],
            ["#c", "#a"],
        ]);
    });
});
