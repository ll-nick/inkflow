// Text size per box and shrink-to-fit, shared by every page that shows a
// slide: the presenter (and so the static build), the editor's canvas and
// thumbnails, the PDF export page and `inkflow render`. Fitting needs the
// browser's own text layout (fonts, line breaks, formulas), so it runs where
// the slide is shown, on the same rule everywhere; nothing it finds is ever
// written to a file. What the author sets is source:
//
//   --inkflow-font-scale  a factor on the zone's text (0.8 = 80 %): the zone
//                         shape's style, layout CSS, a marker's `size=`,
//                         `TextBox(size=)`; contract.css multiplies it in.
//   --inkflow-fit         `none` keeps the text at its size even when it
//                         overflows; anything else (the default) shrinks it.
//
// The fitted factor goes on the zone's wrapper as an inline
// `--inkflow-fit-scale`, which contract.css multiplies into its font size,
// so every size inside (headings, code, tables, formulas: all in em) follows.
// The foreignObject gets `data-inkflow-fit` (the factor, when shrunk) and
// `data-inkflow-overflow` (it does not fit even at the floor, or fitting is
// off), which the editor shows and `inkflow render` reports.

import { parseViewBox } from "./viewbox";

/** Text below this fraction of the slide's height is too small to read (on
 * screen; a printed slide carries its own floor, `data-inkflow-min-text`). */
export const MIN_TEXT_FRACTION = 1 / 80;

/** Shrinking never goes below this share of the box's own text size. */
export const FIT_FLOOR = 0.33;

/** The A− / A+ steps of a box's text size. */
export const TEXT_SIZE_STEPS = [
    0.5, 0.67, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 2,
] as const;

/** The range a typed size may take (manifest.TEXT_SCALE_MIN/MAX). */
export const TEXT_SCALE_MIN = 0.25;
export const TEXT_SCALE_MAX = 3;

/** How close (as a factor) the fitted size gets to the largest that fits. */
const FIT_TOLERANCE = 0.01;
/** Layout lengths are whole CSS px (slide units); this much is rounding. */
const SLACK = 1;

// ── Pure parts ──────────────────────────────────────────────────────────────

/** The next step up (`1`) or down (`-1`) from `current`; at either end the
 * size stays. A size between steps moves to the neighbouring step. */
export function nextTextSize(current: number, direction: 1 | -1): number {
    const eps = 1e-6;
    if (direction > 0) {
        return TEXT_SIZE_STEPS.find((s) => s > current + eps) ?? current;
    }
    return (
        [...TEXT_SIZE_STEPS].reverse().find((s) => s < current - eps) ?? current
    );
}

/** A typed size as a factor: `80`, `80%` and `80 %` are 80 %; `null` when it
 * is no number or outside 25–300 %. */
export function parseTextSize(text: string): number | null {
    const t = text.replace(/\s+/g, "").replace(/%$/, "");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    const scale = Math.round(n * 10) / 1000;
    return scale >= TEXT_SCALE_MIN && scale <= TEXT_SCALE_MAX ? scale : null;
}

/** A factor as people read it: `80%`. */
export function formatTextSize(scale: number): string {
    return `${Math.round(scale * 100)}%`;
}

/** The smallest factor fitting may give a box whose text is `baseSize`
 * slide units: `FIT_FLOOR` of it, or the readable minimum `minText` when
 * that is larger; never above 1 (a box already below it is left alone). */
export function floorScale(baseSize: number, minText: number): number {
    if (!(baseSize > 0)) return 1;
    return Math.min(1, Math.max(FIT_FLOOR, minText / baseSize));
}

export interface FitResult {
    /** The factor applied (1 = the text's own size). */
    scale: number;
    /** It does not fit even at `scale` (the floor), or fitting is off. */
    overflow: boolean;
}

/** The largest factor between `floor` and 1 at which `fits` holds, to within
 * `tolerance` (a bisection: fitting gets no better as the text grows). */
export function searchScale(
    fits: (scale: number) => boolean,
    floor: number,
    tolerance = FIT_TOLERANCE,
): FitResult {
    if (fits(1)) return { scale: 1, overflow: false };
    const lowest = Math.min(1, Math.max(0, floor));
    if (lowest >= 1 || !fits(lowest)) return { scale: lowest, overflow: true };
    let lo = lowest;
    let hi = 1;
    while (hi - lo > tolerance) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
    }
    return {
        scale: Math.max(lowest, Math.floor(lo * 1000) / 1000),
        overflow: false,
    };
}

/** One child of a zone's wrapper, as laid out. */
export interface LaidOut {
    height: number;
    marginTop: number;
    marginBottom: number;
    /** Takes part in the column (not `display: none`, not positioned out). */
    inFlow: boolean;
}

/** The height a zone's wrapper needs for its children. A step not reached
 * yet is transparent but laid out, so it counts: the box fits with every
 * step shown. */
export function neededHeight(children: LaidOut[]): number {
    let total = 0;
    for (const c of children) {
        if (c.inFlow) total += c.height + c.marginTop + c.marginBottom;
    }
    return total;
}

// ── In the page ─────────────────────────────────────────────────────────────

const px = (v: string) => Number.parseFloat(v) || 0;

/** The outermost `<svg>` (the slide) an element is drawn in. */
function slideSvg(el: Element): SVGSVGElement | null {
    let svg = (el as SVGElement).ownerSVGElement ?? null;
    while (svg?.ownerSVGElement) svg = svg.ownerSVGElement;
    return svg ?? (el instanceof SVGSVGElement ? el : null);
}

