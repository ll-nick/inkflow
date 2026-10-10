// Layout measurements `inkflow render` reads back from a rendered slide: text
// that does not fit its zone, drawings outside the slide, text too small to
// read. Every length is in slide units (the root viewBox), the numbers an
// author sees in the SVG. The checks are deliberately conservative: a finding
// an author has to learn to ignore is worse than none.
//
// A printed slide (a poster: `PrintCheck`) is checked as paper instead: text
// sizes in points against the sheet's type scale, and each raster picture's
// resolution at its printed size.

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** How far something reaches past each side of a box (0 = not past it). */
export interface Overhang {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export type Finding =
    /** A zone's text (Markdown) reaches past the zone. */
    | ({ kind: "overflow"; target: string } & Overhang)
    /** A code block (or other scrolling box) in a zone is cut off. */
    | ({ kind: "clipped"; target: string; what: string } & Overhang)
    /** A drawn object reaches past the slide's edges, or lies wholly outside. */
    | ({ kind: "outside"; target: string; entirely: boolean } & Overhang)
    /** Text whose rendered size in slide units is below the readable minimum. */
    | {
          kind: "small-text";
          target: string;
          size: number;
          min: number;
          text: string;
          /** Print: sizes in points, and whether it is body text. */
          unit?: "pt";
          body?: boolean;
      }
    /** Print: a raster picture with too few pixels for its printed size. */
    | {
          kind: "low-res";
          target: string;
          dpi: number;
          min: number;
          problem: boolean;
          text: string;
      };

/** How a printed slide is checked (`inkflow render` on a print deck). */
export interface PrintCheck {
    /** Printed points per slide unit. */
    ptPerUnit: number;
    /** Any text below this many points is a hint. */
    minPt: number;
    /** Body text (paragraphs, lists, tables) below this many points is a hint. */
    bodyPt: number;
}

/** Below this a picture prints visibly soft: a hint. */
export const PRINT_DPI_HINT = 150;
/** Below this it prints pixelated: a problem. */
export const PRINT_DPI_PROBLEM = 100;

/** Pixel sizes of the pictures on the slide, by URL (loaded before measuring). */
export type NaturalSizes = Map<string, { w: number; h: number }>;

/** Elements whose text is body text on a poster. */
const BODY_TEXT = new Set(["p", "li", "td", "dd", "blockquote"]);

/** The resolution a picture of `natural` pixels prints at in a `box` of
 * `boxIn` inches, as `fit` places it (contain: whole picture inside the box;
 * cover: the box filled, the picture cut). */
export function printedDpi(
    natural: { w: number; h: number },
    boxIn: { w: number; h: number },
    fit: "contain" | "cover" | "fill",
): number {
    if (natural.w <= 0 || natural.h <= 0 || boxIn.w <= 0 || boxIn.h <= 0) {
        return Number.POSITIVE_INFINITY;
    }
    const sx = boxIn.w / natural.w;
    const sy = boxIn.h / natural.h;
    if (fit === "fill") return Math.min(1 / sx, 1 / sy);
    const inchesPerPixel =
        fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
    return 1 / inchesPerPixel;
}

/** A picture's URL is vector (SVG, a PDF page) rather than pixels. */
export function isVector(url: string): boolean {
    const clean = url.split(/[?#]/)[0].toLowerCase();
    return (
        clean.endsWith(".svg") ||
        clean.endsWith(".svgz") ||
        clean.endsWith(".pdf") ||
        url.startsWith("data:image/svg")
    );
}

/** Overhangs smaller than this (slide units) are rounding, not layout. */
export const TOLERANCE = 2;

/** Text below this fraction of the slide's height is reported as too small. */
export const MIN_TEXT_FRACTION = 1 / 80;

export function union(a: Box | null, b: Box): Box {
    if (!a) return { ...b };
    return {
        left: Math.min(a.left, b.left),
        top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
    };
}

export function overhang(inner: Box, outer: Box): Overhang {
    return {
        top: Math.max(0, outer.top - inner.top),
        right: Math.max(0, inner.right - outer.right),
        bottom: Math.max(0, inner.bottom - outer.bottom),
        left: Math.max(0, outer.left - inner.left),
    };
}

/** The overhang with sides under the tolerance zeroed, or null if none is left. */
export function significant(
    o: Overhang,
    tolerance = TOLERANCE,
): Overhang | null {
    const kept: Overhang = { top: 0, right: 0, bottom: 0, left: 0 };
    let any = false;
    for (const side of ["top", "right", "bottom", "left"] as const) {
        if (o[side] > tolerance) {
            kept[side] = Math.round(o[side]);
            any = true;
        }
    }
    return any ? kept : null;
}

/** Does `box` span the whole canvas in at least one direction (a background, a band)? */
export function spansCanvas(
    box: Box,
    canvas: Box,
    tolerance = TOLERANCE,
): boolean {
    const wide =
        box.left <= canvas.left + tolerance &&
        box.right >= canvas.right - tolerance;
    const tall =
        box.top <= canvas.top + tolerance &&
        box.bottom >= canvas.bottom - tolerance;
    return wide || tall;
}

export function disjoint(a: Box, b: Box): boolean {
    return (
        a.right <= b.left ||
        a.left >= b.right ||
        a.bottom <= b.top ||
        a.top >= b.bottom
    );
}

/** Merge findings about the same target and kind: the furthest reach per side wins. */
export function mergeFindings(findings: Finding[]): Finding[] {
    const out: Finding[] = [];
    const byKey = new Map<string, Finding>();
    for (const f of findings) {
        const key = `${f.kind}\u0000${f.target}`;
        const seen = byKey.get(key);
        if (!seen) {
            const copy = { ...f };
            byKey.set(key, copy);
            out.push(copy);
            continue;
        }
        if (seen.kind === "small-text" && f.kind === "small-text") {
            if (f.size < seen.size) {
                seen.size = f.size;
                seen.text = f.text;
            }
        } else if (seen.kind === "low-res" && f.kind === "low-res") {
            if (f.dpi < seen.dpi) Object.assign(seen, f);
        } else if (
            seen.kind !== "small-text" &&
            f.kind !== "small-text" &&
            seen.kind !== "low-res" &&
            f.kind !== "low-res"
        ) {
            for (const side of ["top", "right", "bottom", "left"] as const) {
                seen[side] = Math.max(seen[side], f[side]);
            }
            if (seen.kind === "outside" && f.kind === "outside") {
                seen.entirely = seen.entirely && f.entirely;
            }
        }
    }
    return out;
}

export function snippet(text: string, max = 40): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── DOM measurement ──────────────────────────────────────────────────────────

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Containers whose children are never drawn where they stand. */
export const NOT_DRAWN = new Set([
    "defs",
    "clipPath",
    "mask",
    "pattern",
    "marker",
    "symbol",
    "linearGradient",
    "radialGradient",
    "filter",
    "style",
    "script",
    "title",
    "desc",
    "metadata",
]);
const GROUPS = new Set(["g", "a", "switch"]);
const PAINTED_SHAPES = new Set([
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
]);

class Measurer {
    readonly findings: Finding[] = [];
    private readonly canvas: Box;
    private readonly toSlide: DOMMatrix;
    /** Slide units per screen px. */
    private readonly unit: number;
    private readonly minText: number;

    constructor(
        private readonly svg: SVGSVGElement,
        private readonly print: PrintCheck | null = null,
        private readonly natural: NaturalSizes = new Map(),
    ) {
        const vb = svg.viewBox.baseVal;
        const w = vb && vb.width > 0 ? vb.width : svg.width.baseVal.value;
        const h = vb && vb.height > 0 ? vb.height : svg.height.baseVal.value;
        const x = vb && vb.width > 0 ? vb.x : 0;
        const y = vb && vb.height > 0 ? vb.y : 0;
        this.canvas = { left: x, top: y, right: x + w, bottom: y + h };
        const ctm = svg.getScreenCTM();
        this.toSlide = ctm
            ? DOMMatrix.fromMatrix(ctm).inverse()
            : new DOMMatrix();
        this.unit = Math.sqrt(
            Math.abs(
                this.toSlide.a * this.toSlide.d -
                    this.toSlide.b * this.toSlide.c,
            ),
        );
        this.minText = h * MIN_TEXT_FRACTION;
    }

    run(): Finding[] {
        this.walk(this.svg, 1);
        return mergeFindings(this.findings);
    }

    /** A screen rect as a box in slide units. */
    private slideBox(r: DOMRectReadOnly): Box {
        return mapBox(this.toSlide, r);
    }

    private walk(parent: Element, opacity: number): void {
        for (const el of Array.from(parent.children)) {
            if (el.namespaceURI !== SVG_NS || NOT_DRAWN.has(el.localName))
                continue;
            const style = getComputedStyle(el);
            if (style.display === "none") continue;
            // Clipped or masked on purpose (crops, media zones): what shows is
            // decided by the clip, not by the element's box.
            if (
                style.clipPath !== "none" ||
                (style.mask !== "none" && style.mask !== "")
            )
                continue;
            const alpha = opacity * Number.parseFloat(style.opacity || "1");
            if (alpha < 0.02) continue;
            if (GROUPS.has(el.localName)) {
                this.walk(el, alpha);
                continue;
            }
            if (style.visibility === "hidden") continue;
            if (el.localName === "image") {
                this.picture(el, (el as SVGImageElement).href.baseVal);
            }
            if (el.localName === "foreignObject") {
                this.zone(el as SVGForeignObjectElement);
            } else if (el.localName === "text") {
                this.svgText(el as SVGTextElement, style);
            } else if (el.localName === "svg") {
                this.nestedSvg(el as SVGSVGElement);
            }
            if (
                PAINTED_SHAPES.has(el.localName) &&
                style.fill === "none" &&
                style.stroke === "none"
            ) {
                continue;
            }
            this.outside(el);
        }
    }

    /** Does a drawn object reach past the slide? */
    private outside(el: Element): void {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const box = this.slideBox(rect);
        const over = significant(overhang(box, this.canvas));
        if (!over || spansCanvas(box, this.canvas)) return;
        this.findings.push({
            kind: "outside",
            target: describe(el),
            entirely: disjoint(box, this.canvas),
            ...over,
        });
    }

    /** A chart or crop frame: its text is checked for size, its box by `outside`. */
    private nestedSvg(el: SVGSVGElement): void {
        for (const text of Array.from(el.querySelectorAll("text"))) {
            const style = getComputedStyle(text);
            if (style.display !== "none" && style.visibility !== "hidden") {
                this.svgText(text, style);
            }
        }
    }

    private svgText(
        el: SVGTextElement | SVGTSpanElement,
        style: CSSStyleDeclaration,
    ): void {
        const text = el.textContent ?? "";
        if (!text.trim()) return;
        const ctm = el.getScreenCTM();
        if (!ctm) return;
        const size =
            Number.parseFloat(style.fontSize) * scaleOf(ctm) * this.unit;
        this.smallText(el, size, text);
    }

    private smallText(
        el: Element,
        size: number,
        text: string,
        holder: Element | null = null,
    ): void {
        if (!(size > 0)) return;
        if (this.print) {
            const pt = size * this.print.ptPerUnit;
            const body = !!holder?.closest(Array.from(BODY_TEXT).join(","));
            const min = body ? this.print.bodyPt : this.print.minPt;
            if (pt >= min) return;
            this.findings.push({
                kind: "small-text",
                target: describe(el),
                size: Math.round(pt * 10) / 10,
                min: Math.round(min * 10) / 10,
                text: snippet(text),
                unit: "pt",
                body,
            });
            return;
        }
        if (size >= this.minText) return;
        this.findings.push({
            kind: "small-text",
            target: describe(el),
            size: Math.round(size * 10) / 10,
            min: Math.round(this.minText * 10) / 10,
            text: snippet(text),
        });
    }

    /** Print: does a raster picture have pixels enough for its printed size? */
    private picture(el: Element, href: string): void {
        if (!this.print || !href || isVector(href)) return;
        if (el.hasAttribute("data-inkflow-pdf")) return;
        const url = new URL(href, document.baseURI).href;
        const natural = this.natural.get(url);
        if (!natural) return;
        const rect = el.getBoundingClientRect();
        const box = this.slideBox(rect);
        const inch = this.print.ptPerUnit / 72;
        const boxIn = {
            w: (box.right - box.left) * inch,
            h: (box.bottom - box.top) * inch,
        };
        const dpi = printedDpi(natural, boxIn, fitOf(el));
        if (!(dpi < PRINT_DPI_HINT)) return;
        this.findings.push({
            kind: "low-res",
            target: describe(el),
            dpi: Math.round(dpi),
            min: PRINT_DPI_HINT,
            problem: dpi < PRINT_DPI_PROBLEM,
            text: snippet(
                decodeURIComponent(
                    href.split(/[?#]/)[0].split("/").pop() ?? href,
                ),
                40,
            ),
        });
    }

    /** A zone holding HTML: does its content fit inside it? */
    private zone(fo: SVGForeignObjectElement): void {
        const ctm = fo.getScreenCTM();
        // A rotated or skewed zone's screen rects are not its layout boxes.
        if (!ctm || Math.abs(ctm.b) > 1e-6 || Math.abs(ctm.c) > 1e-6) return;
        const target = describe(fo);
        const zoneBox = this.slideBox(fo.getBoundingClientRect());
        const pxToSlide = scaleOf(ctm) * this.unit;
        let content: Box | null = null;
        const add = (r: DOMRectReadOnly) => {
            if (r.width > 0 || r.height > 0)
                content = union(content, this.slideBox(r));
        };
        const range = document.createRange();
        const visit = (node: Node): void => {
            for (const child of Array.from(node.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE) {
                    const text = child.textContent ?? "";
                    if (!text.trim()) continue;
                    range.selectNodeContents(child);
                    for (const r of Array.from(range.getClientRects())) add(r);
                    const holder = child.parentElement;
                    if (holder) {
                        const size =
                            Number.parseFloat(
                                getComputedStyle(holder).fontSize,
                            ) * pxToSlide;
                        this.smallText(fo, size, text, holder);
                    }
                    continue;
                }
                if (!(child instanceof Element)) continue;
                const style = getComputedStyle(child);
                if (style.display === "none" || style.visibility === "hidden")
                    continue;
                if (child.namespaceURI === SVG_NS) {
                    // An inline chart: its box counts, its text is checked for size.
                    add(child.getBoundingClientRect());
                    if (child instanceof SVGSVGElement) this.nestedSvg(child);
                    continue;
                }
                const replaced = [
                    "img",
                    "video",
                    "canvas",
                    "iframe",
                    "object",
                    "embed",
                ];
                if (replaced.includes(child.localName)) {
                    add(child.getBoundingClientRect());
                    if (child instanceof HTMLImageElement) {
                        this.picture(child, child.currentSrc || child.src);
                    }
                    continue;
                }
                const scrolls =
                    style.overflowX !== "visible" ||
                    style.overflowY !== "visible";
                if (scrolls && child instanceof HTMLElement) {
                    add(child.getBoundingClientRect());
                    this.clipped(child, target, pxToSlide);
                    // Its text is still checked for size, but not for extent.
                    this.textSizes(child, fo, pxToSlide);
                    continue;
                }
                const r = child.getBoundingClientRect();
                // Inline boxes are covered by their text; block boxes count.
                if (style.display !== "inline") add(r);
                visit(child);
            }
        };
        const wrapper = fo.querySelector(
            ":scope > .inkflow-wrapper > .inkflow-content",
        );
        if (wrapper) {
            visit(wrapper);
        } else if (fo.querySelector(":scope > img, :scope > video")) {
            // A media zone: object-fit keeps it inside; a picture is still
            // checked for its printed resolution (the shown one of a pair).
            for (const img of Array.from(fo.querySelectorAll("img"))) {
                if (getComputedStyle(img).display !== "none") {
                    this.picture(img, img.currentSrc || img.src);
                }
            }
            return;
        } else {
            visit(fo);
        }
        if (!content) return;
        const over = significant(overhang(content, zoneBox));
        if (over) this.findings.push({ kind: "overflow", target, ...over });
    }

    /** A box with scrollable overflow shows only part of its content. */
    private clipped(el: HTMLElement, target: string, pxToSlide: number): void {
        const over = significant({
            top: 0,
            left: 0,
            right: (el.scrollWidth - el.clientWidth) * pxToSlide,
            bottom: (el.scrollHeight - el.clientHeight) * pxToSlide,
        });
        if (over) {
            const what =
                el.localName === "pre" ? "code block" : `<${el.localName}>`;
            this.findings.push({ kind: "clipped", target, what, ...over });
        }
    }

    private textSizes(
        el: Element,
        fo: SVGForeignObjectElement,
        pxToSlide: number,
    ): void {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.textContent ?? "";
            if (!text.trim() || !n.parentElement) continue;
            const size =
                Number.parseFloat(getComputedStyle(n.parentElement).fontSize) *
                pxToSlide;
            this.smallText(fo, size, text, n.parentElement);
        }
    }
}

/** How a picture element fits its box: `preserveAspectRatio` for an SVG
 * `<image>` (meet by default), `object-fit` for an HTML `<img>`. */
function fitOf(el: Element): "contain" | "cover" | "fill" {
    if (el instanceof HTMLElement) {
        const fit = getComputedStyle(el).objectFit;
        if (fit === "cover") return "cover";
        if (fit === "fill") return "fill";
        return "contain";
    }
    const par = el.getAttribute("preserveAspectRatio") ?? "";
    if (par.startsWith("none")) return "fill";
    return par.includes("slice") ? "cover" : "contain";
}

function scaleOf(m: DOMMatrixReadOnly | DOMMatrix2DInit): number {
    const a = m.a ?? 1;
    const b = m.b ?? 0;
    const c = m.c ?? 0;
    const d = m.d ?? 1;
    return Math.sqrt(Math.abs(a * d - b * c));
}

export function mapBox(
    m: DOMMatrixReadOnly,
    r: { left: number; top: number; right: number; bottom: number },
): Box {
    const corners = [
        m.transformPoint(new DOMPoint(r.left, r.top)),
        m.transformPoint(new DOMPoint(r.right, r.top)),
        m.transformPoint(new DOMPoint(r.left, r.bottom)),
        m.transformPoint(new DOMPoint(r.right, r.bottom)),
    ];
    return {
        left: Math.min(...corners.map((p) => p.x)),
        top: Math.min(...corners.map((p) => p.y)),
        right: Math.max(...corners.map((p) => p.x)),
        bottom: Math.max(...corners.map((p) => p.y)),
    };
}

/** How an author finds the object: the nearest id, else its tag and text. */
export function describe(el: Element): string {
    for (let e: Element | null = el; e; e = e.parentElement) {
        if (e.localName === "svg" && e.parentElement?.id === "slide") break;
        if (e.id && !e.id.startsWith("inkflow-")) return `#${e.id}`;
    }
    const text = snippet(el.textContent ?? "", 30);
    return text ? `<${el.localName}> "${text}"` : `<${el.localName}>`;
}

export function measureSlide(
    svg: SVGSVGElement,
    print: PrintCheck | null = null,
    natural: NaturalSizes = new Map(),
): Finding[] {
    return new Measurer(svg, print, natural).run();
}
