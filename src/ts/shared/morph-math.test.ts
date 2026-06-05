// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import type { AbsolutePose } from "./morph-math";
import {
    buildCompensationMatrix,
    easeInOut,
    interpolateAttribute,
    interpolateColorAttribute,
    interpolateNumericAttribute,
    parseColorToRGB,
    poseCenter,
} from "./morph-math";

// ── helpers ──────────────────────────────────────────────────────────────────

function pose(
    x: number,
    y: number,
    width: number,
    height: number,
    rotation = 0,
): AbsolutePose {
    return { x, y, width, height, rotation };
}

// Apply a compensation matrix to the top-left and bottom-right corners of a pose.
function applyToPose(
    m: DOMMatrix,
    p: AbsolutePose,
): { topLeft: DOMPoint; bottomRight: DOMPoint } {
    return {
        topLeft: new DOMPoint(p.x, p.y).matrixTransform(m),
        bottomRight: new DOMPoint(
            p.x + p.width,
            p.y + p.height,
        ).matrixTransform(m),
    };
}

// ── easeInOut ────────────────────────────────────────────────────────────────

describe("easeInOut", () => {
    test("clamps at 0 and 1", () => {
        expect(easeInOut(0)).toBe(0);
        expect(easeInOut(1)).toBe(1);
    });

    test("midpoint is 0.5", () => {
        expect(easeInOut(0.5)).toBe(0.5);
    });

    test("first half is quadratic ease-in", () => {
        expect(easeInOut(0.25)).toBeCloseTo(0.125, 6);
    });

    test("second half mirrors first half", () => {
        expect(easeInOut(0.75)).toBeCloseTo(1 - easeInOut(0.25), 6);
    });

    test("is monotonically increasing", () => {
        for (let i = 0; i < 99; i++) {
            expect(easeInOut((i + 1) / 100)).toBeGreaterThan(
                easeInOut(i / 100),
            );
        }
    });
});

// ── parseColorToRGB ───────────────────────────────────────────────────────────

describe("parseColorToRGB", () => {
    test("parses 3-digit hex", () => {
        expect(parseColorToRGB("#fff")).toEqual([255, 255, 255]);
        expect(parseColorToRGB("#000")).toEqual([0, 0, 0]);
        expect(parseColorToRGB("#f00")).toEqual([255, 0, 0]);
    });

    test("parses 6-digit hex", () => {
        expect(parseColorToRGB("#89b4fa")).toEqual([137, 180, 250]);
        expect(parseColorToRGB("#1e1e2e")).toEqual([30, 30, 46]);
    });

    test("parses rgb() format", () => {
        expect(parseColorToRGB("rgb(137, 180, 250)")).toEqual([137, 180, 250]);
        expect(parseColorToRGB("rgb(0, 0, 0)")).toEqual([0, 0, 0]);
    });

    test("returns null for unparseable input", () => {
        expect(parseColorToRGB("hsl(200, 50%, 50%)")).toBeNull();
        expect(parseColorToRGB("red")).toBeNull();
        expect(parseColorToRGB("transparent")).toBeNull();
        expect(parseColorToRGB("")).toBeNull();
    });
});

// ── interpolateColorAttribute ─────────────────────────────────────────────────

describe("interpolateColorAttribute", () => {
    test("t=0 returns fromColor", () => {
        expect(interpolateColorAttribute("#000000", "#ffffff", 0)).toBe(
            "#000000",
        );
    });

    test("t=1 returns toColor", () => {
        expect(interpolateColorAttribute("#000000", "#ffffff", 1)).toBe(
            "#ffffff",
        );
    });

    test("t=0.5 returns midpoint", () => {
        expect(interpolateColorAttribute("#000000", "#ffffff", 0.5)).toBe(
            "#808080",
        );
    });

    test("interpolates individual channels", () => {
        expect(interpolateColorAttribute("#ff0000", "#0000ff", 0.5)).toBe(
            "#800080",
        );
    });

    test("unparseable colors snap at midpoint", () => {
        expect(interpolateColorAttribute("red", "blue", 0.3)).toBe("red");
        expect(interpolateColorAttribute("red", "blue", 0.7)).toBe("blue");
    });

    test("accepts rgb() format on either side", () => {
        const result = interpolateColorAttribute(
            "rgb(0, 0, 0)",
            "#ffffff",
            0.5,
        );
        expect(result).toBe("#808080");
    });
});

// ── interpolateNumericAttribute ───────────────────────────────────────────────

