// Sections of the slide list (Section(...) in deck.py): pure arithmetic over
// the model's `sections` (each {name, start, count} in deck indices), shared
// by the slide list and the grid view. Slides before the first section belong
// to none (`null`).

import type { SectionInfo } from "./types";

/** The section deck index `i` is in, or null (before the first section). */
export function sectionOf(sections: SectionInfo[], i: number): number | null {
    for (let k = 0; k < sections.length; k++) {
        const s = sections[k];
        if (i >= s.start && i < s.start + s.count) return k;
    }
    return null;
}

/** The deck indices of section `k`. */
export function sectionSlides(sections: SectionInfo[], k: number): number[] {
    const s = sections[k];
    if (!s) return [];
    return Array.from({ length: s.count }, (_, j) => s.start + j);
}

/** How many slides come before the first section. */
export function unsectioned(sections: SectionInfo[], n: number): number {
    return sections.length ? sections[0].start : n;
}

export type Row =
    | { kind: "header"; section: number }
    | { kind: "slide"; index: number };

/** The slide list's rows: each section's header above its slides, which a
 * collapsed section leaves out. */
export function sorterRows(
    n: number,
    sections: SectionInfo[],
    collapsed: (k: number) => boolean,
): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < unsectioned(sections, n); i++) {
        rows.push({ kind: "slide", index: i });
    }
    sections.forEach((s, k) => {
        rows.push({ kind: "header", section: k });
        if (collapsed(k)) return;
        for (let j = 0; j < s.count; j++) {
            rows.push({ kind: "slide", index: s.start + j });
        }
    });
    return rows;
}

/** The blocks of the grid view: the unsectioned slides (section null, only
 * when there are any), then one per section. */
export function sectionBlocks(
    n: number,
    sections: SectionInfo[],
): { section: number | null; slides: number[] }[] {
    const blocks: { section: number | null; slides: number[] }[] = [];
    const first = unsectioned(sections, n);
    if (first > 0 || !sections.length) {
        blocks.push({
            section: null,
            slides: Array.from({ length: first }, (_, i) => i),
        });
    }
    sections.forEach((_, k) => {
        blocks.push({ section: k, slides: sectionSlides(sections, k) });
    });
    return blocks;
}

export interface MoveRequest {
    slides: number[];
    to: number;
    section: number | null;
}

/** The session's `move` for dropping `moved` so they land at `insertAt` (an
 * index into the list as it is now) in `section`: `to` counts the list
 * without the moved slides. null when nothing would change. */
export function moveRequest(
    sections: SectionInfo[],
    moved: number[],
    insertAt: number,
    section: number | null,
): MoveRequest | null {
    const slides = [...new Set(moved)].sort((a, b) => a - b);
    if (!slides.length) return null;
    const to = insertAt - slides.filter((i) => i < insertAt).length;
    // Unchanged: one contiguous run dropped onto its own place, same section.
    const contiguous = slides.every((v, j) => v === slides[0] + j);
    const sameSection = slides.every((i) => sectionOf(sections, i) === section);
    if (contiguous && sameSection && to === slides[0]) return null;
    return { slides, to, section };
}

/** Where slides dropped before (`after` false) or after slide `i` land: in
 * the section of slide `i`. */
export function dropOnSlide(
    sections: SectionInfo[],
    i: number,
    after: boolean,
): { insertAt: number; section: number | null } {
    return { insertAt: after ? i + 1 : i, section: sectionOf(sections, i) };
}

/** Where slides dropped on section `k`'s header land: first in it. */
export function dropOnHeader(
    sections: SectionInfo[],
    k: number,
): { insertAt: number; section: number } {
    return { insertAt: sections[k].start, section: k };
}

/** The `to` of a `section-move` that puts section `k` at gap `gap` (0 =
 * before the first section, `sections.length` = after the last), or null
 * when it stays where it is. */
export function sectionMoveTo(k: number, gap: number): number | null {
    const to = gap > k ? gap - 1 : gap;
    return to === k ? null : to;
}

/** The gap a dragged section lands in when dropped over slide `i` (the gap
 * before its section when `i` is in that section's first half, else the gap
 * after; before every section for an unsectioned slide). */
export function sectionGapAtSlide(sections: SectionInfo[], i: number): number {
    const k = sectionOf(sections, i);
    if (k == null) return 0;
    const s = sections[k];
    return i - s.start < s.count / 2 ? k : k + 1;
}

/** A stable key per section for remembering which are collapsed: its name and
 * which one of that name it is, so it survives a move. */
export function sectionKeys(sections: SectionInfo[]): string[] {
    const seen = new Map<string, number>();
    return sections.map((s) => {
        const n = (seen.get(s.name) ?? 0) + 1;
        seen.set(s.name, n);
        return n > 1 ? `${s.name}#${n}` : s.name;
    });
}
