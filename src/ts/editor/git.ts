// Version control from the editor: the toolbar's git button shows the branch
// and how many files changed; its menu commits (with a dated message to
// change), pushes, pulls, discards changes, takes back the last commit,
// switches or creates branches and browses the deck's history (view an old
// version, revert a commit, restore the deck to it), and keeps worktrees: a
// branch of the deck in a folder of its own for a coding agent to work in,
// compared, merged or removed from here; "Publish…" (publish.ts) sets up
// GitHub Pages or GitLab Pages and links the published deck. The server runs git
// (editor/gitops.py, editor/worktrees.py); files it changes reach the editor
// through the usual rebuild.

import { openCompare, openComparePicker } from "./compare";
import { closeDialog, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { UNDO_NOTICE, undoNoticeDue, undoNoticeShown } from "./gitnotice";
import { connected, request } from "./net";
import {
    applyPack,
    commitGate,
    openPackDialog,
    PACK_HELP,
    packCheck,
} from "./pack";
import { commitPaths } from "./packtext";
import { openPublishDialog } from "./publish";
import { closeMenu, menuItem, showMenu } from "./sorter";
import { ed, emit, on } from "./state";
import type { EditResult } from "./types";
import {
    agentCommand,
    agentPrompt,
    branchName,
    summary,
    type Worktree,
} from "./worktreetext";

const menu = document.getElementById("context-menu")!;
const button = document.getElementById("btn-git") as HTMLButtonElement;
const label = button.querySelector(".git-label") as HTMLElement;
const badge = button.querySelector(".git-badge") as HTMLElement;

interface Change {
    path: string;
    status: string;
    inDeck: boolean;
}

interface Status {
    repo: boolean;
    git: boolean;
    root?: string;
    scope?: string;
    branch?: string | null;
    detached?: string | null;
    hasCommits?: boolean;
    upstream?: string | null;
    ahead?: number;
    behind?: number;
    remotes?: string[];
    changes?: Change[];
    last?: { sha: string; subject: string; when: string } | null;
    identity?: boolean;
    canUndoCommit?: boolean;
    lfs?: Lfs;
    suggestedMessage?: string;
    // Set up by Publish… (publish.py's `detect`), else null.
    pages?: {
        host: "github" | "gitlab";
        release: boolean;
        url: string | null;
        settingsUrl: string | null;
    } | null;
}

interface LfsFile {
    path: string;
    size: number;
    kind: string;
}

interface Lfs {
    installed: boolean;
    // "on": LFS rules apply to the deck; "off": it opted out (git only).
    mode: "on" | "off" | "none";
    uncovered: LfsFile[];
    unconverted: LfsFile[];
}

interface Commit {
    sha: string;
    short: string;
    author: string;
    when: string;
    subject: string;
    refs: string[];
    head: boolean;
}

let status: Status = { repo: false, git: false };

function render(): void {
    button.hidden = !status.git;
    if (!status.repo) {
        label.textContent = "Git";
        badge.hidden = true;
        button.title = "Not versioned: create a git repository for this deck";
        return;
    }
    label.textContent = status.branch ?? `@${status.detached ?? "?"}`;
    const n = status.changes?.length ?? 0;
    const lfsIssues = lfsFiles().length;
    button.classList.toggle("warn", lfsIssues > 0);
    badge.hidden = n === 0 && lfsIssues === 0;
    badge.textContent = n ? String(n) : "!";
    const sync = [
        status.ahead ? `${status.ahead} to push` : "",
        status.behind ? `${status.behind} to pull` : "",
    ]
        .filter(Boolean)
        .join(", ");
    button.title = [
        status.branch
            ? `Branch ${status.branch}`
            : `Viewing ${status.detached}`,
        n ? `${n} changed file${n === 1 ? "" : "s"}` : "No changes",
        sync,
        lfsIssues
            ? `${lfsIssues} media file${lfsIssues === 1 ? "" : "s"} not in Git LFS`
            : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

export async function refreshGit(): Promise<Status> {
    // Asked again once connected: the server sends a model then.
    if (!connected()) return status;
    const res = await request({ action: "git", op: "status" });
    if (res.ok && res.git) status = res.git as Status;
    render();
    return status;
}

// Operations that change the deck's files on disk: afterwards the editor's
// undo/redo history no longer matches them and starts over (the server says
// so with `historyCleared`). The first one in a session says so first.
const REWRITES = new Set([
    "discard",
    "pull",
    "switch",
    "view",
    "revert",
    "restore",
    "create-branch",
]);
/** Run one git operation; returns its result (status refreshed) or null.
 * `question` is asked first (with the undo notice, when due). */
async function git(
    op: string,
    args: Record<string, unknown> = {},
    question = "",
): Promise<Record<string, unknown> | null> {
    const notice = REWRITES.has(op) && undoNoticeDue();
    if (question || notice) {
        const text = [question, notice ? UNDO_NOTICE : ""]
            .filter(Boolean)
            .join("\n\n");
        if (!confirm(question ? text : `${text}\n\nContinue?`)) return null;
        if (notice) undoNoticeShown();
    }
    button.classList.add("busy");
    const res = await request({ action: "git", op, ...args });
    button.classList.remove("busy");
    if (res.git) {
        status = res.git as Status;
        render();
    }
    if (!res.ok) {
        toast(res.error ?? `git ${op} failed`, "error");
        return null;
    }
    if (typeof res.message === "string") toast(res.message, "ok");
    if (res.historyCleared) {
        ed.canUndo = false;
        ed.canRedo = false;
        emit("history");
    }
    return res;
}

// ── Menu ──

async function openMenu(): Promise<void> {
    await refreshGit();
    clear(menu);
    if (!status.repo) {
        menu.append(
            h("div", { class: "menu-title" }, "Not versioned"),
            menuItem("Create a git repository", async () => {
                if (await git("init"))
                    toast("This deck is now versioned with git", "ok");
            }),
            menuItem("Create a git repository (git only, no LFS)", async () => {
                if (await git("init", { lfs: false }))
                    toast("This deck is now versioned with git", "ok");
            }),
            h("div", { class: "menu-sep" }),
            menuItem(
                "Compare with another deck…",
                () => void openComparePicker(),
            ),
            menuItem("Pack deck…", () => void openPackDialog()),
            h("div", { class: "menu-note" }, PACK_HELP),
        );
    } else {
        const n = status.changes?.length ?? 0;
        const deckChanges = (status.changes ?? []).filter((c) => c.inDeck);
        const where = status.branch
            ? `On ${status.branch}`
            : `Viewing ${status.detached} (no branch)`;
        menu.append(
            h(
                "div",
                { class: "menu-title" },
                `${where} · ${n ? `${n} change${n === 1 ? "" : "s"}` : "no changes"}`,
            ),
        );
        if (status.last) {
            menu.append(
                h(
                    "div",
                    { class: "menu-note" },
                    `Last: ${status.last.subject} (${status.last.when})`,
                ),
            );
        }
        const lfsCount = lfsFiles().length;
        if (lfsCount) {
            const item = menuItem(
                `⚠ ${lfsCount} media file${lfsCount === 1 ? "" : "s"} not in Git LFS…`,
                () => lfsDialog(),
            );
            item.classList.add("warn");
            menu.append(item);
        } else if (status.lfs?.mode === "on" && !status.lfs.installed) {
            menu.append(
                h(
                    "div",
                    { class: "menu-note warn" },
                    "git-lfs is not installed: this deck's media needs it",
                ),
            );
        }
        menu.append(
            menuItem(
                "Commit…",
                () => commitDialog(),
                n === 0 || !status.branch,
            ),
            menuItem(
                status.ahead ? `Push (${status.ahead})` : "Push",
                () => void git("push"),
                !status.remotes?.length || !status.branch,
            ),
            menuItem(
                status.behind ? `Pull (${status.behind})` : "Pull",
                () => void git("pull"),
                !status.upstream,
            ),
            menuItem(
                "Discard changes…",
                () => discardDialog(),
                deckChanges.length === 0,
            ),
            menuItem("Pack deck…", () => void openPackDialog()),
            h("div", { class: "menu-note" }, PACK_HELP),
            menuItem(
                "Undo last commit",
                async () => {
                    if (
                        await git(
                            "undo-commit",
                            {},
                            `Take back "${status.last?.subject}"? Its changes stay, uncommitted.`,
                        )
                    )
                        toast(
                            "Last commit taken back; its changes are kept",
                            "ok",
                        );
                },
                !status.canUndoCommit,
            ),
            h("div", { class: "menu-sep" }),
            menuItem(
                status.branch ? "Branches…" : "Back to a branch…",
                () => void branchesDialog(),
                !status.hasCommits,
            ),
            menuItem(
                "History…",
                () => void historyDialog(),
                !status.hasCommits,
            ),
            menuItem("Compare…", () => void openComparePicker()),
            h("div", { class: "menu-sep" }),
            ...publishItems(),
        );
        if (status.hasCommits) menu.append(...(await worktreeSection()));
    }
    const r = button.getBoundingClientRect();
    showMenu(Math.max(8, r.right - 260), r.bottom + 4);
}

// ── Publishing ──

// "Published at <address>" (a link) once Publish… set it up, and Publish…
// itself (to set it up, or update the workflow).
function publishItems(): HTMLElement[] {
    const pages = status.pages;
    const items: HTMLElement[] = [];
    if (pages?.url) {
        items.push(
            h(
                "a",
                {
                    class: "menu-item publish-link",
                    href: pages.url,
                    target: "_blank",
                    rel: "noopener",
                    title: "Open the published slides",
                    onclick: () => closeMenu(),
                },
                `Published at ${pages.url.replace(/^https:\/\//, "")}`,
            ),
        );
    }
    items.push(
        menuItem(pages ? "Publish… (update)" : "Publish…", () => {
            void openPublishDialog(commitFiles, !!status.remotes?.length);
        }),
    );
    return items;
}

async function commitFiles(
    paths: string[],
    message: string,
    push: boolean,
): Promise<boolean> {
    await refreshGit();
    if (!status.identity) {
        // git needs a name and email first: the Commit dialog asks for them.
        commitDialog(paths, message);
        return true;
    }
    if (!(await git("commit", { message, paths }))) return false;
    if (push) await git("push");
    return true;
}

// ── Git LFS ──

function lfsFiles(): LfsFile[] {
    const l = status.lfs;
    return l ? [...l.uncovered, ...l.unconverted] : [];
}

function size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

function lfsList(files: LfsFile[]): HTMLElement {
    return h(
        "div",
        { class: "git-files" },
        ...files.map((f) =>
            h(
                "div",
                { class: "git-file" },
                h("span", { class: "git-status" }, f.kind),
                h("code", { class: "git-path" }, f.path),
                h("span", { class: "hint git-size" }, size(f.size)),
            ),
        ),
    );
}

// Videos, images and other large files git would keep whole in every version:
// track them with Git LFS, or say this deck uses git alone.
function lfsDialog(): void {
    const l = status.lfs;
    if (!l) return;
    const paths = lfsFiles().map((f) => f.path);
    openDialog(
        "Large files and Git LFS",
        h(
            "div",
            { class: "git-form" },
            h(
                "p",
                { class: "hint" },
                "Git keeps a full copy of a video or image in every version, so the repository grows with each change. Git LFS stores them outside the history; a small repository can do without it.",
            ),
            l.uncovered.length > 0 &&
                h("h3", {}, "No Git LFS rule covers these"),
            l.uncovered.length > 0 && lfsList(l.uncovered),
            l.unconverted.length > 0 &&
                h("h3", {}, "Committed before Git LFS was set up"),
            l.unconverted.length > 0 && lfsList(l.unconverted),
            !l.installed &&
                h(
                    "p",
                    { class: "hint warn" },
                    "git-lfs is not installed on this computer: install it (git-lfs.com) to track files with it.",
                ),
            h(
                "p",
                { class: "hint" },
                "Tracking adds rules to the deck's .gitattributes and stages the files again as LFS files; commit to keep it. Earlier commits keep their full copies (git lfs migrate rewrites history, for everyone with a clone).",
            ),
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        title: "Record in .gitattributes that this deck stores media in git itself; no more warnings",
                        onclick: async () => {
                            if (await git("lfs-off")) closeDialog();
                        },
                    },
                    "Use git without LFS",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        disabled: !l.installed,
                        onclick: async () => {
                            if (await git("lfs-track", { paths }))
                                closeDialog();
                        },
                    },
                    "Track with Git LFS",
                ),
            ),
        ),
        { wide: true },
    );
}