describe("interpolateNumericAttribute", () => {
    test("lerps between two values", () => {
        expect(Number(interpolateNumericAttribute("0", "1", 0.5))).toBeCloseTo(
            0.5,
            6,
        );
        expect(
            Number(interpolateNumericAttribute("0.2", "0.8", 0.25)),
        ).toBeCloseTo(0.35, 6);
    });

    test("t=0 returns fromValue", () => {
        expect(
            Number(interpolateNumericAttribute("0.3", "0.9", 0)),
        ).toBeCloseTo(0.3, 6);
    });

    test("t=1 returns toValue", () => {
        expect(
            Number(interpolateNumericAttribute("0.3", "0.9", 1)),
        ).toBeCloseTo(0.9, 6);
    });
});

// ── interpolateAttribute ──────────────────────────────────────────────────────

describe("interpolateAttribute", () => {
    test("fill uses color interpolation", () => {
        expect(interpolateAttribute("fill", "#000000", "#ffffff", 0.5)).toBe(
            "#808080",
        );
    });

    test("stroke uses color interpolation", () => {
        expect(interpolateAttribute("stroke", "#ff0000", "#0000ff", 0.5)).toBe(
            "#800080",
        );
    });

    test("opacity uses numeric interpolation", () => {
        expect(interpolateAttribute("opacity", "0", "1", 0.5)).toBe("0.5");
    });

    test("stroke-width uses numeric interpolation", () => {
        expect(interpolateAttribute("stroke-width", "2", "10", 0.5)).toBe("6");
    });
});

// ── poseCenter ────────────────────────────────────────────────────────────────

describe("poseCenter", () => {
    test("unrotated pose → naive center", () => {
        const c = poseCenter(pose(100, 100, 200, 100));
        expect(c.x).toBeCloseTo(200, 6);
        expect(c.y).toBeCloseTo(150, 6);
    });

    test("90°-rotated pose → center reached along rotated axes", () => {
        // top-left corner at (100,100), rotated 90°: corners are
        // (100,100),(100,300),(0,100),(0,300) → center (50,200).
        const c = poseCenter(pose(100, 100, 200, 100, Math.PI / 2));
        expect(c.x).toBeCloseTo(50, 6);
        expect(c.y).toBeCloseTo(200, 6);
    });

    test("rotated center differs from naive x+w/2, y+h/2", () => {
        const p = pose(100, 100, 200, 100, Math.PI / 4);
        const c = poseCenter(p);
        expect(c.x).not.toBeCloseTo(p.x + p.width / 2, 3);
    });
});

// ── buildCompensationMatrix ───────────────────────────────────────────────────

