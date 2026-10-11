import { describe, expect, test } from "vitest";
import {
    FIT_FLOOR,
    floorScale,
    formatTextSize,
    MIN_TEXT_FRACTION,
    neededHeight,
    nextTextSize,
    parseTextSize,
    searchScale,
    TEXT_SIZE_STEPS,
} from "./fit";

// A box `room` tall holding text that needs `need` at its own size: text
// height is proportional to the scale (a stand-in for the browser's layout).
const box =
    (need: number, room: number, calls: number[] = []) =>
    (scale: number) => {
        calls.push(scale);
        return need * scale <= room;
    };

describe("searchScale", () => {
    test("text that fits stays at its size, measured once", () => {
        const calls: number[] = [];
        expect(searchScale(box(300, 400, calls), 0.33)).toEqual({
            scale: 1,
            overflow: false,
        });
        expect(calls).toEqual([1]);
    });

    test("converges on the largest size that fits, to 1 %", () => {
        const calls: number[] = [];
        const result = searchScale(box(1000, 600, calls), 0.33);
        expect(result.overflow).toBe(false);
        expect(result.scale).toBeLessThanOrEqual(0.6);
        expect(result.scale).toBeGreaterThan(0.59);
        expect(box(1000, 600)(result.scale)).toBe(true);
        // A bisection: a handful of measurements, not a scan.
        expect(calls.length).toBeLessThan(10);
    });

    test("stays at the floor and says it overflows", () => {
        expect(searchScale(box(1000, 200), 0.33)).toEqual({
            scale: 0.33,
            overflow: true,
        });
    });

    test("a floor at or above 1 never shrinks", () => {
        expect(searchScale(box(1000, 600), 1)).toEqual({
            scale: 1,
            overflow: true,
        });
    });

    test("never goes below the floor while searching", () => {
        const calls: number[] = [];
        searchScale(box(1000, 500, calls), 0.45);
        expect(Math.min(...calls)).toBeGreaterThanOrEqual(0.45);
    });
});

describe("floorScale", () => {
    test("a third of the box's own size on a large text", () => {
        // 1080-high screen: readable from 13.5; a 72-unit heading may go to 24.
        const min = 1080 * MIN_TEXT_FRACTION;
        expect(floorScale(72, min)).toBe(FIT_FLOOR);
    });

    test("the readable minimum when that is larger", () => {
        const min = 1080 * MIN_TEXT_FRACTION;
        expect(floorScale(36, min)).toBeCloseTo(13.5 / 36);
    });

    test("the print rule's minimum (a slide's data-inkflow-min-text)", () => {
        // A0 poster: 18 pt readable, here 24 units per the sheet.
        expect(floorScale(40, 24)).toBeCloseTo(0.6);
    });

    test("text already below the minimum is not shrunk at all", () => {
        expect(floorScale(10, 13.5)).toBe(1);
        expect(floorScale(0, 13.5)).toBe(1);
    });
});

describe("neededHeight", () => {
    test("counts every laid-out child, steps not reached yet included", () => {
        // A reveal not shown yet is transparent, not removed: still laid out.
        const kids = [
            { height: 100, marginTop: 0, marginBottom: 10, inFlow: true },
            { height: 50, marginTop: 5, marginBottom: 0, inFlow: true },
        ];
        expect(neededHeight(kids)).toBe(165);
    });

    test("leaves out what takes no room in the column", () => {
        const kids = [
            { height: 100, marginTop: 0, marginBottom: 0, inFlow: true },
            { height: 80, marginTop: 0, marginBottom: 0, inFlow: false },
        ];
        expect(neededHeight(kids)).toBe(100);
    });
});

describe("text size steps", () => {
    test("A+ and A− walk the steps", () => {
        expect(nextTextSize(1, 1)).toBe(1.15);
        expect(nextTextSize(1, -1)).toBe(0.9);
        expect(nextTextSize(0.67, -1)).toBe(0.5);
    });

    test("a size between steps moves to the neighbouring one", () => {
        expect(nextTextSize(0.75, 1)).toBe(0.8);
        expect(nextTextSize(0.75, -1)).toBe(0.67);
        expect(nextTextSize(2.5, -1)).toBe(2);
    });

    test("the ends stay", () => {
        expect(nextTextSize(TEXT_SIZE_STEPS[0], -1)).toBe(0.5);
        expect(nextTextSize(2, 1)).toBe(2);
        expect(nextTextSize(0.3, -1)).toBe(0.3);
    });

    test("typed sizes are percentages", () => {
        expect(parseTextSize("80")).toBe(0.8);
        expect(parseTextSize("80%")).toBe(0.8);
        expect(parseTextSize(" 125 % ")).toBe(1.25);
        expect(parseTextSize("300")).toBe(3);
        expect(parseTextSize("24")).toBeNull();
        expect(parseTextSize("301")).toBeNull();
        expect(parseTextSize("big")).toBeNull();
        expect(parseTextSize("")).toBeNull();
    });

    test("shown as whole percentages", () => {
        expect(formatTextSize(0.8)).toBe("80%");
        expect(formatTextSize(0.667)).toBe("67%");
    });
});
