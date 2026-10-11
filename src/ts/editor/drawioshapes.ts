// The shapes of a draw.io diagram drawn into its slide (drawio_inline.py):
// each draw.io cell is a <g data-cell-id> named <diagram id>-<cell id>, which
// is what an animation targets.

export interface DiagramShape {
    id: string;
    label: string;
    el: SVGGElement;
}

/** The diagram's shapes and arrows, in drawing order. */
export function diagramShapes(svg: Element): DiagramShape[] {
    const shapes: DiagramShape[] = [];
    for (const g of svg.querySelectorAll<SVGGElement>("g[data-cell-id]")) {
        const parent = g.parentElement?.closest("g[data-cell-id]");
        // The root cell and its layers hold everything.
        if (!parent?.parentElement?.closest("g[data-cell-id]")) continue;
        const id = g.getAttribute("id");
        if (id) shapes.push({ id, label: cellLabel(g), el: g });
    }
    return shapes;
}

// A cell's own label (not the labels of cells inside it), read from its HTML
// label, else its SVG text (draw.io writes both, the text as a fallback).
export function cellLabel(g: Element): string {
    const own = (sel: string) =>
        [...g.querySelectorAll(sel)].filter(
            (el) => el.closest("g[data-cell-id]") === g,
        );
    for (const el of [...own("foreignObject"), ...own("text")]) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) return text;
    }
    return "";
}

/** A shape of a drawn diagram that an arrow can attach to, if `el` is one. */
export function attachableCell(el: Element | null): SVGGElement | null {
    const cell = el?.closest<SVGGElement>('g[data-cell-kind="vertex"][id]');
    return cell?.closest("svg[data-drawio]") ? cell : null;
}

/** The shapes of a drawn diagram that arrows can attach to. */
export function attachableCells(svg: Element): SVGGElement[] {
    return [
        ...svg.querySelectorAll<SVGGElement>('g[data-cell-kind="vertex"][id]'),
    ];
}

/**
 * What a cell's connection points sit on: its shape, not its label (which
 * may stick out) nor the cells inside it. draw.io draws a cell as its shape
 * first, then the label.
 */
export function cellShape(cell: Element): Element {
    for (const kid of cell.children) {
        if (kid.hasAttribute("data-cell-id")) continue;
        if (kid.querySelector("foreignObject, text, switch")) continue;
        return kid;
    }
    return cell;
}

// ── Editing shapes on the slide (editor/drawioedit.py) ──

export interface PageBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Whether a diagram's shapes are edited here (its "Edit shapes here"). */
export function shapesEditable(diagram: Element): boolean {
    return diagram.getAttribute("inkflow:drawio-edit") === "shapes";
}

/** A shape of a drawn diagram the editor can select and edit. */
export function isDiagramCell(el: Element): boolean {
    return (
        el.localName === "g" &&
        el.getAttribute("data-cell-kind") === "vertex" &&
        el.hasAttribute("data-ink") &&
        !!el.closest("svg[data-drawio]")
    );
}

export function median(values: number[]): number {
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// An element's box in the user space of `ref` (an ancestor).
function boxIn(el: Element, ref: Element): PageBox | null {
    const g = el as SVGGraphicsElement;
    const from = g.getScreenCTM?.();
    const to = (ref as SVGGraphicsElement).getScreenCTM?.();
    if (!from || !to || typeof g.getBBox !== "function") return null;
    const m = to.inverse().multiply(from);
    const b = g.getBBox();
    const pts = [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x, b.y + b.height],
        [b.x + b.width, b.y + b.height],
    ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
}

/**
 * Where draw.io put its page on the picture (drawn = page + offset): it
 * crops a picture to the drawing. Measured on the shapes as drawn, against
 * the boxes their drawings show (`data-cell-geometry`), so a shape moved on
 * the slide but not yet redrawn counts at its drawing's own box.
 */
export function pageOffset(diagram: Element): { x: number; y: number } | null {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const cell of diagram.querySelectorAll(
        'g[data-cell-kind="vertex"][data-cell-geometry]',
    )) {
        const geo = (cell.getAttribute("data-cell-geometry") ?? "")
            .split(/\s+/)
            .map(Number);
        // In the cell's own space: without a move it was given meanwhile.
        const b = boxIn(cellShape(cell), cell);
        if (!b || geo.length !== 4 || geo.some((v) => !Number.isFinite(v)))
            continue;
        xs.push(b.x - geo[0]);
        ys.push(b.y - geo[1]);
    }
    return xs.length ? { x: median(xs), y: median(ys) } : null;
}

/** A shape's box on draw.io's page, as it is drawn now (moved or not). */
export function pageBox(
    cell: Element,
    offset: { x: number; y: number },
): PageBox | null {
    const parent = cell.parentElement;
    const b = parent ? boxIn(cellShape(cell), parent) : null;
    if (!b) return null;
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
        x: r(b.x - offset.x),
        y: r(b.y - offset.y),
        width: r(b.width),
        height: r(b.height),
    };
}

/** A shape's box in the diagram's own coordinates (for lining up redraws). */
export function drawnBox(cell: Element, root: Element): PageBox | null {
    return boxIn(cellShape(cell), root);
}
