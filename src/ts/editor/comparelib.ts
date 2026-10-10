// The compare view's pure parts (compare.ts draws them): the model the server
// sends (editor/comparehub.py), which rows the list shows, jumping between
// changes, what a row says, a word-level diff of speaker notes, what "Take
// this slide" and "Merge branch" may do, and the merge request itself.

export type Status = "same" | "changed" | "added" | "removed";
export type Box = [number, number, number, number];

export interface Loc {
    path: number[];
    tag: string;
    box: Box | null;
}

export interface ElementChange {
    change: "changed" | "added" | "removed";
    id: string | null;
    text: string;
    left: Loc | null;
    right: Loc | null;
}

export interface FileChange {
    path: string;
    role: string;
    change: "changed" | "added" | "removed";
}

export interface PairModel {
    left: number | null;
    right: number | null;
    status: Status;
    moved: boolean;
    visual: boolean;
    notes: boolean;
    settings: string[];
    files: FileChange[];
    elements: ElementChange[];
}

export interface CmpSlide {
    index: number;
    number: number | null;
    id: string;
    title: string;
    visible: boolean;
    svg: string | null;
    notes: string;
}

export type Source = Record<string, unknown> & { kind: string };

export interface SideModel {
    kind: "live" | "commit" | "path";
    label: string;
    branch: string | null;
    sha: string | null;
    live: boolean;
    deckPath: string;
    token: string;
    missing: string[];
    error: string | null;
    slides: CmpSlide[];
    css: string;
    fonts: string;
    mode: "dark" | "light";
    source: Source;
}

export interface CompareModel {
    view: number;
    left: SideModel;
    right: SideModel;
    deck: string[];
    pairs: PairModel[];
}

/** A row worth stopping at: different, or moved. */
export function isChange(p: PairModel): boolean {
    return p.status !== "same" || p.moved;
}

/** The rows the list shows: all, or only the changes. */
export function visibleRows(
    pairs: PairModel[],
    onlyChanges: boolean,
): number[] {
    const rows: number[] = [];
    pairs.forEach((p, i) => {
        if (!onlyChanges || isChange(p)) rows.push(i);
    });
    return rows;
}

/** The next (dir 1) or previous (-1) changed row after `from`, or null. */
export function nextChange(
    pairs: PairModel[],
    from: number,
    dir: 1 | -1,
): number | null {
    for (let i = from + dir; i >= 0 && i < pairs.length; i += dir) {
        if (isChange(pairs[i])) return i;
    }
    return null;
}

/** The row to show first: the first change, else the first row. */
export function firstRow(pairs: PairModel[]): number {
    const i = pairs.findIndex(isChange);
    return i >= 0 ? i : 0;
}

/** The row now showing `prev`'s pair again after a new model, by slide ids. */
export function followRow(
    before: CompareModel | null,
    row: number,
    after: CompareModel,
): number {
    const old = before?.pairs[row];
    if (!before || !old) return firstRow(after.pairs);
    const lid = old.left != null ? before.left.slides[old.left]?.id : null;
    const rid = old.right != null ? before.right.slides[old.right]?.id : null;
    const same = after.pairs.findIndex(
        (p) =>
            (lid != null &&
                p.left != null &&
                after.left.slides[p.left]?.id === lid) ||
            (rid != null &&
                p.right != null &&
                after.right.slides[p.right]?.id === rid),
    );
    if (same >= 0) return same;
    return Math.min(row, Math.max(0, after.pairs.length - 1));
}

export interface Badge {
    symbol: string;
    cls: string;
    title: string;
}

export function badge(p: PairModel): Badge {
    if (p.status === "added")
        return { symbol: "+", cls: "added", title: "Only on the right" };
    if (p.status === "removed")
        return { symbol: "−", cls: "removed", title: "Only on the left" };
    if (p.status === "changed")
        return {
            symbol: p.moved ? "↕" : "~",
            cls: p.moved ? "changed moved" : "changed",
            title: p.moved ? "Changed and moved" : "Changed",
        };
    if (p.moved) return { symbol: "↕", cls: "moved", title: "Moved" };
    return { symbol: "", cls: "same", title: "The same" };
}

