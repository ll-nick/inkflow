// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import {
    decomposeAffine,
    easeInOut,
    interpolateAffine,
    interpolateAttribute,
    interpolateColorAttribute,
    interpolateNumericAttribute,
    matrixScaleX,
    matrixScaleY,
    parseColorToRGB,
    recomposeAffine,
} from "./morph-math";

// ── helpers ──────────────────────────────────────────────────────────────────

function expectMatrixClose(a: DOMMatrix, b: DOMMatrix, digits = 4): void {
    for (const key of ["a", "b", "c", "d", "e", "f"] as const) {
        expect(a[key]).toBeCloseTo(b[key], digits);
    }
}

// ── easeInOut ────────────────────────────────────────────────────────────────

describe("easeInOut", () => {
    test("clamps at 0 and 1", () => {
        expect(easeInOut(0)).toBe(0);
        expect(easeInOut(1)).toBe(1);
    });

    test("midpoint is 0.5", () => {
        expect(easeInOut(0.5)).toBe(0.5);
    });

    test("first half is quadratic ease-in", () => {
        expect(easeInOut(0.25)).toBeCloseTo(0.125, 6);
    });

    test("second half mirrors first half", () => {
        expect(easeInOut(0.75)).toBeCloseTo(1 - easeInOut(0.25), 6);
    });

    test("is monotonically increasing", () => {
        for (let i = 0; i < 99; i++) {
            expect(easeInOut((i + 1) / 100)).toBeGreaterThan(
                easeInOut(i / 100),
            );
        }
    });
});

// ── parseColorToRGB ───────────────────────────────────────────────────────────

describe("parseColorToRGB", () => {
    test("parses 3-digit hex", () => {
        expect(parseColorToRGB("#fff")).toEqual([255, 255, 255]);
        expect(parseColorToRGB("#000")).toEqual([0, 0, 0]);
        expect(parseColorToRGB("#f00")).toEqual([255, 0, 0]);
    });

    test("parses 6-digit hex", () => {
        expect(parseColorToRGB("#89b4fa")).toEqual([137, 180, 250]);
        expect(parseColorToRGB("#1e1e2e")).toEqual([30, 30, 46]);
    });

    test("parses rgb() format", () => {
        expect(parseColorToRGB("rgb(137, 180, 250)")).toEqual([137, 180, 250]);
        expect(parseColorToRGB("rgb(0, 0, 0)")).toEqual([0, 0, 0]);
    });

    test("returns null for unparseable input", () => {
        expect(parseColorToRGB("hsl(200, 50%, 50%)")).toBeNull();
        expect(parseColorToRGB("red")).toBeNull();
        expect(parseColorToRGB("transparent")).toBeNull();
        expect(parseColorToRGB("")).toBeNull();
    });
});

// ── interpolateColorAttribute ─────────────────────────────────────────────────

describe("interpolateColorAttribute", () => {
    test("t=0 returns fromColor", () => {
        expect(interpolateColorAttribute("#000000", "#ffffff", 0)).toBe(
            "#000000",
        );
    });

    test("t=1 returns toColor", () => {
        expect(interpolateColorAttribute("#000000", "#ffffff", 1)).toBe(
            "#ffffff",
        );
    });

    test("t=0.5 returns midpoint", () => {
        expect(interpolateColorAttribute("#000000", "#ffffff", 0.5)).toBe(
            "#808080",
        );
    });

    test("interpolates individual channels", () => {
        expect(interpolateColorAttribute("#ff0000", "#0000ff", 0.5)).toBe(
            "#800080",
        );
    });

    test("unparseable colors snap at midpoint", () => {
        expect(interpolateColorAttribute("red", "blue", 0.3)).toBe("red");
        expect(interpolateColorAttribute("red", "blue", 0.7)).toBe("blue");
    });

    test("accepts rgb() format on either side", () => {
        const result = interpolateColorAttribute(
            "rgb(0, 0, 0)",
            "#ffffff",
            0.5,
        );
        expect(result).toBe("#808080");
    });
});

// ── interpolateNumericAttribute ───────────────────────────────────────────────

describe("interpolateNumericAttribute", () => {
    test("lerps between two values", () => {
        expect(Number(interpolateNumericAttribute("0", "1", 0.5))).toBeCloseTo(
            0.5,
            6,
        );
        expect(
            Number(interpolateNumericAttribute("0.2", "0.8", 0.25)),
        ).toBeCloseTo(0.35, 6);
    });

    test("t=0 returns fromValue", () => {
        expect(
            Number(interpolateNumericAttribute("0.3", "0.9", 0)),
        ).toBeCloseTo(0.3, 6);
    });

    test("t=1 returns toValue", () => {
        expect(
            Number(interpolateNumericAttribute("0.3", "0.9", 1)),
        ).toBeCloseTo(0.9, 6);
    });
});

// ── interpolateAttribute ──────────────────────────────────────────────────────

