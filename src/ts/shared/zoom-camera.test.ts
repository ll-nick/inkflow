import { describe, expect, test } from "vitest";
import type { ViewBox } from "./viewbox";
import {
    clampToBounds,
    isZoomedIn,
    lerpViewBox,
    panBy,
    scaleOf,
    zoomAt,
} from "./zoom-camera";

const BASE: ViewBox = { x: 0, y: 0, w: 1920, h: 1080 };
const LIMITS = { minScale: 1, maxScale: 8 };
const CENTER = { ux: 960, uy: 540 };

describe("zoomAt", () => {
    test("zooming in at the centre halves the box and doubles the scale", () => {
        const next = zoomAt(BASE, BASE, 2, CENTER, LIMITS);
        expect(next).toEqual({ x: 480, y: 270, w: 960, h: 540 });
        expect(scaleOf(next, BASE)).toBe(2);
        expect(isZoomedIn(next, BASE)).toBe(true);
    });

    test("zooming at a corner keeps that corner fixed", () => {
        const next = zoomAt(BASE, BASE, 2, { ux: 0, uy: 0 }, LIMITS);
        expect(next).toEqual({ x: 0, y: 0, w: 960, h: 540 });
    });

    test("zooming out past minScale clamps back to the full base", () => {
        const zoomed = { x: 480, y: 270, w: 960, h: 540 };
        const next = zoomAt(zoomed, BASE, 0.1, CENTER, LIMITS);
        expect(next).toEqual(BASE);
        expect(isZoomedIn(next, BASE)).toBe(false);
    });

    test("zooming in past maxScale clamps to the tightest allowed box", () => {
        const next = zoomAt(BASE, BASE, 1000, CENTER, LIMITS);
        expect(scaleOf(next, BASE)).toBe(8);
        expect(next.w).toBe(1920 / 8);
    });
});

describe("panBy", () => {
    test("translates within the canvas", () => {
        const start = { x: 480, y: 270, w: 960, h: 540 };
        expect(panBy(start, BASE, -100, 50)).toEqual({
            x: 380,
            y: 320,
            w: 960,
            h: 540,
        });
    });

    test("clamps at every edge", () => {
        const start = { x: 480, y: 270, w: 960, h: 540 };
        expect(panBy(start, BASE, -10000, 0).x).toBe(0);
        expect(panBy(start, BASE, 10000, 0).x).toBe(960);
        expect(panBy(start, BASE, 0, -10000).y).toBe(0);
        expect(panBy(start, BASE, 0, 10000).y).toBe(540);
    });

    test("a full-size box stays centred", () => {
        expect(panBy(BASE, BASE, 500, 500)).toEqual(BASE);
    });
});

describe("clampToBounds", () => {
    test("shrinks an oversized box and recentres it", () => {
        expect(
            clampToBounds({ x: -50, y: -50, w: 4000, h: 3000 }, BASE),
        ).toEqual(BASE);
    });
});

describe("lerpViewBox", () => {
    const zoomed = { x: 480, y: 270, w: 960, h: 540 };

    test("returns the endpoints at t = 0 and t = 1", () => {
        expect(lerpViewBox(BASE, zoomed, 0)).toEqual(BASE);
        expect(lerpViewBox(BASE, zoomed, 1)).toEqual(zoomed);
    });

    test("blends each field at the midpoint", () => {
        expect(lerpViewBox(BASE, zoomed, 0.5)).toEqual({
            x: 240,
            y: 135,
            w: 1440,
            h: 810,
        });
    });
});
