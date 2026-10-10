// Text contrast for `inkflow render`: each run of text's colour against what is
// actually behind it, by WCAG 2's contrast ratio.
//
// The background is measured, not guessed from the markup: `inkflow render`
// screenshots the slide twice, as shown and with every text's paint (and text
// shadow) made transparent (`hideText`, which keeps everything else: boxes,
// code-block backgrounds, pictures). Pixels that differ between the two are
// where the glyphs are; the background is read from the second shot at exactly
// those pixels, so a label's box sticking out of the badge it sits on does not
// count, and a picture behind text counts where the letters are. The worst
// tenth of those samples decides (a light patch in a photo is found; a few
// anti-aliased edge pixels are not). Text with a thick stroke of another
// colour is read against its stroke (a halo); a text shadow counts where it
// helps; semi-transparent text is blended over each sample first.

import { describe, NOT_DRAWN, SVG_NS, snippet } from "./measure";

export type Rgb = [number, number, number];

/** WCAG's minimum ratios: normal text, and large text (and the floor
 * below which any text is a problem). */
export const NORMAL_RATIO = 4.5;
export const LARGE_RATIO = 3;

/** Large text, in px on a 1080 px tall slide: 18 pt, or 14 pt bold. */
export const LARGE_PX = 24;
export const LARGE_BOLD_PX = 18.66;

/** The share of the background samples that decides: the worst tenth. */
export const WORST_FRACTION = 0.1;

/** Pixels differing by more than this (sum over channels) are glyph pixels. */
export const GLYPH_DIFF = 24;

/** Fewer glyph pixels than this (per run) and the whole box is sampled. */
const MIN_GLYPH_PIXELS = 6;

export interface ContrastFinding {
    kind: "contrast";
    target: string;
    ratio: number;
    needs: number;
    text: string;
    color: string;
    background: string;
}

// ── colour maths (pure) ──────────────────────────────────────────────────────