describe("interpolateAttribute", () => {
    test("fill uses color interpolation", () => {
        expect(interpolateAttribute("fill", "#000000", "#ffffff", 0.5)).toBe(
            "#808080",
        );
    });

    test("stroke uses color interpolation", () => {
        expect(interpolateAttribute("stroke", "#ff0000", "#0000ff", 0.5)).toBe(
            "#800080",
        );
    });

    test("opacity uses numeric interpolation", () => {
        expect(interpolateAttribute("opacity", "0", "1", 0.5)).toBe("0.5");
    });

    test("stroke-width uses numeric interpolation", () => {
        expect(interpolateAttribute("stroke-width", "2", "10", 0.5)).toBe("6");
    });
});

// ── decomposeAffine / recomposeAffine ─────────────────────────────────────────

describe("decomposeAffine / recomposeAffine", () => {
    const roundTrip = (m: DOMMatrix) => recomposeAffine(decomposeAffine(m));

    test("round-trips a pure translation", () => {
        const m = new DOMMatrix().translate(123, -45);
        expectMatrixClose(roundTrip(m), m);
    });

    test("round-trips a pure rotation", () => {
        const m = new DOMMatrix().rotate(37);
        expectMatrixClose(roundTrip(m), m);
    });

    test("round-trips a non-uniform scale", () => {
        const m = new DOMMatrix().scale(2.5, 0.4);
        expectMatrixClose(roundTrip(m), m);
    });

    test("round-trips a sheared matrix", () => {
        // skewX(tan=0.5) composed with a non-uniform scale: columns are neither
        // orthogonal nor equal length — the case the old oriented-box model lost.
        const m = new DOMMatrix([2, 0, 1, 3, 10, 20]);
        expectMatrixClose(roundTrip(m), m);
    });

    test("round-trips a reflection (negative determinant)", () => {
        const m = new DOMMatrix().scale(-1, 1).rotate(20);
        expect(m.a * m.d - m.b * m.c).toBeLessThan(0);
        expectMatrixClose(roundTrip(m), m);
    });

    test("round-trips a real Inkscape free-transform matrix", () => {
        // The demo's shape-bounce parent transform.
        const m = new DOMMatrix([
            2.5210029, 1.0935916, -0.02840859, 0.06548893, -2360.9011,
            -888.96294,
        ]);
        expectMatrixClose(roundTrip(m), m, 3);
    });
});

// ── interpolateAffine ─────────────────────────────────────────────────────────

describe("interpolateAffine", () => {
    const fromMatrix = new DOMMatrix().translate(100, 100).rotate(10).scale(1);
    const toMatrix = new DOMMatrix()
        .translate(400, 300)
        .rotate(-30)
        .scale(1.5, 0.6);
    const from = decomposeAffine(fromMatrix);
    const to = decomposeAffine(toMatrix);

    test("t=0 reproduces the from frame", () => {
        expectMatrixClose(interpolateAffine(from, to, 0), fromMatrix);
    });

    test("t=1 reproduces the to frame", () => {
        expectMatrixClose(interpolateAffine(from, to, 1), toMatrix);
    });

    test("t=0.5 translation is the midpoint", () => {
        const m = interpolateAffine(from, to, 0.5);
        expect(m.e).toBeCloseTo(250, 4); // (100 + 400) / 2
        expect(m.f).toBeCloseTo(200, 4); // (100 + 300) / 2
    });

    test("rotation interpolates along the shorter arc (170° → 190°, not via 0°)", () => {
        const a = decomposeAffine(new DOMMatrix().rotate(170));
        const b = decomposeAffine(new DOMMatrix().rotate(-170)); // 190°
        const mid = interpolateAffine(a, b, 0.5);
        // Shorter arc passes through 180° (a = cos180 = -1), not 0° (a = 1).
        expect(mid.a).toBeCloseTo(-1, 4);
        expect(mid.b).toBeCloseTo(0, 4);
    });
});

// ── matrixScaleX / matrixScaleY ───────────────────────────────────────────────

describe("matrixScaleX / matrixScaleY", () => {
    test("reads a non-uniform scale", () => {
        const m = new DOMMatrix().scale(3, 7);
        expect(matrixScaleX(m)).toBeCloseTo(3, 6);
        expect(matrixScaleY(m)).toBeCloseTo(7, 6);
    });

    test("is rotation-invariant", () => {
        const m = new DOMMatrix().rotate(50).scale(3, 7);
        expect(matrixScaleX(m)).toBeCloseTo(3, 6);
        expect(matrixScaleY(m)).toBeCloseTo(7, 6);
    });

    test("scaleY removes shear (orthogonal component only)", () => {
        // Column 2 is (1,3) with length √10 ≈ 3.16, but the shear-free y-scale is
        // |det| / scaleX = 6 / 2 = 3.
        const m = new DOMMatrix([2, 0, 1, 3, 0, 0]);
        expect(matrixScaleX(m)).toBeCloseTo(2, 6);
        expect(matrixScaleY(m)).toBeCloseTo(3, 6);
    });
});
