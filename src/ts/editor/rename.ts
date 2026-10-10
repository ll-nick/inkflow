// Giving files meaningful names. An inserted picture is called whatever it
// was uploaded as, a chart's data data/chart-3.csv, a diagram
// diagrams/diagram-2.drawio.svg: "Rename…" gives a file a name (and a folder)
// of the author's choosing, and the server rewrites every reference to it in
// the same undoable step (inkflow/editor/filerename.py). The dialog asks the
// server what would change as the name is typed, so the author sees which
// files are touched before anything is.
//
// Also here: "Rename files…" for a slide (its drawing, Markdown, notes and
// ink to one new name, the slide's id with them), and the Files view (every
// file a deck can use, how often it is used, rename, delete the unused).

import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { edit, request } from "./net";
import { joinFileName, projectRel, splitFileName } from "./pathtext";
import { ed } from "./state";
import type { EditRequest } from "./types";

interface Preview {
    moves: { from: string; to: string }[];
    edits: { file: string; kind: string; old: string; new: string }[];
    references: number;
    files: number;
    ids: Record<string, string>;
    links: number;
    shared: string[];
    warnings: string[];
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The project-relative path of a file a panel names (or null). */
function relOf(path: string | null | undefined): string | null {
    if (!path) return null;
    const rel = projectRel(
        path.replace(/[?#].*$/, ""),
        ed.model?.projectDir ?? "",
    );
    return rel && !rel.startsWith("_theme/") && !rel.startsWith("_pdf/")
        ? rel
        : null;
}

/** A small "Rename…" button for a project file, or null when there is none. */
export function renameButton(
    path: string | null | undefined,
    label = "Rename…",
): HTMLElement | null {
    const rel = relOf(path);
    if (!rel) return null;
    return h(
        "button",
        {
            type: "button",
            class: "pbtn open-with",
            title: `Give ${rel} another name or folder; every reference follows`,
            onclick: () => void renameFile(rel),
        },
        label,
    );
}

// ── The preview ──

function summaryLine(p: Preview): string {
    if (!p.references) return "Nothing refers to it: only the file moves.";
    return `Updates ${plural(p.references, "reference")} in ${plural(p.files, "file")}.`;
}

function previewBody(p: Preview, opts: { moves: boolean }): HTMLElement {
    const box = h("div", { class: "rename-preview" });
    if (opts.moves && p.moves.length) {
        box.append(
            h("p", { class: "rename-msg rename-head" }, "Files"),
            h(
                "ul",
                { class: "rename-list" },
                ...p.moves.map((m) =>
                    h(
                        "li",
                        {},
                        h("code", { class: "rename-code" }, m.from),
                        " → ",
                        h("code", { class: "rename-code" }, m.to),
                    ),
                ),
            ),
        );
    }
    if (p.shared.length) {
        box.append(
            h("p", { class: "rename-msg rename-head" }, "Stay as they are"),
            h(
                "ul",
                { class: "rename-list" },
                ...p.shared.map((s) =>
                    h("li", {}, h("code", { class: "rename-code" }, s)),
                ),
            ),
        );
    }
    box.append(h("p", { class: "rename-msg rename-summary" }, summaryLine(p)));
    for (const [old, now] of Object.entries(p.ids)) {
        box.append(
            h(
                "p",
                { class: "hint" },
                `The slide id ${old} becomes ${now}; its saved ink follows${p.links ? `, and ${plural(p.links, "slide: link")} ${p.links === 1 ? "is" : "are"} rewritten` : ""}.`,
            ),
        );
    }
    if (p.edits.length) {
        const byFile = new Map<string, Preview["edits"]>();
        for (const e of p.edits) {
            const list = byFile.get(e.file) ?? [];
            list.push(e);
            byFile.set(e.file, list);
        }
        const list = h("ul", { class: "rename-list" });
        for (const [file, edits] of byFile) {
            list.append(
                h(
                    "li",
                    {},
                    h("code", { class: "rename-code" }, file),
                    h(
                        "ul",
                        {},
                        ...edits.map((e) =>
                            h(
                                "li",
                                { class: "hint" },
                                `${e.kind}: `,
                                h("code", { class: "rename-code" }, e.old),
                                " → ",
                                h("code", { class: "rename-code" }, e.new),
                            ),
                        ),
                    ),
                ),
            );
        }
        box.append(
            h(
                "details",
                { class: "rename-details" },
                h("summary", {}, "Show the references"),
                list,
            ),
        );
    }
    for (const w of p.warnings) {
        box.append(h("p", { class: "rename-msg rename-warning" }, w));
    }
    return box;
}

/**
 * A dialog that previews a rename request as its fields change and applies
 * it on "Rename". ``build`` turns the fields into the request (or a reason
 * it cannot be sent yet).
 */
function renameDialog(opts: {
    title: string;
    hint: string;
    fields: HTMLElement;
    inputs: HTMLInputElement[];
    build: () => EditRequest | string;
    moves: boolean;
    done: (p: Preview | null) => void;
}): void {
    const status = h("div", { class: "rename-status" });
    const go = h(
        "button",
        { type: "button", class: "pbtn primary", disabled: true },
        "Rename",
    ) as HTMLButtonElement;
    const cancel = h(
        "button",
        { type: "button", class: "pbtn", onclick: () => closeDialog() },
        "Cancel",
    );
    let token = 0;
    let timer = 0;
    let last: Preview | null = null;
    const refresh = async () => {
        const mine = ++token;
        const req = opts.build();
        go.disabled = true;
        if (typeof req === "string") {
            status.className = "rename-status";
            status.replaceChildren(h("p", { class: "rename-msg hint" }, req));
            return;
        }
        status.className = "rename-status busy";
        const res = await request({ ...req, dryRun: true });
        if (mine !== token) return;
        if (!res.ok) {
            last = null;
            status.className = "rename-status error";
            status.replaceChildren(
                h(
                    "p",
                    { class: "rename-msg" },
                    res.error ?? "This name cannot be used",
                ),
            );
            return;
        }
        last = res.rename as Preview;
        status.className = "rename-status";
        status.replaceChildren(previewBody(last, { moves: opts.moves }));
        go.disabled = false;
    };
    const schedule = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void refresh(), 200);
    };
    for (const input of opts.inputs) {
        input.addEventListener("input", schedule);
        input.addEventListener("change", schedule);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !go.disabled) {
                e.preventDefault();
                go.click();
            }
        });
    }
    go.addEventListener("click", async () => {
        const req = opts.build();
        if (typeof req === "string") return;
        go.disabled = true;
        const res = await edit(req);
        if (!res.ok) {
            status.className = "rename-status error";
            status.replaceChildren(
                h("p", { class: "rename-msg" }, res.error ?? "Rename failed"),
            );
            return;
        }
        const p = (res.rename as Preview | undefined) ?? last;
        closeDialog();
        toast(
            `${res.label ?? "Renamed"}${p?.references ? ` · ${plural(p.references, "reference")} updated` : ""}`,
            "ok",
        );
        opts.done(p);
    });
    openDialog(
        opts.title,
        h(
            "div",
            { class: "rename-body" },
            opts.fields,
            status,
            h("div", { class: "rename-actions" }, cancel, go),
        ),
        { hint: opts.hint },
    );
    opts.inputs[opts.inputs.length - 1]?.focus();
    opts.inputs[opts.inputs.length - 1]?.select();
    status.replaceChildren(
        h("p", { class: "hint" }, "Type a new name to see what changes."),
    );
}

