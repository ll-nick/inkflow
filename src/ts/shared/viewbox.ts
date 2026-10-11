// Parsing/formatting for an SVG `viewBox` attribute — shared by every module that
// reads or writes one (the zoom camera, the overview grid, the presenter-panel
// preview, and the fade-transition backdrop). The fallback, when an attribute is
// missing or malformed, is the deck's canvas: 1920 x 1080 unless the page knows
// the deck's size (`setDeckCanvas`, from the editor model's `deckSize`).

export interface ViewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

let deckCanvas = { w: 1920, h: 1080 };

/** The deck's canvas (`Deck(size=)`), which a slide without a usable viewBox
 * is taken to have. */
export function setDeckCanvas(w: number, h: number): void {
    if (w > 0 && h > 0) deckCanvas = { w, h };
}

export function getDeckCanvas(): { w: number; h: number } {
    return { ...deckCanvas };
}

export function parseViewBox(
    attr: string | null,
    fallback = `0 0 ${deckCanvas.w} ${deckCanvas.h}`,
): ViewBox {
    const parts = (attr ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);
    const valid =
        parts.length === 4 &&
        parts.every((n) => Number.isFinite(n)) &&
        parts[2] > 0 &&
        parts[3] > 0;
    const [x, y, w, h] = valid ? parts : fallback.split(/[\s,]+/).map(Number);
    return { x, y, w, h };
}

export function formatViewBox(vb: ViewBox): string {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return `${round(vb.x)} ${round(vb.y)} ${round(vb.w)} ${round(vb.h)}`;
}
