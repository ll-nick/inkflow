// A rebuild as the server sends it to a page that asked for patches (`hello`
// with `patch`; inkflow/incremental.py): every slide, and every slide's entry
// in the editor's model, carries a `key` (a digest of its content), and one
// the page already holds is named by that key instead of sent again. The
// page puts the list together from what it holds; a key it does not hold
// means it missed a build, and it asks for everything (`resync`).

export interface Keyed {
    key?: string;
}

/** A list as sent: an item, or the key of one the page holds. */
export type Patch<T> = (T | string)[];

/** Whether every item was sent whole (what a page gets when it asks again,
 * and what a server sends a page that takes no patches). */
export function isWhole<T>(sent: Patch<T>): sent is T[] {
    return !sent.some((item) => typeof item === "string");
}

/** The list `sent` stands for, given the items the page holds; null when it
 * names one the page does not hold. Held items keep their identity, so
 * whatever was drawn from one is still good. */
export function applyPatch<T extends Keyed>(
    held: readonly T[],
    sent: Patch<T>,
): T[] | null {
    if (isWhole(sent)) return sent;
    const byKey = new Map<string, T>();
    for (const item of held) {
        if (item.key != null) byKey.set(item.key, item);
    }
    const out: T[] = [];
    for (const item of sent) {
        if (typeof item !== "string") {
            out.push(item);
            continue;
        }
        const mine = byKey.get(item);
        if (!mine) return null;
        out.push(mine);
    }
    return out;
}

/** Whether two lists hold the very same items in the same order. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((item, i) => item === b[i]);
}