// ── Commit ──

function fileRow(change: Change, checked: boolean): HTMLElement {
    const box = h("input", {
        type: "checkbox",
        value: change.path,
    }) as HTMLInputElement;
    box.checked = checked;
    return h(
        "label",
        { class: `git-file${change.inDeck ? "" : " outside"}` },
        box,
        h("span", { class: `git-status s-${change.status}` }, change.status),
        h("code", { class: "git-path" }, change.path),
    );
}

function checkedPaths(list: HTMLElement): string[] {
    return [...list.querySelectorAll<HTMLInputElement>("input:checked")].map(
        (b) => b.value,
    );
}

/** `ticked`: the files to tick (else the deck's own); `text`: the message. */
function commitDialog(ticked?: string[], text?: string): void {
    const changes = status.changes ?? [];
    const message = h("textarea", {
        class: "git-message",
        rows: "3",
    }) as HTMLTextAreaElement;
    message.value = text ?? status.suggestedMessage ?? "Update slides";
    const files = h(
        "div",
        { class: "git-files" },
        ...changes.map((c) =>
            fileRow(c, ticked ? ticked.includes(c.path) : c.inDeck),
        ),
    );
    const outside = changes.some((c) => !c.inDeck);
    const name = h("input", {
        type: "text",
        placeholder: "Your name",
    }) as HTMLInputElement;
    const email = h("input", {
        type: "email",
        placeholder: "you@example.com",
    }) as HTMLInputElement;
    const identity = status.identity
        ? null
        : h(
              "div",
              { class: "git-identity" },
              h(
                  "p",
                  { class: "hint" },
                  "git needs to know who commits (kept in this repository only):",
              ),
              h("div", { class: "btn-row" }, name, email),
          );
    const commit = async (paths: string[], push: boolean): Promise<void> => {
        const res = await git("commit", {
            message: message.value,
            paths,
            ...(identity ? { name: name.value, email: email.value } : {}),
        });
        if (!res) return;
        closeDialog();
        if (push) await git("push");
    };
    const run = async (push: boolean) => {
        const paths = checkedPaths(files);
        // A deck that depends on this computer asks to be packed first; the
        // files packing writes go into this same commit.
        const summary = paths.length ? await packCheck() : null;
        if (!summary?.needed) {
            await commit(paths, push);
            return;
        }
        commitGate(
            summary,
            async () => {
                const packed = await applyPack();
                if (!packed) return;
                await refreshGit();
                await commit(commitPaths(paths, packed.gitPaths), push);
            },
            () => commit(paths, push),
        );
    };
    const canPush = !!status.remotes?.length;
    const changed = new Set(changes.map((c) => c.path));
    const heavy = lfsFiles().filter((f) => changed.has(f.path));
    const lfsNote =
        heavy.length > 0 &&
        h(
            "p",
            { class: "hint warn" },
            `${heavy.length} of these ${heavy.length === 1 ? "is a media file" : "are media files"} git would store whole, not in Git LFS. `,
            h(
                "button",
                {
                    type: "button",
                    class: "link-btn",
                    onclick: () => lfsDialog(),
                },
                "Review…",
            ),
        );
    message.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run(false);
        }
    });
    openDialog(
        "Commit",
        h(
            "div",
            { class: "git-form" },
            h(
                "label",
                { class: "field" },
                h("span", { class: "field-label" }, "Message"),
                message,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Files"),
                h(
                    "div",
                    {},
                    files,
                    outside &&
                        h(
                            "p",
                            { class: "hint" },
                            "Files outside this deck are left out unless you tick them.",
                        ),
                ),
            ),
            lfsNote,
            identity,
            h(
                "div",
                { class: "btn-row end" },
                canPush &&
                    h(
                        "button",
                        {
                            type: "button",
                            class: "pbtn",
                            onclick: () => void run(true),
                        },
                        "Commit and push",
                    ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        title: "Ctrl+Enter",
                        onclick: () => void run(false),
                    },
                    "Commit",
                ),
            ),
        ),
        { wide: true, hint: status.branch ? `on ${status.branch}` : undefined },
    );
    message.focus();
    message.select();
}

