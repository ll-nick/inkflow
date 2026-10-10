import { describe, expect, test } from "vitest";
import {
    dropOnHeader,
    dropOnSlide,
    moveRequest,
    sectionBlocks,
    sectionGapAtSlide,
    sectionKeys,
    sectionMoveTo,
    sectionOf,
    sectionSlides,
    sorterRows,
} from "./sections";
import type { SectionInfo } from "./types";

// Slides 0-1 unsectioned, Method = 2-4, Empty = none, End = 5.
const SECTIONS: SectionInfo[] = [
    { name: "Method", start: 2, count: 3 },
    { name: "Empty", start: 5, count: 0 },
    { name: "End", start: 5, count: 1 },
];
const N = 6;

describe("ranges", () => {
    test("each slide's section", () => {
        expect([0, 1, 2, 4, 5].map((i) => sectionOf(SECTIONS, i))).toEqual([
            null,
            null,
            0,
            0,
            2,
        ]);
        expect(sectionSlides(SECTIONS, 0)).toEqual([2, 3, 4]);
        expect(sectionSlides(SECTIONS, 1)).toEqual([]);
    });

    test("the slide list puts a header above each section", () => {
        const rows = sorterRows(N, SECTIONS, (k) => k === 0);
        expect(
            rows.map((r) =>
                r.kind === "header" ? `h${r.section}` : String(r.index),
            ),
        ).toEqual(["0", "1", "h0", "h1", "h2", "5"]);
    });

    test("the grid has a block per section, unsectioned slides first", () => {
        expect(sectionBlocks(N, SECTIONS)).toEqual([
            { section: null, slides: [0, 1] },
            { section: 0, slides: [2, 3, 4] },
            { section: 1, slides: [] },
            { section: 2, slides: [5] },
        ]);
        const all = [{ name: "All", start: 0, count: 2 }];
        expect(sectionBlocks(2, all)).toEqual([{ section: 0, slides: [0, 1] }]);
        expect(sectionBlocks(2, [])).toEqual([
            { section: null, slides: [0, 1] },
        ]);
    });

    test("collapse keys survive a move and tell equal names apart", () => {
        expect(
            sectionKeys([
                { name: "Part", start: 0, count: 1 },
                { name: "Part", start: 1, count: 1 },
                { name: "End", start: 2, count: 1 },
            ]),
        ).toEqual(["Part", "Part#2", "End"]);
    });
});

describe("dropping slides", () => {
    test("before or after a slide: into that slide's section", () => {
        expect(dropOnSlide(SECTIONS, 4, true)).toEqual({
            insertAt: 5,
            section: 0,
        });
        // The same gap, seen from the next section's first slide.
        expect(dropOnSlide(SECTIONS, 5, false)).toEqual({
            insertAt: 5,
            section: 2,
        });
        expect(dropOnHeader(SECTIONS, 1)).toEqual({ insertAt: 5, section: 1 });
    });

    test("the move request counts the list without the moved slides", () => {
        expect(moveRequest(SECTIONS, [0], 5, 0)).toEqual({
            slides: [0],
            to: 4,
            section: 0,
        });
        expect(moveRequest(SECTIONS, [5, 0], 3, 0)).toEqual({
            slides: [0, 5],
            to: 2,
            section: 0,
        });
    });

    test("dropping a slide where it already is changes nothing", () => {
        expect(moveRequest(SECTIONS, [3], 3, 0)).toBeNull();
        expect(moveRequest(SECTIONS, [3], 4, 0)).toBeNull();
        expect(moveRequest(SECTIONS, [2, 3], 2, 0)).toBeNull();
        expect(moveRequest(SECTIONS, [], 2, 0)).toBeNull();
        // The same place, but another section: a real move.
        expect(moveRequest(SECTIONS, [4], 5, 1)).toEqual({
            slides: [4],
            to: 4,
            section: 1,
        });
    });
});

describe("dropping a section", () => {
    test("the gap becomes a position among the sections", () => {
        expect(sectionMoveTo(2, 0)).toBe(0);
        expect(sectionMoveTo(0, 3)).toBe(2);
        expect(sectionMoveTo(1, 1)).toBeNull();
        expect(sectionMoveTo(1, 2)).toBeNull();
    });

    test("over a slide: before or after that slide's section", () => {
        expect(sectionGapAtSlide(SECTIONS, 0)).toBe(0);
        expect(sectionGapAtSlide(SECTIONS, 2)).toBe(0);
        expect(sectionGapAtSlide(SECTIONS, 4)).toBe(1);
        expect(sectionGapAtSlide(SECTIONS, 5)).toBe(2); // a lone slide: its first half
    });
});
