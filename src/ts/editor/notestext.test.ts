import { describe, expect, it } from "vitest";
import {
    CANVAS_MIN,
    clampHeight,
    NOTES_DEFAULT,
    NOTES_MIN,
    readNumber,
} from "./notestext";

describe("clampHeight", () => {
    it("keeps a height that fits", () => {
        expect(clampHeight(300, 900)).toBe(300);
        expect(clampHeight(NOTES_DEFAULT, 900)).toBe(NOTES_DEFAULT);
        expect(clampHeight(300.4, 900)).toBe(300);
    });

    it("never hides the panel's heading", () => {
        expect(clampHeight(10, 900)).toBe(NOTES_MIN);
        expect(clampHeight(-50, 900)).toBe(NOTES_MIN);
    });

    it("leaves the slide above it some room", () => {
        expect(clampHeight(2000, 900)).toBe(900 - CANVAS_MIN);
        // A window too small for both: the notes keep their least.
        expect(clampHeight(500, 200)).toBe(NOTES_MIN);
    });
});

describe("readNumber", () => {
    it("reads what was remembered", () => {
        expect(readNumber("320")).toBe(320);
        expect(readNumber("320.5")).toBe(320.5);
    });

    it("has nothing for what cannot be a height", () => {
        expect(readNumber(null)).toBeNull();
        expect(readNumber("")).toBeNull();
        expect(readNumber("tall")).toBeNull();
        expect(readNumber("0")).toBeNull();
        expect(readNumber("-4")).toBeNull();
    });
});