/** The slide a row is named after (the right one, else the left). */
export function rowSlide(m: CompareModel, p: PairModel): CmpSlide | null {
    if (p.right != null) return m.right.slides[p.right] ?? null;
    if (p.left != null) return m.left.slides[p.left] ?? null;
    return null;
}

function num(s: CmpSlide | null | undefined): string {
    return s?.number != null ? String(s.number) : "·";
}

/** "3", or "5 → 6" for a moved slide, as `inkflow compare` prints them. */
export function rowNumber(m: CompareModel, p: PairModel): string {
    const l = p.left != null ? m.left.slides[p.left] : null;
    const r = p.right != null ? m.right.slides[p.right] : null;
    if (p.moved && l && r) return `${num(l)} → ${num(r)}`;
    return num(r ?? l);
}

/** Short names of what differs: files (but notes), "notes", settings. */
export function whatChanged(p: PairModel): string[] {
    const parts = p.files.filter((f) => f.role !== "notes").map((f) => f.path);
    if (p.notes || p.files.some((f) => f.role === "notes")) parts.push("notes");
    parts.push(...p.settings.map((s) => s.replace(/_/g, " ")));
    if (!parts.length && p.visual) parts.push("look");
    return parts;
}

export interface Counts {
    changed: number;
    added: number;
    removed: number;
    moved: number;
    same: number;
}

export function counts(pairs: PairModel[]): Counts {
    const c: Counts = { changed: 0, added: 0, removed: 0, moved: 0, same: 0 };
    for (const p of pairs) {
        if (p.status === "changed") c.changed++;
        else if (p.status === "added") c.added++;
        else if (p.status === "removed") c.removed++;
        else if (!p.moved) c.same++;
        if (p.moved) c.moved++;
    }
    return c;
}

export function countText(c: Counts): string {
    const parts = [
        c.changed && `${c.changed} changed`,
        c.added && `${c.added} added`,
        c.removed && `${c.removed} removed`,
        c.moved && `${c.moved} moved`,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "No differences";
}

// ── Notes ──

export interface DiffPart {
    kind: "same" | "del" | "ins";
    text: string;
}

const MAX_CELLS = 4_000_000;

function tokens(text: string): string[] {
    return text.split(/(\s+)/).filter((t) => t !== "");
}

function merge(parts: DiffPart[]): DiffPart[] {
    const out: DiffPart[] = [];
    for (const p of parts) {
        const last = out[out.length - 1];
        if (last && last.kind === p.kind) last.text += p.text;
        else out.push({ ...p });
    }
    return out;
}

/** A word-level diff (whitespace kept with the words around it): what was
 * only in `a` is "del", only in `b` "ins". Long texts that would take too
 * long fall back to all of `a` out, all of `b` in. */
export function wordDiff(a: string, b: string): DiffPart[] {
    if (a === b) return a ? [{ kind: "same", text: a }] : [];
    const x = tokens(a);
    const y = tokens(b);
    let start = 0;
    while (start < x.length && start < y.length && x[start] === y[start])
        start++;
    let endX = x.length;
    let endY = y.length;
    while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
        endX--;
        endY--;
    }
    const head: DiffPart[] = start
        ? [{ kind: "same", text: x.slice(0, start).join("") }]
        : [];
    const tail: DiffPart[] =
        endX < x.length ? [{ kind: "same", text: x.slice(endX).join("") }] : [];
    const xs = x.slice(start, endX);
    const ys = y.slice(start, endY);
    if (xs.length * ys.length > MAX_CELLS) {
        return merge([
            ...head,
            { kind: "del", text: xs.join("") },
            { kind: "ins", text: ys.join("") },
            ...tail,
        ]).filter((p) => p.text);
    }
    // LCS table, from the end, so the walk below goes forward.
    const n = xs.length;
    const m = ys.length;
    const table: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] =
                xs[i] === ys[j]
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const mid: DiffPart[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (xs[i] === ys[j]) {
            mid.push({ kind: "same", text: xs[i] });
            i++;
            j++;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            mid.push({ kind: "del", text: xs[i++] });
        } else {
            mid.push({ kind: "ins", text: ys[j++] });
        }
    }
    while (i < n) mid.push({ kind: "del", text: xs[i++] });
    while (j < m) mid.push({ kind: "ins", text: ys[j++] });
    return merge([...head, ...mid, ...tail]);
}

