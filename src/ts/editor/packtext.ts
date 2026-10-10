// What the Pack dialogs say: pure, so it is tested without a page.
// The session's `pack` action (inkflow/pack.py) lists the ways the deck
// depends on this machine as items; packing fixes the `fixable` ones.

export interface PackItem {
    key: string;
    message: string;
    consequence: string;
    fixable: boolean;
}

export interface PackSummary {
    needed: boolean;
    items: PackItem[];
    steps: string[];
    fonts?: { warnings?: string[]; families?: string[] };
    assets?: { copies?: { from: string; to: string }[]; references?: number };
}

/** The fixable items, for the commit question: what is missing and what
 * other machines will lack without it. */
export function missingLines(summary: PackSummary): string[] {
    return summary.items.filter((i) => i.fixable).map((i) => i.message);
}

/** What committing without packing leaves others with, one sentence each
 * (deduplicated: several outside files say it once per file). */
export function consequences(summary: PackSummary): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of summary.items.filter((i) => i.fixable)) {
        const line = sentence(item.consequence);
        if (!seen.has(line)) {
            seen.add(line);
            out.push(line);
        }
    }
    return out;
}

/** What packing cannot change, for the result and the dialog's footer. */
export function remainingLines(items: PackItem[]): string[] {
    return items.filter((i) => !i.fixable).map((i) => sentence(i.message));
}

/** The button title saying in one line why "Commit without packing" is not
 * recommended: the first consequence, and how many more. */
export function withoutPackingTitle(summary: PackSummary): string {
    const all = consequences(summary);
    if (!all.length) return "Commit as it is";
    const more = all.length > 1 ? ` (and ${all.length - 1} more)` : "";
    return `Not recommended: ${all[0]}${more}`;
}

export function sentence(text: string): string {
    const t = text.trim();
    if (!t) return t;
    const first = t[0].toUpperCase() + t.slice(1);
    return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** The paths to commit after packing: the ticked ones and every file the
 * pack wrote (relative to the repository), each once. */
export function commitPaths(ticked: string[], packed: string[]): string[] {
    return [...new Set([...ticked, ...packed])];
}
