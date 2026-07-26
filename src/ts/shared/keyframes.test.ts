// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { buildKeyframes, substituteVars } from "./keyframes";

// substituteVars injects a cue's own values into a keyframe template's var(--anim-*)
// tokens, so multiple cues on one element never share a custom property. Non-anim vars
// (theme tokens) are left for the browser.
describe("substituteVars", () => {
    test("replaces --anim-* tokens with the cue's values", () => {
        expect(
            substituteVars("var(--anim-from-x) var(--anim-from-y)", {
                "from-x": "-60px",
                "from-y": "0px",
            }),
        ).toBe("-60px 0px");
    });

    test("leaves non-anim vars (theme tokens) untouched", () => {
        expect(substituteVars("drop-shadow(0 0 8px var(--accent))", {})).toBe(
            "drop-shadow(0 0 8px var(--accent))",
        );
    });

    test("honors a fallback in the token and still substitutes", () => {
        expect(
            substituteVars("var(--anim-color, red)", { color: "#ff0000" }),
        ).toBe("#ff0000");
    });

    test("leaves an unknown --anim-* token as-is", () => {
        expect(substituteVars("var(--anim-scale)", {})).toBe(
            "var(--anim-scale)",
        );
    });

    test("substitutes inside a calc() expression", () => {
        expect(
            substituteVars("calc(10px * var(--anim-intensity))", {
                intensity: "2",
            }),
        ).toBe("calc(10px * 2)");
    });
});

// The engine looks a cue's keyframes up by its full `anim-<slug>` rule name (the cue's
// `name` is the bare slug, so the engine prefixes `anim-`). Resolving a real @keyframes
// rule from the document confirms that contract — a mismatch there silently produces
// empty keyframes and no animation at all.
describe("buildKeyframes lookup", () => {
    test("resolves an @keyframes rule by its anim-<slug> name", () => {
        const style = document.createElement("style");
        style.textContent =
            "@keyframes anim-testfade { from { opacity: 0; } to { opacity: 1; } }";
        document.head.appendChild(style);

        const frames = buildKeyframes("anim-testfade", {});
        expect(frames.length).toBeGreaterThan(0);
        const opacities = frames.map((f) => String(f.opacity));
        expect(opacities).toContain("0");
        expect(opacities).toContain("1");

        style.remove();
    });

    test("returns [] when no matching rule exists (bare slug would miss)", () => {
        expect(buildKeyframes("testfade", {})).toEqual([]);
    });
});
