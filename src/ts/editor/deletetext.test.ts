import { describe, expect, it } from "vitest";
import {
    deleteWarnings,
    gitBadge,
    names,
    pickable,
    slideFilesLine,
    slideQuestion,
    useText,
} from "./deletetext";

describe("git badges", () => {
    it("names what git could bring back", () => {
        expect(gitBadge("committed")?.text).toBe("in git");
        expect(gitBadge("modified")?.tone).toBe("warn");
        expect(gitBadge("untracked")).toMatchObject({
            text: "not in git",
            tone: "lost",
        });
        expect(gitBadge("ignored")?.tone).toBe("lost");
        expect(gitBadge("no-repo")).toBeNull();
    });
});

describe("how the deck uses a file", () => {
    it("counts uses and names who still refers to an orphan", () => {
        expect(useText({ state: "used", uses: 1, by: [] }).text).toBe("1 use");
        expect(useText({ state: "used", uses: 3, by: [] }).text).toBe("3 uses");
        expect(useText({ state: "unused", uses: 0, by: [] }).text).toBe(
            "unused",
        );
        const orphan = useText({
            state: "orphan",
            uses: 0,
            by: ["slides/old.svg"],
        });
        expect(orphan.text).toBe("only used by unused files");
        expect(orphan.title).toContain("slides/old.svg");
        expect(useText({ state: "template", uses: 0, by: [] }).text).toBe(
            "unused template",
        );
        expect(
            useText({ state: "template", uses: 0, by: ["layouts/x.svg"] }).text,
        ).toBe("used by a template");
    });

    it("picks unused files and orphans, never templates or used ones", () => {
        expect(pickable("unused")).toBe(true);
        expect(pickable("orphan")).toBe(true);
        expect(pickable("template")).toBe(false);
        expect(pickable("used")).toBe(false);
    });
});

describe("delete warnings", () => {
    it("says nothing for nothing", () => {
        expect(deleteWarnings([], true)).toEqual([]);
    });

    it("warns once without a repository", () => {
        expect(
            deleteWarnings([{ path: "a.png", git: "no-repo" }], false),
        ).toEqual([
            {
                tone: "warn",
                text: "This deck is not in a git repository: deleted files can only be brought back with Undo while this editor is open.",
            },
        ]);
    });

    it("names files git cannot bring back and files with changes", () => {
        const w = deleteWarnings(
            [
                { path: "assets/new.png", git: "untracked" },
                { path: "assets/x.png", git: "ignored" },
                { path: "slides/a.md", git: "modified" },
                { path: "slides/b.svg", git: "committed" },
            ],
            true,
        );
        expect(w).toEqual([
            {
                tone: "warn",
                text: "Not in git: 2 files (assets/new.png, assets/x.png) can't be restored from version control. Undo brings them back only while this editor stays open.",
            },
            {
                tone: "warn",
                text: "Uncommitted changes in 1 file (slides/a.md): git keeps only its last committed version.",
            },
        ]);
    });

    it("is calm when git has every file", () => {
        expect(
            deleteWarnings([{ path: "a.png", git: "committed" }], true),
        ).toEqual([
            {
                tone: "ok",
                text: "All in git: Discard changes in the Git menu brings them back, or its history once you commit.",
            },
        ]);
    });

    it("shortens long lists", () => {
        expect(names(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
        expect(names(["a"])).toBe("a");
    });
});

describe("slide delete words", () => {
    it("asks about one slide or several", () => {
        expect(slideQuestion(["Intro"])).toBe("Delete “Intro” from the deck?");
        expect(slideQuestion(["a", "b"])).toBe(
            "Delete 2 slides from the deck?",
        );
    });

    it("says what the files option deletes", () => {
        expect(slideFilesLine(3, 1)).toBe(
            "Also deletes 3 files no other slide uses:",
        );
        expect(slideFilesLine(0, 1)).toBe(
            "No file is this slide's alone: nothing else is deleted.",
        );
        expect(slideFilesLine(0, 2)).toContain("these slides'");
    });
});
