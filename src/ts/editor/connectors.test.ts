import { describe, expect, test } from "vitest";
import {
    endpointsOf,
    formatBend,
    nearestSite,
    parseBend,
    parseConnection,
    parseSite,
    pathData,
    route,
    siteByName,
    sitesFromCorners,
} from "./connectors";

const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
];

describe("sites", () => {
    test("one per edge, facing outward", () => {
        const s = sitesFromCorners(square);
        expect(s.map((x) => [x.name, x.x, x.y, x.dx, x.dy])).toEqual([
            ["top", 50, 0, 0, -1],
            ["right", 100, 25, 1, 0],
            ["bottom", 50, 50, 0, 1],
            ["left", 0, 25, -1, 0],
        ]);
    });

    test("follow rotation", () => {
        // The square turned 90° about the origin.
        const turned = square.map((p) => ({ x: -p.y, y: p.x }));
        const right = sitesFromCorners(turned)[1];
        expect(right.x).toBeCloseTo(-25);
        expect(right.y).toBeCloseTo(100);
        expect(right.dy).toBeCloseTo(1);
    });

    test("nearest within a distance", () => {
        const s = sitesFromCorners(square);
        expect(nearestSite(s, { x: 96, y: 30 }, 10)?.name).toBe("right");
        expect(nearestSite(s, { x: 50, y: 25 }, 10)).toBeNull();
    });
});

describe("routes", () => {
    const a = { x: 100, y: 25, dx: 1, dy: 0 }; // right side of one box
    const b = { x: 300, y: 125, dx: -1, dy: 0 }; // left side of another

    test("straight", () => {
        expect(pathData(route("straight", a, b))).toBe("M100,25 L300,125");
    });

    test("elbow between facing sides turns twice, halfway", () => {
        expect(pathData(route("elbow", a, b))).toBe(
            "M100,25 L200,25 L200,125 L300,125",
        );
    });

    test("elbow from a side to a top turns once", () => {
        const top = { x: 300, y: 125, dx: 0, dy: -1 };
        expect(pathData(route("elbow", a, top))).toBe(
            "M100,25 L300,25 L300,125",
        );
    });

    test("elbow between aligned ends is straight", () => {
        const level = { x: 300, y: 25, dx: -1, dy: 0 };
        expect(pathData(route("elbow", a, level))).toBe("M100,25 L300,25");
    });

    test("curved leaves and enters along the sites", () => {
        const d = pathData(route("curved", a, b));
        expect(d.startsWith("M100,25 C")).toBe(true);
        expect(d.endsWith(" 300,125")).toBe(true);
        const r = route("curved", a, b);
        expect(r.points[1].y).toBe(25); // leaves to the right
        expect(r.points[2].x).toBeLessThan(300); // enters from the left
    });

    test("a free end routes too", () => {
        expect(
            pathData(route("elbow", { x: 0, y: 0 }, { x: 100, y: 40 })),
        ).toBe("M0,0 L50,0 L50,40 L100,40");
    });
});

describe("paths and connections", () => {
    test("endpoints come back from the path data", () => {
        expect(endpointsOf("M1.5,2 C3,4 5,6 7,-8.25")).toEqual({
            start: { x: 1.5, y: 2 },
            end: { x: 7, y: -8.25 },
        });
        expect(endpointsOf("M1,2")).toBeNull();
    });

    test("connection values", () => {
        expect(parseConnection("box-1:right")).toEqual({
            id: "box-1",
            site: "right",
        });
        expect(parseConnection("box:middle")).toBeNull();
        expect(parseConnection(null)).toBeNull();
    });
});

describe("more connection points", () => {
    test("evenly spaced on every side, the middle keeping its plain name", () => {
        const s = sitesFromCorners(square, 3);
        expect(s.slice(0, 3).map((x) => [x.name, x.x, x.y])).toEqual([
            ["top@0.25", 25, 0],
            ["top", 50, 0],
            ["top@0.75", 75, 0],
        ]);
        // Clockwise: the right side runs top to bottom, the bottom right to left.
        expect(s[3]).toMatchObject({
            name: "right@0.25",
            x: 100,
            y: 12.5,
            dx: 1,
        });
        expect(s[6]).toMatchObject({
            name: "bottom@0.25",
            x: 75,
            y: 50,
            dy: 1,
        });
    });

    test("a named point is found whether or not the shape offers it", () => {
        expect(siteByName(square, "left@0.2")).toMatchObject({ x: 0, y: 40 });
        expect(siteByName(square, "middle")).toBeNull();
        expect(parseSite("top@1.5")).toBeNull();
        expect(parseConnection("box:right@0.25")).toEqual({
            id: "box",
            site: "right@0.25",
        });
    });

    test("on a round shape the points sit on the ellipse", () => {
        const circle = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
            { x: 0, y: 100 },
        ];
        const p = siteByName(circle, "top@0.25", true)!;
        expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(50);
        expect(siteByName(circle, "top", true)).toMatchObject({ x: 50, y: 0 });
    });
});

describe("elbow bends", () => {
    const a = { x: 100, y: 25, dx: 1, dy: 0 };
    const b = { x: 300, y: 125, dx: -1, dy: 0 };

    test("the middle segment can be moved", () => {
        const r = route("elbow", a, b, { axis: "x", at: 150 });
        expect(pathData(r)).toBe("M100,25 L150,25 L150,125 L300,125");
        expect(r.bend).toEqual({ axis: "x", at: 150, mid: { x: 150, y: 75 } });
    });

    test("a bend for the other axis is ignored", () => {
        const r = route("elbow", a, b, { axis: "y", at: 150 });
        expect(r.bend?.at).toBe(200);
    });

    test("two ends facing the same way go round the further one", () => {
        const rightA = { x: 100, y: 25, dx: 1, dy: 0 };
        const rightB = { x: 300, y: 125, dx: 1, dy: 0 };
        expect(pathData(route("elbow", rightA, rightB))).toBe(
            "M100,25 L330,25 L330,125 L300,125",
        );
    });

    test("side to top: moving the bend adds a jog before the top", () => {
        const top = { x: 300, y: 125, dx: 0, dy: -1 };
        expect(pathData(route("elbow", a, top, { axis: "x", at: 200 }))).toBe(
            "M100,25 L200,25 L200,95 L300,95 L300,125",
        );
    });

    test("stored as axis:value", () => {
        expect(parseBend("x:640.5")).toEqual({ axis: "x", at: 640.5 });
        expect(parseBend("z:1")).toBeNull();
        expect(formatBend({ axis: "y", at: 12.345 })).toBe("y:12.35");
    });
});