// ── Discard ──

function discardDialog(): void {
    const changes = (status.changes ?? []).filter((c) => c.inDeck);
    const files = h(
        "div",
        { class: "git-files" },
        ...changes.map((c) => fileRow(c, true)),
    );
    openDialog(
        "Discard changes",
        h(
            "div",
            { class: "git-form" },
            h(
                "p",
                { class: "hint warn" },
                "The ticked files go back to how they were in the last commit; new files are deleted. This cannot be undone.",
            ),
            files,
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn danger",
                        onclick: async () => {
                            const paths = checkedPaths(files);
                            if (!paths.length) return;
                            if (await git("discard", { paths })) {
                                closeDialog();
                                toast(
                                    `Discarded changes to ${paths.length} file${paths.length === 1 ? "" : "s"}`,
                                    "ok",
                                );
                            }
                        },
                    },
                    "Discard",
                ),
            ),
        ),
        { wide: true },
    );
}

// ── Branches ──

async function branchesDialog(): Promise<void> {
    const res = await git("branches");
    if (!res) return;
    const branches = res.branches as {
        name: string;
        current: boolean;
        when: string;
    }[];
    const name = h("input", {
        type: "text",
        placeholder: "new-branch-name",
    }) as HTMLInputElement;
    const create = async () => {
        if (!name.value.trim()) return;
        if (await git("create-branch", { name: name.value.trim() })) {
            closeDialog();
            toast(`Created and switched to ${name.value.trim()}`, "ok");
        }
    };
    name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void create();
        }
    });
    openDialog(
        "Branches",
        h(
            "div",
            { class: "git-form" },
            h(
                "div",
                { class: "git-list" },
                ...branches.map((b) =>
                    h(
                        "div",
                        { class: `git-row${b.current ? " current" : ""}` },
                        h("strong", {}, b.name),
                        h(
                            "span",
                            { class: "hint" },
                            b.current ? "current" : b.when,
                        ),
                        !b.current &&
                            h(
                                "button",
                                {
                                    type: "button",
                                    class: "pbtn",
                                    onclick: async () => {
                                        if (
                                            await git("switch", {
                                                name: b.name,
                                            })
                                        ) {
                                            closeDialog();
                                            toast(
                                                `Switched to ${b.name}`,
                                                "ok",
                                            );
                                        }
                                    },
                                },
                                "Switch",
                            ),
                    ),
                ),
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "New branch"),
                h(
                    "div",
                    { class: "btn-row" },
                    name,
                    h(
                        "button",
                        {
                            type: "button",
                            class: "pbtn primary",
                            onclick: create,
                        },
                        "Create and switch",
                    ),
                ),
            ),
            h(
                "p",
                { class: "hint" },
                "Uncommitted changes come along to the branch you switch to; git refuses a switch that would overwrite them.",
            ),
        ),
        { wide: true },
    );
}

