// The Export dialog: the deck as a single self-contained HTML file (the
// default), a web page with its media in a folder, or a PDF, the same builds
// as `inkflow build` (`--assets-folder`) and `inkflow export`. Each result is
// saved in the project and offered for download.

import { openDialog } from "./dialog";
import { h } from "./dom";
import { request } from "./net";
import { ed } from "./state";

const FORMATS: {
    format: "html" | "single" | "pdf";
    title: string;
    text: string;
    placeholder: (stem: string) => string;
}[] = [
    {
        format: "single",
        title: "HTML file",
        text: "One file with everything inside: slides, pictures, videos and fonts. Opens offline in any browser, looks the same everywhere, easy to email or share.",
        placeholder: (stem) => `${stem}.html`,
    },
    {
        format: "html",
        title: "Web page with an assets folder",
        text: "index.html with the pictures and videos as files beside it, for a large deck on a web host: the first slide shows at once and each video loads when needed.",
        placeholder: () => "build",
    },
    {
        format: "pdf",
        title: "PDF",
        text: "One page per slide, every build step shown. Needs Chromium or Chrome on this computer.",
        placeholder: (stem) => `${stem}.pdf`,
    },
];

function size(bytes: number): string {
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// For a print deck (a poster): the page it prints on, and print marks.
function printOptions(): { line: HTMLElement; marks: HTMLInputElement } | null {
    const deck = ed.model?.deckSize;
    if (!deck?.print) return null;
    const marks = h("input", { type: "checkbox" }) as HTMLInputElement;
    const line = h(
        "div",
        { class: "export-print" },
        h("p", { class: "hint" }, `Page: ${deck.label}, at its final size.`),
        h(
            "label",
            {
                title: "For a print shop that asks for bleed: the background runs 3 mm past each edge, and the corners are marked where to cut",
            },
            marks,
            " 3 mm bleed and crop marks",
        ),
    );
    return { line, marks };
}

function option(f: (typeof FORMATS)[number], stem: string): HTMLElement {
    const print = f.format === "pdf" ? printOptions() : null;
    const output = h("input", {
        type: "text",
        placeholder: f.placeholder(stem),
        spellcheck: "false",
        title: "Where to save it, relative to deck.py",
    });
    const status = h("div", { class: "export-status" });
    const go = h("button", { type: "button", class: "pbtn primary" }, "Export");
    go.addEventListener("click", async () => {
        go.disabled = true;
        status.textContent =
            f.format === "pdf" ? "Rendering pages…" : "Building…";
        status.className = "export-status busy";
        const result = await request({
            action: "export",
            format: f.format,
            output: output.value.trim() || null,
            printMarks: print?.marks.checked ?? false,
        });
        go.disabled = false;
        if (!result.ok) {
            status.className = "export-status error";
            status.textContent = result.error ?? "export failed";
            return;
        }
        const r = result as unknown as {
            rel: string;
            download: string;
            size: number;
        };
        status.className = "export-status done";
        status.replaceChildren(
            h("span", {}, `Saved to ${r.rel} · ${size(r.size)}`),
            h(
                "a",
                { href: r.download, class: "pbtn", download: "" },
                f.format === "html" ? "Download .zip" : "Download",
            ),
        );
    });
    return h(
        "div",
        { class: "export-option" },
        h(
            "div",
            { class: "export-text" },
            h("strong", {}, f.title),
            h("p", { class: "hint" }, f.text),
            print?.line ?? null,
        ),
        h("div", { class: "export-row" }, output, go),
        status,
    );
}

export function openExport(): void {
    const stem =
        ed.model?.deckPath.split(/[\\/]/).pop()?.replace(/\.py$/, "") ?? "deck";
    openDialog(
        "Export",
        h(
            "div",
            { class: "export-body" },
            ...FORMATS.map((f) => option(f, stem)),
        ),
        { hint: "Saved next to deck.py; the paths can be changed" },
    );
}

export function initExport(): void {
    document
        .getElementById("btn-export")
        ?.addEventListener("click", openExport);
}
