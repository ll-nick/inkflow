import { describe, expect, test } from "vitest";
import { positionHref, readPosition } from "./deck-url";

const HTTP = "http://localhost:7777/index.html";
const FILE = "file:///tmp/build/index.html";

function href(from: string, slideIndex: number, step = 0): string {
    return positionHref(new URL(from), slideIndex, step);
}

function read(from: string, slideCount = 10) {
    return readPosition(new URL(from), slideCount);
}

describe("positionHref", () => {
    test("names the position in the fragment, whatever the scheme", () => {
        expect(href(HTTP, 6)).toBe(`${HTTP}#slide=7`);
        expect(href(FILE, 6)).toBe(`${FILE}#slide=7`);
    });

    test("carries a non-zero step and drops it at zero", () => {
        expect(href(HTTP, 6, 2)).toBe(`${HTTP}#slide=7&steps=2`);
        expect(href(`${HTTP}#slide=7&steps=2`, 6)).toBe(`${HTTP}#slide=7`);
    });

    test("replaces a fragment it wrote before rather than appending", () => {
        expect(href(`${FILE}#slide=7&steps=2`, 7)).toBe(`${FILE}#slide=8`);
    });

    test("leaves the path and query alone", () => {
        // Nothing routes a path segment on a static host, so the deck writes
        // only the fragment and lets the rest of the URL stand.
        expect(href("http://localhost:7777/deck/?pv=1", 7)).toBe(
            "http://localhost:7777/deck/?pv=1#slide=8",
        );
    });
});

describe("readPosition", () => {
    test("reads the fragment", () => {
        expect(read(`${HTTP}#slide=7&steps=2`)).toEqual({
            slideIndex: 6,
            step: 2,
        });
        expect(read(`${FILE}#slide=7&steps=2`)).toEqual({
            slideIndex: 6,
            step: 2,
        });
    });

    test("ignores a position outside the fragment", () => {
        // The path and the query are the deck's to leave alone, not to read.
        expect(read("http://localhost:7777/7?steps=2")).toEqual({
            slideIndex: null,
            step: 0,
        });
    });

    test("reports no slide when the URL names none", () => {
        expect(read(HTTP).slideIndex).toBeNull();
        expect(read(FILE).slideIndex).toBeNull();
        expect(read("http://localhost:7777/").slideIndex).toBeNull();
    });

    test("reports no slide when the number is outside the deck", () => {
        expect(read(`${FILE}#slide=11`, 10).slideIndex).toBeNull();
        expect(read(`${FILE}#slide=0`, 10).slideIndex).toBeNull();
    });

    test("falls back to step zero for a missing or malformed step", () => {
        expect(read(`${FILE}#slide=7`).step).toBe(0);
        expect(read(`${FILE}#slide=7&steps=nope`).step).toBe(0);
        expect(read(`${FILE}#slide=7&steps=-1`).step).toBe(0);
    });

    test("round-trips a position through the href it produces", () => {
        for (const base of [HTTP, FILE]) {
            expect(read(href(base, 4, 3))).toEqual({ slideIndex: 4, step: 3 });
        }
    });
});
