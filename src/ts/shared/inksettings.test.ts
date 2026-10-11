import { describe, expect, test } from "vitest";
import { PEN_SIZES, SWATCHES } from "./ink";
import {
    defaultSettings,
    normalizeHex,
    settingsFrom,
    styleFor,
} from "./inksettings";

const noTheme = () => null;

describe("settingsFrom", () => {
    const fallback = defaultSettings(false);

    test("missing or malformed storage gives the defaults", () => {
        expect(settingsFrom(null, fallback)).toEqual(fallback);
        expect(settingsFrom("junk", fallback)).toEqual(fallback);
    });

    test("each bad field falls back on its own", () => {
        const s = settingsFrom(
            {
                tool: "laser",
                pen: { swatch: 99, custom: "red", size: 1 },
                highlighter: { swatch: null, custom: "#123456", size: -1 },
                fingers: "yes",
                keep: true,
            },
            fallback,
        );
        expect(s.tool).toBe("pen");
        expect(s.pen).toEqual({ ...fallback.pen, size: 1 });
        expect(s.highlighter).toEqual({
            swatch: null,
            custom: "#123456",
            size: fallback.highlighter.size,
        });
        expect(s.fingers).toBe(false);
        expect(s.keep).toBe(true);
    });

    test("a page may default to drawing with a mouse", () => {
        expect(defaultSettings(true).fingers).toBe(true);
        expect(defaultSettings(false).fingers).toBe(false);
    });
});

describe("styleFor", () => {
    test("a theme swatch uses the theme's colour and keeps its token", () => {
        const s = defaultSettings(false);
        const red = SWATCHES.findIndex((w) => w.token === "red");
        s.pen.swatch = red;
        const style = styleFor(s, "pen", 1920, (t) =>
            t === "red" ? "#abcdef" : null,
        );
        expect(style).toEqual({
            tool: "pen",
            fill: "#abcdef",
            token: "red",
            size: PEN_SIZES[s.pen.size],
        });
        expect(styleFor(s, "pen", 1920, noTheme).fill).toBe(SWATCHES[red].hex);
    });

    test("black, white and a custom colour have no token", () => {
        const s = defaultSettings(false);
        s.pen.swatch = 0;
        expect(styleFor(s, "pen", 1920, noTheme)).toMatchObject({
            fill: "#000000",
            token: null,
        });
        s.pen.swatch = null;
        s.pen.custom = "#00FF00";
        expect(styleFor(s, "pen", 1920, noTheme)).toMatchObject({
            fill: "#00ff00",
            token: null,
        });
    });

    test("sizes scale with the width of slide on screen", () => {
        const s = defaultSettings(false);
        const full = styleFor(s, "pen", 1920, noTheme).size;
        expect(styleFor(s, "pen", 960, noTheme).size).toBe(full / 2);
        expect(styleFor(s, "highlighter", 1920, noTheme).size).toBeGreaterThan(
            full,
        );
    });
});

test.each([
    ["#ABC", "#aabbcc"],
    ["#a1b2c3", "#a1b2c3"],
    ["rgb(255, 0, 16)", "#ff0010"],
    ["rgba(1 2 3 / 0.5)", "#010203"],
    ["red", null],
])("normalizeHex(%s)", (input, out) => {
    expect(normalizeHex(input)).toBe(out);
});
