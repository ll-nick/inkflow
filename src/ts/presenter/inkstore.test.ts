import { describe, expect, test } from "vitest";
import type { InkStroke } from "../shared/ink";
import { InkStore, SlideInk } from "./inkstore";

const stroke = (id: string, fill = "#ff0000"): InkStroke => ({
    id,
    tool: "pen",
    fill,
    token: null,
    size: 4,
    d: "M0 0Q1 1 2 2Z",
});

describe("SlideInk", () => {
    test("adds in order and replaces a stroke with the same id in place", () => {
        const ink = new SlideInk();
        ink.add([stroke("ink-a"), stroke("ink-b")]);
        const rev = ink.rev;
        ink.add([stroke("ink-a", "#00ff00")]);
        expect(ink.strokes.map((s) => [s.id, s.fill])).toEqual([
            ["ink-a", "#00ff00"],
            ["ink-b", "#ff0000"],
        ]);
        expect(ink.rev).toBeGreaterThan(rev);
    });

    test("removing returns what was there and changes nothing else", () => {
        const ink = new SlideInk();
        ink.add([stroke("ink-a"), stroke("ink-b")]);
        expect(ink.remove(["ink-b", "ink-zzz"]).map((s) => s.id)).toEqual([
            "ink-b",
        ]);
        const rev = ink.rev;
        expect(ink.remove(["ink-zzz"])).toEqual([]);
        expect(ink.rev).toBe(rev);
        expect(ink.strokes.map((s) => s.id)).toEqual(["ink-a"]);
    });

    test("undo takes back the latest action first", () => {
        const ink = new SlideInk();
        ink.record({ kind: "add", strokes: [stroke("ink-a")] });
        ink.record({ kind: "erase", strokes: [stroke("ink-a")] });
        ink.record({ kind: "add", strokes: [] }); // nothing to undo: not kept
        expect(ink.popUndo()?.kind).toBe("erase");
        expect(ink.popUndo()?.kind).toBe("add");
        expect(ink.popUndo()).toBeNull();
        expect(ink.canUndo).toBe(false);
    });

    test("saved strokes the ink file now shows are no longer held", () => {
        const ink = new SlideInk();
        ink.add([{ ...stroke("ink-a"), saved: true }, stroke("ink-b")]);
        ink.settle(new Set(["ink-a"]));
        expect(ink.strokes.map((s) => s.id)).toEqual(["ink-b"]);
    });
});

test("a snapshot is every slide's strokes, without what is local", () => {
    const store = new InkStore();
    store.get("intro").add([{ ...stroke("ink-a"), saved: true }]);
    store.get("empty");
    expect(store.snapshot()).toEqual({ intro: [stroke("ink-a")] });
    expect(store.get("intro")).toBe(store.get("intro"));
});