function channel(c: number): number {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB colour (0–255 channels). */
export function luminance([r, g, b]: Rgb): number {
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of two colours (1 to 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at `alpha` painted over `bg`. */
export function blend(fg: Rgb, alpha: number, bg: Rgb): Rgb {
    return [
        fg[0] * alpha + bg[0] * (1 - alpha),
        fg[1] * alpha + bg[1] * (1 - alpha),
        fg[2] * alpha + bg[2] * (1 - alpha),
    ];
}

/** A computed CSS colour (`rgb()`, `rgba()`, `color(srgb …)`) as channels
 * and alpha; null for anything else (`none`, `url(#gradient)`…). */
export function parseColor(css: string): { rgb: Rgb; alpha: number } | null {
    const text = css.trim();
    let m = /^rgba?\(([^)]*)\)$/i.exec(text);
    if (m) {
        const parts = m[1]
            .split(/[\s,/]+/)
            .filter(Boolean)
            .map((p) => p.trim());
        if (parts.length < 3) return null;
        const rgb = parts
            .slice(0, 3)
            .map((p) =>
                p.endsWith("%")
                    ? (Number.parseFloat(p) * 255) / 100
                    : Number.parseFloat(p),
            ) as Rgb;
        const alpha = parts[3] == null ? 1 : alphaOf(parts[3]);
        return rgb.some(Number.isNaN) ? null : { rgb, alpha };
    }
    m = /^color\(srgb\s+([^)]*)\)$/i.exec(text);
    if (m) {
        const parts = m[1].split(/[\s/]+/).filter(Boolean);
        if (parts.length < 3) return null;
        const rgb = parts
            .slice(0, 3)
            .map((p) => Number.parseFloat(p) * 255) as Rgb;
        const alpha = parts[3] == null ? 1 : alphaOf(parts[3]);
        return rgb.some(Number.isNaN) ? null : { rgb, alpha };
    }
    return null;
}

function alphaOf(p: string): number {
    const v = Number.parseFloat(p);
    return p.endsWith("%") ? v / 100 : v;
}

export function hex([r, g, b]: Rgb): string {
    const h = (v: number) =>
        Math.round(Math.min(255, Math.max(0, v)))
            .toString(16)
            .padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
}

/** Large text by WCAG, its size taken on a 1080 px tall slide. */
export function isLarge(
    size: number,
    weight: number,
    slideHeight: number,
): boolean {
    const px = (size * 1080) / slideHeight;
    return px >= LARGE_PX || (weight >= 700 && px >= LARGE_BOLD_PX);
}

/** Pixels as screenshots give them: RGBA bytes, row by row. */
export interface Pixels {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => channel(i));

/** The worst contrast of `color` (at `alpha`) against the background
 * samples (byte offsets of pixels in `bg`): the ratio a `fraction` of them
 * are at or below, and the background colour giving it. */
export function worstContrast(
    color: Rgb,
    alpha: number,
    bg: Uint8ClampedArray,
    samples: ArrayLike<number>,
    fraction = WORST_FRACTION,
    shadow: { rgb: Rgb; alpha: number } | null = null,
): { ratio: number; background: Rgb } | null {
    const n = samples.length;
    if (!n) return null;
    const ratios = new Float64Array(n);
    const lText = luminance(color);
    const ratioOf = (a: number, b: number) =>
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    for (let k = 0; k < n; k++) {
        const i = samples[k];
        const lBg =
            0.2126 * LINEAR[bg[i]] +
            0.7152 * LINEAR[bg[i + 1]] +
            0.0722 * LINEAR[bg[i + 2]];
        const under: Rgb = [bg[i], bg[i + 1], bg[i + 2]];
        const lFg = alpha >= 1 ? lText : luminance(blend(color, alpha, under));
        ratios[k] = ratioOf(lFg, lBg);
        if (shadow) {
            // A text shadow only ever helps: the text against its shadow
            // over this background, when that is the better of the two.
            const lShadow = luminance(blend(shadow.rgb, shadow.alpha, under));
            ratios[k] = Math.max(ratios[k], ratioOf(lFg, lShadow));
        }
    }
    const sorted = ratios.slice().sort();
    const ratio = sorted[Math.min(n - 1, Math.floor(n * fraction))];
    const k = ratios.indexOf(ratio);
    const i = samples[k];
    return { ratio, background: [bg[i], bg[i + 1], bg[i + 2]] };
}

/** What a run of text needs, or null when its ratio is enough: below 3:1 is
 * a problem for any text, below 4.5:1 a hint for normal-size text. */
export function needed(ratio: number, large: boolean): number | null {
    if (ratio < LARGE_RATIO) return large ? LARGE_RATIO : NORMAL_RATIO;
    if (!large && ratio < NORMAL_RATIO) return NORMAL_RATIO;
    return null;
}

/** The colour text is read against when it has an outline of its own: a
 * stroke that is opaque, thick enough to set it apart (a twentieth of the
 * font size) and of another colour than the fill (one the colour of the
 * fill only makes it bolder). */
export function haloOf(
    fill: Rgb,
    stroke: { rgb: Rgb; alpha: number } | null,
    strokeWidth: number,
    fontSize: number,
): Rgb | null {
    if (!stroke || stroke.alpha < 0.5) return null;
    if (!(strokeWidth >= fontSize / 20)) return null;
    if (contrastRatio(fill, stroke.rgb) < 1.5) return null;
    return stroke.rgb;
}

/** Keep the worst finding per target. */
export function worstPerTarget(found: ContrastFinding[]): ContrastFinding[] {
    const byTarget = new Map<string, ContrastFinding>();
    for (const f of found) {
        const seen = byTarget.get(f.target);
        if (!seen || f.ratio < seen.ratio) byTarget.set(f.target, f);
    }
    return [...byTarget.values()];
}

/** A ratio as it is printed: rounded down, so 2.97 never reads as 3. */
export function shownRatio(ratio: number): number {
    return Math.floor(ratio * 10) / 10;
}

// Emoji and other pictographs keep their own colours: not text to check.
const PICTOGRAPHS = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu;

export function readableText(text: string): string {
    return text.replace(PICTOGRAPHS, "").trim();
}

// ── the page ─────────────────────────────────────────────────────────────────

interface Run {
    el: Element;
    rects: DOMRect[];
    color: Rgb;
    alpha: number;
    halo: Rgb | null;
    shadow: { rgb: Rgb; alpha: number } | null;
    large: boolean;
    text: string;
}

/** The colour of the first of an element's text shadows. */
export function shadowColor(
    textShadow: string,
): { rgb: Rgb; alpha: number } | null {
    if (!textShadow || textShadow === "none") return null;
    const m = /(rgba?\([^)]*\)|color\(srgb[^)]*\))/i.exec(textShadow);
    const parsed = m ? parseColor(m[1]) : null;
    return parsed && parsed.alpha > 0 ? parsed : null;
}

