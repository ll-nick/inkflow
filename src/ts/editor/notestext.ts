// The notes panel's height (notes.ts), without the page: how tall it may be.

/** The height the panel has until the author drags it. */
export const NOTES_DEFAULT = 150;
/** Room for the panel's heading and two lines. */
export const NOTES_MIN = 72;
/** What is always left of the workspace for the slide above the notes. */
export const CANVAS_MIN = 160;

/** `px` as a height the panel may have in a workspace `available` px tall:
 * never smaller than its heading and a line or two, never so tall that the
 * slide above it disappears. */
export function clampHeight(px: number, available: number): number {
    const most = Math.max(NOTES_MIN, available - CANVAS_MIN);
    return Math.round(Math.min(Math.max(px, NOTES_MIN), most));
}

/** A remembered number, or null when nothing usable was remembered. */
export function readNumber(stored: string | null): number | null {
    if (stored == null || stored.trim() === "") return null;
    const n = Number(stored);
    return Number.isFinite(n) && n > 0 ? n : null;
}
