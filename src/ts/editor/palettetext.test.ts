import { describe, expect, it } from "vitest";
import { type Entry, fromTitle, rank, score } from "./palettetext";

describe("score", () => {
    it("prefers the start, then word starts, then any run", () => {
        const start = score("comm", "Commit…") ?? 0;
        const word = score("comm", "Add comment") ?? 0;
        const loose = score("cmt", "Commit…") ?? 0;
        expect(start).toBeGreaterThan(word);
        expect(word).toBeGreaterThan(loose);
        expect(score("xyz", "Commit")).toBeNull();
        expect(score("", "anything")).toBe(0);
    });

    it("matches letters in order, across words", () => {
        expect(score("nsa", "New slide after")).not.toBeNull();
        expect(score("asn", "New slide after")).toBeNull();
    });
});

describe("rank", () => {
    const entries: Entry[] = [
        { label: "Commit…", group: "Git" },
        { label: "Add comment", group: "Comments", keys: "Shift+C" },
        { label: "3 Features", group: "Slide", hint: "features" },
        { label: "12 Thanks", group: "Slide", hint: "end" },
        { label: "Grid view", group: "View", keys: "G" },
    ];

    it("orders by how well each matches", () => {
        expect(rank(entries, "com").map((e) => e.label)).toEqual([
            "Commit…",
            "Add comment",
        ]);
        expect(rank(entries, "").length).toBe(5);
        expect(rank(entries, "", 2).length).toBe(2);
    });

    it("finds a slide by its number, its title or its id", () => {
        expect(rank(entries, "12")[0].label).toBe("12 Thanks");
        expect(rank(entries, "3")[0].label).toBe("3 Features");
        expect(rank(entries, "end")[0].label).toBe("12 Thanks");
    });

    it("matches the group too", () => {
        expect(rank(entries, "git commit")[0].label).toBe("Commit…");
    });
});

describe("fromTitle", () => {
    it("splits off the shortcut", () => {
        expect(fromTitle("Find and replace (Ctrl+F)")).toEqual({
            label: "Find and replace",
            keys: "Ctrl+F",
        });
        expect(fromTitle("All slides as a grid (G)")).toEqual({
            label: "All slides as a grid",
            keys: "G",
        });
        expect(fromTitle("Export as a web page (or a PDF)")).toEqual({
            label: "Export as a web page (or a PDF)",
        });
        expect(fromTitle("Share\nmore")).toEqual({ label: "Share" });
    });
});