const HIDE_ID = "inkflow-contrast-hide";

/** Every run of visible text on the slide, measured as it is shown. */
function collectRuns(svg: SVGSVGElement): Run[] {
    const vb = svg.viewBox.baseVal;
    const height = vb && vb.height > 0 ? vb.height : svg.height.baseVal.value;
    const ctm = svg.getScreenCTM();
    const unit = ctm
        ? 1 / Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c))
        : 1;
    const runs: Run[] = [];
    const range = document.createRange();

    const add = (
        holder: Element,
        nodes: Text[],
        style: CSSStyleDeclaration,
        paint: string,
        alpha: number,
        sizeSlide: number,
    ) => {
        const text = nodes.map((n) => n.textContent ?? "").join("");
        if (!readableText(text)) return;
        const parsed = parseColor(paint);
        if (!parsed || parsed.alpha * alpha < 0.1) return;
        const rects: DOMRect[] = [];
        for (const n of nodes) {
            range.selectNodeContents(n);
            for (const r of Array.from(range.getClientRects())) {
                if (r.width > 0 && r.height > 0) rects.push(r);
            }
        }
        if (!rects.length) return;
        let halo: Rgb | null = null;
        if (holder.namespaceURI === SVG_NS) {
            halo = haloOf(
                parsed.rgb,
                parseColor(style.stroke),
                Number.parseFloat(style.strokeWidth),
                Number.parseFloat(style.fontSize),
            );
        }
        runs.push({
            el: holder,
            rects,
            color: parsed.rgb,
            alpha: parsed.alpha * alpha,
            halo,
            shadow: shadowColor(style.textShadow),
            large: isLarge(
                sizeSlide,
                Number.parseFloat(style.fontWeight) || 400,
                height,
            ),
            text,
        });
    };

    const walk = (parent: Element, opacity: number): void => {
        for (const el of Array.from(parent.children)) {
            const style = getComputedStyle(el);
            if (style.display === "none") continue;
            const alpha = opacity * Number.parseFloat(style.opacity || "1");
            if (alpha < 0.1) continue;
            if (el.namespaceURI === SVG_NS) {
                if (NOT_DRAWN.has(el.localName)) continue;
                if (["text", "tspan", "textPath"].includes(el.localName)) {
                    if (style.visibility !== "hidden") {
                        const own = directText(el);
                        const elCtm = (el as SVGGraphicsElement).getScreenCTM();
                        if (own.length && elCtm) {
                            const scale = Math.sqrt(
                                Math.abs(elCtm.a * elCtm.d - elCtm.b * elCtm.c),
                            );
                            const fillOpacity = Number.parseFloat(
                                style.fillOpacity || "1",
                            );
                            add(
                                el,
                                own,
                                style,
                                style.fill,
                                alpha * fillOpacity,
                                Number.parseFloat(style.fontSize) *
                                    scale *
                                    unit,
                            );
                        }
                    }
                    walk(el, alpha);
                    continue;
                }
                walk(el, alpha);
                continue;
            }
            // HTML inside a zone.
            if (style.visibility !== "hidden") {
                const own = directText(el);
                if (own.length) {
                    const fo = el.closest("foreignObject");
                    const pxToSlide = fo ? htmlScaleOf(fo, unit) : unit;
                    add(
                        el,
                        own,
                        style,
                        style.color,
                        alpha,
                        Number.parseFloat(style.fontSize) * pxToSlide,
                    );
                }
            }
            walk(el, alpha);
        }
    };
    walk(svg, 1);
    return runs;
}

const htmlScale = new WeakMap<Element, number>();

