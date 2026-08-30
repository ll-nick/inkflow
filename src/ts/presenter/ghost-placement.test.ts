// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from "vitest";
import { planGhostPlacement } from "./ghost-placement";

// The shape that produced the regression this replaces: a label sitting immediately
// before its own arrow, so it is "below everything matched" by rank while being plain
// foreground content.
const OUTGOING = `
<svg xmlns="http://www.w3.org/2000/svg" id="out">
  <rect id="backdrop" width="100" height="100"/>
  <text id="label">straight (H)</text>
  <path id="straight"/>
  <text id="caption">cubic</text>
  <path id="curve"/>
  <g id="badge"><rect/></g>
</svg>`;

const INCOMING = `
<svg xmlns="http://www.w3.org/2000/svg" id="in">
  <rect width="100" height="100"/>
  <text>straight (L)</text>
  <g id="wrapper"><path id="straight"/></g>
  <path id="curve"/>
</svg>`;

let outgoing: SVGSVGElement;
let incoming: SVGSVGElement;

beforeEach(() => {
    document.body.innerHTML = `<div id="a">${OUTGOING}</div><div id="b">${INCOMING}</div>`;
    outgoing = document.querySelector("#a svg") as SVGSVGElement;
    incoming = document.querySelector("#b svg") as SVGSVGElement;
});

const out = (id: string) => outgoing.querySelector(`#${id}`) as Element;
const plan = (ghostIds: string[]) =>
    planGhostPlacement(
        outgoing,
        incoming,
        new Set(ghostIds.map(out)),
        new Set(["straight", "curve"]),
    );

describe("planGhostPlacement", () => {
    test("a ghost lands before the incoming element it sat under", () => {
        const groups = plan(["label"]);

        expect(groups).toHaveLength(1);
        // #straight is nested, so placement rises to its top-level ancestor rather than
        // inserting beside it, which would inherit that group's transform.
        expect(groups[0].before).toBe(incoming.querySelector("#wrapper"));
        expect(groups[0].ghosts).toEqual([out("label")]);
    });

    test("ghosts under different anchors get separate insertion points", () => {
        const groups = plan(["label", "caption"]);

        expect(groups.map((g) => g.before)).toEqual([
            incoming.querySelector("#wrapper"),
            incoming.querySelector("#curve"),
        ]);
    });

    test("ghosts sharing an anchor stay in outgoing paint order", () => {
        const groups = plan(["label", "backdrop"]);

        expect(groups).toHaveLength(1);
        expect(groups[0].ghosts).toEqual([out("backdrop"), out("label")]);
    });

    test("a ghost above everything matched appends last", () => {
        const groups = plan(["badge"]);

        expect(groups[0].before).toBeNull();
    });

    test("with nothing matched, everything appends last", () => {
        const groups = planGhostPlacement(
            outgoing,
            incoming,
            new Set([out("backdrop"), out("badge")]),
            new Set(),
        );

        expect(groups).toHaveLength(1);
        expect(groups[0].before).toBeNull();
        expect(groups[0].ghosts).toEqual([out("backdrop"), out("badge")]);
    });
});
