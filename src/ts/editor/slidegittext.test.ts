import { describe, expect, it } from "vitest";
import {
    type CommitPlan,
    changedAmong,
    changeTitle,
    commitWhat,
    countChanged,
    deckWords,
    defaultMessage,
    diffLine,
    leftWords,
    letter,
    markedAmong,
    missingWords,
    nextMarked,
    removedName,
    type SlideChanges,
    touchedWords,
    whyWords,
} from "./slidegittext";

const changes: SlideChanges = {
    slides: [
        { state: null, entry: null, files: [] },
        {
            state: "shared",
            entry: null,
            files: [
                {
                    path: "talk/layouts/two.svg",
                    status: "modified",
                    role: "layout",
                    shared: true,
                },
            ],
        },
        {
            state: "modified",
            entry: "modified",
            files: [
                {
                    path: "talk/slides/b.md",
                    status: "modified",
                    role: "md",
                    shared: false,
                },
            ],
        },
        { state: "new", entry: "new", files: [] },
    ],
    removed: [],
    deck: {
        path: "talk/deck.py",
        status: "modified",
        readable: true,
        other: false,
    },
};

const plan: CommitPlan = {
    paths: [],
    offered: [],
    deck: "partial",
    deckPath: "talk/deck.py",
    other: false,
    removed: [],
    left: 1,
    missing: [],
    touched: 0,
};

describe("letter", () => {
    it("is VS Code's mark for each state", () => {
        expect(letter("new")).toBe("U");
        expect(letter("modified")).toBe("M");
        expect(letter("shared")).toBe("•");
        expect(letter(null)).toBe("");
    });
});

describe("changeTitle", () => {
    it("names the entry and every file", () => {
        expect(changeTitle(changes.slides[2])).toBe(
            [
                "Changed since the last commit",
                "  its Slide(...) in deck.py changed",
                "  talk/slides/b.md (its Markdown, modified)",
            ].join("\n"),
        );
        expect(changeTitle(changes.slides[1])).toContain(
            "its layout, modified, shared with other slides",
        );
    });

    it("is empty for a slide as committed", () => {
        expect(changeTitle(changes.slides[0])).toBe("");
        expect(changeTitle(undefined)).toBe("");
    });
});

describe("changedAmong", () => {
    it("keeps the new and changed slides, in deck order", () => {
        expect(changedAmong(changes, new Set([3, 0, 1, 2]))).toEqual([2, 3]);
        expect(changedAmong(null, [1])).toEqual([]);
        expect(countChanged(changes)).toBe(2);
    });
});

describe("defaultMessage", () => {
    it("names one, a few or counts many", () => {
        expect(defaultMessage(["Intro"])).toBe('Update slide "Intro"');
        expect(defaultMessage(["A", "B"])).toBe('Update slides "A" and "B"');
        expect(defaultMessage(["A", "B", "C"])).toBe(
            'Update slides "A", "B" and "C"',
        );
        expect(defaultMessage(["A", "B", "C", "D"])).toBe("Update 4 slides");
        expect(defaultMessage([" "])).toBe('Update slide "untitled"');
    });
});

describe("plan words", () => {
    it("say how deck.py goes in", () => {
        expect(deckWords(plan)).toBe(
            "talk/deck.py: these slides' Slide(...) entries only",
        );
        expect(deckWords({ ...plan, deck: "whole", other: true })).toBe(
            "talk/deck.py: all its changes, with its imports, settings, sections and order as they are now",
        );
        expect(deckWords({ ...plan, deck: "none" })).toBe("");
    });

    it("say what stays out", () => {
        expect(leftWords(plan)).toBe(
            "1 other changed slide stays uncommitted.",
        );
        expect(leftWords({ ...plan, left: 3 })).toBe(
            "3 other changed slides stay uncommitted.",
        );
        expect(leftWords({ ...plan, left: 0 })).toBe("");
    });

    it("say why a file goes in and what else changes", () => {
        expect(whyWords("own")).toBe("");
        expect(whyWords("shared")).toBe("shared with other slides");
        expect(whyWords("deck")).toBe("every slide is drawn with it");
        expect(touchedWords(plan)).toBe("");
        expect(touchedWords({ ...plan, touched: 1 })).toBe(
            "1 other slide shares these files and will look different in this commit too.",
        );
        expect(touchedWords({ ...plan, touched: 3 })).toContain(
            "3 other slides share",
        );
    });

    it("name the files a clone would lack", () => {
        expect(
            missingWords({
                ...plan,
                missing: [
                    { path: "talk/secret/a.png", why: "ignored" },
                    { path: "/home/me/logo.svg", why: "outside" },
                ],
            }),
        ).toEqual([
            "talk/secret/a.png: ignored by git, so a clone will not have it",
            "/home/me/logo.svg: outside the repository, so a clone will not have it",
        ]);
    });

    it("name a removed slide", () => {
        expect(removedName({ index: 2, key: "md:c.md", code: "" })).toBe(
            "c.md",
        );
        expect(removedName({ index: 2, key: null, code: "" })).toBe("slide 3");
    });
});

describe("diffLine", () => {
    it("tells headers, hunks, additions and removals apart", () => {
        expect(diffLine("diff --git a/x b/x")).toBe("meta");
        expect(diffLine("--- a/x")).toBe("meta");
        expect(diffLine("+++ b/x")).toBe("meta");
        expect(diffLine("@@ -1 +1 @@")).toBe("hunk");
        expect(diffLine("+new")).toBe("add");
        expect(diffLine("-old")).toBe("del");
        expect(diffLine(" same")).toBe("");
    });
});

describe("marked slides", () => {
    it("are every slide with a mark, the dot included", () => {
        expect(markedAmong(changes, [0, 1, 2, 3])).toEqual([1, 2, 3]);
        expect(markedAmong(null, [1])).toEqual([]);
    });

    it("are reached in both directions, wrapping around", () => {
        expect(nextMarked(changes, 0, 1)).toBe(1);
        expect(nextMarked(changes, 3, 1)).toBe(1);
        expect(nextMarked(changes, 1, -1)).toBe(3);
        const one: SlideChanges = {
            ...changes,
            slides: [changes.slides[0], changes.slides[2]],
        };
        expect(nextMarked(one, 1, 1)).toBeNull();
        expect(nextMarked(one, 0, 1)).toBe(1);
        expect(nextMarked(null, 0, 1)).toBeNull();
    });
});

describe("commitWhat", () => {
    it("names the entry change and the files", () => {
        const base = {
            sha: "a",
            short: "a",
            author: "T",
            when: "now",
            subject: "s",
        };
        expect(
            commitWhat({
                ...base,
                files: ["talk/slides/b.md"],
                entry: "added",
            }),
        ).toBe("added the slide · slides/b.md");
        expect(commitWhat({ ...base, files: [], entry: "changed" })).toBe(
            "its Slide(...)",
        );
    });
});
