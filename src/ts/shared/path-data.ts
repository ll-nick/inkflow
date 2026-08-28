// Interpolating `d` itself, so a morph tweens the outline rather than the box around
// it. Pure string and number work: the DOM-dependent capture that feeds it lives in the
// presenter, which unit tests cannot reach.

export interface Point {
    x: number;
    y: number;
}

// Everything a `d` can express, arcs aside, normalizes to these. Two paths then compare
// structurally whether one was authored `H` and the other `L`, and a matrix applies as a
// point-by-point map, which `H`/`V` could not have survived.
export type SegmentType = "M" | "L" | "C" | "Z";

// M and L carry the endpoint. C carries [control1, control2, endpoint]. Z carries none.
export interface Segment {
    type: SegmentType;
    points: Point[];
}

// A DOMMatrix satisfies this structurally, and so does a plain object, which keeps the
// transform testable without a browser.
export interface Affine2D {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

const ARGUMENT_COUNT: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    A: 7,
};

// SVG numbers are loose: `.5`, `1.`, and `1.5.5` (two numbers). The fractional
// alternative comes first so that last case splits correctly.
const TOKEN_PATTERN =
    /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/g;

type Token = { command: string } | { value: number };

// Null on anything malformed, so a broken `d` degrades to a fallback rather than
// throwing mid-transition.
function tokenize(d: string): Token[] | null {
    const tokens: Token[] = [];
    let consumed = 0;
    TOKEN_PATTERN.lastIndex = 0;
    for (
        let match = TOKEN_PATTERN.exec(d);
        match;
        match = TOKEN_PATTERN.exec(d)
    ) {
        // Whatever sits between two tokens may only be separator whitespace or commas.
        if (/[^\s,]/.test(d.slice(consumed, match.index))) return null;
        consumed = match.index + match[0].length;
        tokens.push(
            match[1] ? { command: match[1] } : { value: Number(match[2]) },
        );
    }
    return /[^\s,]/.test(d.slice(consumed)) ? null : tokens;
}

function reflect(about: Point, control: Point): Point {
    return { x: 2 * about.x - control.x, y: 2 * about.y - control.y };
}

// Exact degree elevation: controls sit two thirds of the way from each endpoint.
function cubicFromQuadratic(from: Point, control: Point, to: Point): Point[] {
    return [
        {
            x: from.x + (2 / 3) * (control.x - from.x),
            y: from.y + (2 / 3) * (control.y - from.y),
        },
        {
            x: to.x + (2 / 3) * (control.x - to.x),
            y: to.y + (2 / 3) * (control.y - to.y),
        },
        to,
    ];
}

/**
 * Normalized absolute segments, or null for an arc (whose flags are booleans and do not
 * interpolate) or malformed data.
 *
 * One pass, because normalizing needs state the parser already tracks: current point,
 * subpath start, and the control point `S` and `T` reflect.
 */
