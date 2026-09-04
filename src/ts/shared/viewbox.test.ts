import { describe, expect, test } from "vitest";
import { formatViewBox, parseViewBox } from "./viewbox";

describe("parseViewBox / formatViewBox", () => {
    test("round-trips a plain viewBox string", () => {
        expect(formatViewBox(parseViewBox("0 0 1920 1080"))).toBe(
            "0 0 1920 1080",
        );
    });

    test("accepts comma and whitespace separators", () => {
        expect(parseViewBox("10, 20, 300, 400")).toEqual({
            x: 10,
            y: 20,
            w: 300,
            h: 400,
        });
    });

    test("falls back on a missing or malformed value", () => {
        const base = { x: 0, y: 0, w: 1920, h: 1080 };
        expect(parseViewBox(null)).toEqual(base);
        expect(parseViewBox("nope")).toEqual(base);
        expect(parseViewBox("0 0 -5 0")).toEqual(base);
    });
});
