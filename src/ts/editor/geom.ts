// Pure 2D geometry for the editor: affine matrices, boxes, and turning a move,
// resize or rotation into the attribute changes written back to the SVG file.
// Kept free of the DOM so every case is unit-tested; canvas.ts feeds it the
// matrices it reads from getScreenCTM().

export interface Mat {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

export interface Pt {
    x: number;
    y: number;
}

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function mat(m: {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}): Mat {
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

// p ∘ q: apply q first, then p.
export function multiply(p: Mat, q: Mat): Mat {
    return {
        a: p.a * q.a + p.c * q.b,
        b: p.b * q.a + p.d * q.b,
        c: p.a * q.c + p.c * q.d,
        d: p.b * q.c + p.d * q.d,
        e: p.a * q.e + p.c * q.f + p.e,
        f: p.b * q.e + p.d * q.f + p.f,
    };
}

export function invert(m: Mat): Mat {
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-12) return { ...IDENTITY };
    return {
        a: m.d / det,
        b: -m.b / det,
        c: -m.c / det,
        d: m.a / det,
        e: (m.c * m.f - m.d * m.e) / det,
        f: (m.b * m.e - m.a * m.f) / det,
    };
}

export function apply(m: Mat, p: Pt): Pt {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

// A direction vector: the linear part only.
export function applyVector(m: Mat, p: Pt): Pt {
    return { x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y };
}

export function translate(x: number, y: number): Mat {
    return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scaleAbout(sx: number, sy: number, origin: Pt): Mat {
    return {
        a: sx,
        b: 0,
        c: 0,
        d: sy,
        e: origin.x - sx * origin.x,
        f: origin.y - sy * origin.y,
    };
}

export function rotateAbout(degrees: number, origin: Pt): Mat {
    const r = (degrees * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return multiply(
        translate(origin.x, origin.y),
        multiply(
            { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 },
            translate(-origin.x, -origin.y),
        ),
    );
}

const EPS = 1e-6;

export function isTranslateOnly(m: Mat): boolean {
    return (
        Math.abs(m.a - 1) < EPS &&
        Math.abs(m.d - 1) < EPS &&
        Math.abs(m.b) < EPS &&
        Math.abs(m.c) < EPS
    );
}

export function isAxisAligned(m: Mat): boolean {
    return Math.abs(m.b) < EPS && Math.abs(m.c) < EPS;
}

// Bounding box of a box's four corners under m.
export function transformBox(m: Mat, box: Box): Box {
    const pts = [
        apply(m, { x: box.x, y: box.y }),
        apply(m, { x: box.x + box.width, y: box.y }),
        apply(m, { x: box.x, y: box.y + box.height }),
        apply(m, { x: box.x + box.width, y: box.y + box.height }),
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionBoxes(boxes: Box[]): Box | null {
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const r = Math.max(...boxes.map((b) => b.x + b.width));
    const btm = Math.max(...boxes.map((b) => b.y + b.height));
    return { x, y, width: r - x, height: btm - y };
}

// ── Number + transform formatting ──

export function fmt(n: number): string {
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? "0" : String(r);
}

export function formatTransform(m: Mat): string | null {
    if (isTranslateOnly(m)) {
        if (Math.abs(m.e) < EPS && Math.abs(m.f) < EPS) return null;
        return `translate(${fmt(m.e)},${fmt(m.f)})`;
    }
    const r = (n: number) => String(Math.round(n * 1e6) / 1e6);
    return `matrix(${r(m.a)},${r(m.b)},${r(m.c)},${r(m.d)},${fmt(m.e)},${fmt(m.f)})`;
}

// ── Attribute plans ──

// What the editor writes for one element: attribute values (null removes).
export type AttrPlan = Record<string, string | null>;

// The element facts a plan is computed from; read from the DOM by canvas.ts.
export interface ElementGeom {
    tag: string; // DOM tag (a filled zone is a foreignObject)
    sourceTag: string; // tag in the source file (data-ink-tag for zones)
    attrs: Record<string, string | null>;
    own: Mat; // the element's transform attribute, consolidated
    parentToSlide: Mat; // parent user space → slide user space
    localBox: Box; // getBBox(): geometry in the element's own user space
}

// "svg" is a cropped image's frame (a nested <svg> with a viewBox).
const BOX_TAGS = new Set(["rect", "image", "foreignObject", "use", "svg"]);

function num(v: string | null | undefined, fallback = 0): number {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? n : fallback;
}

// The element's own geometry attributes can absorb the change (no transform
// written) when its transform is a plain translate and the attribute exists in
// the source file with that meaning.
function usesBoxAttrs(g: ElementGeom): boolean {
    return (
        BOX_TAGS.has(g.sourceTag) &&
        g.sourceTag !== "use" &&
        g.attrs.width != null &&
        g.attrs.height != null &&
        isTranslateOnly(g.own)
    );
}

function transformPlan(g: ElementGeom, slideChange: Mat): AttrPlan {
    // parent space: P⁻¹ · S · P, then applied on top of the element's own transform.
    const p = g.parentToSlide;
    const inParent = multiply(invert(p), multiply(slideChange, p));
    return { transform: formatTransform(multiply(inParent, g.own)) };
}

function shiftList(value: string | null, delta: number): string | null {
    if (value == null) return null;
    const parts = value.trim().split(/[\s,]+/);
    if (!parts.length || parts.some((p) => !Number.isFinite(parseFloat(p))))
        return null;
    return parts.map((p) => fmt(parseFloat(p) + delta)).join(" ");
}

// A move by (dx, dy) in slide units.
export function planMove(
    g: ElementGeom,
    dx: number,
    dy: number,
    textChildren: { attrs: Record<string, string | null> }[] = [],
): { attrs: AttrPlan; children?: AttrPlan[] } {
    const delta = applyVector(invert(g.parentToSlide), { x: dx, y: dy });
    if (isTranslateOnly(g.own)) {
        if (usesBoxAttrs(g)) {
            return {
                attrs: {
                    x: fmt(num(g.attrs.x) + delta.x),
                    y: fmt(num(g.attrs.y) + delta.y),
                },
            };
        }
        if (g.sourceTag === "circle" || g.sourceTag === "ellipse") {
            return {
                attrs: {
                    cx: fmt(num(g.attrs.cx) + delta.x),
                    cy: fmt(num(g.attrs.cy) + delta.y),
                },
            };
        }
        if (g.sourceTag === "line") {
            return {
                attrs: {
                    x1: fmt(num(g.attrs.x1) + delta.x),
                    y1: fmt(num(g.attrs.y1) + delta.y),
                    x2: fmt(num(g.attrs.x2) + delta.x),
                    y2: fmt(num(g.attrs.y2) + delta.y),
                },
            };
        }
        if (g.sourceTag === "text") {
            // Inkscape writes absolute x/y on the text and on each line's tspan.
            const xs = shiftList(g.attrs.x ?? "0", delta.x);
            const ys = shiftList(g.attrs.y ?? "0", delta.y);
            const kids = textChildren.map((c) => {
                const plan: AttrPlan = {};
                const cx = shiftList(c.attrs.x, delta.x);
                const cy = shiftList(c.attrs.y, delta.y);
                if (cx != null) plan.x = cx;
                if (cy != null) plan.y = cy;
                return plan;
            });
            if (xs != null && ys != null) {
                return { attrs: { x: xs, y: ys }, children: kids };
            }
        }
    }
    return { attrs: { transform: prependTranslate(g.attrs.transform, delta) } };
}

const LEADING_TRANSLATE =
    /^\s*translate\(\s*([-+.\deE]+)(?:[\s,]+([-+.\deE]+))?\s*\)\s*(.*)$/s;

// A move keeps the author's transform as written (a `rotate(…)` stays a
// rotate) and only adds to, or merges into, a leading translate.
export function prependTranslate(
    transform: string | null | undefined,
    d: Pt,
): string | null {
    const original = (transform ?? "").trim();
    const m = original.match(LEADING_TRANSLATE);
    let x = d.x;
    let y = d.y;
    let rest = original;
    if (m) {
        x += parseFloat(m[1]);
        y += parseFloat(m[2] ?? "0");
        rest = m[3].trim();
    }
    // A lone matrix(…) absorbs the move into its own translation.
    const mm = rest.match(/^matrix\(([^)]*)\)$/);
    const nums =
        mm?.[1]
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number) ?? [];
    if (!m && nums.length === 6 && nums.every(Number.isFinite)) {
        const [a, b, c, dd, e, f] = nums;
        return `matrix(${a},${b},${c},${dd},${fmt(e + x)},${fmt(f + y)})`;
    }
    const zero = Math.abs(x) < EPS && Math.abs(y) < EPS;
    if (zero) return rest || null;
    const t = `translate(${fmt(x)},${fmt(y)})`;
    return rest ? `${t} ${rest}` : t;
}

// Resize the element's slide-space bounding box `from` to `to`.
export function planResize(g: ElementGeom, from: Box, to: Box): AttrPlan {
    const sx = from.width > EPS ? to.width / from.width : 1;
    const sy = from.height > EPS ? to.height / from.height : 1;
    const change = multiply(
        translate(to.x, to.y),
        multiply(
            scaleAbout(sx, sy, { x: 0, y: 0 }),
            translate(-from.x, -from.y),
        ),
    );
    const p = g.parentToSlide;
    const inParent = multiply(invert(p), multiply(change, p));
    if (isTranslateOnly(g.own) && isAxisAligned(inParent)) {
        const t = { x: g.own.e, y: g.own.f };
        const mapBox = (b: Box): Box => {
            const shifted = { ...b, x: b.x + t.x, y: b.y + t.y };
            const out = transformBox(inParent, shifted);
            return { ...out, x: out.x - t.x, y: out.y - t.y };
        };
        if (usesBoxAttrs(g)) {
            const b = mapBox({
                x: num(g.attrs.x),
                y: num(g.attrs.y),
                width: num(g.attrs.width),
                height: num(g.attrs.height),
            });
            return {
                x: fmt(b.x),
                y: fmt(b.y),
                width: fmt(b.width),
                height: fmt(b.height),
            };
        }
        if (g.sourceTag === "ellipse" || g.sourceTag === "circle") {
            const rx = num(g.attrs.rx ?? g.attrs.r);
            const ry = num(g.attrs.ry ?? g.attrs.r);
            const b = mapBox({
                x: num(g.attrs.cx) - rx,
                y: num(g.attrs.cy) - ry,
                width: 2 * rx,
                height: 2 * ry,
            });
            const cx = fmt(b.x + b.width / 2);
            const cy = fmt(b.y + b.height / 2);
            if (g.sourceTag === "circle") {
                return { cx, cy, r: fmt((b.width + b.height) / 4) };
            }
            return { cx, cy, rx: fmt(b.width / 2), ry: fmt(b.height / 2) };
        }
        if (g.sourceTag === "line") {
            const tt = translate(t.x, t.y);
            const m = multiply(invert(tt), multiply(inParent, tt));
            const p1 = apply(m, { x: num(g.attrs.x1), y: num(g.attrs.y1) });
            const p2 = apply(m, { x: num(g.attrs.x2), y: num(g.attrs.y2) });
            return {
                x1: fmt(p1.x),
                y1: fmt(p1.y),
                x2: fmt(p2.x),
                y2: fmt(p2.y),
            };
        }
    }
    return { transform: formatTransform(multiply(inParent, g.own)) };
}

// Crop a framed image (a nested <svg> with a viewBox): the frame's slide box
// goes from `from` to `to` and its viewBox follows, so the picture inside stays
// where it is and only the visible part changes. Null when the frame cannot
// take the change as plain attributes (rotated, skewed).
export function planCrop(g: ElementGeom, from: Box, to: Box): AttrPlan | null {
    const vb = (g.attrs.viewBox ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);
    if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return null;
    if (!usesBoxAttrs(g)) return null;
    const frame: Box = {
        x: num(g.attrs.x),
        y: num(g.attrs.y),
        width: num(g.attrs.width),
        height: num(g.attrs.height),
    };
    if (frame.width <= EPS || frame.height <= EPS) return null;
    const sx = from.width > EPS ? to.width / from.width : 1;
    const sy = from.height > EPS ? to.height / from.height : 1;
    const change = multiply(
        translate(to.x, to.y),
        multiply(
            scaleAbout(sx, sy, { x: 0, y: 0 }),
            translate(-from.x, -from.y),
        ),
    );
    const p = g.parentToSlide;
    const inParent = multiply(invert(p), multiply(change, p));
    if (!isAxisAligned(inParent)) return null;
    const t = { x: g.own.e, y: g.own.f };
    const moved = transformBox(inParent, {
        ...frame,
        x: frame.x + t.x,
        y: frame.y + t.y,
    });
    const next = { ...moved, x: moved.x - t.x, y: moved.y - t.y };
    const kx = vb[2] / frame.width;
    const ky = vb[3] / frame.height;
    return {
        x: fmt(next.x),
        y: fmt(next.y),
        width: fmt(next.width),
        height: fmt(next.height),
        viewBox: [
            vb[0] + (next.x - frame.x) * kx,
            vb[1] + (next.y - frame.y) * ky,
            next.width * kx,
            next.height * ky,
        ]
            .map(fmt)
            .join(" "),
    };
}

export function planRotate(
    g: ElementGeom,
    degrees: number,
    center: Pt,
): AttrPlan {
    return transformPlan(g, rotateAbout(degrees, center));
}

// Parse a transform attribute (the subset SVG allows) into one matrix.
export function parseTransform(value: string | null): Mat {
    if (!value) return { ...IDENTITY };
    let m: Mat = { ...IDENTITY };
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    for (const match of value.matchAll(re)) {
        const args = match[2]
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number);
        let t: Mat = { ...IDENTITY };
        switch (match[1]) {
            case "matrix":
                if (args.length === 6) {
                    t = {
                        a: args[0],
                        b: args[1],
                        c: args[2],
                        d: args[3],
                        e: args[4],
                        f: args[5],
                    };
                }
                break;
            case "translate":
                t = translate(args[0] ?? 0, args[1] ?? 0);
                break;
            case "scale":
                t = scaleAbout(args[0] ?? 1, args[1] ?? args[0] ?? 1, {
                    x: 0,
                    y: 0,
                });
                break;
            case "rotate":
                t = rotateAbout(args[0] ?? 0, {
                    x: args[1] ?? 0,
                    y: args[2] ?? 0,
                });
                break;
            case "skewX":
                t = {
                    ...IDENTITY,
                    c: Math.tan(((args[0] ?? 0) * Math.PI) / 180),
                };
                break;
            case "skewY":
                t = {
                    ...IDENTITY,
                    b: Math.tan(((args[0] ?? 0) * Math.PI) / 180),
                };
                break;
        }
        m = multiply(m, t);
    }
    return m;
}

// The rotation angle (degrees) a matrix applies, for the properties panel.
export function rotationOf(m: Mat): number {
    return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

// Relative path from a file's directory to a target, both absolute POSIX paths.
export function relativePath(fromFile: string, target: string): string {
    const from = fromFile.split("/").slice(0, -1).filter(Boolean);
    const to = target.split("/").filter(Boolean);
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    const up = from.slice(i).map(() => "..");
    return [...up, ...to.slice(i)].join("/");
}

/**
 * The project file a reference names, or null for one no program here opens
 * (a URL, a data: URI, a theme asset). `base` is the file the reference was
 * written in; without it the reference is relative to the project.
 */
export function projectFile(
    ref: string | null | undefined,
    base?: string,
): string | null {
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("_theme/"))
        return null;
    // The file only: not a PDF's page (#page=2) or a served version (?v=).
    const file = ref.replace(/[#?].*$/, "");
    if (file.startsWith("/")) return file;
    const parts = base ? base.split("/").slice(0, -1) : [];
    for (const part of file.split("/")) {
        if (part === "..") parts.pop();
        else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
}
