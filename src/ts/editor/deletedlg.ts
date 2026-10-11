// Deleting from disk, asked in the editor's dialog (not window.confirm): the
// files that would go, each with what git could bring back of it, and a
// warning when some cannot come back from version control. Used by the Files
// view (picked files) and by a slide delete, whose "Also delete its files
// from disk" box (off by default, never remembered) shows the server's dry run
// of exactly what would go. The words are in deletetext.ts.

import {
    type Deleting,
    deleteWarnings,
    gitBadge,
    slideFilesLine,
} from "./deletetext";
import { closeDialog, openDialog } from "./dialog";
import { h } from "./dom";
import { request } from "./net";
import type { EditRequest, EditResult } from "./types";

export interface DeletePlan {
    files: Deleting[];
    repo: boolean;
}

/** The plan in a dry run's (or a delete's) result, or null when refused. */
export function planOf(result: EditResult): DeletePlan | null {
    if (!result.ok) return null;
    return {
        files: (result.deleted as Deleting[] | undefined) ?? [],
        repo: Boolean(result.repo),
    };
}

function fileList(files: Deleting[]): HTMLElement {
    return h(
        "ul",
        { class: "delete-files" },
        ...files.map((f) => {
            const badge = gitBadge(f.git);
            return h(
                "li",
                {},
                h("code", { class: "rename-code", title: f.path }, f.path),
                badge
                    ? h(
                          "span",
                          {
                              class: `git-state ${badge.tone}`,
                              title: badge.title,
                          },
                          badge.text,
                      )
                    : null,
            );
        }),
    );
}

function warnings(plan: DeletePlan): HTMLElement | null {
    const lines = deleteWarnings(plan.files, plan.repo);
    if (!lines.length) return null;
    return h(
        "div",
        { class: "delete-warnings" },
        ...lines.map((w) =>
            h("p", { class: `delete-warning ${w.tone}`, role: "note" }, w.text),
        ),
    );
}

export interface AskDelete {
    title: string;
    question: string;
    /** The button's words ("Delete", "Delete 3 files"). */
    confirm: string;
    /** The files that go (the Files view's dry run). */
    plan?: DeletePlan;
    /** A slide delete: "Also delete its files from disk", off by default;
     * `load` is the dry run listing what ticking it deletes. */
    option?: {
        label: string;
        slides: number;
        load: () => Promise<DeletePlan | null>;
    };
}

/** Ask; resolves with whether to delete (and the box's state), or null. */
export function askDelete(opts: AskDelete): Promise<{ files: boolean } | null> {
    return new Promise((resolve) => {
        let answer: { files: boolean } | null = null;
        const details = h("div", { class: "delete-details" });
        let check: HTMLInputElement | null = null;
        const ok = h(
            "button",
            {
                type: "button",
                class: "pbtn primary danger",
                "data-delete": "confirm",
                onclick: () => {
                    answer = { files: check?.checked ?? false };
                    closeDialog();
                },
            },
            opts.confirm,
        ) as HTMLButtonElement;
        const body = h(
            "div",
            { class: "delete-dialog" },
            h("p", { class: "delete-question" }, opts.question),
        );
        if (opts.plan) {
            body.append(fileList(opts.plan.files));
            const w = warnings(opts.plan);
            if (w) body.append(w);
        }
        if (opts.option) {
            const option = opts.option;
            check = h("input", {
                type: "checkbox",
                "data-delete": "files",
            }) as HTMLInputElement;
            let plan: Promise<DeletePlan | null> | null = null;
            const box = check;
            box.addEventListener("change", async () => {
                if (!box.checked) {
                    details.replaceChildren();
                    return;
                }
                details.replaceChildren(
                    h(
                        "p",
                        { class: "hint delete-line" },
                        "Looking for its files…",
                    ),
                );
                plan ??= option.load();
                const found = await plan;
                if (!box.checked) return;
                if (!found) {
                    details.replaceChildren(
                        h(
                            "p",
                            { class: "hint warn delete-line" },
                            "Cannot tell which files would go.",
                        ),
                    );
                    return;
                }
                details.replaceChildren(
                    h(
                        "p",
                        { class: "hint delete-line" },
                        slideFilesLine(found.files.length, option.slides),
                    ),
                    ...(found.files.length ? [fileList(found.files)] : []),
                    ...[warnings(found)].filter((w) => w !== null),
                );
            });
            body.append(
                h(
                    "label",
                    { class: "rename-check delete-option" },
                    check,
                    option.label,
                ),
                details,
            );
        }
        body.append(
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => closeDialog(),
                    },
                    "Cancel",
                ),
                ok,
            ),
        );
        // Enter confirms wherever the focus is (but on Cancel); Esc cancels
        // (dialog.ts).
        body.addEventListener("keydown", (e) => {
            const target = e.target as HTMLElement;
            if (e.key !== "Enter" || target.tagName === "BUTTON") return;
            e.preventDefault();
            ok.click();
        });
        openDialog(opts.title, body, {
            wide: true,
            onClose: () => resolve(answer),
        });
        ok.focus();
    });
}

/** A slide delete's question, with "Also delete its files from disk" listing
 * what `req` (the delete, without `files`) would take along. */
export function askSlideDelete(
    question: string,
    slides: number,
    req: EditRequest,
): Promise<{ files: boolean } | null> {
    return askDelete({
        title: slides === 1 ? "Delete slide" : "Delete slides",
        question,
        confirm: "Delete",
        option: {
            label:
                slides === 1
                    ? "Also delete its files from disk"
                    : "Also delete their files from disk",
            slides,
            load: async () =>
                planOf(await request({ ...req, files: true, dryRun: true })),
        },
    });
}
