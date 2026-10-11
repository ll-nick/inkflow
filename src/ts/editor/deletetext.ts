// The words of deleting files from disk (the Files view, a slide delete that
// takes its files along): how the deck uses each file (filerename.file_uses on
// the server) and what git could bring back of it once it is gone
// (gitops.file_states). Pure, so every sentence is tested.

/** What git could bring back of a file once it is deleted. */
export type GitState =
    | "committed"
    | "modified"
    | "untracked"
    | "ignored"
    | "no-repo";

/** How the deck uses a file. */
export type FileState = "used" | "unused" | "orphan" | "template";

/** A file the server lists (the session's `files` action). */
export interface FileEntry {
    path: string;
    state: FileState;
    uses: number;
    by: string[];
    git: GitState;
    size: number;
}

/** A file a step deletes (`deleted` in a delete's result or dry run). */
export interface Deleting {
    path: string;
    git: GitState;
    size?: number;
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Up to `limit` names, then "and N more". */
export function names(paths: string[], limit = 3): string {
    const shown = paths.slice(0, limit).join(", ");
    return paths.length > limit
        ? `${shown} and ${paths.length - limit} more`
        : shown;
}

export interface Badge {
    text: string;
    title: string;
    /** `ok` (git has it), `warn` (changes lost), `lost` (not in git). */
    tone: "ok" | "warn" | "lost";
}

/** A file's git state as a small badge; none outside a repository. */
export function gitBadge(state: GitState): Badge | null {
    switch (state) {
        case "committed":
            return {
                text: "in git",
                title: "Committed: git can bring it back",
                tone: "ok",
            };
        case "modified":
            return {
                text: "changed",
                title: "Uncommitted changes: git has only the last committed version",
                tone: "warn",
            };
        case "untracked":
            return {
                text: "not in git",
                title: "Never committed: git cannot bring it back",
                tone: "lost",
            };
        case "ignored":
            return {
                text: "ignored",
                title: "Ignored by git: never committed, git cannot bring it back",
                tone: "lost",
            };
        default:
            return null;
    }
}

/** How the deck uses a file, for its row in the Files view. */
export function useText(f: Pick<FileEntry, "state" | "uses" | "by">): {
    text: string;
    title: string;
} {
    switch (f.state) {
        case "used":
            return {
                text: plural(f.uses, "use"),
                title: "The deck uses it",
            };
        case "orphan":
            return {
                text: "only used by unused files",
                title: `Named only by files the deck does not use: ${f.by.join(", ")}`,
            };
        case "template":
            return f.by.length
                ? {
                      text: "used by a template",
                      title: `Named only by layouts or overlays no slide uses: ${f.by.join(", ")}`,
                  }
                : {
                      text: "unused template",
                      title: "A layout or overlay no slide uses: kept as a template",
                  };
        default:
            return { text: "unused", title: "Nothing refers to it" };
    }
}

/** What "Pick all unused" picks: unused files and those only unused files
 * name (not templates). */
export function pickable(state: FileState): boolean {
    return state === "unused" || state === "orphan";
}

export interface Warning {
    tone: "warn" | "ok";
    text: string;
}

const NOT_IN_GIT = (n: number, list: string) =>
    `Not in git: ${plural(n, "file")} (${list}) can't be restored from version control. Undo brings ${n === 1 ? "it" : "them"} back only while this editor stays open.`;

/** What can bring the deleted files back, as the delete dialog says it. */
export function deleteWarnings(files: Deleting[], repo: boolean): Warning[] {
    if (!files.length) return [];
    if (!repo) {
        return [
            {
                tone: "warn",
                text: "This deck is not in a git repository: deleted files can only be brought back with Undo while this editor is open.",
            },
        ];
    }
    const lost = files
        .filter((f) => f.git === "untracked" || f.git === "ignored")
        .map((f) => f.path);
    const changed = files
        .filter((f) => f.git === "modified")
        .map((f) => f.path);
    const out: Warning[] = [];
    if (lost.length) {
        out.push({ tone: "warn", text: NOT_IN_GIT(lost.length, names(lost)) });
    }
    if (changed.length) {
        out.push({
            tone: "warn",
            text: `Uncommitted changes in ${plural(changed.length, "file")} (${names(changed)}): git keeps only ${changed.length === 1 ? "its" : "their"} last committed version.`,
        });
    }
    if (!out.length) {
        out.push({
            tone: "ok",
            text: "All in git: Discard changes in the Git menu brings them back, or its history once you commit.",
        });
    }
    return out;
}

/** The question a slide delete asks. */
export function slideQuestion(names: string[]): string {
    return names.length === 1
        ? `Delete “${names[0]}” from the deck?`
        : `Delete ${names.length} slides from the deck?`;
}

/** Below "Also delete its files from disk": what that would delete. */
export function slideFilesLine(n: number, slides: number): string {
    if (!n) {
        return slides === 1
            ? "No file is this slide's alone: nothing else is deleted."
            : "No file is these slides' alone: nothing else is deleted.";
    }
    return `Also deletes ${plural(n, "file")} no other slide uses:`;
}
