// Sections in the presented slide list (Section(...) in deck.py): each slide
// carries the section it is in (pipeline.py `SlideData.section`), and the
// slides of a section are consecutive. Pure, shared by the presenter's
// overview, picker and panel, and by the editor's grid.

export interface SectionRef {
    name: string;
    index: number;
}

export interface SectionRun {
    section: SectionRef | null;
    start: number;
    /** One past the last slide. */
    end: number;
}

/** The slides as runs of one section each (`null`: before the first). */
export function sectionRuns(
    slides: readonly { section?: SectionRef }[],
): SectionRun[] {
    const runs: SectionRun[] = [];
    slides.forEach((s, i) => {
        const section = s.section ?? null;
        const last = runs[runs.length - 1];
        if (last && (last.section?.index ?? -1) === (section?.index ?? -1)) {
            last.end = i + 1;
        } else {
            runs.push({ section, start: i, end: i + 1 });
        }
    });
    return runs;
}

/** Slide `i`'s section and its place in it (1-based), or null. */
export function sectionPosition(
    slides: readonly { section?: SectionRef }[],
    i: number,
): { name: string; at: number; of: number } | null {
    const run = sectionRuns(slides).find((r) => i >= r.start && i < r.end);
    if (!run?.section) return null;
    return {
        name: run.section.name,
        at: i - run.start + 1,
        of: run.end - run.start,
    };
}

/** Rows a wrapped grid of `cols` columns takes for these runs, each section
 * starting on a row of its own. */
export function gridRows(runs: readonly SectionRun[], cols: number): number {
    return runs.reduce((n, r) => n + Math.ceil((r.end - r.start) / cols), 0);
}

/** In a wrapped grid of boxes (reading order), the box in the next row
 * (`dir` 1) or the previous one (-1) closest to box `i` horizontally; `i`
 * itself when there is none. Rows are boxes sharing a top. */
export function verticalNeighbor(
    boxes: readonly { left: number; top: number; width: number }[],
    i: number,
    dir: 1 | -1,
): number {
    const me = boxes[i];
    if (!me) return i;
    const tops = [...new Set(boxes.map((b) => b.top))].sort((a, b) => a - b);
    const row = tops.indexOf(me.top) + dir;
    if (row < 0 || row >= tops.length) return i;
    const center = me.left + me.width / 2;
    let best = i;
    let bestD = Number.POSITIVE_INFINITY;
    boxes.forEach((b, j) => {
        if (b.top !== tops[row]) return;
        const d = Math.abs(b.left + b.width / 2 - center);
        if (d < bestD) {
            best = j;
            bestD = d;
        }
    });
    return best;
}
