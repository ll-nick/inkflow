// "Open ▾": open one of the deck's source files in another program on this
// machine — Inkscape for a drawing, GIMP or Krita for a picture, a text editor
// for Markdown and deck.py, or whatever the system opens it with. The server
// lists what is installed (inkflow/edit.py open_choices) and launches it; the
// browser only names the file.

import { clear, h, toast } from "./dom";
import { request } from "./net";
import { menuItem, showMenu } from "./sorter";
import { ed } from "./state";

const menu = document.getElementById("context-menu")!;

interface App {
    id: string;
    label: string;
}

export function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

/** Whether `path` (absolute, or relative to the project) is the project's. */
function inProject(path: string): boolean {
    const root = ed.model?.projectDir;
    if (!path.startsWith("/")) return !path.split("/").includes("..");
    return !!root && path.startsWith(`${root}/`);
}

export async function openMenu(
    path: string,
    x: number,
    y: number,
): Promise<void> {
    const res = await request({ action: "open-apps", path });
    if (!res.ok) {
        toast(res.error ?? "Cannot open this file", "error");
        return;
    }
    const apps: App[] = res.apps ?? [];
    clear(menu);
    menu.append(h("div", { class: "menu-title" }, `Open ${fileName(path)} in`));
    for (const app of apps) {
        menu.append(menuItem(app.label, () => void open(path, app)));
    }
    menu.append(
        menuItem("Copy path", () => {
            const root = ed.model?.projectDir ?? "";
            const full = path.startsWith("/") ? path : `${root}/${path}`;
            void navigator.clipboard.writeText(full).then(
                () => toast(`Copied ${full}`, "ok"),
                () => toast(full),
            );
        }),
    );
    showMenu(x, y);
}

async function open(path: string, app: App): Promise<void> {
    const res = await request({ action: "open-file", path, app: app.id });
    if (res.ok) toast(`Opened ${fileName(path)} in ${app.label}`, "ok");
    else toast(res.error ?? "Could not open the file", "error");
}

/** A small "Open ▾" button for a project file, or null when there is none. */
export function openButton(
    path: string | null | undefined,
    label = "Open",
): HTMLElement | null {
    if (!path || !inProject(path)) return null;
    return h(
        "button",
        {
            type: "button",
            class: "pbtn open-with",
            title: `Open ${fileName(path)} in another program`,
            onclick: (e: MouseEvent) => {
                const r = (
                    e.currentTarget as HTMLElement
                ).getBoundingClientRect();
                void openMenu(path, r.left, r.bottom + 4);
            },
        },
        `${label} ▾`,
    );
}
