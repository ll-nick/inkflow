// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { referencedDefinitions } from "../shared/svg-refs";
import {
    buildGhostLayer,
    limitScopesToLiveContent,
    markGhost,
    removeGhosts,
} from "./ghost-layer";

// A slide with a nested spine, so the prune has ancestors to preserve, and a marker id
// that a second slide would plausibly also define.
const OUTGOING = `
<svg xmlns="http://www.w3.org/2000/svg" id="inkflow-slide-3" class="layout-base layout-wide" viewBox="0 0 100 100">
  <defs>
    <marker id="ConcaveTriangle"><path id="tip"/></marker>
  </defs>
  <g id="background"><rect id="bg"/></g>
  <g id="layer1" fill="#cdd6f4" transform="translate(90,200)">
    <g id="inner">
      <path id="leaving" marker-end="url(#ConcaveTriangle)" data-cues="[]"/>
      <text id="staying">kept elsewhere</text>
    </g>
  </g>
</svg>`;

let outgoing: SVGSVGElement;
const byId = (id: string) => outgoing.querySelector(`#${id}`) as Element;

beforeEach(() => {
    document.body.innerHTML = OUTGOING;
    outgoing = document.querySelector("svg") as SVGSVGElement;
    // Built rather than parsed: happy-dom's HTML parser drops everything after a
    // <style> inside inline SVG, though browsers handle it. Real slides carry one, so
    // it has to be here.
    const style = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "style",
    );
    style.textContent = "@scope(#inkflow-slide-3) { .a { fill: red } }";
    outgoing.querySelector("defs")?.append(style);
});

const build = (keep: Element[], carryDefinitions = true) =>
    buildGhostLayer(outgoing, new Set(keep), {
        carryDefinitions,
        idPrefix: "g1-",
        rename: referencedDefinitions(outgoing),
    });

describe("buildGhostLayer", () => {
    test("keeps the ghost and its whole ancestor spine", () => {
        const layer = build([byId("leaving")]);
        if (!layer) throw new Error("expected a layer");

        // The spine is what carries the inherited fill and the coordinate space the
        // ghost's geometry is written in.
        const group = layer.querySelector("#layer1");
        expect(group?.getAttribute("fill")).toBe("#cdd6f4");
        expect(group?.getAttribute("transform")).toBe("translate(90,200)");
        expect(layer.querySelector("#inner #leaving")).not.toBeNull();
    });

    test("the layer is a real slide root, with the outgoing id, classes and viewBox", () => {
        const layer = build([byId("leaving")]);

        expect(layer?.id).toBe("inkflow-slide-3");
        expect(layer?.getAttribute("class")).toBe("layout-base layout-wide");
        expect(layer?.getAttribute("viewBox")).toBe("0 0 100 100");
    });

    test("drops siblings that are not fading out", () => {
        const layer = build([byId("leaving")]);

        expect(layer?.querySelector("#staying")).toBeNull();
        expect(layer?.querySelector("#background")).toBeNull();
    });

    test("leaves the outgoing slide itself untouched", () => {
        build([byId("leaving")]);

        expect(outgoing.querySelector("#staying")).not.toBeNull();
        expect(outgoing.querySelector("#ConcaveTriangle")).not.toBeNull();
    });

    test("renames carried definitions so they cannot shadow the incoming slide's", () => {
        const layer = build([byId("leaving")]);

        expect(layer?.querySelector("marker")?.id).toBe("g1-ConcaveTriangle");
        expect(
            layer?.querySelector("#leaving")?.getAttribute("marker-end"),
        ).toBe("url(#g1-ConcaveTriangle)");
    });

    test("a second layer carries no definitions, since one copy serves the document", () => {
        const layer = build([byId("leaving")], false);

        expect(layer?.querySelector("defs")).toBeNull();
        expect(layer?.querySelector("style")).toBeNull();
    });

    test("strips data-cues so the step engine cannot reach into a layer", () => {
        const layer = build([byId("leaving")]);

        expect(layer?.querySelector("[data-cues]")).toBeNull();
    });

    test("keeps a whole subtree when a group itself is the ghost", () => {
        const layer = build([byId("layer1")]);

        expect(layer?.querySelector("#staying")).not.toBeNull();
        expect(layer?.querySelector("#leaving")).not.toBeNull();
    });

    test("no ghosts means no layer", () => {
        expect(build([])).toBeNull();
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

describe("limitScopesToLiveContent", () => {
    // A ghost container is nested inside the incoming slide, so the incoming slide's
    // own scoped rules would reach in and restyle content on its way out.
    function slide(css: string): SVGSVGElement {
        document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" id="inkflow-slide-4"></svg>`;
        const svg = document.querySelector("svg") as SVGSVGElement;
        const style = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "style",
        );
        style.textContent = css;
        svg.append(style);
        return svg;
    }
    const css = (svg: Element) => svg.querySelector("style")?.textContent;

    test("adds the limit, and the undo puts the original back", () => {
        const svg = slide("@scope(#inkflow-slide-4) {\n.a { fill: red }\n}");
        const undo = limitScopesToLiveContent(svg);

        expect(css(svg)).toContain(
            "@scope(#inkflow-slide-4) to ([data-morph-ghost])",
        );
        undo();
        expect(css(svg)).toBe(
            "@scope(#inkflow-slide-4) {\n.a { fill: red }\n}",
        );
    });

    test("limits an @scope a deck author wrote, which the pipeline never sees", () => {
        const svg = slide("@scope (.card) { .a { fill: red } }");

        limitScopesToLiveContent(svg);

        expect(css(svg)).toContain("@scope(.card) to ([data-morph-ghost])");
    });

    test("leaves an already-limited scope alone, so applying twice is a no-op", () => {
        const original = "@scope(#x) to (.stop) { .a { fill: red } }";
        const svg = slide(original);

        limitScopesToLiveContent(svg);

        expect(css(svg)).toBe(original);
    });

    test("ignores keyframes and other css lifted alongside the scope", () => {
        const svg = slide("@keyframes spin { to { rotate: 360deg } }");

        limitScopesToLiveContent(svg);

        expect(css(svg)).toBe("@keyframes spin { to { rotate: 360deg } }");
    });
});
