import { describe, expect, test } from "vitest";
import {
    backgroundSamples,
    blend,
    contrastRatio,
    haloOf,
    hex,
    isLarge,
    needed,
    parseColor,
    type Rgb,
    readableText,
    shadowColor,
    shownRatio,
    worstContrast,
    worstPerTarget,
} from "./contrast";

const white: Rgb = [255, 255, 255];
const black: Rgb = [0, 0, 0];

describe("WCAG maths", () => {
    test("black on white is 21:1, a colour on itself 1:1", () => {
        expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
        expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
        expect(contrastRatio([119, 119, 119], [119, 119, 119])).toBe(1);
    });

    test("the classic thresholds", () => {
        // #767676 on white is the darkest grey passing 4.5:1.
        expect(contrastRatio([118, 118, 118], white)).toBeGreaterThan(4.5);
        expect(contrastRatio([119, 119, 119], white)).toBeLessThan(4.5);
    });

    test("blending and printing", () => {
        expect(blend(white, 0.5, black)).toEqual([127.5, 127.5, 127.5]);
        expect(hex([255, 0, 127.6])).toBe("#ff0080");
        expect(shownRatio(2.97)).toBe(2.9);
    });

    test("large text is 24px, or 18.66px bold, on a 1080px slide", () => {
        expect(isLarge(24, 400, 1080)).toBe(true);
        expect(isLarge(23, 400, 1080)).toBe(false);
        expect(isLarge(19, 700, 1080)).toBe(true);
        expect(isLarge(16, 400, 720)).toBe(true); // 24px on 1080
    });

    test("what text needs", () => {
        expect(needed(2.5, true)).toBe(3);
        expect(needed(2.5, false)).toBe(4.5);
        expect(needed(3.5, false)).toBe(4.5);
        expect(needed(3.5, true)).toBeNull();
        expect(needed(4.6, false)).toBeNull();
    });
});

describe("parsing computed colours", () => {
    test("rgb, rgba, space syntax and color(srgb)", () => {
        expect(parseColor("rgb(1, 2, 3)")).toEqual({
            rgb: [1, 2, 3],
            alpha: 1,
        });
        expect(parseColor("rgba(1, 2, 3, 0.5)")?.alpha).toBe(0.5);
        expect(parseColor("rgb(1 2 3 / 50%)")?.alpha).toBe(0.5);
        expect(parseColor("color(srgb 1 0 0.5)")?.rgb).toEqual([255, 0, 127.5]);
        expect(parseColor("none")).toBeNull();
        expect(parseColor('url("#gradient")')).toBeNull();
    });

    test("a text shadow's colour", () => {
        expect(shadowColor("rgba(0, 0, 0, 0.45) 0px 2px 12px")).toEqual({
            rgb: [0, 0, 0],
            alpha: 0.45,
        });
        expect(shadowColor("none")).toBeNull();
        expect(shadowColor("rgba(0, 0, 0, 0) 0px 0px 0px")).toBeNull();
    });

    test("emoji are not text to check", () => {
        expect(readableText("✏️ Draw")).toBe("Draw");
        expect(readableText("🎨")).toBe("");
    });
});

describe("a halo", () => {
    const stroke = (rgb: Rgb) => ({ rgb, alpha: 1 });
    test("a thick stroke of another colour is the text's background", () => {
        expect(haloOf(white, stroke(black), 6, 60)).toEqual(black);
    });
    test("a stroke the colour of the fill only makes it bolder", () => {
        expect(haloOf(black, stroke([20, 20, 20]), 6, 60)).toBeNull();
    });
    test("a hairline is no halo", () => {
        expect(haloOf(white, stroke(black), 1, 60)).toBeNull();
        expect(haloOf(white, null, 6, 60)).toBeNull();
    });
});

/** A `width` x `height` image, filled with `fill(x, y)`. */
function image(
    width: number,
    height: number,
    fill: (x: number, y: number) => Rgb,
): { data: Uint8ClampedArray; width: number; height: number } {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [r, g, b] = fill(x, y);
            data.set([r, g, b, 255], (y * width + x) * 4);
        }
    }
    return { data, width, height };
}

describe("the worst of the background", () => {
    const offsets = (n: number) => Array.from({ length: n }, (_, i) => i * 4);

    test("a light tenth behind white text is found", () => {
        // 100 pixels: 85 black, 15 white.
        const bg = image(100, 1, (x) => (x < 85 ? black : white));
        const worst = worstContrast(white, 1, bg.data, offsets(100));
        expect(worst?.ratio).toBe(1);
        expect(worst?.background).toEqual(white);
    });

    test("a few edge pixels are not", () => {
        const bg = image(100, 1, (x) => (x < 95 ? black : white));
        const worst = worstContrast(white, 1, bg.data, offsets(100));
        expect(worst?.ratio).toBeCloseTo(21, 5);
    });

    test("semi-transparent text is blended over the background", () => {
        const bg = image(1, 1, () => black);
        const worst = worstContrast(white, 0.25, bg.data, [0]);
        expect(worst?.ratio).toBeLessThan(3);
    });

    test("a shadow only helps", () => {
        // Dark text on a light box, its own dark shadow behind it: the box counts.
        const light = image(1, 1, () => [230, 233, 239]);
        const shadow = { rgb: black, alpha: 0.45 };
        const text: Rgb = [76, 79, 105];
        const plain = worstContrast(text, 1, light.data, [0]);
        const shadowed = worstContrast(text, 1, light.data, [0], 0.1, shadow);
        expect(shadowed?.ratio).toBe(plain?.ratio);
        // White text over white, lifted by a dark shadow.
        const page = image(1, 1, () => white);
        const lifted = worstContrast(white, 1, page.data, [0], 0.1, shadow);
        expect(lifted?.ratio).toBeGreaterThan(2);
        expect(worstContrast(white, 1, page.data, [])).toBeNull();
    });
});

describe("background samples", () => {
    // The text's box is the left half; its glyphs are a dark bar in the shown
    // shot; behind them (hidden shot) the left quarter is grey, the rest white.
    const hidden = image(8, 4, (x) => (x < 2 ? [128, 128, 128] : white));
    const shown = image(8, 4, (x, y) =>
        y === 1 || y === 2 ? black : x < 2 ? [128, 128, 128] : white,
    );
    const box = [{ left: 0, top: 0, right: 4, bottom: 4 }];

    test("only where the glyphs are", () => {
        const samples = backgroundSamples(box, shown, hidden, 1);
        expect(samples.length).toBe(8); // two rows of four
        expect(samples.every((i) => i >= 8 * 4 && i < 3 * 8 * 4)).toBe(true);
    });

    test("every pixel of the box when the glyphs do not show", () => {
        expect(backgroundSamples(box, hidden, hidden, 1).length).toBe(16);
    });

    test("boxes are in CSS px, the shots in device pixels", () => {
        const samples = backgroundSamples(
            [{ left: 0, top: 0, right: 8, bottom: 8 }],
            shown,
            hidden,
            0.5,
        );
        expect(samples.length).toBe(8);
    });
});

test("one finding per target, the worst", () => {
    const f = (target: string, ratio: number) => ({
        kind: "contrast" as const,
        target,
        ratio,
        needs: 4.5,
        text: "",
        color: "",
        background: "",
    });
    expect(
        worstPerTarget([f("#a", 2), f("#a", 1.5), f("#b", 3)]).map((x) => [
            x.target,
            x.ratio,
        ]),
    ).toEqual([
        ["#a", 1.5],
        ["#b", 3],
    ]);
});
