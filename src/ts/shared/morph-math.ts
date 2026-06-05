export interface AbsolutePose {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number; // radians
}

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

// Absolute-space center of an oriented pose. `x`/`y` is the (possibly rotated)
// top-left corner and `width`/`height` are edge lengths along the box's own
// axes, so the center must be reached by stepping half an edge along each
// rotated axis — not by naive `x + width/2`, which only holds at rotation 0.
export function poseCenter(pose: AbsolutePose): { x: number; y: number } {
    const cos = Math.cos(pose.rotation);
    const sin = Math.sin(pose.rotation);
    const halfWidth = pose.width / 2;
    const halfHeight = pose.height / 2;
    return {
        x: pose.x + halfWidth * cos - halfHeight * sin,
        y: pose.y + halfWidth * sin + halfHeight * cos,
    };
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
    const rgbMatch = colorString.match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\)/);
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
    for (const attribute of INTERPOLATED_ATTRIBUTES) {
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

// The per-axis scale the compensation applies at a given progress: fromSize/toSize
// at progress 0, decaying to 1 at progress 1. Exposed so the presenter can divide
// it back out of length attributes (rx, ry, stroke-width) and text, which must not
// stretch with the box.
export function compensationScale(
    fromPose: AbsolutePose,
    toPose: AbsolutePose,
    easedProgress: number,
): { x: number; y: number } {
    const remainingProgress = 1 - easedProgress;
    return {
        x:
            toPose.width > 0
                ? 1 + (fromPose.width / toPose.width - 1) * remainingProgress
                : 1,
        y:
            toPose.height > 0
                ? 1 + (fromPose.height / toPose.height - 1) * remainingProgress
                : 1,
    };
}

// Returns the DOMMatrix that, prepended to an element's own transform,
// makes it appear at lerp(fromPose, toPose, easedProgress) in absolute space.
// Returns null (identity) when easedProgress >= 1.
export function buildCompensationMatrix(
    fromPose: AbsolutePose,
    toPose: AbsolutePose,
    parentCTM: DOMMatrix,
    easedProgress: number,
): DOMMatrix | null {
    if (easedProgress >= 1) return null;
    const remainingProgress = 1 - easedProgress;
    const parentCTMInverse = parentCTM.inverse();

    const fromCenter = poseCenter(fromPose);
    const toCenter = poseCenter(toPose);

    // Center delta in absolute space, converted to parent-local space (linear part only)
    const absoluteDeltaX = fromCenter.x - toCenter.x;
    const absoluteDeltaY = fromCenter.y - toCenter.y;
    const localDeltaX =
        (parentCTMInverse.a * absoluteDeltaX +
            parentCTMInverse.c * absoluteDeltaY) *
        remainingProgress;
    const localDeltaY =
        (parentCTMInverse.b * absoluteDeltaX +
            parentCTMInverse.d * absoluteDeltaY) *
        remainingProgress;

    const { x: compensationScaleX, y: compensationScaleY } = compensationScale(
        fromPose,
        toPose,
        easedProgress,
    );
    const rotationDeltaDegrees =
        (fromPose.rotation - toPose.rotation) *
        (180 / Math.PI) *
        remainingProgress;

    // Pivot = center of toPose in parent-local space
    const toPoseCenter = new DOMPoint(toCenter.x, toCenter.y).matrixTransform(
        parentCTMInverse,
    );
    const pivotX = toPoseCenter.x;
    const pivotY = toPoseCenter.y;

    return new DOMMatrix()
        .translate(pivotX + localDeltaX, pivotY + localDeltaY)
        .scale(compensationScaleX, compensationScaleY)
        .rotate(rotationDeltaDegrees)
        .translate(-pivotX, -pivotY);
}