// ── One file ──

/** Rename or move one project file (``path``: relative to the project, or
 * absolute inside it). */
export async function renameFile(
    path: string,
    done: () => void = () => {},
): Promise<void> {
    const rel = relOf(path);
    if (!rel) {
        toast("Only the deck's own files can be renamed", "error");
        return;
    }
    const { folder, stem, ext } = splitFileName(rel);
    const folderInput = h("input", {
        type: "text",
        value: folder,
        spellcheck: "false",
        placeholder: "(the deck's folder)",
        title: "The folder, relative to deck.py; a new one is created",
    }) as HTMLInputElement;
    const nameInput = h("input", {
        type: "text",
        value: stem,
        spellcheck: "false",
        title: "Letters, digits, - and _",
    }) as HTMLInputElement;
    const fields = h(
        "div",
        { class: "rename-fields" },
        h(
            "label",
            { class: "rename-row" },
            h("span", { class: "rename-label" }, "Folder"),
            folderInput,
        ),
        h(
            "label",
            { class: "rename-row" },
            h("span", { class: "rename-label" }, "Name"),
            nameInput,
            h(
                "code",
                { class: "rename-ext", title: "The extension stays" },
                ext,
            ),
        ),
    );
    renameDialog({
        title: `Rename ${rel.split("/").pop() ?? rel}`,
        hint: "Every slide, Markdown file and deck.py line that names it follows",
        fields,
        inputs: [folderInput, nameInput],
        moves: false,
        build: () => {
            if (!nameInput.value.trim()) return "Give it a name.";
            const to = joinFileName(folderInput.value, nameInput.value, ext);
            if (to === rel) return "Type a new name to see what changes.";
            return { action: "rename", from: rel, to };
        },
        done: () => done(),
    });
}

// ── A slide's files ──

