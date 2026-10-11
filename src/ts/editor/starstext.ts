// Starred slides (stars.ts), without the page: which slides a star command
// means, and the words on its controls.

/** The slides (deck indices) a star command acts on: the ones picked in the
 * slide list or the grid when that is where the author is working, else the
 * slide being edited. */
export function starTargets(
    focus: "canvas" | "sorter",
    picked: ReadonlySet<number>,
    current: number,
): number[] {
    if (focus === "sorter" && picked.size) {
        return [...picked].sort((a, b) => a - b);
    }
    return [current];
}

/** Whether a command on these slides stars them: yes unless every one of
 * them is starred already (then it takes the stars off). */
export function starsOn(
    ids: readonly (string | undefined)[],
    starred: ReadonlySet<string>,
): boolean {
    return !ids.every((id) => id != null && starred.has(id));
}

export function starTitle(starred: boolean): string {
    return starred ? "Starred: take the star off (S)" : "Star this slide (S)";
}

/** The grid's filter button, with how many slides it would leave. */
export function filterLabel(count: number): string {
    return `Starred only (${count})`;
}

/** The slides of `indices` that are starred, order kept. */
export function onlyStarred(
    indices: readonly number[],
    isStarred: (index: number) => boolean,
): number[] {
    return indices.filter(isStarred);
}
