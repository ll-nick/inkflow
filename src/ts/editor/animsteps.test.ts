// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { cueSteps } from "./animsteps";
import type { CueInfo } from "./types";

const cue = (element: string, kind = "enter"): CueInfo => ({
    type: "FadeIn",
    slug: "fade-in",
    kind,
    custom: false,
    element,
    fields: {},
});

describe("cueSteps", () => {
    it("reads each animation's step off the built slide", () => {
        const host = document.createElement("div");
        host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">
            <rect id="a" data-cues='[{"step":3},{"step":1}]'/>
            <g id="b" data-cues='[{"step":2}]'/>
            <foreignObject id="zone-clip"><video data-play-on-step="4"></video></foreignObject>
        </svg>`;
        const svg = host.querySelector("svg");
        // An element's cues are its animations in order: its first is step 1.
        expect(
            cueSteps(
                [
                    cue("a"),
                    cue("b"),
                    cue("a"),
                    cue("clip", "video"),
                    cue("gone"),
                ],
                svg,
            ),
        ).toEqual([1, 2, 3, 4, null]);
    });
});
