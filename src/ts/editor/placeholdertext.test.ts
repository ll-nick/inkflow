import { describe, expect, it } from "vitest";
import {
    checkName,
    fillsText,
    kindOf,
    nameProblem,
    renameSummary,
    slugName,
    zoneNameFor,
} from "./placeholdertext";

describe("placeholder names", () => {
    it("slugs like master.slug_name", () => {
        expect(slugName("customCodeExamples")).toBe("custom-code-examples");
        expect(slugName("Code examples")).toBe("code-examples");
        expect(slugName("  HTMLBox ")).toBe("html-box");
        expect(slugName("!!")).toBe("");
    });

    it("gives a picture placeholder a name that says so", () => {
        expect(zoneNameFor("picture", "hero")).toBe("picture-hero");
        expect(zoneNameFor("picture", "Team photo")).toBe("team-photo");
        expect(zoneNameFor("text", "zone-Caption")).toBe("caption");
        expect(kindOf("picture-hero")).toBe("picture");
        expect(kindOf("caption")).toBe("text");
    });

    it("refuses what Markdown or the build reserve", () => {
        expect(nameProblem("")).toMatch(/name/);
        expect(nameProblem("2col")).toMatch(/letter/);
        expect(nameProblem("notes")).toMatch(/reserved/);
        expect(nameProblem("step")).toMatch(/step/);
        expect(nameProblem("steps-2")).toMatch(/step/);
        expect(nameProblem("stepper")).toBeNull();
        expect(nameProblem("caption")).toBeNull();
    });

    it("refuses a name in use, but not the zone's own", () => {
        const taken = ["zone-title", "zone-code", "frame"];
        expect(checkName("text", "Title", taken).problem).toMatch(
            /zone-title is already used/,
        );
        expect(checkName("text", "code", taken, "code").problem).toBeNull();
        expect(checkName("text", "frame", taken)).toEqual({
            name: "frame",
            problem: null,
        });
    });
});

describe("panel words", () => {
    it("says who fills a placeholder", () => {
        const n = (i: number) => String(i + 1);
        expect(fillsText([], n)).toBe("No slide fills it yet");
        expect(fillsText([1], n)).toBe("Filled on slide 2");
        expect(fillsText([1, 4, 6], n)).toBe("Filled on 3 slides: 2, 5, 7");
    });

    it("sums up a rename", () => {
        const plan = {
            slides: [0, 2],
            slideNames: ["slide 1", "slide 3"],
            files: [],
            edits: [],
            warnings: [],
        };
        expect(renameSummary(plan)).toBe(
            "Renames the zone on 2 slides (slide 1, slide 3)",
        );
        expect(renameSummary({ ...plan, slides: [], slideNames: [] })).toBe(
            "No slide fills it: only the layout changes",
        );
    });
});
