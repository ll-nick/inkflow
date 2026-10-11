// The command palette's matching (palette.ts): what a typed query finds
// among commands and slides, best first. Pure, tested.

export interface Entry {
    label: string;
    group: string; // "Slide", "Git", "View"…: shown beside it, also matched
    keys?: string; // its shortcut, shown
    hint?: string; // more words matched but not shown first (a slide's id)
}

/** A palette entry that does something (the menus hand these in). */
export interface Command extends Entry {
    run: () => void;
}

/** How well `query` matches `text`, as a subsequence of its characters
 * (case ignored): higher is better, null when it does not match. Letters
 * at word starts and runs of consecutive letters count most; a match at the
 * very start most of all. */
export function score(query: string, text: string): number | null {
    const q = query.toLowerCase().replace(/\s+/g, " ").trim();
    if (!q) return 0;
    const t = text.toLowerCase();
    const direct = t.indexOf(q);
    if (direct === 0) return 1000 - t.length;
    if (direct > 0) {
        const wordStart = /[\s\-_/.:(]/.test(t[direct - 1]);
        return (wordStart ? 800 : 600) - direct - t.length / 10;
    }
    let s = 0;
    let at = 0;
    let run = 0;
    for (const ch of q) {
        if (ch === " ") continue;
        const found = t.indexOf(ch, at);
        if (found < 0) return null;
        const start = found === 0 || /[\s\-_/.:(]/.test(t[found - 1]);
        run = found === at ? run + 1 : 0;
        s += 10 + (start ? 15 : 0) + run * 5 - Math.min(found - at, 10);
        at = found + 1;
    }
    return s - t.length / 10;
}

/** The entries matching `query`, best first (ties keep their order), at
 * most `limit`. A query of digits puts slide number N first. */
export function rank<T extends Entry>(
    entries: readonly T[],
    query: string,
    limit = 60,
): T[] {
    const scored: { e: T; s: number; k: number }[] = [];
    entries.forEach((e, k) => {
        const best = Math.max(
            score(query, e.label) ?? -Infinity,
            (score(query, `${e.group} ${e.label}`) ?? -Infinity) - 50,
            e.hint ? (score(query, e.hint) ?? -Infinity) - 100 : -Infinity,
        );
        if (best > -Infinity) scored.push({ e, s: best, k });
    });
    const n = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;
    if (n != null) {
        for (const item of scored) {
            if (item.e.group === "Slide" && item.e.label.startsWith(`${n} `))
                item.s += 5000;
        }
    }
    scored.sort((a, b) => b.s - a.s || a.k - b.k);
    return scored.slice(0, limit).map((x) => x.e);
}

/** A toolbar button's title as a command: its words and its shortcut, from
 * "Find and replace (Ctrl+F)". */
export function fromTitle(title: string): { label: string; keys?: string } {
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(title.split("\n")[0]);
    if (m && /^(Ctrl|Shift|Alt|⌘|[A-Z0-9]$|F\d|Esc)/.test(m[2])) {
        return { label: m[1].trim(), keys: m[2].trim() };
    }
    return { label: title.split("\n")[0].trim() };
}
