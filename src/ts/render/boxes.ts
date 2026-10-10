// Exact boxes `inkflow render --boxes` reads back from a rendered slide: every
// element with an id, each zone with its content's real extent (and the free
// space left in it), and each block of a zone's text (paragraph, list,
// heading, code, table, picture) with the extent of its text. Every box is in
// slide units (the root viewBox), after transforms, so an agent can line
// things up against what the browser actually drew instead of guessing.

import { type Box, mapBox, NOT_DRAWN, SVG_NS, snippet, union } from "./measure";

/** A box as an author writes one: corner and size, in slide units. */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface BoxEntry {
    /** The element's id, or `<zone id>/<n>` for the n-th block of a zone. */
    id: string;
    /** The tag (`rect`, `text`, `g`…), `zone`/`media`/`chart` for a zone,
     * or a block's kind (`p`, `h2`, `list`, `code`, `table`, `image`…). */
    kind: string;
    box: Rect;
    /** How many listed elements it is inside. */
    depth: number;
    /** The nearest listed element it is inside. */
    parent?: string;
    /** The start of its text. */
    text?: string;
    /** For a block: the zone it is in. */
    zone?: string;
    /** For a block: its layout box (`box` is the extent of its text). */
    block?: Rect;
    /** For a zone with text: the extent of all of it, and the zone's height
     * minus the content's (negative: the text overflows). */
    content?: Rect;
    free?: number;
    /** Not visible in this state (opacity 0, `visibility: hidden`). */
    hidden?: boolean;
}

/** Block-level content a zone's text is made of, by tag. */
export const BLOCK_KINDS: Record<string, string> = {
    p: "p",
    h1: "h1",
    h2: "h2",
    h3: "h3",
    h4: "h4",
    h5: "h5",
    h6: "h6",
    ul: "list",
    ol: "list",
    dl: "list",
    pre: "code",
    table: "table",
    blockquote: "quote",
    figure: "figure",
    img: "image",
    video: "video",
    svg: "chart",
    math: "math",
    hr: "rule",
};

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function toRect(b: Box): Rect {
    return {
        x: round1(b.left),
        y: round1(b.top),
        w: round1(b.right - b.left),
        h: round1(b.bottom - b.top),
    };
}

/** The kind a block element is listed as, or null for a container to look
 * into (reveal wrappers, highlighter divs). */
export function blockKind(el: Element): string | null {
    if (el.localName === "math" && el.getAttribute("display") !== "block")
        return null;
    return BLOCK_KINDS[el.localName] ?? null;
}

class BoxWalker {
    readonly out: BoxEntry[] = [];
    private readonly toSlide: DOMMatrix;

    constructor(private readonly svg: SVGSVGElement) {
        const ctm = svg.getScreenCTM();
        this.toSlide = ctm
            ? DOMMatrix.fromMatrix(ctm).inverse()
            : new DOMMatrix();
    }

    private box(r: DOMRectReadOnly): Box {
        return mapBox(this.toSlide, r);
    }

    run(): BoxEntry[] {
        this.walk(this.svg, 1, null, 0);
        return this.out;
    }

    private walk(
        parent: Element,
        opacity: number,
        listed: BoxEntry | null,
        depth: number,
    ): void {
        for (const el of Array.from(parent.children)) {
            if (el.namespaceURI !== SVG_NS || NOT_DRAWN.has(el.localName))
                continue;
            const style = getComputedStyle(el);
            if (style.display === "none") continue;
            const alpha = opacity * Number.parseFloat(style.opacity || "1");
            const id = el.id;
            let entry: BoxEntry | null = null;
            if (id && !id.startsWith("inkflow-")) {
                entry = this.element(el, style, alpha, listed, depth);
            }
            const inner = entry ?? listed;
            const innerDepth = entry ? depth + 1 : depth;
            if (el.localName === "foreignObject") {
                this.zoneBlocks(
                    el as SVGForeignObjectElement,
                    entry,
                    inner,
                    innerDepth,
                );
                continue;
            }
            this.walk(el, alpha, inner, innerDepth);
        }
    }

