import { describe, expect, it } from "vitest";
import {
    badge,
    type CmpSlide,
    type CompareModel,
    counts,
    countText,
    firstRow,
    followRow,
    mergeBranch,
    mergeTarget,
    newFontRules,
    nextChange,
    type PairModel,
    rowNumber,
    type SideModel,
    takeState,
    toSlideBox,
    visibleRows,
    whatChanged,
    wordDiff,
} from "./comparelib";

function pair(
    left: number | null,
    right: number | null,
    status: PairModel["status"],
    extra: Partial<PairModel> = {},
): PairModel {
    return {
        left,
        right,
        status,
        moved: false,
        visual: status === "changed",
        notes: false,
        settings: [],
        files: [],
        elements: [],
        ...extra,
    };
}

function slides(...ids: string[]): CmpSlide[] {
    return ids.map((id, index) => ({
        index,
        number: index + 1,
        id,
        title: id,
        visible: true,
        svg: "<svg/>",
        notes: "",
    }));
}

function side(
    label: string,
    ids: string[],
    extra: Partial<SideModel> = {},
): SideModel {
    return {
        kind: "commit",
        label,
        branch: null,
        sha: null,
        live: false,
        deckPath: "/x/deck.py",
        token: label,
        missing: [],
        error: null,
        slides: slides(...ids),
        css: "",
        fonts: "",
        mode: "dark",
        source: { kind: "commit", rev: label },
        ...extra,
    };
}

function model(pairs: PairModel[], l: string[], r: string[]): CompareModel {
    return {
        view: 1,
        left: side("Working copy", l, {
            kind: "live",
            live: true,
            source: { kind: "live" },
        }),
        right: side("abc1234 Fix", r),
        deck: [],
        pairs,
    };
}

const PAIRS = [
    pair(0, 0, "same"),
    pair(1, 1, "changed"),
    pair(2, null, "removed"),
    pair(null, 2, "added"),
    pair(3, 4, "same", { moved: true }),
    pair(4, 3, "same"),
];
const M = model(
    PAIRS,
    ["a", "b", "gone", "m", "z"],
    ["a", "b", "new", "z", "m"],
);

