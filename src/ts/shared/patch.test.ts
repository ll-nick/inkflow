import { describe, expect, it } from "vitest";
import { applyPatch, isWhole, sameItems } from "./patch";

const a = { key: "a", text: "one" };
const b = { key: "b", text: "two" };
const c = { key: "c", text: "three" };

describe("applyPatch", () => {
    it("keeps the items it holds, by identity", () => {
        const fresh = { key: "b2", text: "two, edited" };
        const out = applyPatch([a, b, c], ["a", fresh, "c"]);
        expect(out).toEqual([a, fresh, c]);
        expect(out?.[0]).toBe(a);
        expect(out?.[2]).toBe(c);
    });

    it("follows a new order, an insertion and a removal", () => {
        const added = { key: "d", text: "four" };
        expect(applyPatch([a, b, c], ["c", added, "a"])).toEqual([c, added, a]);
    });

    it("says when the page does not hold a key", () => {
        expect(applyPatch([a, b], ["a", "zz"])).toBeNull();
    });

    it("does not trust an item without a key", () => {
        // What the page changed itself (a hash kept current) is not what the
        // server means by the key any more.
        const dirty: { key?: string; text: string } = { text: "one" };
        expect(applyPatch([dirty, b], ["a", "b"])).toBeNull();
    });

    it("takes a whole list as it is", () => {
        const whole = [c, a];
        expect(isWhole(whole)).toBe(true);
        expect(applyPatch([b], whole)).toBe(whole);
        expect(applyPatch([b], [])).toEqual([]);
    });
});

describe("sameItems", () => {
    it("compares by identity and order", () => {
        expect(sameItems([a, b], [a, b])).toBe(true);
        expect(sameItems([a, b], [b, a])).toBe(false);
        expect(sameItems([a], [a, b])).toBe(false);
        expect(sameItems([a], [{ ...a }])).toBe(false);
    });
});
