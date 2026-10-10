// The words the Git menu's Worktrees section shows (git.ts): a worktree's
// state in one line, and what to tell a coding agent to work in it. Pure, so
// tested on its own.

/** One worktree of the deck's repository, as the session's `worktree`
 * action lists it (editor/worktrees.py). */
export interface Worktree {
    name: string;
    path: string;
    branch: string | null;
    head: string;
    /** deck.py at the deck's place inside it; null when not there. */
    deck: string | null;
    dirty: boolean;
    /** Commits relative to the open deck's branch. */
    ahead: number;
    behind: number;
    /** The worktree the open deck lives in. */
    main: boolean;
}

export function branchName(wt: Worktree): string {
    return wt.branch ?? `@${wt.head}`;
}

/** "2 ahead · 1 behind · uncommitted changes", or "up to date". */
export function summary(wt: Worktree): string {
    const parts = [
        wt.ahead ? `${wt.ahead} ahead` : "",
        wt.behind ? `${wt.behind} behind` : "",
        wt.dirty ? "uncommitted changes" : "",
        wt.deck ? "" : "no deck",
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "up to date";
}

/** The folder holding ``deck`` (either separator). */
export function deckDir(deck: string): string {
    const cut = Math.max(deck.lastIndexOf("/"), deck.lastIndexOf("\\"));
    return cut > 0 ? deck.slice(0, cut) : deck;
}

/** Quoted for a shell when it needs to be. */
export function shellQuote(path: string): string {
    return /^[\w@%+=:,./\\-]+$/.test(path)
        ? path
        : `'${path.replace(/'/g, "'\\''")}'`;
}

/** What to tell an agent already running in the deck's project. */
export function agentPrompt(wt: Worktree): string {
    const deck = wt.deck ?? `${wt.path}/deck.py`;
    return [
        `Work on this deck in the git worktree ${wt.path} (branch ${branchName(wt)}), not in the deck I have open.`,
        `Pass --deck ${shellQuote(deck)} to every inkflow command, change only files under that folder, and commit there when you are done.`,
        "Do not merge it: I will compare and merge it myself.",
    ].join(" ");
}

/** Or start an agent in the worktree itself. */
export function agentCommand(wt: Worktree): string {
    return `cd ${shellQuote(wt.deck ? deckDir(wt.deck) : wt.path)} && claude`;
}
