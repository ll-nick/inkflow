// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { diagramShapes } from "./drawioshapes";

// As drawio_inline.py draws a diagram: cells nested root > layer > shapes,
// labels as HTML with an SVG <text> fallback.
const DRAWN = `<svg xmlns="http://www.w3.org/2000/svg" id="flow">
<g><g data-cell-id="0" id="flow-0"><g data-cell-id="1" id="flow-1">
  <g data-cell-id="box" id="flow-box"><rect/>
    <switch><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Group  box</div></foreignObject><text>Group box</text></switch>
    <g data-cell-id="inner" id="flow-inner"><rect/><text>Inner</text></g>
  </g>
  <g data-cell-id="e1" id="flow-e1"><path/></g>
</g></g></g></svg>`;

describe("diagramShapes", () => {
    it("lists shapes and arrows with their own labels, not layers", () => {
        const host = document.createElement("div");
        host.innerHTML = DRAWN;
        const shapes = diagramShapes(host.querySelector("svg")!);
        expect(shapes.map((s) => [s.id, s.label])).toEqual([
            ["flow-box", "Group box"],
            ["flow-inner", "Inner"],
            ["flow-e1", ""],
        ]);
    });
});