/** Rename a slide's own files (deck index ``deckIndex``) to one new name. */
export function renameSlideFiles(deckIndex: number): void {
    const slide = ed.model?.slides[deckIndex];
    if (!slide) return;
    const current =
        slide.md?.kind === "file" && slide.md.rel
            ? splitFileName(slide.md.rel).stem
            : slide.srcRel && !slide.srcShared
              ? splitFileName(slide.srcRel).stem
              : (slide.id ?? "");
    const nameInput = h("input", {
        type: "text",
        value: current,
        spellcheck: "false",
        title: "Letters, digits, - and _ (no folder, no extension)",
    }) as HTMLInputElement;
    const keep = h("input", { type: "checkbox" }) as HTMLInputElement;
    const id = slide.id ?? "";
    const fields = h(
        "div",
        { class: "rename-fields" },
        h(
            "label",
            { class: "rename-row" },
            h("span", { class: "rename-label" }, "Name"),
            nameInput,
        ),
        slide.explicitId
            ? h(
                  "p",
                  { class: "hint" },
                  `Its id stays ${slide.explicitId} (set in deck.py).`,
              )
            : h(
                  "label",
                  {
                      class: "rename-check",
                      title: "Write id= into deck.py so links and ink keep the old id",
                  },
                  keep,
                  ` Keep the slide id ${id}`,
              ),
    );
    renameDialog({
        title: "Rename slide files",
        hint: "Its drawing, Markdown, notes and ink get the new name",
        fields,
        inputs: [nameInput],
        moves: true,
        build: () => {
            const stem = nameInput.value.trim();
            if (!stem) return "Give it a name.";
            return {
                action: "rename",
                slide: deckIndex,
                stem,
                keepId: keep.checked,
            };
        },
        done: () => {},
    });
    keep.addEventListener("change", () =>
        nameInput.dispatchEvent(new Event("input")),
    );
}

// ── The Files view ──

interface FileEntry {
    path: string;
    uses: number;
    size: number;
}

function size(bytes: number): string {
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
    return `${bytes} B`;
}

/** Every file a deck can use, with how often it is used: rename, delete the unused. */
export async function openFiles(): Promise<void> {
    const res = await request({ action: "files" });
    if (!res.ok) {
        toast(res.error ?? "Cannot list the deck's files", "error");
        return;
    }
    const files = (res.files as FileEntry[]) ?? [];
    const unused = files.filter((f) => !f.uses);
    const picked = new Set<string>();
    const list = h("div", { class: "files-list" });
    const deleteBtn = h(
        "button",
        { type: "button", class: "pbtn", disabled: true },
        "Delete unused…",
    ) as HTMLButtonElement;
    const sync = () => {
        deleteBtn.disabled = !picked.size;
        deleteBtn.textContent = picked.size
            ? `Delete ${plural(picked.size, "file")}…`
            : "Delete unused…";
    };
    let folder: string | null = null;
    for (const f of files) {
        const { folder: dir } = splitFileName(f.path);
        if (dir !== folder) {
            folder = dir;
            list.append(h("div", { class: "files-folder" }, `${dir || "."}/`));
        }
        const check = h("input", {
            type: "checkbox",
            disabled: f.uses > 0,
            title: f.uses ? "In use" : "Pick it to delete",
        }) as HTMLInputElement;
        check.addEventListener("change", () => {
            if (check.checked) picked.add(f.path);
            else picked.delete(f.path);
            sync();
        });
        list.append(
            h(
                "div",
                { class: `files-row${f.uses ? "" : " unused"}` },
                check,
                h(
                    "code",
                    { class: "rename-code files-name", title: f.path },
                    f.path.split("/").pop() ?? f.path,
                ),
                h(
                    "span",
                    { class: "files-uses" },
                    f.uses ? plural(f.uses, "use") : "unused",
                ),
                h("span", { class: "files-size" }, size(f.size)),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn open-with",
                        title: "Give it another name or folder; every reference follows",
                        onclick: () =>
                            void renameFile(f.path, () => void openFiles()),
                    },
                    "Rename…",
                ),
            ),
        );
    }
    deleteBtn.addEventListener("click", async () => {
        const paths = [...picked];
        if (
            !window.confirm(
                `Delete ${plural(paths.length, "file")} nothing uses?\n\n${paths.join("\n")}\n\nUndo brings them back.`,
            )
        ) {
            return;
        }
        const r = await edit({ action: "delete-files", paths });
        if (r.ok) {
            toast(r.label ?? "Deleted", "ok");
            void openFiles();
        }
    });
    const selectUnused = h(
        "button",
        {
            type: "button",
            class: "pbtn",
            disabled: !unused.length,
            onclick: () => {
                for (const row of list.querySelectorAll<HTMLInputElement>(
                    ".files-row.unused input",
                )) {
                    row.checked = true;
                }
                for (const f of unused) picked.add(f.path);
                sync();
            },
        },
        "Pick all unused",
    );
    const body = h(
        "div",
        { class: "files-body" },
        files.length ? list : h("p", { class: "hint" }, "No files yet."),
        h(
            "div",
            { class: "rename-actions" },
            h(
                "span",
                { class: "hint rename-count" },
                `${plural(files.length, "file")} · ${unused.length} unused`,
            ),
            selectUnused,
            deleteBtn,
        ),
    );
    openDialog("Files", body, {
        wide: true,
        hint: "Pictures, videos, data, diagrams and slide files; a use is a reference in a slide, Markdown or deck.py",
    });
}
