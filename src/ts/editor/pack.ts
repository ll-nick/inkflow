// Packing the deck (inkflow/pack.py): "Pack deck…" in the Git menu, and the
// question a commit asks first when the deck depends on this machine (fonts
// only this computer has, files outside the deck, no uv.lock, no line-ending
// or LFS rules). Packing is one undoable step on the server, local only (it
// copies this computer's files); its files go into the same commit.

import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { edit, request } from "./net";
import {
    consequences,
    missingLines,
    type PackItem,
    type PackSummary,
    remainingLines,
    withoutPackingTitle,
} from "./packtext";

export const PACK_HELP =
    "Make the deck self-contained: fonts, outside files, lock file, git rules — so it looks the same on every machine";

export interface PackResult {
    gitPaths: string[];
    changed: string[];
    remaining: PackItem[];
}

/** The cheap check a commit runs first; null when it cannot tell (no deck
 * built yet), which never blocks a commit. */
export async function packCheck(): Promise<PackSummary | null> {
    const res = await request({ action: "pack", op: "check" });
    return res.ok ? (res.pack as PackSummary) : null;
}

/** Pack now; the files it wrote, relative to the repository, or null. */
export async function applyPack(): Promise<PackResult | null> {
    const res = await edit({ action: "pack", op: "apply" });
    if (!res.ok) return null;
    const lock = res.lock;
    if (typeof lock === "string" && !lock.startsWith("uv.lock written")) {
        toast(lock, "info");
    }
    const changes =
        (res.changes as { path: string; change: string }[] | undefined) ?? [];
    return {
        gitPaths: (res.gitPaths as string[] | undefined) ?? [],
        changed: changes.map((c) => `${c.change}: ${c.path}`),
        remaining: (res.remaining as PackItem[] | undefined) ?? [],
    };
}

function list(lines: string[], cls = "pack-list"): HTMLElement {
    return h("ul", { class: cls }, ...lines.map((l) => h("li", {}, l)));
}

/** Asked before a commit when packing would change something: "Pack and
 * commit" (the default) or "Commit without packing" (not recommended, with
 * what other machines will lack). */
export function commitGate(
    summary: PackSummary,
    packAndCommit: () => Promise<void>,
    commitAnyway: () => Promise<void>,
): void {
    const remaining = remainingLines(summary.items);
    const busy = (b: boolean) => {
        for (const btn of box.querySelectorAll<HTMLButtonElement>("button"))
            btn.disabled = b;
    };
    const primary = h(
        "button",
        {
            type: "button",
            class: "pbtn primary",
            "data-pack": "pack-and-commit",
            onclick: async () => {
                busy(true);
                await packAndCommit();
                busy(false);
            },
        },
        "Pack and commit",
    ) as HTMLButtonElement;
    const box = openDialog(
        "Commit: pack the deck first?",
        h(
            "div",
            { class: "git-form pack-gate" },
            h(
                "p",
                {},
                "This deck depends on this computer, so it will not look the same elsewhere:",
            ),
            list(missingLines(summary)),
            h(
                "p",
                { class: "hint" },
                "Packing copies what is missing into the deck and adds the files it writes to this commit.",
            ),
            h(
                "div",
                { class: "pack-without" },
                h(
                    "p",
                    { class: "hint warn" },
                    "Without packing, on other machines:",
                ),
                list(consequences(summary), "pack-list warn"),
            ),
            remaining.length
                ? h(
                      "details",
                      { class: "pack-remaining" },
                      h("summary", {}, "Packing cannot change"),
                      list(remaining),
                  )
                : null,
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        "data-pack": "commit-anyway",
                        title: withoutPackingTitle(summary),
                        onclick: async () => {
                            busy(true);
                            await commitAnyway();
                            busy(false);
                        },
                    },
                    "Commit without packing (not recommended)",
                ),
                primary,
            ),
        ),
        { wide: true },
    );
    primary.focus();
}

/** "Pack deck…": what packing will do (its dry run), then the result. */
export async function openPackDialog(): Promise<void> {
    const body = h(
        "div",
        { class: "git-form pack-dialog" },
        h("p", { class: "hint" }, "Checking the deck…"),
    );
    openDialog("Pack deck", body, { wide: true, hint: PACK_HELP });
    const res = await request({ action: "pack", op: "plan" });
    if (!body.isConnected) return;
    body.replaceChildren();
    if (!res.ok) {
        body.append(h("p", { class: "hint warn" }, res.error ?? "cannot pack"));
        return;
    }
    const summary = res.pack as PackSummary;
    const remaining = remainingLines(summary.items);
    const copies = summary.assets?.copies ?? [];
    const warnings = summary.fonts?.warnings ?? [];
    if (!summary.steps.length) {
        body.append(
            h(
                "p",
                {},
                "Nothing to pack: everything this deck needs is in its folder.",
            ),
        );
    } else {
        body.append(h("p", {}, "Packing will:"), list(summary.steps));
        if (copies.length) {
            body.append(
                h(
                    "details",
                    {},
                    h("summary", {}, `Files copied in (${copies.length})`),
                    list(copies.map((c) => `${c.from} → ${c.to}`)),
                ),
            );
        }
    }
    if (warnings.length) {
        body.append(
            h("p", { class: "hint warn" }, "Font licences:"),
            list(warnings, "pack-list warn"),
        );
    }
    if (remaining.length) {
        body.append(
            h(
                "p",
                { class: "hint" },
                "Still depends on the machine afterwards:",
            ),
            list(remaining),
        );
    }
    const pack = h(
        "button",
        {
            type: "button",
            class: "pbtn primary",
            "data-pack": "pack",
            onclick: async () => {
                pack.disabled = true;
                const done = await applyPack();
                if (!done) {
                    pack.disabled = false;
                    return;
                }
                showResult(done);
            },
        },
        "Pack",
    ) as HTMLButtonElement;
    pack.disabled = !summary.steps.length;
    body.append(
        h(
            "div",
            { class: "btn-row end" },
            h(
                "button",
                { type: "button", class: "pbtn", onclick: () => closeDialog() },
                summary.steps.length ? "Cancel" : "Close",
            ),
            pack,
        ),
    );
    if (summary.steps.length) pack.focus();
}

function showResult(done: PackResult): void {
    const remaining = remainingLines(done.remaining);
    openDialog(
        "Deck packed",
        h(
            "div",
            { class: "git-form pack-dialog" },
            done.changed.length
                ? h(
                      "div",
                      {},
                      h(
                          "p",
                          {},
                          "Packed (one step: Ctrl+Z takes it back). Commit these files to share them:",
                      ),
                      list(done.changed),
                  )
                : h("p", {}, "Packed: nothing needed changing."),
            remaining.length
                ? h(
                      "div",
                      {},
                      h(
                          "p",
                          { class: "hint" },
                          "Still depends on the machine:",
                      ),
                      list(remaining),
                  )
                : h(
                      "p",
                      { class: "hint" },
                      "Nothing else depends on this machine.",
                  ),
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        onclick: () => closeDialog(),
                    },
                    "Done",
                ),
            ),
        ),
        { wide: true },
    );
}