// ── History ──

async function historyDialog(): Promise<void> {
    const res = await git("log");
    if (!res) return;
    const log = res.log as Commit[];
    const act = async (
        op: string,
        c: Commit,
        question: string,
        done: string,
    ) => {
        if (await git(op, { sha: c.sha }, question)) {
            closeDialog();
            toast(done, "ok");
        }
    };
    openDialog(
        "History",
        h(
            "div",
            { class: "git-form" },
            log.length
                ? h(
                      "div",
                      { class: "git-list history" },
                      ...log.map((c) =>
                          h(
                              "div",
                              { class: `git-row${c.head ? " current" : ""}` },
                              h(
                                  "div",
                                  { class: "git-commit" },
                                  h("strong", {}, c.subject),
                                  h(
                                      "span",
                                      { class: "hint" },
                                      `${c.short} · ${c.author} · ${c.when}${c.refs.length ? ` · ${c.refs.join(", ")}` : ""}`,
                                  ),
                              ),
                              h(
                                  "div",
                                  { class: "btn-row" },
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          class: "pbtn",
                                          title: "Compare with the working copy, slide by slide",
                                          onclick: () => {
                                              closeDialog();
                                              openCompare(
                                                  { kind: "live" },
                                                  {
                                                      kind: "commit",
                                                      rev: c.sha,
                                                  },
                                              );
                                          },
                                      },
                                      "Compare",
                                  ),
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          class: "pbtn",
                                          title: "Show the deck as it was then (switch back with Branches)",
                                          onclick: () =>
                                              void act(
                                                  "view",
                                                  c,
                                                  `Show the deck as it was at "${c.subject}"? Edits there are not on any branch until you create one.`,
                                                  `Viewing ${c.short}; switch back to a branch from the git menu`,
                                              ),
                                      },
                                      "View",
                                  ),
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          class: "pbtn",
                                          title: "Make the deck's files what they were then, as uncommitted changes",
                                          onclick: () =>
                                              void act(
                                                  "restore",
                                                  c,
                                                  `Restore the deck's files to "${c.subject}"? Your current files are replaced (commit first to keep them).`,
                                                  `Restored the deck to ${c.short}; commit to keep it`,
                                              ),
                                      },
                                      "Restore",
                                  ),
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          class: "pbtn",
                                          title: "A new commit that undoes this one",
                                          onclick: () =>
                                              void act(
                                                  "revert",
                                                  c,
                                                  `Undo "${c.subject}" with a new commit?`,
                                                  `Reverted ${c.short}`,
                                              ),
                                      },
                                      "Revert",
                                  ),
                              ),
                          ),
                      ),
                  )
                : h("p", { class: "hint" }, "No commits touch this deck yet."),
            h(
                "p",
                { class: "hint" },
                "View: look at an old version (no branch). Restore: bring the deck back to it as changes you can commit. Revert: undo one commit with a new one.",
            ),
        ),
        {
            wide: true,
            hint: status.scope ? `changes to ${status.scope}/` : undefined,
        },
    );
}

