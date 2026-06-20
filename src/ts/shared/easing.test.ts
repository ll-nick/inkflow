import { describe, expect, test } from "vitest";
import { cubicBezierEasing } from "./easing";

describe("cubicBezierEasing", () => {
    test("pins the endpoints for every curve", () => {
        for (const spec of [
            "linear",
            "ease",
            "ease-in-out",
            "cubic-bezier(0.3,0,0.7,1)",
        ]) {
            const ease = cubicBezierEasing(spec);
            expect(ease(0)).toBe(0);
            expect(ease(1)).toBe(1);
        }
    });

    test("linear and identity fallbacks are the identity function", () => {
        for (const spec of [
            "linear",
            undefined,
            "not-a-real-easing",
            "steps(4)",
        ]) {
            const ease = cubicBezierEasing(spec);
            expect(ease(0.37)).toBeCloseTo(0.37, 6);
        }
    });

    test("ease-in-out is symmetric: midpoint maps to 0.5", () => {
        const ease = cubicBezierEasing("ease-in-out");
        expect(ease(0.5)).toBeCloseTo(0.5, 4);
    });

    test("ease-in starts slow (below the diagonal early on)", () => {
        const ease = cubicBezierEasing("ease-in");
        expect(ease(0.25)).toBeLessThan(0.25);
        expect(ease(0.75)).toBeLessThan(0.75);
    });

    test("parses explicit cubic-bezier control points", () => {
        // A curve biased toward fast-start should sit above the diagonal early.
        const ease = cubicBezierEasing("cubic-bezier(0, 0.8, 0.2, 1)");
        expect(ease(0.25)).toBeGreaterThan(0.25);
    });
});
