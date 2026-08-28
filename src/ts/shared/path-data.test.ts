// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import type { Segment } from "./path-data";
import {
    areCompatible,
    interpolateSegments,
    parsePathData,
    serializePathData,
    transformSegments,
} from "./path-data";

// Compact spelling for expectations: "C 1 2 3 4 5 6" reads like the `d` it came from.
function spell(segments: Segment[] | null): string[] {
    if (!segments) throw new Error("expected segments, got null");
    return segments.map((segment) =>
        `${segment.type} ${segment.points
            .map((p) => `${+p.x.toFixed(4)} ${+p.y.toFixed(4)}`)
            .join(" ")}`.trim(),
    );
}

describe("parsePathData", () => {
    test("absolute moveto and lineto", () => {
        expect(spell(parsePathData("M 10 20 L 30 40"))).toEqual([
            "M 10 20",
            "L 30 40",
        ]);
    });

    test("relative commands resolve against the current point", () => {
        expect(spell(parsePathData("m 10 20 l 5 5 l 5 5"))).toEqual([
            "M 10 20",
            "L 15 25",
            "L 20 30",
        ]);
    });

    test("every coordinate in one relative command shares the same origin", () => {
        // Not chained: c1, c2 and the endpoint are all relative to the start point.
        expect(spell(parsePathData("M 0 0 c 1 1 2 2 3 3"))).toEqual([
            "M 0 0",
            "C 1 1 2 2 3 3",
        ]);
    });

    test("H and V become linetos, which is what makes a straight arrow morphable", () => {
        expect(spell(parsePathData("M 100 50 H 300"))).toEqual([
            "M 100 50",
            "L 300 50",
        ]);
        expect(spell(parsePathData("M 100 50 v 25"))).toEqual([
            "M 100 50",
            "L 100 75",
        ]);
    });

    test("extra coordinate pairs after a moveto are implicit linetos", () => {
        expect(spell(parsePathData("M 0 0 10 10 20 20"))).toEqual([
            "M 0 0",
            "L 10 10",
            "L 20 20",
        ]);
        expect(spell(parsePathData("m 0 0 10 10"))).toEqual([
            "M 0 0",
            "L 10 10",
        ]);
    });

    test("a repeated command letter may be omitted", () => {
        expect(spell(parsePathData("M 0 0 L 1 1 2 2"))).toEqual([
            "M 0 0",
            "L 1 1",
            "L 2 2",
        ]);
    });

    test("S reflects the previous cubic's second control", () => {
        // Previous c2 is (3,3) about the point (4,4), so the mirrored control is (5,5).
        expect(spell(parsePathData("M 0 0 C 1 1 3 3 4 4 S 8 8 9 9"))).toEqual([
            "M 0 0",
            "C 1 1 3 3 4 4",
            "C 5 5 8 8 9 9",
        ]);
    });

    test("S with no preceding cubic uses the current point", () => {
        expect(spell(parsePathData("M 2 2 S 8 8 9 9"))).toEqual([
            "M 2 2",
            "C 2 2 8 8 9 9",
        ]);
    });

    test("a quadratic is elevated to the exact equivalent cubic", () => {
        // Controls sit two thirds of the way from each endpoint toward (3,0).
        expect(spell(parsePathData("M 0 0 Q 3 0 6 0"))).toEqual([
            "M 0 0",
            "C 2 0 4 0 6 0",
        ]);
    });

    test("T reflects the previous quadratic control, not the elevated cubic one", () => {
        const segments = parsePathData("M 0 0 Q 3 0 6 0 T 12 0");
        // Mirroring (3,0) about (6,0) gives (9,0), elevated to controls at 8 and 10.
        expect(spell(segments)).toEqual([
            "M 0 0",
            "C 2 0 4 0 6 0",
            "C 8 0 10 0 12 0",
        ]);
    });

    test("Z returns the current point to the subpath start", () => {
        expect(spell(parsePathData("M 5 5 L 9 9 Z l 1 1"))).toEqual([
            "M 5 5",
            "L 9 9",
            "Z",
            "L 6 6",
        ]);
    });

    describe("loose number syntax", () => {
        test("omitted separators, leading dots and exponents", () => {
            expect(spell(parsePathData("M-1.5.5L1e2 2"))).toEqual([
                "M -1.5 0.5",
                "L 100 2",
            ]);
        });

        test("a trailing decimal point", () => {
            expect(spell(parsePathData("M 1. 2."))).toEqual(["M 1 2"]);
        });
    });

    describe("returns null rather than throwing", () => {
        test.each([
            ["an arc", "M 0 0 A 5 5 0 0 1 10 10"],
            ["a truncated command", "M 0 0 C 1 1 2 2"],
            ["coordinates before any command", "10 20 L 30 40"],
            ["a stray character", "M 0 0 L 10 x 20"],
            ["arguments after Z", "M 0 0 Z 5 5"],
            ["an empty string", ""],
            ["whitespace only", "   "],
        ])("%s", (_label, d) => {
            expect(parsePathData(d)).toBeNull();
        });
    });
});

