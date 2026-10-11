// Each slide's changes since the last commit, in words (slidegit.ts shows
// them; the server reads them off git: editor/slidegit.py). Pure, tested.

/** VS Code's marks: U a slide not in the last commit, M a changed one, and
 * a dot for one only its layout, an overlay or another shared file changed. */
export type SlideState = "new" | "modified" | "shared" | null;

export interface SlideFile {
    path: string; // relative to the repository root
    status: string; // git's: modified, new, deleted, renamed…
    role: string; // slide, layout, overlay, md, notes, ink, data, asset…
    shared: boolean; // other slides use it too
}

export interface SlideChange {
    state: SlideState;
    entry: "new" | "modified" | null; // its Slide(...) in deck.py
    files: SlideFile[];
}

export interface RemovedSlide {
    index: number;
    key: string | null; // "md:c.md", "id:intro", "src:x.svg"
    code: string;
}

export interface SlideChanges {
    slides: SlideChange[];
    removed: RemovedSlide[];
    deck: {
        path: string;
        status: string | null;
        readable: boolean;
        other: boolean; // deck.py changed besides its slides
    };
}

export interface CommitPlan {
    // Every changed file the slides are made of: their own, shared with
    // other slides, or what every slide is drawn with ("deck").
    paths: { path: string; status: string; why: "own" | "shared" | "deck" }[];
    // Deleted files no slide uses (they go with the removal of slides).
    offered: { path: string; status: string; why: string }[];
    deck: "none" | "whole" | "partial";
    deckPath: string;
    other: boolean;
    removed: RemovedSlide[];
    left: number;
    // Files a fresh clone would lack whatever is committed.
    missing: { path: string; why: "ignored" | "outside" }[];
    touched: number; // other slides that look different in the commit too
}

export function letter(state: SlideState): string {
    if (state === "new") return "U";
    if (state === "modified") return "M";
    if (state === "shared") return "•";
    return "";
}

const STATE_WORDS: Record<string, string> = {
    new: "New since the last commit",
    modified: "Changed since the last commit",
    shared: "Only files it shares with other slides changed",
};

const ROLE_WORDS: Record<string, string> = {
    layout: "its layout",
    overlay: "an overlay",
    md: "its Markdown",
    notes: "its notes",
    ink: "its ink",
    data: "chart data",
    asset: "a picture",
    diagram: "a diagram",
    slide: "its SVG",
    style: "its stylesheet",
    deck: "every slide uses it",
};

/** The tooltip of a slide's mark: what changed, file by file. */
export function changeTitle(c: SlideChange | undefined): string {
    if (!c?.state) return "";
    const lines = [STATE_WORDS[c.state] ?? ""];
    if (c.entry === "new") lines.push("  its Slide(...) in deck.py is new");
    else if (c.entry === "modified")
        lines.push("  its Slide(...) in deck.py changed");
    for (const f of c.files) {
        const what = ROLE_WORDS[f.role] ?? f.role;
        const shared = f.shared ? ", shared with other slides" : "";
        lines.push(`  ${f.path} (${what}, ${f.status}${shared})`);
    }
    return lines.join("\n");
}

/** The slides among `indices` (deck order) that have changes to commit. */
export function changedAmong(
    changes: SlideChanges | null,
    indices: Iterable<number>,
): number[] {
    if (!changes) return [];
    return [...indices]
        .filter((i) => {
            const s = changes.slides[i]?.state;
            return s === "new" || s === "modified";
        })
        .sort((a, b) => a - b);
}

/** The slides among `indices` with any mark (U, M or the dot), in deck
 * order: what can be put back, and the grid's "Changed only". */
export function markedAmong(
    changes: SlideChanges | null,
    indices: Iterable<number>,
): number[] {
    if (!changes) return [];
    return [...indices]
        .filter((i) => !!changes.slides[i]?.state)
        .sort((a, b) => a - b);
}

/** The next slide with a mark after `from` (`dir` 1) or before it (-1),
 * wrapping around; null when no other slide has one. */
export function nextMarked(
    changes: SlideChanges | null,
    from: number,
    dir: 1 | -1,
): number | null {
    const n = changes?.slides.length ?? 0;
    for (let k = 1; k <= n; k++) {
        const i = (((from + dir * k) % n) + n) % n;
        if (i !== from && changes?.slides[i]?.state) return i;
    }
    return null;
}

export interface SlideCommit {
    sha: string;
    short: string;
    author: string;
    when: string;
    subject: string;
    files: string[];
    entry: "added" | "changed" | "removed" | null;
}

/** What a commit of a slide's history changed of it, in words. */
export function commitWhat(c: SlideCommit): string {
    const parts: string[] = [];
    if (c.entry === "added") parts.push("added the slide");
    else if (c.entry === "changed") parts.push("its Slide(...)");
    else if (c.entry === "removed") parts.push("removed the slide");
    // Its folder and name: a slide's Markdown and its notes are often
    // both <id>.md.
    const names = c.files.map((f) => f.split("/").slice(-2).join("/"));
    if (names.length) parts.push(names.join(", "));
    return parts.join(" · ");
}

export function countChanged(changes: SlideChanges | null): number {
    return (changes?.slides ?? []).filter(
        (s) => s.state === "new" || s.state === "modified",
    ).length;
}

/** A first commit message naming the slides. */
export function defaultMessage(titles: string[]): string {
    const named = titles.map((t) => `"${t.trim() || "untitled"}"`);
    if (named.length === 1) return `Update slide ${named[0]}`;
    if (named.length <= 3) {
        const last = named.pop();
        return `Update slides ${named.join(", ")} and ${last}`;
    }
    return `Update ${named.length} slides`;
}

/** What a removed slide is called: what names it in deck.py. */
export function removedName(r: RemovedSlide): string {
    if (!r.key) return `slide ${r.index + 1}`;
    return r.key.replace(/^(id|md|src):/, "");
}

/** How deck.py goes into the commit, in words. */
export function deckWords(plan: CommitPlan): string {
    if (plan.deck === "none") return "";
    const whole = plan.deck === "whole";
    const base = whole
        ? `${plan.deckPath}: all its changes`
        : `${plan.deckPath}: these slides' Slide(...) entries only`;
    return plan.other
        ? `${base}, with its imports, settings, sections and order as they are now`
        : base;
}

/** The note under the files: what stays out of the commit. */
export function leftWords(plan: CommitPlan): string {
    if (!plan.left) return "";
    return `${plan.left} other changed slide${plan.left === 1 ? "" : "s"} stay${plan.left === 1 ? "s" : ""} uncommitted.`;
}

/** Why a file goes into a slide commit, beside its path. */
export function whyWords(why: string): string {
    if (why === "shared") return "shared with other slides";
    if (why === "deck") return "every slide is drawn with it";
    return "";
}

/** Other slides a commit changes too, through the files they share. */
export function touchedWords(plan: CommitPlan): string {
    const n = plan.touched;
    if (!n) return "";
    return `${n} other slide${n === 1 ? " shares" : "s share"} these files and will look different in this commit too.`;
}

/** Files a fresh clone of the commit would not have. */
export function missingWords(plan: CommitPlan): string[] {
    return plan.missing.map((m) =>
        m.why === "ignored"
            ? `${m.path}: ignored by git, so a clone will not have it`
            : `${m.path}: outside the repository, so a clone will not have it`,
    );
}

export type DiffLine = "add" | "del" | "hunk" | "meta" | "";

/** How one line of diff text is shown. */
export function diffLine(line: string): DiffLine {
    if (
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("Binary files")
    )
        return "meta";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "";
}
