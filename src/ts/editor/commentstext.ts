// Review comments in words and numbers (comments.ts shows them; the server
// keeps them: editor/comments.py). Pure, tested.

export interface CommentMessage {
    author: string;
    name: string;
    text: string;
    at: number; // seconds since the epoch
}

export interface Thread {
    id: string;
    slide: string; // the slide's id
    x?: number; // a point in slide units
    y?: number;
    target?: string; // an element id on the slide
    resolved: boolean;
    created: number;
    messages: CommentMessage[];
}

/** A slide's threads, open ones first, each kind oldest first. */
export function slideThreads(
    threads: readonly Thread[],
    slideId: string | null | undefined,
): Thread[] {
    return threads
        .filter((t) => slideId != null && t.slide === slideId)
        .sort(
            (a, b) =>
                Number(a.resolved) - Number(b.resolved) ||
                a.created - b.created,
        );
}

export function openCount(
    threads: readonly Thread[],
    slideId: string | null | undefined,
): number {
    return slideThreads(threads, slideId).filter((t) => !t.resolved).length;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else the date. */
export function ago(at: number, now: number = Date.now() / 1000): string {
    const s = Math.max(0, now - at);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) {
        const d = Math.floor(s / 86400);
        return `${d} day${d === 1 ? "" : "s"} ago`;
    }
    return new Date(at * 1000).toISOString().slice(0, 10);
}

/** Where a thread is pinned, in words. */
export function whereWords(t: Thread): string {
    if (t.target) return `on #${t.target}`;
    if (t.x != null && t.y != null)
        return `at ${Math.round(t.x)}, ${Math.round(t.y)}`;
    return "on the slide";
}

/** The tooltip of a slide's comment mark. */
export function commentTitle(threads: readonly Thread[]): string {
    const open = threads.filter((t) => !t.resolved);
    if (!open.length) return "";
    const lines = open.map((t) => {
        const first = t.messages[0];
        const more =
            t.messages.length > 1 ? ` (+${t.messages.length - 1})` : "";
        return `${first?.name || "someone"}: ${(first?.text ?? "").slice(0, 80)}${more}`;
    });
    return `${open.length} open comment${open.length === 1 ? "" : "s"}\n${lines.join("\n")}`;
}