// ── Worktrees ──

/** Run one `worktree` operation; returns its result, failed or not (an
 * error is shown unless `quiet`), or null when not confirmed. `question` is
 * asked first; `rewrites`: it changes the deck's files (a merge), so the undo
 * notice may be due. */
async function worktreeOp(
    op: string,
    args: Record<string, unknown> = {},
    question = "",
    rewrites = false,
    quiet = false,
): Promise<EditResult | null> {
    const notice = rewrites && undoNoticeDue();
    if (question || notice) {
        const text = [question, notice ? UNDO_NOTICE : ""]
            .filter(Boolean)
            .join("\n\n");
        if (!confirm(text)) return null;
        if (notice) undoNoticeShown();
    }
    button.classList.add("busy");
    const res = await request({ action: "worktree", op, ...args });
    button.classList.remove("busy");
    if (res.git) {
        status = res.git as Status;
        render();
    }
    if (!res.ok) {
        if (!quiet) toast(res.error ?? `worktree ${op} failed`, "error");
        return res;
    }
    if (typeof res.message === "string") toast(res.message, "ok");
    if (typeof res.note === "string") toast(res.note, "info");
    if (res.historyCleared) {
        ed.canUndo = false;
        ed.canRedo = false;
        emit("history");
    }
    return res;
}

