import { describe, expect, test } from "vitest";
import {
    type ElementGeom,
    formatTransform,
    IDENTITY,
    invert,
    multiply,
    parseTransform,
    planCrop,
    planMove,
    planResize,
    planRotate,
    prependTranslate,
    projectFile,
    relativePath,
    rotateAbout,
    scaleAbout,
    transformBox,
    translate,
    unionBoxes,
} from "./geom";

function geom(over: Partial<ElementGeom> = {}): ElementGeom {
    return {
        tag: "rect",
        sourceTag: "rect",
        attrs: { x: "10", y: "20", width: "100", height: "50" },
        own: { ...IDENTITY },
        parentToSlide: { ...IDENTITY },
        localBox: { x: 10, y: 20, width: 100, height: 50 },
        ...over,
    };
}

describe("matrices", () => {
    test("invert undoes multiply", () => {
        const m = multiply(translate(5, -3), rotateAbout(30, { x: 2, y: 9 }));
        const id = multiply(m, invert(m));
        expect(id.a).toBeCloseTo(1);
        expect(id.d).toBeCloseTo(1);
        expect(id.e).toBeCloseTo(0);
        expect(id.f).toBeCloseTo(0);
    });

    test("parseTransform composes left to right", () => {
        const m = parseTransform("translate(10,20) scale(2)");
        expect(m).toMatchObject({ a: 2, d: 2, e: 10, f: 20 });
    });

    test("parseTransform handles rotate about a point", () => {
        const m = parseTransform("rotate(90, 10, 10)");
        const p = {
            x: m.a * 20 + m.c * 10 + m.e,
            y: m.b * 20 + m.d * 10 + m.f,
        };
        expect(p.x).toBeCloseTo(10);
        expect(p.y).toBeCloseTo(20);
    });

    test("formatTransform prefers translate and drops identity", () => {
        expect(formatTransform(translate(3, 4))).toBe("translate(3,4)");
        expect(formatTransform(IDENTITY)).toBeNull();
        expect(formatTransform(scaleAbout(2, 2, { x: 0, y: 0 }))).toBe(
            "matrix(2,0,0,2,0,0)",
        );
    });

    test("transformBox and unionBoxes", () => {
        const b = transformBox(scaleAbout(2, 3, { x: 0, y: 0 }), {
            x: 1,
            y: 1,
            width: 2,
            height: 2,
        });
        expect(b).toEqual({ x: 2, y: 3, width: 4, height: 6 });
        expect(
            unionBoxes([
                { x: 0, y: 0, width: 1, height: 1 },
                { x: 5, y: 5, width: 1, height: 1 },
            ]),
        ).toEqual({ x: 0, y: 0, width: 6, height: 6 });
        expect(unionBoxes([])).toBeNull();
    });
});

describe("planMove", () => {
    test("a plain rect moves by its x/y", () => {
        expect(planMove(geom(), 5, -5).attrs).toEqual({ x: "15", y: "15" });
    });

    test("the parent's scale is undone", () => {
        const g = geom({ parentToSlide: scaleAbout(2, 2, { x: 0, y: 0 }) });
        expect(planMove(g, 10, 10).attrs).toEqual({ x: "15", y: "25" });
    });

    test("circles move their centre, lines both ends", () => {
        const c = geom({
            sourceTag: "circle",
            attrs: { cx: "5", cy: "6", r: "2" },
        });
        expect(planMove(c, 1, 1).attrs).toEqual({ cx: "6", cy: "7" });
        const l = geom({
            sourceTag: "line",
            attrs: { x1: "0", y1: "0", x2: "10", y2: "10" },
        });
        expect(planMove(l, 2, 3).attrs).toEqual({
            x1: "2",
            y1: "3",
            x2: "12",
            y2: "13",
        });
    });

    test("text shifts its own and its lines' positions", () => {
        const t = geom({ sourceTag: "text", attrs: { x: "10", y: "20" } });
        const plan = planMove(t, 5, 5, [{ attrs: { x: "10", y: "60" } }]);
        expect(plan.attrs).toEqual({ x: "15", y: "25" });
        expect(plan.children).toEqual([{ x: "15", y: "65" }]);
    });

    test("anything else keeps its transform and gains a translate", () => {
        const g = geom({
            sourceTag: "path",
            attrs: { transform: "rotate(10,5,5)" },
            own: parseTransform("rotate(10,5,5)"),
        });
        expect(planMove(g, 3, 4).attrs).toEqual({
            transform: "translate(3,4) rotate(10,5,5)",
        });
    });

    test("a zone filled from a rect moves the rect", () => {
        const g = geom({ tag: "foreignObject", sourceTag: "rect" });
        expect(planMove(g, 1, 2).attrs).toEqual({ x: "11", y: "22" });
    });
});