describe("transformSegments", () => {
    test("applies the matrix to every coordinate", () => {
        const segments = parsePathData("M 1 2 C 3 4 5 6 7 8");
        if (!segments) throw new Error("unreachable");
        // Scale by 2, then translate by (10, 20).
        const moved = transformSegments(segments, {
            a: 2,
            b: 0,
            c: 0,
            d: 2,
            e: 10,
            f: 20,
        });

        expect(spell(moved)).toEqual(["M 12 24", "C 16 28 20 32 24 36"]);
    });

    test("survives rotation, which H and V could not have", () => {
        const segments = parsePathData("M 0 0 H 10");
        if (!segments) throw new Error("unreachable");
        // Quarter turn: (10, 0) lands on (0, 10).
        const rotated = transformSegments(segments, {
            a: 0,
            b: 1,
            c: -1,
            d: 0,
            e: 0,
            f: 0,
        });

        expect(spell(rotated)).toEqual(["M 0 0", "L 0 10"]);
    });
});

describe("areCompatible", () => {
    const parse = (d: string) => parsePathData(d) as Segment[];

    test("a path authored with H pairs with one authored with L", () => {
        expect(areCompatible(parse("M 0 0 H 10"), parse("M 5 5 L 20 5"))).toBe(
            true,
        );
    });

    test("a quadratic pairs with a cubic once both are elevated", () => {
        expect(
            areCompatible(
                parse("M 0 0 Q 3 0 6 0"),
                parse("M 0 0 C 1 1 2 2 3 3"),
            ),
        ).toBe(true);
    });

    test("different segment counts do not pair", () => {
        expect(
            areCompatible(
                parse("M 0 0 C 1 1 2 2 3 3"),
                parse("M 0 0 C 1 1 2 2 3 3 C 4 4 5 5 6 6"),
            ),
        ).toBe(false);
    });

    test("a lineto does not pair with a curve", () => {
        expect(
            areCompatible(parse("M 0 0 L 10 10"), parse("M 0 0 C 1 1 2 2 3 3")),
        ).toBe(false);
    });
});

describe("interpolateSegments", () => {
    const from = parsePathData("M 0 0 L 10 0") as Segment[];
    const to = parsePathData("M 100 100 L 200 100") as Segment[];

    test("t=0 is the source", () => {
        expect(spell(interpolateSegments(from, to, 0))).toEqual([
            "M 0 0",
            "L 10 0",
        ]);
    });

    test("t=1 is the target", () => {
        expect(spell(interpolateSegments(from, to, 1))).toEqual([
            "M 100 100",
            "L 200 100",
        ]);
    });

    test("t=0.5 is halfway", () => {
        expect(spell(interpolateSegments(from, to, 0.5))).toEqual([
            "M 50 50",
            "L 105 50",
        ]);
    });
});

describe("serializePathData", () => {
    test("round trips through the parser", () => {
        const d = "M 10 20 C 30 40 50 60 70 80 Z";
        const segments = parsePathData(d) as Segment[];

        expect(serializePathData(segments)).toBe(d);
    });

    test("rounds to keep the per-frame string short", () => {
        const segments = parsePathData("M 1.23456789 2.5") as Segment[];

        expect(serializePathData(segments)).toBe("M 1.235 2.5");
    });
});

describe("real slide data", () => {
    // Arrows from the deck these bugs were found in, each authored differently on the
    // two slides (relative vs absolute, H vs L).
    const STRAIGHT_ARROW = {
        from: "M 984.9084965,539.7787418 H 1169.23435",
        to: "m 206.0778897,545.4823746 h 184.325853",
    };
    const CURVED_ARROW = {
        from: "m 323.9228045,867.2925538 c 18.7373883,-88.7556481 47.0509154,-133.5200697 73.9057002,-164.5258242",
        to: "M 247.3438321,916.7258088 C 245.1956824,833.6569537 333.7386295,657.8656989 393.8951023,613.5053872",
    };

    test.each([
        ["a straight arrow", STRAIGHT_ARROW],
        ["a curved arrow", CURVED_ARROW],
    ])("%s interpolates across the two slides", (_label, { from, to }) => {
        const parsedFrom = parsePathData(from);
        const parsedTo = parsePathData(to);
        if (!parsedFrom || !parsedTo) throw new Error("expected both to parse");

        expect(areCompatible(parsedFrom, parsedTo)).toBe(true);
        // Halfway is a real intermediate shape, not either endpoint.
        const half = serializePathData(
            interpolateSegments(parsedFrom, parsedTo, 0.5),
        );
        expect(half).not.toBe(serializePathData(parsedFrom));
        expect(half).not.toBe(serializePathData(parsedTo));
    });

    test("a one-cubic path does not pair with a three-cubic one", () => {
        const one = parsePathData("M 260 500 C 420 380 560 620 720 500");
        const three = parsePathData(
            "M 260 820 C 340 700 420 940 500 820 C 560 720 620 920 700 820 C 760 740 820 900 900 820",
        );
        if (!one || !three) throw new Error("expected both to parse");

        expect(areCompatible(one, three)).toBe(false);
    });
});
