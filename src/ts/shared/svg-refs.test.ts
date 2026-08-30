// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import {
    collectReferencedIds,
    referencedDefinitions,
    renameIds,
} from "./svg-refs";

function svg(markup: string): SVGSVGElement {
    document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`;
    return document.querySelector("svg") as SVGSVGElement;
}

describe("collectReferencedIds", () => {
    test("finds funciris in presentation attributes and in style", () => {
        const root = svg(`
            <path marker-end="url(#tip)"/>
            <rect fill="url(#grad)" clip-path="url(#clip)"/>
            <path style="stroke:#fff;marker-end:url(#styled)"/>`);

        expect(collectReferencedIds(root)).toEqual(
            new Set(["tip", "grad", "clip", "styled"]),
        );
    });

    test("finds same-document href references", () => {
        const root = svg(
            '<use href="#shape"/><text><textPath xlink:href="#curve"/></text>',
        );

        expect(collectReferencedIds(root)).toEqual(new Set(["shape", "curve"]));
    });

    test("ignores external references and plain colours", () => {
        const root = svg(
            '<image href="photo.png"/><rect fill="#ff0000" stroke="none"/>',
        );

        expect(collectReferencedIds(root)).toEqual(new Set());
    });

    test("handles quoted and spaced url syntax", () => {
        const root = svg(`<rect fill="url( '#quoted' )"/>`);

        expect(collectReferencedIds(root)).toEqual(new Set(["quoted"]));
    });
});

describe("renameIds", () => {
    let root: SVGSVGElement;

    beforeEach(() => {
        root = svg(`
            <defs>
              <marker id="ConcaveTriangle"><path id="tip-shape"/></marker>
              <linearGradient id="grad"/>
            </defs>
            <path id="arrow" marker-end="url(#ConcaveTriangle)"/>
            <rect id="box" style="fill:url(#grad)"/>`);
        renameIds(root, "g1-", referencedDefinitions(root));
    });

    test("renames the definition and the reference together", () => {
        expect(root.querySelector("marker")?.id).toBe("g1-ConcaveTriangle");
        expect(root.querySelector("#arrow")?.getAttribute("marker-end")).toBe(
            "url(#g1-ConcaveTriangle)",
        );
    });

    test("rewrites references inside a style attribute", () => {
        expect(root.querySelector("#box")?.getAttribute("style")).toBe(
            "fill:url(#g1-grad)",
        );
    });

    test("leaves ids nobody references alone", () => {
        // #arrow and #box are referenced by no one, and #tip-shape only exists to
        // check that a nested id is not swept up.
        expect(root.querySelector("[id='arrow']")).not.toBeNull();
        expect(root.querySelector("[id='tip-shape']")).not.toBeNull();
    });

    test("leaves a reference to something defined elsewhere alone", () => {
        // Rewriting it would point it at a name nothing answers to.
        const external = svg('<path marker-end="url(#lives-elsewhere)"/>');
        renameIds(external, "g1-", referencedDefinitions(external));

        expect(external.querySelector("path")?.getAttribute("marker-end")).toBe(
            "url(#lives-elsewhere)",
        );
    });
});
