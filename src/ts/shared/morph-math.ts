// Attributes interpolated directly, frame by frame. These are scale-independent
// (colours, opacities) — unlike lengths such as stroke-width/rx/ry, which the
// presenter counter-scales so they don't inherit the compensation matrix's scale.
export const INTERPOLATED_ATTRIBUTES = [
    "fill",
    "stroke",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
];

export function easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export function parseColorToRGB(
    colorString: string,
): [number, number, number] | null {
    if (colorString.startsWith("#")) {
        const hexDigits = colorString.slice(1);
        if (hexDigits.length === 3)
            return hexDigits.split("").map((c) => parseInt(c + c, 16)) as [
                number,
                number,
                number,
            ];
        if (hexDigits.length === 6)
            return [0, 2, 4].map((i) =>
                parseInt(hexDigits.slice(i, i + 2), 16),
            ) as [number, number, number];
    }
    const rgbMatch = colorString.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
    return null;
}

export function interpolateColorAttribute(
    fromColor: string,
    toColor: string,
    progress: number,
): string {
    const fromRGB = parseColorToRGB(fromColor);
    const toRGB = parseColorToRGB(toColor);
    if (!fromRGB || !toRGB) return progress < 0.5 ? fromColor : toColor;
    return (
        "#" +
        fromRGB
            .map((channel, index) =>
                Math.round(channel + (toRGB[index] - channel) * progress)
                    .toString(16)
                    .padStart(2, "0"),
            )
            .join("")
    );
}

export function interpolateNumericAttribute(
    fromValue: string,
    toValue: string,
    progress: number,
): string {
    return String(
        parseFloat(fromValue) +
            (parseFloat(toValue) - parseFloat(fromValue)) * progress,
    );
}

const COLOR_ATTRIBUTES = new Set(["fill", "stroke"]);

export function interpolateAttribute(
    attribute: string,
    fromValue: string,
    toValue: string,
    progress: number,
): string {
    if (COLOR_ATTRIBUTES.has(attribute))
        return interpolateColorAttribute(fromValue, toValue, progress);
    return interpolateNumericAttribute(fromValue, toValue, progress);
}

export function readInterpolatedAttributes(
    element: Element,
): Record<string, string> {
    const result: Record<string, string> = {};
    const inlineStyle =
        element instanceof SVGElement || element instanceof HTMLElement
            ? element.style
            : null;
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
        // Prefer an inline style value. A morph in flight writes the live
        // (intermediate) colour/opacity there via style.setProperty, while the
        // attribute still holds the original target. Reading the attribute first
        // would snapshot the end value and make a mid-flight reversal jump.
        const styleValue = inlineStyle?.getPropertyValue(attribute).trim();
        if (styleValue && styleValue !== "none") {
            result[attribute] = styleValue;
            continue;
        }
        const directValue = element.getAttribute(attribute);
        if (directValue !== null && directValue !== "none") {
            result[attribute] = directValue;
            continue;
        }
        const computedValue = getComputedStyle(element)
            .getPropertyValue(attribute)
            .trim();
        if (computedValue && computedValue !== "none")
            result[attribute] = computedValue;
    }
    return result;
}

// ── 2D affine decomposition ──────────────────────────────────────────────────
//
// A morphed box is reduced to the full affine map that takes its local unit
// square to the screen (`AffineComponents`), not to a 5-DOF oriented box. The
// extra degree of freedom (skew) lets the model represent any matrix an SVG
// editor writes — rotation, non-uniform scale, *and* shear — so reconstruction
// is exact. Interpolating the decomposed components (translate, per-axis scale,
// skew, rotation) and recomposing is the same algorithm CSS uses to interpolate
// `matrix()` values.

export interface AffineComponents {
    tx: number;
    ty: number;
    scaleX: number;
    scaleY: number;
    skew: number; // tan of the skew-x angle
    rotation: number; // radians
}

// Decompose a 2D affine matrix into translate · rotate · skewX · scale.
// Reflection (negative determinant) is folded into scaleX and the rotation so
// recomposition reproduces the original orientation.
export function decomposeAffine(m: DOMMatrix): AffineComponents {
    let a = m.a;
    let b = m.b;
    let c = m.c;
    let d = m.d;
    const determinant = a * d - b * c;

    let scaleX = Math.hypot(a, b);
    if (scaleX !== 0) {
        a /= scaleX;
        b /= scaleX;
    }
    // Shear = dot of the (normalized) first row with the second row.
    let skew = a * c + b * d;
    // Make the second row orthogonal to the first.
    c -= a * skew;
    d -= b * skew;
    const scaleY = Math.hypot(c, d);
    if (scaleY !== 0) {
        skew /= scaleY;
    }
    if (determinant < 0) {
        scaleX = -scaleX;
        a = -a;
        b = -b;
    }
    return {
        tx: m.e,
        ty: m.f,
        scaleX,
        scaleY,
        skew,
        rotation: Math.atan2(b, a),
    };
}

// Inverse of decomposeAffine; the multiply order must match the decomposition.
export function recomposeAffine(c: AffineComponents): DOMMatrix {
    const skewMatrix = new DOMMatrix([1, 0, c.skew, 1, 0, 0]);
    return new DOMMatrix()
        .translate(c.tx, c.ty)
        .rotate((c.rotation * 180) / Math.PI)
        .multiply(skewMatrix)
        .scale(c.scaleX, c.scaleY);
}

function lerp(from: number, to: number, t: number): number {
    return from + (to - from) * t;
}

// Interpolate rotation along the shorter arc so a morph never spins the long way.
function lerpAngle(from: number, to: number, t: number): number {
    let delta = to - from;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return from + delta * t;
}

// Component-wise interpolation of two already-decomposed frames. Inputs are
// pre-decomposed (once, at capture) so the per-frame cost is just recompose.
export function interpolateAffine(
    from: AffineComponents,
    to: AffineComponents,
    t: number,
): DOMMatrix {
    return recomposeAffine({
        tx: lerp(from.tx, to.tx, t),
        ty: lerp(from.ty, to.ty, t),
        scaleX: lerp(from.scaleX, to.scaleX, t),
        scaleY: lerp(from.scaleY, to.scaleY, t),
        skew: lerp(from.skew, to.skew, t),
        rotation: lerpAngle(from.rotation, to.rotation, t),
    });
}

// Shear-free per-axis scale of a matrix. scaleX is the length of the first
// column; scaleY is the orthogonal (shear-removed) component of the second,
// equal to |determinant| / scaleX. Used to divide the current visual scale back
// out of length attributes (rx, ry, stroke-width) so corners stay circular.
export function matrixScaleX(m: DOMMatrix): number {
    return Math.hypot(m.a, m.b);
}

export function matrixScaleY(m: DOMMatrix): number {
    const scaleX = Math.hypot(m.a, m.b);
    if (scaleX === 0) return Math.hypot(m.c, m.d);
    return Math.abs(m.a * m.d - m.b * m.c) / scaleX;
}