describe("buildCompensationMatrix", () => {
    const identity = new DOMMatrix();

    test("returns null when easedProgress >= 1", () => {
        expect(
            buildCompensationMatrix(
                pose(0, 0, 100, 100),
                pose(200, 200, 100, 100),
                identity,
                1,
            ),
        ).toBeNull();
        expect(
            buildCompensationMatrix(
                pose(0, 0, 100, 100),
                pose(200, 200, 100, 100),
                identity,
                1.5,
            ),
        ).toBeNull();
    });

    test("t=0, same pose → identity matrix", () => {
        const p = pose(100, 100, 200, 200);
        const m = buildCompensationMatrix(p, p, identity, 0)!;
        const pt = new DOMPoint(100, 100).matrixTransform(m);
        expect(pt.x).toBeCloseTo(100, 3);
        expect(pt.y).toBeCloseTo(100, 3);
    });

    test("t=0, translation only → corners map fromPose → toPose in reverse", () => {
        const from = pose(100, 100, 200, 200);
        const to = pose(500, 500, 200, 200);
        const m = buildCompensationMatrix(from, to, identity, 0)!;
        const { topLeft, bottomRight } = applyToPose(m, to);
        expect(topLeft.x).toBeCloseTo(from.x, 3);
        expect(topLeft.y).toBeCloseTo(from.y, 3);
        expect(bottomRight.x).toBeCloseTo(from.x + from.width, 3);
        expect(bottomRight.y).toBeCloseTo(from.y + from.height, 3);
    });

    test("t=0, translation + scale change → corners map correctly (the key invariant)", () => {
        const from = pose(120, 200, 400, 300);
        const to = pose(900, 600, 600, 200);
        const m = buildCompensationMatrix(from, to, identity, 0)!;
        const { topLeft, bottomRight } = applyToPose(m, to);
        expect(topLeft.x).toBeCloseTo(from.x, 3);
        expect(topLeft.y).toBeCloseTo(from.y, 3);
        expect(bottomRight.x).toBeCloseTo(from.x + from.width, 3);
        expect(bottomRight.y).toBeCloseTo(from.y + from.height, 3);
    });

    test("t=0.5 → center is at midpoint between fromPose and toPose centers", () => {
        const from = pose(0, 0, 200, 200);
        const to = pose(400, 400, 200, 200);
        const m = buildCompensationMatrix(from, to, identity, 0.5)!;
        // fromCenter=(100,100), toCenter=(500,500); midpoint=(300,300)
        const center = new DOMPoint(to.x + 100, to.y + 100).matrixTransform(m);
        expect(center.x).toBeCloseTo(300, 3);
        expect(center.y).toBeCloseTo(300, 3);
    });

    test("t=0.5 → visual size is midpoint between fromPose and toPose sizes", () => {
        const from = pose(0, 0, 400, 300);
        const to = pose(100, 100, 200, 100);
        const m = buildCompensationMatrix(from, to, identity, 0.5)!;
        // Width and height at midpoint
        const tl = new DOMPoint(to.x, to.y).matrixTransform(m);
        const tr = new DOMPoint(to.x + to.width, to.y).matrixTransform(m);
        const bl = new DOMPoint(to.x, to.y + to.height).matrixTransform(m);
        expect(Math.hypot(tr.x - tl.x, tr.y - tl.y)).toBeCloseTo(300, 3); // midpoint width
        expect(Math.hypot(bl.x - tl.x, bl.y - tl.y)).toBeCloseTo(200, 3); // midpoint height
    });

    test("t=0, with scaled parentCTM → converts delta to parent-local space correctly", () => {
        // parentCTM with 0.5x scale: viewport pixels = 0.5 * SVG user units.
        // A viewport delta of -390px corresponds to -780 SVG units, not -390.
        // Without applying parentCTMInverse the compensation would be off by 2x.
        const parentCTM = new DOMMatrix().scale(0.5);
        const parentCTMInverse = parentCTM.inverse();
        // Poses in viewport pixels
        const from = pose(60, 100, 200, 150);
        const to = pose(450, 300, 300, 100);
        const m = buildCompensationMatrix(from, to, parentCTM, 0)!;

        // M operates in parent-local (SVG unit) space.
        // Verify: M maps (parentCTMInverse * toPose_corner) → (parentCTMInverse * fromPose_corner)
        const toTL_local = new DOMPoint(to.x, to.y).matrixTransform(
            parentCTMInverse,
        );
        const fromTL_local = new DOMPoint(from.x, from.y).matrixTransform(
            parentCTMInverse,
        );
        const result = toTL_local.matrixTransform(m);
        expect(result.x).toBeCloseTo(fromTL_local.x, 3);
        expect(result.y).toBeCloseTo(fromTL_local.y, 3);
    });

    test("t=0, rotation + translation → toPose center maps to fromPose center", () => {
        // Both poses rotated, with a center delta. The matrix must move the
        // (rotation-aware) toPose center onto the fromPose center. With the old
        // naive x+w/2 center this fails for any nonzero rotation.
        const from = pose(300, 300, 200, 100, Math.PI / 2);
        const to = pose(100, 100, 200, 100, 0);
        const m = buildCompensationMatrix(from, to, identity, 0)!;
        const fromCenter = poseCenter(from);
        const toCenter = poseCenter(to);
        const mapped = new DOMPoint(toCenter.x, toCenter.y).matrixTransform(m);
        expect(mapped.x).toBeCloseTo(fromCenter.x, 3);
        expect(mapped.y).toBeCloseTo(fromCenter.y, 3);
    });

    test("t=0.5, rotated poses → center is midpoint of pose centers", () => {
        const from = pose(300, 300, 200, 100, Math.PI / 2);
        const to = pose(100, 100, 200, 100, 0);
        const m = buildCompensationMatrix(from, to, identity, 0.5)!;
        const fromCenter = poseCenter(from);
        const toCenter = poseCenter(to);
        const mapped = new DOMPoint(toCenter.x, toCenter.y).matrixTransform(m);
        expect(mapped.x).toBeCloseTo((fromCenter.x + toCenter.x) / 2, 3);
        expect(mapped.y).toBeCloseTo((fromCenter.y + toCenter.y) / 2, 3);
    });

    test("t=0, with rotation → element rotates to fromPose rotation", () => {
        const angle = Math.PI / 4; // 45 degrees
        const from = pose(100, 100, 200, 200, angle);
        const to = pose(100, 100, 200, 200, 0);
        const m = buildCompensationMatrix(from, to, identity, 0)!;
        // The matrix should encode a 45-degree rotation
        // For a rotation matrix R(θ): a=cos(θ), b=sin(θ)
        expect(m.a).toBeCloseTo(Math.cos(angle), 3);
        expect(m.b).toBeCloseTo(Math.sin(angle), 3);
    });
});