async function worktreeList(): Promise<Worktree[]> {
    const res = await request({ action: "worktree", op: "list" });
    return res.ok ? (res.worktrees as Worktree[]) : [];
}

/** The menu's section: one row per other worktree (its state, and Compare),
 * then the way to make one. */
async function worktreeSection(): Promise<HTMLElement[]> {
    const others = (await worktreeList()).filter((w) => !w.main);
    return [
        h("div", { class: "menu-sep" }),
        h("div", { class: "menu-title" }, "Worktrees"),
        ...others.map((wt) =>
            h(
                "div",
                { class: "menu-wt" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "menu-item",
                        title: `${wt.path}\nMerge, remove, or what to tell the agent`,
                        onclick: () => {
                            closeMenu();
                            worktreeDialog(wt);
                        },
                    },
                    h("span", { class: "wt-branch" }, branchName(wt)),
                    h("span", { class: "wt-state" }, summary(wt)),
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "menu-mini",
                        disabled: !wt.deck,
                        title: "Compare its slides with this deck",
                        onclick: () => {
                            closeMenu();
                            compareWith(wt);
                        },
                    },
                    "Compare",
                ),
            ),
        ),
        menuItem("New worktree for an agent…", () => newWorktreeDialog()),
    ];
}

// The compare view listens for this: the deck in that folder, side by side
// with this one.
function compareWith(wt: Worktree): void {
    if (!wt.deck) return;
    document.dispatchEvent(
        new CustomEvent("inkflow:compare", {
            detail: { kind: "path", deck: wt.deck, label: branchName(wt) },
        }),
    );
}

function copyBlock(text: string): HTMLElement {
    return h(
        "div",
        { class: "wt-copy" },
        h("pre", { class: "wt-command" }, text),
        h(
            "button",
            {
                type: "button",
                class: "pbtn",
                onclick: () =>
                    void navigator.clipboard.writeText(text).then(
                        () => toast("Copied", "ok"),
                        () => toast("Could not copy: select the text", "error"),
                    ),
            },
            "Copy",
        ),
    );
}

