// Copy an object's look and paste it onto others (the format painter of
// PowerPoint and Google Slides, Ctrl+Alt+C / Ctrl+Alt+V): theme colour
// classes or plain colours, stroke width, dashes and caps, opacity, shadow,
// arrow heads, corner radius; between texts, the font settings; between text
// boxes, their padding, alignment and drawn box.

import { canTransform, isZone, sendSvgOps } from "./canvas";
import { toast } from "./dom";
import { ed } from "./state";
import type { Selected, SvgOp } from "./types";

const PAINT_CLASS = /^inkflow-(fill|stroke)-[\w-]+$/;
const COMMON = ["opacity", "filter"];
const PAINT = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin",
];
const MARKERS = ["marker-start", "marker-mid", "marker-end"];
const FONT = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-decoration",
    "letter-spacing",
];
const BOX_VARS = ["--inkflow-padding", "--inkflow-align", "--inkflow-valign"];
const SHAPES = "rect, ellipse, circle, path, line, polyline, polygon, text";
const LINES = new Set(["path", "line", "polyline"]);
const SHOW_SHAPE = "inkflow:show-shape";

interface CopiedStyle {
    kind: Kind;
    tag: string;
    classes: string[];
    props: Record<string, string | null>;
    radius: { rx: string | null; ry: string | null };
    showShape: boolean;
}

type Kind = "text" | "box" | "shape";

let copied: CopiedStyle | null = null;

function kindOf(el: Element): Kind {
    if (el.localName === "text") return "text";
    if (isZone(el)) return "box";
    return "shape";
}

function read(el: Element, prop: string): string | null {
    const inline = (el as SVGElement).style?.getPropertyValue(prop).trim();
    return inline || el.getAttribute(prop);
}

// The element that carries the look: a group's (or link's, or crop
// frame's) first drawn shape.
function painted(el: Element): Element | null {
    if (["g", "a", "svg"].includes(el.localName)) {
        return el.querySelector(SHAPES);
    }
    return el;
}

// Every element a paste restyles: a group's drawn shapes, each by its own
// locator in the same file.
function targets(sel: Selected): Selected[] {
    if (!["g", "a", "svg"].includes(sel.el.localName)) return [sel];
    return [...sel.el.querySelectorAll<SVGGraphicsElement>(SHAPES)]
        .filter((el) => el.hasAttribute("data-ink"))
        .map((el) => ({ ...sel, el, loc: el.getAttribute("data-ink") ?? "" }));
}

export function hasCopiedStyle(): boolean {
    return copied !== null;
}

export function copyStyle(): void {
    const sel = ed.selection[0];
    const el = sel ? painted(sel.el) : null;
    if (!el) {
        toast("Select an object to copy its style from");
        return;
    }
    const kind = kindOf(el);
    const names = [...COMMON, ...PAINT, ...MARKERS, ...FONT, ...BOX_VARS];
    copied = {
        kind,
        tag: el.localName,
        classes: [...el.classList].filter((c) => PAINT_CLASS.test(c)),
        props: Object.fromEntries(names.map((n) => [n, read(el, n)])),
        radius: { rx: el.getAttribute("rx"), ry: el.getAttribute("ry") },
        showShape: el.getAttribute(SHOW_SHAPE) === "true",
    };
    toast("Style copied: select objects and press Ctrl+Alt+V to apply it");
}

// What carries over from the copied look to one element: shapes and boxes
// share their paint, texts their fonts and colour, anything at all its
// opacity and shadow.
function propsFor(style: CopiedStyle, el: Element): string[] {
    const kind = kindOf(el);
    const props = [...COMMON];
    const shapeLike = (k: Kind) => k === "shape" || k === "box";
    if (kind === "text" && style.kind === "text") props.push(...PAINT, ...FONT);
    else if (shapeLike(kind) && shapeLike(style.kind)) props.push(...PAINT);
    if (LINES.has(el.localName) && LINES.has(style.tag)) props.push(...MARKERS);
    if (kind === "box" && style.kind === "box") props.push(...BOX_VARS);
    return props;
}

function opsFor(style: CopiedStyle, sel: Selected): SvgOp[] {
    const el = sel.el;
    const props = propsFor(style, el);
    const set: Record<string, string | null> = {};
    for (const p of props) set[p] = style.props[p] ?? null;
    const ops: SvgOp[] = [];
    // Theme colours are classes, which the server swaps (the paint op): the
    // target's token for the property goes, the copied one, if any, comes.
    for (const prop of ["fill", "stroke"]) {
        if (!props.includes(prop)) continue;
        const token = style.classes
            .find((c) => c.startsWith(`inkflow-${prop}-`))
            ?.slice(`inkflow-${prop}-`.length);
        ops.push({ kind: "paint", loc: sel.loc, prop, token });
        if (token) set[prop] = null;
    }
    const attrs: Record<string, string | null> = {};
    if (el.localName === "rect" && style.tag === "rect") {
        attrs.rx = style.radius.rx;
        attrs.ry = style.radius.ry;
    }
    if (kindOf(el) === "box" && style.kind === "box") {
        attrs[SHOW_SHAPE] = style.showShape ? "true" : null;
    }
    if (Object.keys(attrs).length) {
        ops.push({ kind: "attrs", loc: sel.loc, set: attrs });
    }
    ops.push({ kind: "style", loc: sel.loc, set });
    return ops;
}

export async function pasteStyle(): Promise<void> {
    const style = copied;
    if (!style) {
        toast("Copy a style first: select an object and press Ctrl+Alt+C");
        return;
    }
    const sels = ed.selection
        .filter((s) => canTransform(s.el))
        .flatMap(targets);
    if (!sels.length) {
        toast("Select the objects to apply the style to");
        return;
    }
    await sendSvgOps(
        sels.map((sel) => ({ sel, ops: opsFor(style, sel) })),
        "Paste style",
    );
}
