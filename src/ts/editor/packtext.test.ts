import { describe, expect, it } from "vitest";
import {
    commitPaths,
    consequences,
    missingLines,
    type PackSummary,
    remainingLines,
    sentence,
    withoutPackingTitle,
} from "./packtext";

const summary: PackSummary = {
    needed: true,
    steps: ["copy 1 font family into fonts/ (Arial)"],
    items: [
        {
            key: "font",
            message: 'font "Arial" comes from this machine',
            consequence:
                'Slides use a different font on machines without "Arial"',
            fixable: true,
        },
        {
            key: "asset",
            message: "/home/me/pics/x.png is outside the deck",
            consequence: "it won't be in the repository: others see it missing",
            fixable: true,
        },
        {
            key: "asset",
            message: "/home/me/pics/y.png is outside the deck",
            consequence: "it won't be in the repository: others see it missing",
            fixable: true,
        },
        {
            key: "generic-font",
            message: "text set in the generic font sans-serif looks different",
            consequence: "Text set in sans-serif looks different on each OS",
            fixable: false,
        },
    ],
};

describe("the commit question", () => {
    it("lists only what packing fixes", () => {
        expect(missingLines(summary)).toEqual([
            'font "Arial" comes from this machine',
            "/home/me/pics/x.png is outside the deck",
            "/home/me/pics/y.png is outside the deck",
        ]);
    });

    it("says each consequence once, as a sentence", () => {
        expect(consequences(summary)).toEqual([
            'Slides use a different font on machines without "Arial".',
            "It won't be in the repository: others see it missing.",
        ]);
    });

    it("titles the not-recommended button with what goes missing", () => {
        expect(withoutPackingTitle(summary)).toBe(
            'Not recommended: Slides use a different font on machines without "Arial". (and 1 more)',
        );
        expect(withoutPackingTitle({ ...summary, items: [] })).toBe(
            "Commit as it is",
        );
    });

    it("keeps what packing cannot change apart", () => {
        expect(remainingLines(summary.items)).toEqual([
            "Text set in the generic font sans-serif looks different.",
        ]);
    });

    it("commits the ticked files and what packing wrote, once each", () => {
        expect(
            commitPaths(
                ["talk/deck.py", "talk/styles.css"],
                ["talk/deck.py", "talk/fonts/arial/Arial.ttf", "talk/uv.lock"],
            ),
        ).toEqual([
            "talk/deck.py",
            "talk/styles.css",
            "talk/fonts/arial/Arial.ttf",
            "talk/uv.lock",
        ]);
    });

    it("leaves a finished sentence alone", () => {
        expect(sentence("done.")).toBe("Done.");
        expect(sentence("")).toBe("");
    });
});
