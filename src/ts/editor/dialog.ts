// One modal dialog at a time (theme, find & replace, export): a titled box
// over the editor, closed with Esc, the × button or a click outside.

import { clear, h } from "./dom";

const host = document.getElementById("dialog")!;
let onClose: (() => void) | null = null;

export function openDialog(
    title: string,
    body: Node,
    opts: {
        wide?: boolean;
        large?: boolean;
        onClose?: () => void;
        hint?: string;
    } = {},
): HTMLElement {
    closeDialog();
    onClose = opts.onClose ?? null;
    const box = h(
        "div",
        {
            class: `dialog-box${opts.large ? " large" : opts.wide ? " wide" : ""}`,
            role: "dialog",
        },
        h(
            "div",
            { class: "dialog-head" },
            h("h2", {}, title),
            opts.hint ? h("span", { class: "hint" }, opts.hint) : null,
            h(
                "button",
                {
                    type: "button",
                    class: "dialog-close",
                    title: "Close (Esc)",
                    onclick: () => closeDialog(),
                },
                "×",
            ),
        ),
        h("div", { class: "dialog-body" }, body),
    );
    host.append(box);
    host.classList.add("open");
    return box;
}

export function closeDialog(): void {
    if (!host.classList.contains("open")) return;
    host.classList.remove("open");
    clear(host);
    const fn = onClose;
    onClose = null;
    fn?.();
}

export function dialogOpen(): boolean {
    return host.classList.contains("open");
}

export function initDialog(): void {
    host.addEventListener("pointerdown", (e) => {
        if (e.target === host) closeDialog();
    });
    document.addEventListener(
        "keydown",
        (e) => {
            // A field may claim Escape first (the folder picker's filter).
            const own = (e.target as Element | null)?.closest?.(
                "[data-own-escape]",
            );
            if (e.key === "Escape" && dialogOpen() && !own) {
                e.preventDefault();
                e.stopPropagation();
                closeDialog();
            }
        },
        true,
    );
    // Keys typed in the dialog never reach the editor's shortcuts.
    host.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") e.stopPropagation();
    });
}