    private element(
        el: Element,
        style: CSSStyleDeclaration,
        alpha: number,
        listed: BoxEntry | null,
        depth: number,
    ): BoxEntry | null {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        const entry: BoxEntry = {
            id: el.id,
            kind: el.localName,
            box: toRect(this.box(r)),
            depth,
        };
        if (listed) entry.parent = listed.id;
        if (alpha < 0.02 || style.visibility === "hidden") entry.hidden = true;
        const zone = el.id.startsWith("zone-");
        if (el.localName === "foreignObject") {
            const media = el.querySelector(":scope > img, :scope > video");
            entry.kind = media ? "media" : "zone";
        } else if (el.localName === "svg" && zone) {
            entry.kind = "chart";
        }
        if (el.localName === "text" || entry.kind === "zone") {
            const text = snippet(el.textContent ?? "");
            if (text) entry.text = text;
        }
        this.out.push(entry);
        return entry;
    }

    /** The blocks of a zone's text, each with the extent of its text, and
     * the zone's content extent and free space. */
    private zoneBlocks(
        fo: SVGForeignObjectElement,
        zoneEntry: BoxEntry | null,
        listed: BoxEntry | null,
        depth: number,
    ): void {
        const content = fo.querySelector(
            ":scope > .inkflow-wrapper > .inkflow-content",
        );
        if (!content) return;
        const zoneId = zoneEntry?.id ?? fo.id;
        let all: Box | null = null;
        let n = 0;
        for (const block of blocksOf(content)) {
            const style = getComputedStyle(block);
            if (style.display === "none") continue;
            const layout = block.getBoundingClientRect();
            if (layout.width === 0 && layout.height === 0) continue;
            const blockBox = this.box(layout);
            const ink = this.inkOf(block) ?? blockBox;
            all = union(all, ink);
            n += 1;
            const entry: BoxEntry = {
                id: `${zoneId}/${n}`,
                kind: blockKind(block) ?? block.localName,
                box: toRect(ink),
                depth,
                zone: zoneId,
                block: toRect(blockBox),
            };
            if (listed) entry.parent = listed.id;
            const text = snippet(block.textContent ?? "");
            if (text) entry.text = text;
            if (style.visibility === "hidden" || opacityOf(block, fo) < 0.02)
                entry.hidden = true;
            this.out.push(entry);
        }
        if (zoneEntry && all) {
            zoneEntry.content = toRect(all);
            zoneEntry.free = round1(zoneEntry.box.h - (all.bottom - all.top));
        }
    }

    /** Where a block's text (and pictures) actually are: the union of its
     * line boxes, not the full width a paragraph's box takes. */
    private inkOf(block: Element): Box | null {
        if (block.namespaceURI === SVG_NS || blockKind(block) === "image") {
            return null; // a chart or picture is its own box
        }
        let ink: Box | null = null;
        const range = document.createRange();
        const walker = document.createTreeWalker(
            block,
            NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        );
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.nodeType === Node.TEXT_NODE) {
                if (!(n.textContent ?? "").trim()) continue;
                range.selectNodeContents(n);
                for (const r of Array.from(range.getClientRects())) {
                    if (r.width > 0 || r.height > 0)
                        ink = union(ink, this.box(r));
                }
            } else if (
                n instanceof Element &&
                ["img", "video", "svg", "canvas"].includes(n.localName)
            ) {
                const r = n.getBoundingClientRect();
                if (r.width > 0 || r.height > 0) ink = union(ink, this.box(r));
            }
        }
        return ink;
    }
}

/** A zone's blocks in reading order: containers (reveal wrappers, the
 * highlighter's divs) are looked into, not listed. */
export function blocksOf(container: Element): Element[] {
    const out: Element[] = [];
    for (const child of Array.from(container.children)) {
        if (blockKind(child)) out.push(child);
        else if (child.children.length) out.push(...blocksOf(child));
    }
    return out;
}

function opacityOf(el: Element, stop: Element): number {
    let alpha = 1;
    for (let e: Element | null = el; e && e !== stop; e = e.parentElement) {
        alpha *= Number.parseFloat(getComputedStyle(e).opacity || "1");
    }
    return alpha;
}

export function measureBoxes(svg: SVGSVGElement): BoxEntry[] {
    return new BoxWalker(svg).run();
}
