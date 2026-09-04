// Parsing/formatting for an SVG `viewBox` attribute — shared by every module that
// reads or writes one (the zoom camera, the overview grid, the presenter-panel
// preview, and the fade-transition backdrop). All theme layouts share one canvas
// size, so `1920 1080` is the fallback when an attribute is missing or malformed.

export interface ViewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

const DEFAULT_VIEWBOX = "0 0 1920 1080";

export function parseViewBox(
    attr: string | null,
    fallback = DEFAULT_VIEWBOX,
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
