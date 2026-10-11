import { describe, expect, it } from "vitest";
import {
    ALL_SHOWN,
    panelOfKey,
    panelTitle,
    parseShown,
    storeShown,
} from "./panelstext";

describe("parseShown / storeShown", () => {
    it("shows every panel when nothing was remembered", () => {
        expect(parseShown(null)).toEqual(ALL_SHOWN);
        expect(parseShown("")).toEqual(ALL_SHOWN);
        expect(parseShown("not json")).toEqual(ALL_SHOWN);
        expect(parseShown('{"left":false}')).toEqual(ALL_SHOWN);
    });

    it("remembers the hidden ones and nothing else", () => {
        const shown = { left: false, bottom: true, right: false };
        expect(storeShown(shown)).toBe('["left","right"]');
        expect(parseShown(storeShown(shown))).toEqual(shown);
        expect(parseShown('["bottom","elsewhere",3]')).toEqual({
            left: true,
            bottom: false,
            right: true,
        });
        expect(storeShown(ALL_SHOWN)).toBe("[]");
    });
});

describe("keys and titles", () => {
    it("gives each panel a key of its own", () => {
        expect(panelOfKey("1")).toBe("left");
        expect(panelOfKey("2")).toBe("bottom");
        expect(panelOfKey("3")).toBe("right");
        expect(panelOfKey("4")).toBeNull();
        expect(panelOfKey("g")).toBeNull();
    });

    it("says what a click would do, and the key", () => {
        expect(panelTitle("left", true)).toBe("Hide the slide list (1)");
        expect(panelTitle("bottom", false)).toBe("Show the speaker notes (2)");
    });
});
