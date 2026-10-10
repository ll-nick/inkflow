// A PDF figure's page: which one a picture shows. A one-page PDF needs no
// question; for more, a dialog shows the pages as thumbnails. The server
// converts each page to SVG (inkflow/pdf.py, the `pdf-pages`/`pdf-page`
// actions), the same file the slide then shows, so its size is the size the
// picture takes.

import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { request } from "./net";
import { assetRef } from "./pathtext";

// Thumbnails converted for the dialog; any later page is typed in.
const THUMBS = 24;

export interface PdfChoice {
    page: number;
    /** The converted page (a canonical asset ref), or null when no converter
     * is installed and the slide will show a placeholder. */
    url: string | null;
}

/** What the slide wrote for a picture: a PDF picture shows its converted
 * page but keeps the PDF reference beside it (``data-inkflow-pdf``). */
export function sourceRef(image: Element): string {
    return (
        image.getAttribute("data-inkflow-pdf") ??
        assetRef(
            image.getAttribute("href") ??
                image.getAttribute("xlink:href") ??
                "",
        )
    );
}

function fileName(path: string): string {
    return path.replace(/#.*$/, "").split(/[\\/]/).pop() ?? path;
}

/** The converted page, or null (and a toast) when it cannot be shown. */
export async function pageUrl(
    path: string,
    page: number,
): Promise<string | null> {
    const res = await request({ action: "pdf-page", path, page });
    if (!res.ok) {
        toast(res.error ?? `cannot show page ${page}`, "error");
        return null;
    }
    return String(res.url);
}

/** Which page of the PDF at ``path`` (absolute, or relative to the project)
 * to show; null when the question was dismissed. */
export async function choosePage(
    path: string,
    current = 1,
): Promise<PdfChoice | null> {
    const info = await request({ action: "pdf-pages", path });
    if (!info.ok) {
        toast(info.error ?? "cannot read the PDF", "error");
        return null;
    }
    const name = fileName(path);
    if (info.ignored) {
        toast(
            `${name} is ignored by git (see .gitignore): add it to the repository with "git add -f" to keep it`,
        );
    }
    if (!info.converter) {
        toast(`${name} shows as a placeholder: ${String(info.hint)}`, "error");
        return { page: current, url: null };
    }
    const pages = typeof info.pages === "number" ? info.pages : null;
    if (pages === 1) {
        const url = await pageUrl(path, 1);
        return url ? { page: 1, url } : null;
    }
    return pageDialog(path, name, pages, current);
}

function pageDialog(
    path: string,
    name: string,
    pages: number | null,
    current: number,
): Promise<PdfChoice | null> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (choice: PdfChoice | null) => {
            if (done) return;
            done = true;
            resolve(choice);
            closeDialog();
        };
        const grid = h("div", { class: "pdf-pages" });
        const urls = new Map<number, string>();
        const pick = async (page: number) => {
            const url = urls.get(page) ?? (await pageUrl(path, page));
            if (url) finish({ page, url });
        };
        const count = pages ?? THUMBS;
        for (let page = 1; page <= Math.min(count, THUMBS); page++) {
            grid.append(
                h(
                    "button",
                    {
                        type: "button",
                        class: `pdf-page${page === current ? " current" : ""}`,
                        title: `Page ${page}`,
                        "data-page": page,
                        onclick: () => void pick(page),
                    },
                    h("span", { class: "pdf-thumb" }),
                    h("span", {}, `Page ${page}`),
                ),
            );
        }
        const field = h("input", {
            type: "number",
            min: 1,
            max: pages ?? null,
            step: 1,
            value: String(current),
        });
        field.addEventListener("keydown", (e) => {
            if (e.key === "Enter") void pick(Math.max(1, Number(field.value)));
        });
        const body = h(
            "div",
            {},
            grid,
            h(
                "div",
                { class: "pdf-page-field" },
                h("label", {}, "Page ", field, pages ? ` of ${pages}` : ""),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn on",
                        onclick: () =>
                            void pick(Math.max(1, Number(field.value))),
                    },
                    "Use this page",
                ),
            ),
        );
        openDialog(`Which page of ${name}?`, body, {
            wide: true,
            hint: "A figure from a PDF shows one page",
            onClose: () => finish(null),
        });
        // One page at a time: the first thumbnails show while the rest convert.
        void (async () => {
            for (const card of grid.querySelectorAll<HTMLElement>(
                ".pdf-page",
            )) {
                if (done) return;
                const page = Number(card.dataset.page);
                const res = await request({ action: "pdf-page", path, page });
                if (!res.ok) {
                    // Past the last page of a PDF whose length is unknown.
                    for (const rest of grid.querySelectorAll<HTMLElement>(
                        ".pdf-page",
                    )) {
                        if (Number(rest.dataset.page) >= page) rest.remove();
                    }
                    return;
                }
                const url = String(res.url);
                urls.set(page, url);
                card.querySelector(".pdf-thumb")?.append(
                    h("img", { src: `/${url}`, alt: `Page ${page}` }),
                );
            }
        })();
    });
}