export function parsePathData(d: string): Segment[] | null {
    const tokens = tokenize(d);
    if (!tokens || tokens.length === 0) return null;

    const segments: Segment[] = [];
    let current: Point = { x: 0, y: 0 };
    let subpathStart: Point = { x: 0, y: 0 };
    let previousCubicControl: Point | null = null;
    let previousQuadraticControl: Point | null = null;
    let previousCommand = "";
    let command = "";
    let index = 0;

    while (index < tokens.length) {
        const token = tokens[index];
        if ("command" in token) {
            command = token.command;
            index++;
        } else if (command === "") {
            return null; // coordinates before any command
        }

        const upper = command.toUpperCase();
        const relative = command !== upper;

        if (upper === "Z") {
            segments.push({ type: "Z", points: [] });
            current = subpathStart;
            previousCubicControl = null;
            previousQuadraticControl = null;
            previousCommand = upper;
            // Z takes no arguments, so a following number would loop forever.
            if (index < tokens.length && !("command" in tokens[index]))
                return null;
            continue;
        }

        const arity = ARGUMENT_COUNT[upper];
        if (arity === undefined) return null;
        const args: number[] = [];
        for (let offset = 0; offset < arity; offset++) {
            const argument = tokens[index + offset];
            if (!argument || "command" in argument) return null;
            args.push(argument.value);
        }
        index += arity;

        // Relative coordinates share one origin: the point the command began at.
        const origin = current;
        const at = (i: number): Point =>
            relative
                ? { x: origin.x + args[i], y: origin.y + args[i + 1] }
                : { x: args[i], y: args[i + 1] };

        switch (upper) {
            case "M": {
                const end = at(0);
                segments.push({ type: "M", points: [end] });
                current = end;
                subpathStart = end;
                // Further coordinate pairs after a moveto are implicit linetos.
                command = relative ? "l" : "L";
                break;
            }
            case "L": {
                const end = at(0);
                segments.push({ type: "L", points: [end] });
                current = end;
                break;
            }
            case "H": {
                const end = {
                    x: relative ? origin.x + args[0] : args[0],
                    y: origin.y,
                };
                segments.push({ type: "L", points: [end] });
                current = end;
                break;
            }
            case "V": {
                const end = {
                    x: origin.x,
                    y: relative ? origin.y + args[0] : args[0],
                };
                segments.push({ type: "L", points: [end] });
                current = end;
                break;
            }
            case "C": {
                const points: Point[] = [at(0), at(2), at(4)];
                segments.push({ type: "C", points });
                current = points[2];
                previousCubicControl = points[1];
                break;
            }
            case "S": {
                // Mirrors the previous control, but only after an actual cubic.
                const control1: Point =
                    previousCubicControl &&
                    (previousCommand === "C" || previousCommand === "S")
                        ? reflect(origin, previousCubicControl)
                        : origin;
                const points: Point[] = [control1, at(0), at(2)];
                segments.push({ type: "C", points });
                current = points[2];
                previousCubicControl = points[1];
                break;
            }
            case "Q": {
                const control = at(0);
                const end = at(2);
                segments.push({
                    type: "C",
                    points: cubicFromQuadratic(origin, control, end),
                });
                current = end;
                previousQuadraticControl = control;
                break;
            }
            case "T": {
                const control: Point =
                    previousQuadraticControl &&
                    (previousCommand === "Q" || previousCommand === "T")
                        ? reflect(origin, previousQuadraticControl)
                        : origin;
                const end = at(0);
                segments.push({
                    type: "C",
                    points: cubicFromQuadratic(origin, control, end),
                });
                current = end;
                previousQuadraticControl = control;
                break;
            }
            default:
                return null; // "A": arcs do not interpolate
        }

        if (upper !== "C" && upper !== "S") previousCubicControl = null;
        if (upper !== "Q" && upper !== "T") previousQuadraticControl = null;
        previousCommand = upper;
    }

    return segments.length > 0 ? segments : null;
}

/** Valid because normalization left only segments whose arguments are plain points. */
export function transformSegments(
    segments: Segment[],
    matrix: Affine2D,
): Segment[] {
    return segments.map((segment) => ({
        type: segment.type,
        points: segment.points.map((point) => ({
            x: matrix.a * point.x + matrix.c * point.y + matrix.e,
            y: matrix.b * point.x + matrix.d * point.y + matrix.f,
        })),
    }));
}

/** Whether two normalized paths can be interpolated segment by segment. */
export function areCompatible(from: Segment[], to: Segment[]): boolean {
    return (
        from.length === to.length &&
        from.every((segment, index) => segment.type === to[index].type)
    );
}

/** Component-wise interpolation. Callers check `areCompatible` first. */
export function interpolateSegments(
    from: Segment[],
    to: Segment[],
    t: number,
): Segment[] {
    return from.map((segment, index) => ({
        type: segment.type,
        points: segment.points.map((point, pointIndex) => {
            const target = to[index].points[pointIndex];
            return {
                x: point.x + (target.x - point.x) * t,
                y: point.y + (target.y - point.y) * t,
            };
        }),
    }));
}

// Well under a device pixel at slide scale, and cheap to rebuild every frame.
function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

export function serializePathData(segments: Segment[]): string {
    return segments
        .map((segment) =>
            segment.type === "Z"
                ? "Z"
                : `${segment.type} ${segment.points
                      .map((point) => `${round(point.x)} ${round(point.y)}`)
                      .join(" ")}`,
        )
        .join(" ");
}
