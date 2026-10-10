// Git menu → "Publish…": the deck on GitHub Pages or GitLab Pages at every
// push, optionally with a release at every tag. The server writes the CI
// files (publish.py, the session's `publish` action) as one undoable step;
// the dialog then offers to commit them and says what is left to do by hand.

import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { edit, request } from "./net";
import {
    defaultHost,
    fileAction,
    filesFor,
    type Host,
    linkParts,
    type PublishInfo,
} from "./publishtext";

/** Commits `paths` (repository-relative), pushing too with `push`; true when done. */
export type Commit = (
    paths: string[],
    message: string,
    push: boolean,
) => Promise<boolean>;

const HOST_NAMES: Record<Host, string> = {
    github: "GitHub Pages",
    gitlab: "GitLab Pages",
};

function linked(text: string): HTMLElement {
    return h(
        "span",
        {},
        ...linkParts(text).map((p) =>
            "url" in p
                ? h(
                      "a",
                      { href: p.url, target: "_blank", rel: "noopener" },
                      p.url,
                  )
                : p.text,
        ),
    );
}

// A file the setup writes, with what happens to it (new, update, replace, link).
function fileRow(action: string, path: string): HTMLElement {
    const tone =
        action === "new"
            ? "new"
            : action === "replace"
              ? "deleted"
              : "modified";
    return h(
        "div",
        { class: "git-file" },
        h("span", { class: `git-status s-${tone}` }, action),
        h("code", { class: "git-path" }, path),
    );
}

function address(url: string | null, note: string | null): HTMLElement {
    return h(
        "div",
        { class: "publish-url" },
        url
            ? h("a", { href: url, target: "_blank", rel: "noopener" }, url)
            : h("span", { class: "hint" }, "not known yet"),
        note ? h("p", { class: "hint publish-note" }, `(${note})`) : null,
    );
}

export async function openPublishDialog(
    commit: Commit,
    canPush: boolean,
): Promise<void> {
    const res = await request({ action: "publish", op: "status" });
    if (!res.ok) {
        toast(res.error ?? "could not read the publishing setup", "error");
        return;
    }
    const info = res.publish as PublishInfo;
    let host: Host = defaultHost(info);
    const release = h("input", { type: "checkbox" }) as HTMLInputElement;
    release.checked = info.configured?.release ?? false;
    const readme = h("input", { type: "checkbox" }) as HTMLInputElement;
    readme.checked = info.readme === "missing";
    const hostButtons = (["github", "gitlab"] as Host[]).map((value) => {
        const radio = h("input", {
            type: "radio",
            name: "publish-host",
            value,
        }) as HTMLInputElement;
        radio.checked = value === host;
        radio.addEventListener("change", () => {
            host = value;
            update();
        });
        return h(
            "label",
            { class: "look" },
            radio,
            h(
                "span",
                { class: "look-text" },
                h("strong", {}, HOST_NAMES[value]),
                h(
                    "span",
                    { class: "hint" },
                    value === "github"
                        ? "A workflow in .github/workflows/"
                        : "A pages job in .gitlab-ci.yml",
                ),
            ),
        );
    });
    const files = h("div", { class: "git-files" });
    const where = h("div", {});
    const notes = h("div", { class: "publish-notes" });
    const write = h(
        "button",
        { type: "button", class: "pbtn primary", onclick: () => void run() },
        "Write files",
    ) as HTMLButtonElement;
    release.addEventListener("change", () => update());
    readme.addEventListener("change", () => update());

    function update(): void {
        const hostInfo = info.hosts[host];
        const list = filesFor(info, host, release.checked);
        const rows = list.map((f) => fileRow(fileAction(f), f.path));
        if (readme.checked && info.readme !== "linked") {
            const missing = info.readme === "missing";
            rows.push(fileRow(missing ? "new" : "link", "README.md"));
        }
        files.replaceChildren(...rows);
        where.replaceChildren(address(hostInfo.url, hostInfo.note));
        notes.replaceChildren(
            ...[...hostInfo.warnings, ...info.fonts].map((w) =>
                h("p", { class: "hint warn publish-note" }, w),
            ),
        );
        write.textContent = list.some((f) => f.exists !== "none")
            ? "Update files"
            : "Write files";
    }

    async function run(): Promise<void> {
        const list = filesFor(info, host, release.checked);
        const theirs = list.filter((f) => f.exists === "other");
        if (
            theirs.length &&
            !confirm(
                `${theirs.map((f) => f.path).join(", ")} exists already and was not written by inkflow. Replace it?`,
            )
        )
            return;
        write.disabled = true;
        const out = await edit({
            action: "publish",
            op: "setup",
            host,
            release: release.checked,
            readme: readme.checked,
            force: list.some((f) => f.exists !== "none"),
        });
        write.disabled = false;
        if (!out.ok) return;
        done(out);
    }

    function done(out: Record<string, unknown>): void {
        const written = (out.written as string[]) ?? [];
        const steps = (out.steps as string[]) ?? [];
        const url = (out.url as string | null) ?? null;
        const note = (out.note as string | null) ?? null;
        const message = `Publish the slides on ${HOST_NAMES[host]}`;
        const commitBtn = (push: boolean) =>
            h(
                "button",
                {
                    type: "button",
                    class: push ? "pbtn" : "pbtn primary",
                    onclick: async () => {
                        if (await commit(written, message, push)) closeDialog();
                    },
                },
                push ? "Commit and push" : "Commit",
            );
        openDialog(
            `Publishing on ${HOST_NAMES[host]}`,
            h(
                "div",
                { class: "git-form publish-form" },
                h(
                    "div",
                    { class: "field" },
                    h("span", { class: "field-label" }, "Written"),
                    h(
                        "div",
                        { class: "git-files" },
                        ...written.map((p) =>
                            h("code", { class: "git-path" }, p),
                        ),
                    ),
                ),
                h(
                    "div",
                    { class: "field" },
                    h("span", { class: "field-label" }, "Address"),
                    address(url, note),
                ),
                h(
                    "div",
                    { class: "field" },
                    h("span", { class: "field-label" }, "Next"),
                    h(
                        "ol",
                        { class: "publish-steps" },
                        ...steps.map((s) => h("li", {}, linked(s))),
                    ),
                ),
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
                        "Later",
                    ),
                    written.length > 0 && canPush && commitBtn(true),
                    written.length > 0 && commitBtn(false),
                ),
            ),
            { wide: true },
        );
    }

    update();
    openDialog(
        "Publish the slides",
        h(
            "div",
            { class: "git-form publish-form" },
            h(
                "p",
                { class: "hint" },
                `Every push to ${info.branch} builds the deck with inkflow build and puts it online. The files below go in the repository${info.scope ? ` (at its root, ${info.root})` : ""}: commit and push them.`,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Host"),
                h("div", { class: "look-list" }, ...hostButtons),
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Also"),
                h(
                    "div",
                    {},
                    h(
                        "label",
                        { class: "check-row" },
                        release,
                        "Publish a release at every tag v… (the slides as one HTML file and a PDF)",
                    ),
                    info.readme !== "linked" &&
                        h(
                            "label",
                            { class: "check-row" },
                            readme,
                            info.readme === "missing"
                                ? "Write a README.md that links to the slides"
                                : "Add a link to the slides to README.md",
                        ),
                ),
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Files"),
                files,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Address"),
                where,
            ),
            notes,
            h("div", { class: "btn-row end" }, write),
        ),
        { wide: true, hint: info.remote ?? "no remote yet" },
    );
}
