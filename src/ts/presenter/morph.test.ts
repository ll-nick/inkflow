// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import {
    collectPairableIds,
    isDefinitionContent,
    markGhost,
    readInlineStyle,
    removeGhosts,
    restoreInlineStyle,
    sameIntrinsicShape,
} from "./morph";

// two slides that share nothing but stock Inkscape marker ids, plus one real matching element.
const SLIDE = `
<svg id="inkflow-slide-3" xmlns="http://www.w3.org/2000/svg">
  <defs id="defs1">
    <marker id="ConcaveTriangle"><path id="path7"/></marker>
    <clipPath id="clip1"><rect id="clip-rect"/></clipPath>
  </defs>
  <g id="layer1">
    <path id="trajectory-arrow" marker-end="url(#ConcaveTriangle)"/>
    <text id="text6">verify</text>
  </g>
</svg>`;

let svg: SVGSVGElement;

beforeEach(() => {
    document.body.innerHTML = SLIDE;
    svg = document.querySelector("svg") as SVGSVGElement;
});

const byId = (id: string) => svg.querySelector(`#${id}`) as Element;

describe("isDefinitionContent", () => {
    test("the definition container itself counts", () => {
        expect(isDefinitionContent(byId("defs1"))).toBe(true);
    });

    test("content nested inside a definition counts", () => {
        expect(isDefinitionContent(byId("ConcaveTriangle"))).toBe(true);
        expect(isDefinitionContent(byId("path7"))).toBe(true);
        expect(isDefinitionContent(byId("clip-rect"))).toBe(true);
    });

    test("drawn content does not", () => {
        expect(isDefinitionContent(svg)).toBe(false);
        expect(isDefinitionContent(byId("layer1"))).toBe(false);
        expect(isDefinitionContent(byId("trajectory-arrow"))).toBe(false);
    });
});

describe("collectPairableIds", () => {
    test("definition ids never enter the pairing set", () => {
        expect(collectPairableIds(svg)).toEqual(
            new Set(["inkflow-slide-3", "layer1", "trajectory-arrow", "text6"]),
        );
    });

    test("a definition child contributes nothing, not even its own id", () => {
        expect(collectPairableIds(byId("defs1"))).toEqual(new Set());
    });

    test("a drawn child contributes its own id and its descendants'", () => {
        expect(collectPairableIds(byId("layer1"))).toEqual(
            new Set(["layer1", "trajectory-arrow", "text6"]),
        );
    });
});

describe("inline style round trip", () => {
    // Finalize used to blanket-remove the properties a morph writes, which also dropped
    // the author's own: `fill:none;stroke:#b4befe` came out as the SVG defaults.
    const AUTHORED = "fill:none;stroke:#b4befe;stroke-width:6;font-size:64px";

    function arrow(): SVGElement {
        document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">
            <path id="a-generate" style="${AUTHORED}"/></svg>`;
        return document.querySelector("#a-generate") as SVGElement;
    }

    test("author declarations survive a morph that overwrites them", () => {
        const element = arrow();
        const original = readInlineStyle(element);

        element.style.setProperty("fill", "#ff0000");
        element.style.setProperty("stroke", "#00ff00");
        element.style.setProperty("font-size", "10px");

        restoreInlineStyle(element, original);

        expect(element.style.getPropertyValue("fill")).toBe("none");
        expect(element.style.getPropertyValue("stroke")).toBe("#b4befe");
        expect(element.style.getPropertyValue("font-size")).toBe("64px");
    });

    test("properties the morph added, and the author did not write, are removed", () => {
        const element = arrow();
        const original = readInlineStyle(element);

        element.style.setProperty("opacity", "0.5");

        restoreInlineStyle(element, original);

        expect(element.style.getPropertyValue("opacity")).toBe("");
    });

    test("untouched declarations are left alone", () => {
        const element = arrow();
        restoreInlineStyle(element, readInlineStyle(element));

        expect(element.style.getPropertyValue("stroke-width")).toBe("6");
    });
});

describe("ghost sweep", () => {
    // Cleanup used to walk the task list, which is never assigned if the build throws
    // partway. A selector sweep does not care how far the build got.
    beforeEach(() => {
        document.body.innerHTML = `<div id="stage"><svg id="inkflow-slide-4">
            <g id="keep"><rect id="real"/></g></svg></div>`;
    });

    const stage = () => document.querySelector("#stage") as HTMLElement;

    test("removes every tagged node, at any depth", () => {
        const svg = document.querySelector("svg") as SVGSVGElement;
        const ghost = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "rect",
        );
        ghost.id = "ghost";
        markGhost(ghost);
        svg.appendChild(ghost);

        removeGhosts(stage());

        expect(document.querySelector("#ghost")).toBeNull();
    });

    test("leaves the incoming slide's own content alone", () => {
        removeGhosts(stage());

        expect(document.querySelector("#real")).not.toBeNull();
        expect(document.querySelector("#keep")).not.toBeNull();
    });

    test("is a no-op when there is nothing to sweep", () => {
        const before = stage().innerHTML;
        removeGhosts(stage());

        expect(stage().innerHTML).toBe(before);
    });
});

describe("sameIntrinsicShape", () => {
    // A box morph moves a shape, it cannot turn one shape into another, so a pair that
    // fails this crossfades rather than snapping to the destination on frame 0.
    function pair(first: string, second: string): [Element, Element] {
        document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${first}${second}</svg>`;
        const svg = document.querySelector("svg") as SVGSVGElement;
        return [svg.children[0], svg.children[1]];
    }

    test("the same shape moved and resized still morphs", () => {
        expect(
            sameIntrinsicShape(
                ...pair(
                    '<rect x="0" y="0" width="10" height="10"/>',
                    '<rect x="90" y="90" width="40" height="20" rx="8"/>',
                ),
            ),
        ).toBe(true);
    });

    test("a circle and an ellipse are one family", () => {
        expect(
            sameIntrinsicShape(
                ...pair('<circle r="10"/>', '<ellipse rx="30" ry="10"/>'),
            ),
        ).toBe(true);
    });

    test("a rect and a circle do not morph", () => {
        expect(
            sameIntrinsicShape(
                ...pair('<rect width="10" height="10"/>', '<circle r="10"/>'),
            ),
        ).toBe(false);
    });

    test("paths morph only when their data is identical", () => {
        expect(
            sameIntrinsicShape(
                ...pair('<path d="M 0 0 L 9 9"/>', '<path d="M 0 0 L 9 9"/>'),
            ),
        ).toBe(true);
        expect(
            sameIntrinsicShape(
                ...pair('<path d="M 0 0 L 9 9"/>', '<path d="M 0 0 L 9 1"/>'),
            ),
        ).toBe(false);
    });

    test("an image morphs only while it shows the same file", () => {
        expect(
            sameIntrinsicShape(
                ...pair('<image href="a.png"/>', '<image href="a.png"/>'),
            ),
        ).toBe(true);
        expect(
            sameIntrinsicShape(
                ...pair('<image href="a.png"/>', '<image href="b.png"/>'),
            ),
        ).toBe(false);
    });

    test("polygons morph only while their points match", () => {
        expect(
            sameIntrinsicShape(
                ...pair(
                    '<polygon points="0,0 10,0 5,9"/>',
                    '<polygon points="0,0 10,0 5,4"/>',
                ),
            ),
        ).toBe(false);
    });
});