function newWorktreeDialog(): void {
    const name = h("input", {
        type: "text",
        placeholder: "e.g. bolder-colours",
        spellcheck: "false",
    }) as HTMLInputElement;
    const create = async () => {
        const value = name.value.trim().replace(/\s+/g, "-");
        if (!value) return;
        const res = await worktreeOp("add", { name: value });
        if (res?.ok) worktreeDialog(res.worktree as Worktree, true);
    };
    name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void create();
        }
    });
    openDialog(
        "New worktree for an agent",
        h(
            "div",
            { class: "git-form" },
            h(
                "p",
                { class: "hint" },
                `A copy of the deck on a branch of its own, deck/<name>, from the last commit of ${status.branch ?? "this version"}. A coding agent works and commits there while your deck stays as it is; then compare and merge it, or remove it.`,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Name"),
                h(
                    "div",
                    { class: "btn-row" },
                    name,
                    h(
                        "button",
                        {
                            type: "button",
                            class: "pbtn primary",
                            onclick: () => void create(),
                        },
                        "Create",
                    ),
                ),
            ),
            (status.changes ?? []).some((c) => c.inDeck) &&
                h(
                    "p",
                    { class: "hint warn" },
                    "Your uncommitted changes to the deck are not in it: commit first to include them.",
                ),
        ),
        { wide: true },
    );
    name.focus();
}

/** One worktree: what to tell the agent, Compare, Merge, Remove. */
function worktreeDialog(wt: Worktree, created = false): void {
    const into = status.branch;
    const merge = async () => {
        const n = wt.ahead;
        const question = [
            `Merge ${branchName(wt)} (${n} commit${n === 1 ? "" : "s"}) into ${into}? Its changes land in your deck's files now.`,
            wt.dirty
                ? "Its uncommitted changes are not merged (commit them there first)."
                : "",
        ]
            .filter(Boolean)
            .join("\n\n");
        const res = await worktreeOp(
            "merge",
            { branch: wt.branch },
            question,
            true,
        );
        if (res?.ok) closeDialog();
    };
    const remove = async () => {
        const lost = [
            wt.dirty ? "uncommitted changes" : "",
            wt.ahead
                ? `${wt.ahead} unmerged commit${wt.ahead === 1 ? "" : "s"}`
                : "",
        ].filter(Boolean);
        if (
            !confirm(
                `Remove the worktree ${wt.name} (${wt.path})?${lost.length ? `\n\nIt has ${lost.join(" and ")}.` : ""}`,
            )
        )
            return;
        let res = await worktreeOp(
            "remove",
            { name: wt.path },
            "",
            false,
            true,
        );
        if (res && !res.ok) {
            if (
                !confirm(
                    `${res.error}\n\nRemove it anyway? Its uncommitted changes and unmerged commits are lost.`,
                )
            )
                return;
            res = await worktreeOp("remove", { name: wt.path, force: true });
        }
        if (res?.ok) closeDialog();
    };
    openDialog(
        `Worktree ${branchName(wt)}`,
        h(
            "div",
            { class: "git-form" },
            h(
                "p",
                { class: "hint" },
                created
                    ? `Created from the last commit${into ? ` of ${into}` : ""} · `
                    : `${summary(wt)} · `,
                h("code", { class: "git-path" }, wt.path),
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Tell the agent"),
                copyBlock(agentPrompt(wt)),
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Or start one there"),
                copyBlock(agentCommand(wt)),
            ),
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn danger",
                        onclick: () => void remove(),
                    },
                    "Remove…",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        disabled: !wt.deck,
                        title: "Its slides side by side with this deck's",
                        onclick: () => {
                            closeDialog();
                            compareWith(wt);
                        },
                    },
                    "Compare",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        disabled: !wt.branch || !into || wt.ahead === 0,
                        title: into
                            ? `Bring its commits into ${into}`
                            : "Switch the deck to a branch first",
                        onclick: () => void merge(),
                    },
                    into ? `Merge into ${into}…` : "Merge…",
                ),
            ),
        ),
        { wide: true },
    );
}

let timer = 0;

export function initGit(): void {
    button.addEventListener("click", () => void openMenu());
    // Files changed (an edit, a save in Inkscape, a git operation): the
    // rebuild that follows refreshes the count.
    on("model", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void refreshGit(), 600);
    });
}