// ── Actions ──

export interface TakeState {
    enabled: boolean;
    /** Why not, or what it does (the button's title). */
    title: string;
    replace: boolean;
}

/** Whether "Take this slide" can take a row's other version into the live
 * deck: one side must be the working copy, the other must have the slide,
 * and it must differ. */
export function takeState(m: CompareModel, row: number): TakeState {
    const p = m.pairs[row];
    const liveLeft = m.left.live && !m.right.live;
    const liveRight = m.right.live && !m.left.live;
    if (!p || !(liveLeft || liveRight)) {
        return {
            enabled: false,
            title: "One side must be the working copy to take a slide into it",
            replace: false,
        };
    }
    const other = liveLeft ? m.right : m.left;
    const theirs = liveLeft ? p.right : p.left;
    const mine = liveLeft ? p.left : p.right;
    if (theirs == null) {
        return {
            enabled: false,
            title: `This slide is not in ${other.label}`,
            replace: false,
        };
    }
    if (p.status === "same") {
        return {
            enabled: false,
            title: "Both versions are the same",
            replace: true,
        };
    }
    return {
        enabled: true,
        title:
            mine == null
                ? `Insert ${other.label}'s slide into the working copy`
                : `Replace the working copy's slide with ${other.label}'s version (Ctrl+Z undoes it)`,
        replace: mine != null,
    };
}

/** The branch "Merge branch" would merge: the non-live side's, when it is a
 * branch or a worktree on one and the other side is the working copy. */
export function mergeTarget(m: CompareModel): string | null {
    if (m.left.live && !m.right.live) return m.right.branch;
    if (m.right.live && !m.left.live) return m.left.branch;
    return null;
}

export interface MergeResult {
    ok: boolean;
    error?: string;
    historyCleared?: boolean;
    message?: string;
}

/** Ask the server to merge `branch` into the working copy (the worktree
 * session action); `send` is net.request, a fake in tests. */
export async function mergeBranch(
    branch: string,
    send: (req: {
        action: string;
        [key: string]: unknown;
    }) => Promise<Record<string, unknown>>,
): Promise<MergeResult> {
    const res = await send({ action: "worktree", op: "merge", branch });
    if (!res.ok) {
        return {
            ok: false,
            error: String(res.error ?? `could not merge ${branch}`),
        };
    }
    return {
        ok: true,
        historyCleared: res.historyCleared === true,
        message:
            typeof res.message === "string"
                ? res.message
                : `Merged ${branch} into the working copy`,
    };
}

/** The other side as a source to compare with: what a CLI `--compare` spec,
 * a commit row or the worktree event names. */
export function swapSources(m: CompareModel): [Source, Source] {
    return [m.right.source, m.left.source];
}

/** Font rules of a side the page does not have yet (`@font-face` does not
 * work inside a shadow root, so they go into the document). */
export function newFontRules(fonts: string, present: string): string {
    const rules = fonts.match(/@font-face\s*\{[^{}]*\}/g) ?? [];
    return rules.filter((r) => !present.includes(r)).join("\n");
}

/** A box in slide units from a client rect, given the slide's rect and
 * viewBox (the slide fills its rect exactly). */
export function toSlideBox(
    r: { left: number; top: number; width: number; height: number },
    slide: { left: number; top: number; width: number; height: number },
    vb: { x: number; y: number; w: number; h: number },
): Box | null {
    if (!slide.width || !slide.height || (!r.width && !r.height)) return null;
    const sx = vb.w / slide.width;
    const sy = vb.h / slide.height;
    return [
        vb.x + (r.left - slide.left) * sx,
        vb.y + (r.top - slide.top) * sy,
        r.width * sx,
        r.height * sy,
    ];
}
