// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import {
    collectPairableIds,
    isDefinitionContent,
    readInlineStyle,
    restoreInlineStyle,
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
    // A morph writes fill/stroke/font-size over the element while it animates. Finalize
    // used to blanket-remove those properties, which also dropped the author's own
    // declarations: an arrow styled `fill:none;stroke:#b4befe` came out of the morph
    // with the SVG defaults, black fill and no stroke.
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
