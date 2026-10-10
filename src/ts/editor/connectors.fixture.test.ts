// The shared cases (tests/data/connector_routes.json) that the Python port of
// this maths (inkflow/editor/routing.py, geometry.py) is tested against too:
// `inkflow shape` routes arrows exactly as the editor does only while both
// give these answers. A deliberate change here regenerates the file
// (node tests/data/make_connector_routes.mjs) and the Python follows.

import { describe, expect, test } from "vitest";
import fixture from "../../../tests/data/connector_routes.json" with {
    type: "json",
};
import {
    type Bend,
    type ConnectorStyle,
    type End,
    endpointsOf,
    formatBend,
    type Pt,
    parseBend,
    parseConnection,
    pathData,
    route,
    siteByName,
    sitesFromCorners,
} from "./connectors";
import {
    type ElementGeom,
    formatTransform,
    type Mat,
    parseTransform,
    planMove,
    planResize,
    prependTranslate,
} from "./geom";

interface GeomCase {
    tag: string;
    attrs: Record<string, string | null>;
    parentToSlide: Mat;
}

function geom(g: GeomCase): ElementGeom {
    return {
        tag: g.tag,
        sourceTag: g.tag,
        attrs: g.attrs,
        own: parseTransform(g.attrs.transform ?? null),
        parentToSlide: g.parentToSlide,
        localBox: { x: 0, y: 0, width: 0, height: 0 },
    };
}

describe("shared connector cases", () => {
    test("sites", () => {
        for (const c of fixture.sites) {
            const got = sitesFromCorners(c.corners as Pt[], c.per, c.round);
            expect(got).toEqual(c.expected);
        }
        for (const c of fixture.named) {
            expect(siteByName(c.corners as Pt[], c.name, c.round)).toEqual(
                c.expected,
            );
        }
    });

    test("routes", () => {
        for (const c of fixture.routes) {
            const r = route(
                c.style as ConnectorStyle,
                c.a as End,
                c.b as End,
                c.bend as Bend | null,
            );
            expect(pathData(r)).toBe(c.expected.d);
            expect(
                r.bend ? { axis: r.bend.axis, at: r.bend.at } : null,
            ).toEqual(c.expected.bend);
        }
    });

    test("bends, ends and connections", () => {
        for (const c of fixture.bends) {
            const b = parseBend(c.text);
            expect(b).toEqual(c.parsed);
            expect(b ? formatBend(b) : null).toBe(c.formatted);
        }
        for (const c of fixture.endpoints) {
            expect(endpointsOf(c.d)).toEqual(c.expected);
        }
        for (const c of fixture.connections) {
            expect(parseConnection(c.value || null)).toEqual(c.expected);
        }
    });

    test("moves and resizes", () => {
        for (const c of fixture.moves) {
            const got = planMove(
                geom(c.geom as unknown as GeomCase),
                c.dx,
                c.dy,
                [
                    ...c.kids.map((attrs) => ({
                        attrs: attrs as Record<string, string | null>,
                    })),
                ],
            );
            expect(got).toEqual(c.expected);
        }
        for (const c of fixture.resizes) {
            expect(
                planResize(geom(c.geom as unknown as GeomCase), c.from, c.to),
            ).toEqual(c.expected);
        }
        for (const c of fixture.prepends) {
            expect(prependTranslate(c.transform, c.d)).toBe(c.expected);
        }
        for (const c of fixture.formats) {
            expect(formatTransform(c.matrix)).toBe(c.expected);
        }
    });
});