describe("prependTranslate", () => {
    test("merges into a leading translate", () => {
        expect(
            prependTranslate("translate(10, 20) scale(2)", { x: 1, y: 2 }),
        ).toBe("translate(11,22) scale(2)");
    });

    test("folds into a lone matrix", () => {
        expect(prependTranslate("matrix(2,0,0,2,10,20)", { x: 1, y: 2 })).toBe(
            "matrix(2,0,0,2,11,22)",
        );
    });

    test("drops a translate that cancels out", () => {
        expect(
            prependTranslate("translate(-1,-2) rotate(5)", { x: 1, y: 2 }),
        ).toBe("rotate(5)");
        expect(prependTranslate(null, { x: 0, y: 0 })).toBeNull();
    });
});

describe("planResize", () => {
    test("a rect gets new x/y/width/height", () => {
        const plan = planResize(
            geom(),
            { x: 10, y: 20, width: 100, height: 50 },
            { x: 0, y: 0, width: 200, height: 100 },
        );
        expect(plan).toEqual({ x: "0", y: "0", width: "200", height: "100" });
    });

    test("an ellipse gets new centre and radii", () => {
        const g = geom({
            sourceTag: "ellipse",
            attrs: { cx: "50", cy: "50", rx: "10", ry: "5" },
        });
        const plan = planResize(
            g,
            { x: 40, y: 45, width: 20, height: 10 },
            { x: 40, y: 45, width: 40, height: 20 },
        );
        expect(plan).toEqual({ cx: "60", cy: "55", rx: "20", ry: "10" });
    });

    test("a group is scaled through its transform", () => {
        const g = geom({ tag: "g", sourceTag: "g", attrs: {} });
        const plan = planResize(
            g,
            { x: 0, y: 0, width: 10, height: 10 },
            { x: 0, y: 0, width: 20, height: 20 },
        );
        expect(plan).toEqual({ transform: "matrix(2,0,0,2,0,0)" });
    });
});

test("planRotate writes a matrix about the centre", () => {
    const g = geom({ tag: "g", sourceTag: "g", attrs: {} });
    const plan = planRotate(g, 90, { x: 0, y: 0 });
    expect(plan.transform).toBe("matrix(0,1,-1,0,0,0)");
});

test("relativePath", () => {
    expect(relativePath("/p/slides/a.svg", "/p/assets/x.png")).toBe(
        "../assets/x.png",
    );
    expect(relativePath("/p/a.svg", "/p/x.png")).toBe("x.png");
    expect(relativePath("/p/slides/a.svg", "/p/slides/img/x.png")).toBe(
        "img/x.png",
    );
});

describe("planCrop", () => {
    const frame = (over: Partial<ElementGeom> = {}) =>
        geom({
            tag: "svg",
            sourceTag: "svg",
            attrs: {
                x: "100",
                y: "50",
                width: "400",
                height: "200",
                viewBox: "100 50 400 200",
            },
            ...over,
        });

    test("trimming an edge moves the viewBox with the frame", () => {
        const plan = planCrop(
            frame(),
            { x: 100, y: 50, width: 400, height: 200 },
            { x: 150, y: 50, width: 350, height: 100 },
        );
        expect(plan).toEqual({
            x: "150",
            y: "50",
            width: "350",
            height: "100",
            viewBox: "150 50 350 100",
        });
    });

    test("a scaled frame maps the crop into picture units", () => {
        // Shown at twice the size: the viewBox is half the frame.
        const plan = planCrop(
            frame({
                attrs: {
                    x: "0",
                    y: "0",
                    width: "400",
                    height: "200",
                    viewBox: "10 10 200 100",
                },
            }),
            { x: 0, y: 0, width: 400, height: 200 },
            { x: 100, y: 0, width: 300, height: 200 },
        );
        expect(plan?.viewBox).toBe("60 10 150 100");
        expect(plan?.x).toBe("100");
    });

    test("refuses a frame without a usable viewBox or a rotated one", () => {
        const box = { x: 0, y: 0, width: 1, height: 1 };
        expect(
            planCrop(
                frame({ attrs: { x: "0", y: "0", width: "1", height: "1" } }),
                box,
                box,
            ),
        ).toBeNull();
        expect(
            planCrop(frame({ own: rotateAbout(30, { x: 0, y: 0 }) }), box, box),
        ).toBeNull();
    });
});

describe("projectFile", () => {
    test("resolves a reference against the file it was written in", () => {
        expect(projectFile("../assets/a.png", "slides/x.svg")).toBe(
            "assets/a.png",
        );
        expect(projectFile("./b.png", "slides/x.svg")).toBe("slides/b.png");
        expect(projectFile("assets/v.mp4")).toBe("assets/v.mp4");
        expect(projectFile("../figures/plot.pdf#page=2", "slides/x.svg")).toBe(
            "figures/plot.pdf",
        );
    });

    test("ignores what no program here opens", () => {
        expect(projectFile("https://example.com/a.png")).toBeNull();
        expect(projectFile("data:image/png;base64,AA")).toBeNull();
        expect(projectFile("_theme/logo.svg")).toBeNull();
        expect(projectFile("")).toBeNull();
    });
});