describe("rows", () => {
    it("filters to the changes", () => {
        expect(visibleRows(PAIRS, false)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(visibleRows(PAIRS, true)).toEqual([1, 2, 3, 4]);
    });

    it("jumps between changes both ways and stops at the ends", () => {
        expect(nextChange(PAIRS, 0, 1)).toBe(1);
        expect(nextChange(PAIRS, 1, 1)).toBe(2);
        expect(nextChange(PAIRS, 4, 1)).toBeNull();
        expect(nextChange(PAIRS, 4, -1)).toBe(3);
        expect(nextChange(PAIRS, 1, -1)).toBeNull();
        expect(firstRow(PAIRS)).toBe(1);
        expect(firstRow([pair(0, 0, "same")])).toBe(0);
    });

    it("badges and numbers each row", () => {
        expect(PAIRS.map((p) => badge(p).symbol)).toEqual([
            "",
            "~",
            "−",
            "+",
            "↕",
            "",
        ]);
        expect(badge(pair(0, 1, "changed", { moved: true })).cls).toBe(
            "changed moved",
        );
        expect(rowNumber(M, PAIRS[4])).toBe("4 → 5");
        expect(rowNumber(M, PAIRS[2])).toBe("3");
        expect(rowNumber(M, PAIRS[3])).toBe("3");
    });

    it("counts", () => {
        const c = counts(PAIRS);
        expect(c).toEqual({
            changed: 1,
            added: 1,
            removed: 1,
            moved: 1,
            same: 2,
        });
        expect(countText(c)).toBe("1 changed · 1 added · 1 removed · 1 moved");
        expect(countText(counts([pair(0, 0, "same")]))).toBe("No differences");
    });

    it("keeps the selected slide after a new model", () => {
        const after = model(
            [pair(null, 0, "added"), ...PAIRS],
            ["a", "b", "gone", "m", "z"],
            ["first", "a", "b", "new", "z", "m"],
        );
        // "b" was row 1; now it is row 2.
        after.pairs[2] = pair(1, 2, "changed");
        expect(followRow(M, 1, after)).toBe(2);
        expect(followRow(null, 3, after)).toBe(0);
    });
});

describe("what changed", () => {
    it("names files, notes and settings like the CLI", () => {
        const p = pair(0, 0, "changed", {
            notes: true,
            settings: ["font_size"],
            files: [
                { path: "slides/a.md", role: "md", change: "changed" },
                { path: "notes/a.md", role: "notes", change: "changed" },
            ],
        });
        expect(whatChanged(p)).toEqual(["slides/a.md", "notes", "font size"]);
        expect(whatChanged(pair(0, 0, "changed"))).toEqual(["look"]);
    });
});

describe("word diff", () => {
    it("marks words out and in, keeping spaces", () => {
        expect(wordDiff("the quick fox", "the slow fox")).toEqual([
            { kind: "same", text: "the " },
            { kind: "del", text: "quick" },
            { kind: "ins", text: "slow" },
            { kind: "same", text: " fox" },
        ]);
    });

    it("handles empty and equal texts", () => {
        expect(wordDiff("", "")).toEqual([]);
        expect(wordDiff("same", "same")).toEqual([
            { kind: "same", text: "same" },
        ]);
        expect(wordDiff("", "new words")).toEqual([
            { kind: "ins", text: "new words" },
        ]);
        expect(wordDiff("old", "")).toEqual([{ kind: "del", text: "old" }]);
    });

    it("rebuilds both texts", () => {
        const a = "one two three four five\nsix seven";
        const b = "one 2 three five\nsix seven eight";
        const parts = wordDiff(a, b);
        const left = parts
            .filter((p) => p.kind !== "ins")
            .map((p) => p.text)
            .join("");
        const right = parts
            .filter((p) => p.kind !== "del")
            .map((p) => p.text)
            .join("");
        expect(left).toBe(a);
        expect(right).toBe(b);
    });
});

describe("actions", () => {
    it("takes only into the working copy, only a differing slide", () => {
        expect(takeState(M, 1)).toMatchObject({ enabled: true, replace: true });
        expect(takeState(M, 3)).toMatchObject({
            enabled: true,
            replace: false,
        });
        expect(takeState(M, 2).enabled).toBe(false); // not on the right
        expect(takeState(M, 0).enabled).toBe(false); // the same
        const neither = { ...M, left: { ...M.left, live: false } };
        expect(takeState(neither, 1).title).toMatch(/working copy/);
        // Swapped: the working copy on the right takes from the left.
        const swapped: CompareModel = {
            ...M,
            left: M.right,
            right: M.left,
            pairs: [pair(1, 1, "changed"), pair(null, 2, "removed")],
        };
        expect(takeState(swapped, 0).enabled).toBe(true);
        expect(takeState(swapped, 1).enabled).toBe(false);
    });

    it("offers to merge the other side's branch", () => {
        expect(mergeTarget(M)).toBeNull();
        const branch = { ...M, right: { ...M.right, branch: "agent/idea" } };
        expect(mergeTarget(branch)).toBe("agent/idea");
        const noLive = { ...branch, left: { ...branch.left, live: false } };
        expect(mergeTarget(noLive)).toBeNull();
    });

    it("sends the worktree merge and reports the session's answer", async () => {
        const sent: Record<string, unknown>[] = [];
        const ok = await mergeBranch("agent/idea", async (req) => {
            sent.push(req);
            return { ok: true, historyCleared: true };
        });
        expect(sent).toEqual([
            { action: "worktree", op: "merge", branch: "agent/idea" },
        ]);
        expect(ok).toMatchObject({ ok: true, historyCleared: true });
        const refused = await mergeBranch("x", async () => ({
            ok: false,
            error: "unknown action 'worktree'",
        }));
        expect(refused).toEqual({
            ok: false,
            error: "unknown action 'worktree'",
        });
    });
});

describe("helpers", () => {
    it("adds only font rules the page lacks", () => {
        const a = "@font-face { font-family: A; src: url(a) }";
        const b = "@font-face { font-family: B; src: url(b) }";
        expect(newFontRules(`${a}\n${b}`, `body{} ${a}`)).toBe(b);
        expect(newFontRules("", "")).toBe("");
    });

    it("maps a client rect to slide units", () => {
        const box = toSlideBox(
            { left: 110, top: 60, width: 50, height: 25 },
            { left: 100, top: 50, width: 960, height: 540 },
            { x: 0, y: 0, w: 1920, h: 1080 },
        );
        expect(box).toEqual([20, 20, 100, 50]);
        expect(
            toSlideBox(
                { left: 0, top: 0, width: 0, height: 0 },
                { left: 0, top: 0, width: 10, height: 10 },
                { x: 0, y: 0, w: 1, h: 1 },
            ),
        ).toBeNull();
    });
});