function htmlScaleOf(fo: Element, unit: number): number {
    const known = htmlScale.get(fo);
    if (known != null) return known;
    const ctm = (fo as SVGGraphicsElement).getScreenCTM();
    const scale = ctm ? Math.sqrt(Math.abs(ctm.a * ctm.d - ctm.b * ctm.c)) : 1;
    htmlScale.set(fo, scale * unit);
    return scale * unit;
}

function directText(el: Element): Text[] {
    return Array.from(el.childNodes).filter(
        (n): n is Text =>
            n.nodeType === Node.TEXT_NODE && !!(n.textContent ?? "").trim(),
    );
}

let measured: Run[] = [];

/** Measure the slide's text runs, then make every text's paint transparent
 * (nothing else changes) for the background screenshot. */
export function hideText(svg: SVGSVGElement): number {
    measured = collectRuns(svg);
    if (measured.length && !document.getElementById(HIDE_ID)) {
        const style = document.createElement("style");
        style.id = HIDE_ID;
        style.textContent =
            "#slide svg text, #slide svg tspan, #slide svg textPath" +
            " { fill: transparent !important; stroke: transparent !important; }" +
            " #slide foreignObject, #slide foreignObject *" +
            " { color: transparent !important;" +
            " -webkit-text-fill-color: transparent !important;" +
            " text-decoration-color: transparent !important;" +
            " text-shadow: none !important; }";
        document.head.append(style);
    }
    return measured.length;
}

export function showText(): void {
    document.getElementById(HIDE_ID)?.remove();
}

async function pixels(png: string): Promise<ImageData> {
    const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** The contrast findings, from the slide as shown and with its text hidden
 * (base64 PNGs of the same size; `width` is the slide's width in CSS px). */
export async function checkContrast(
    shownPng: string,
    hiddenPng: string,
    width: number,
): Promise<ContrastFinding[]> {
    const [shown, hidden] = await Promise.all([
        pixels(shownPng),
        pixels(hiddenPng),
    ]);
    showText();
    const scale = hidden.width / width;
    const found: ContrastFinding[] = [];
    for (const run of measured) {
        let verdict: { ratio: number; background: Rgb } | null;
        if (run.halo) {
            verdict = {
                ratio: contrastRatio(run.color, run.halo),
                background: run.halo,
            };
        } else {
            verdict = worstContrast(
                run.color,
                run.alpha,
                hidden.data,
                backgroundSamples(run.rects, shown, hidden, scale),
                WORST_FRACTION,
                run.shadow,
            );
        }
        if (!verdict) continue;
        const needs = needed(verdict.ratio, run.large);
        if (needs == null) continue;
        found.push({
            kind: "contrast",
            target: describe(run.el),
            ratio: shownRatio(verdict.ratio),
            needs,
            text: snippet(readableText(run.text)),
            color: hex(run.color),
            background: hex(verdict.background),
        });
    }
    measured = [];
    return worstPerTarget(found);
}

/** The background behind a run's glyphs, as byte offsets into the
 * hidden shot: the pixels inside its boxes where the two shots differ,
 * else (text the colour of what is behind it shows no difference) every
 * pixel of its boxes. */
export function backgroundSamples(
    rects: { left: number; top: number; right: number; bottom: number }[],
    shown: Pixels,
    hidden: Pixels,
    scale: number,
): number[] {
    const glyphs: number[] = [];
    const all: number[] = [];
    const a = shown.data;
    const b = hidden.data;
    for (const r of rects) {
        const x0 = Math.max(0, Math.floor(r.left * scale));
        const y0 = Math.max(0, Math.floor(r.top * scale));
        const x1 = Math.min(hidden.width, Math.ceil(r.right * scale));
        const y1 = Math.min(hidden.height, Math.ceil(r.bottom * scale));
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = (y * hidden.width + x) * 4;
                all.push(i);
                const diff =
                    Math.abs(a[i] - b[i]) +
                    Math.abs(a[i + 1] - b[i + 1]) +
                    Math.abs(a[i + 2] - b[i + 2]);
                if (diff > GLYPH_DIFF) glyphs.push(i);
            }
        }
    }
    return glyphs.length >= MIN_GLYPH_PIXELS ? glyphs : all;
}