/** The smallest readable text on `svg`, in slide units. */
export function minTextSize(svg: Element): number {
    const own = Number.parseFloat(
        svg.getAttribute("data-inkflow-min-text") ?? "",
    );
    if (own > 0) return own;
    return parseViewBox(svg.getAttribute("viewBox")).h * MIN_TEXT_FRACTION;
}

/** Slide units per CSS px inside `fo` (a zone may be drawn scaled). */
function unitScale(fo: Element): number {
    const root = slideSvg(fo);
    const a = (fo as SVGGraphicsElement).getScreenCTM?.();
    const b = root?.getScreenCTM();
    if (!a || !b) return 1;
    const da = Math.sqrt(Math.abs(a.a * a.d - a.b * a.c));
    const db = Math.sqrt(Math.abs(b.a * b.d - b.b * b.c));
    return da > 0 && db > 0 ? da / db : 1;
}

function laidOut(wrapper: HTMLElement): LaidOut[] {
    return Array.from(wrapper.children, (el) => {
        const s = getComputedStyle(el);
        return {
            height: (el as HTMLElement).offsetHeight ?? 0,
            marginTop: px(s.marginTop),
            marginBottom: px(s.marginBottom),
            inFlow:
                s.display !== "none" &&
                s.position !== "absolute" &&
                s.position !== "fixed",
        };
    });
}

function overflows(wrapper: HTMLElement, content: HTMLElement): boolean {
    const ws = getComputedStyle(wrapper);
    const avail =
        wrapper.clientHeight - px(ws.paddingTop) - px(ws.paddingBottom);
    if (neededHeight(laidOut(wrapper)) > avail + SLACK) return true;
    // Too wide: a code block that scrolls, a table wider than the box.
    const width = content.clientWidth;
    for (const el of Array.from(content.querySelectorAll("pre, table"))) {
        const box = el as HTMLElement;
        if (box.localName === "pre") {
            if (box.scrollWidth > box.clientWidth + SLACK) return true;
        } else if (box.offsetWidth > width + SLACK) {
            return true;
        }
    }
    return false;
}

/** The height `fo`'s box needs (in its own units) to hold its text at the
 * text's own size, not shrunk: what "Make box taller" sets. */
export function neededBoxHeight(fo: Element): number | null {
    const wrapper = fo.querySelector(
        ":scope > .inkflow-wrapper",
    ) as HTMLElement | null;
    if (!wrapper) return null;
    const saved = wrapper.style.getPropertyValue("--inkflow-fit-scale");
    wrapper.style.removeProperty("--inkflow-fit-scale");
    const ws = getComputedStyle(wrapper);
    const need =
        px(ws.paddingTop) +
        px(ws.paddingBottom) +
        px(ws.borderTopWidth) +
        px(ws.borderBottomWidth) +
        neededHeight(laidOut(wrapper));
    if (saved) wrapper.style.setProperty("--inkflow-fit-scale", saved);
    return need;
}

/** Fit one zone (a foreignObject holding text) to its box; `null` when it
 * holds no text or is not laid out (hidden). */
export function fitZone(fo: Element, minText: number): FitResult | null {
    const wrapper = fo.querySelector(
        ":scope > .inkflow-wrapper",
    ) as HTMLElement | null;
    const content = wrapper?.querySelector(
        ":scope > .inkflow-content",
    ) as HTMLElement | null;
    if (!wrapper || !content) return null;
    wrapper.style.removeProperty("--inkflow-fit-scale");
    fo.removeAttribute("data-inkflow-fit");
    fo.removeAttribute("data-inkflow-overflow");
    const cs = getComputedStyle(wrapper);
    if (cs.display === "none" || wrapper.clientHeight === 0) return null;
    const apply = (scale: number) => {
        if (scale < 1)
            wrapper.style.setProperty("--inkflow-fit-scale", String(scale));
        else wrapper.style.removeProperty("--inkflow-fit-scale");
    };
    const fits = (scale: number) => {
        apply(scale);
        return !overflows(wrapper, content);
    };
    const off = cs.getPropertyValue("--inkflow-fit").trim() === "none";
    const result = off
        ? { scale: 1, overflow: !fits(1) }
        : searchScale(
              fits,
              floorScale(px(cs.fontSize) * unitScale(fo), minText),
          );
    apply(result.scale);
    if (result.scale < 1)
        fo.setAttribute("data-inkflow-fit", result.scale.toFixed(3));
    if (result.overflow) fo.setAttribute("data-inkflow-overflow", "");
    return result;
}

/** Fit every text zone of a slide (`root`: its `<svg>`, or anything holding
 * one). Run once the slide is in the page, before it shows. */
export function fitSlide(root: Element | null | undefined): void {
    if (!root) return;
    const svg =
        root instanceof SVGSVGElement ? root : root.querySelector("svg");
    if (!svg) return;
    const min = minTextSize(slideSvg(svg) ?? svg);
    for (const wrapper of Array.from(
        svg.querySelectorAll("foreignObject > .inkflow-wrapper"),
    )) {
        const fo = wrapper.parentElement;
        if (fo) fitZone(fo, min);
    }
}

const pending = new Set<Element>();
let scheduled = false;

/** Fit a slide on the next frame (a thumbnail built before it is attached):
 * one that is not in the page by then is skipped. */
export function scheduleFit(root: Element): void {
    pending.add(root);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        const roots = [...pending];
        pending.clear();
        for (const r of roots) if (r.isConnected) fitSlide(r);
    });
}

/** Call `fn` whenever web fonts finish loading (text is measured again in
 * its real font) and once the page's fonts are ready. */
export function onFontsLoaded(fn: () => void): void {
    if (typeof document === "undefined" || !document.fonts) return;
    document.fonts.addEventListener("loadingdone", () => fn());
    void document.fonts.ready.then(() => fn());
}
