// A folder browser for paths on the server's machine (a browser cannot name a
// path on disk), shared by "New deck", "Open deck" and "Insert video from a
// folder". Type a path with Tab completion; typing (in the path or the list)
// narrows the list to the names starting with it; arrow keys and Enter move
// through it, Backspace goes up. Favourite folders and a default location
// are kept per user by the server (editor/places.py), and "Browse…" opens the
// system's own chooser when the server can show one.

import { clear, h, toast } from "./dom";
import { request } from "./net";
import {
    baseName,
    commonPrefix,
    joinPath,
    samePath,
    splitTyped,
    startingWith,
    withSep,
} from "./pathtext";

export interface Places {
    favorites: string[];
    default: string | null;
}

export interface Folder {
    path: string;
    parent: string | null;
    dirs: string[];
    files?: { name: string; size: number }[];
    isDeck: boolean;
    repo: string | null;
    home: string;
    places?: Places;
    systemPicker?: boolean;
}

export function megabytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function folderPicker(
    start: string,
    onChange: (folder: Folder) => void,
    // Also list files of a kind ("video", "media"), each picked with onFile.
    files?: { kind: string; onFile: (path: string) => void },
): {
    el: HTMLElement;
    current: () => Folder | null;
    focus: () => void;
} {
    let folder: Folder | null = null;
    let places: Places = { favorites: [], default: null };
    let filter = "";
    let typing = 0;

    const path = h("input", {
        type: "text",
        class: "folder-path",
        spellcheck: "false",
        autocomplete: "off",
        title: "Type a path: Tab completes, Enter opens, ↓ goes to the list",
    }) as HTMLInputElement;
    const list = h("div", { class: "folder-list", role: "listbox" });
    const where = h("div", { class: "hint folder-where" });
    const placesRow = h("div", { class: "folder-places" });
    const star = h("button", {
        type: "button",
        class: "pbtn folder-star",
    }) as HTMLButtonElement;
    const system = h(
        "button",
        {
            type: "button",
            class: "pbtn",
            hidden: true,
            title: "Choose with this computer's own dialog",
        },
        "Browse…",
    ) as HTMLButtonElement;

    const entries = () =>
        [...list.querySelectorAll<HTMLButtonElement>("button.folder")].filter(
            (b) => !b.hidden,
        );

    async function go(
        target: string,
        opts: { quiet?: boolean; focus?: "list" | "path" } = {},
    ): Promise<boolean> {
        const res = await request({
            action: "browse",
            path: target,
            files: files?.kind,
        });
        if (!res.ok) {
            if (!opts.quiet) {
                where.textContent = res.error ?? "Cannot open that folder";
            }
            return false;
        }
        folder = res as unknown as Folder;
        places = folder.places ?? places;
        system.hidden = !folder.systemPicker;
        path.value = withSep(folder.path);
        filter = "";
        renderList();
        renderPlaces();
        where.textContent = folder.repo
            ? `In the git repository at ${folder.repo}`
            : "Not in a git repository";
        onChange(folder);
        if (opts.focus === "list") (entries()[0] ?? path).focus();
        else if (opts.focus === "path") path.focus();
        return true;
    }

    function entry(
        label: string,
        kind: "up" | "dir" | "file",
        onOpen: () => void,
        extra?: Node,
    ): HTMLButtonElement {
        const b = h(
            "button",
            {
                type: "button",
                class: `folder ${kind === "file" ? "file" : kind === "up" ? "up" : ""}`,
                role: "option",
                onclick: onOpen,
            },
            label,
            extra ?? null,
        ) as HTMLButtonElement;
        return b;
    }

    function renderList(): void {
        clear(list);
        const f = folder;
        if (!f) return;
        if (f.parent && !filter) {
            list.append(
                entry("↑ ..", "up", () => {
                    if (f.parent) void go(f.parent, { focus: "list" });
                }),
            );
        }
        const dirs = startingWith(f.dirs, filter);
        for (const name of dirs) {
            list.append(
                entry(`📁 ${name}`, "dir", () => {
                    void go(joinPath(f.path, name), { focus: "list" });
                }),
            );
        }
        const shown = startingWith(
            (f.files ?? []).map((x) => x.name),
            filter,
        );
        for (const file of f.files ?? []) {
            if (!shown.includes(file.name)) continue;
            list.append(
                entry(
                    `🎞 ${file.name}`,
                    "file",
                    () => files?.onFile(joinPath(f.path, file.name)),
                    h(
                        "span",
                        { class: "hint file-size" },
                        megabytes(file.size),
                    ),
                ),
            );
        }
        if (!dirs.length && !shown.length) {
            list.append(
                h(
                    "p",
                    { class: "hint folder-empty" },
                    filter
                        ? `Nothing here starts with “${filter}”.`
                        : "No folders here.",
                ),
            );
        }
        path.toggleAttribute("data-own-escape", !!filter);
    }

    async function setPlaces(op: string, target: string | null): Promise<void> {
        const res = await request({ action: "places-set", op, path: target });
        if (!res.ok) {
            toast(res.error ?? "Cannot save that", "error");
            return;
        }
        places = res.places as Places;
        renderPlaces();
    }

    function chip(label: string, target: string, remove?: () => void) {
        return h(
            "span",
            { class: "place" },
            h(
                "button",
                {
                    type: "button",
                    class: "place-go",
                    title: target,
                    onclick: () => void go(target, { focus: "list" }),
                },
                label,
            ),
            remove
                ? h(
                      "button",
                      {
                          type: "button",
                          class: "place-remove",
                          title: "Remove from favourites",
                          onclick: remove,
                      },
                      "×",
                  )
                : null,
        );
    }

    function renderPlaces(): void {
        clear(placesRow);
        const here = folder?.path ?? "";
        const isFavorite = places.favorites.some((p) => samePath(p, here));
        star.textContent = isFavorite ? "★" : "☆";
        star.title = isFavorite
            ? "Remove this folder from your favourites"
            : "Add this folder to your favourites";
        star.classList.toggle("on", isFavorite);
        if (places.default) {
            placesRow.append(
                chip(`⌂ ${baseName(places.default)} (default)`, places.default),
            );
        }
        for (const p of places.favorites) {
            placesRow.append(
                chip(`★ ${baseName(p)}`, p, () => void setPlaces("remove", p)),
            );
        }
        const isDefault = !!places.default && samePath(places.default, here);
        placesRow.append(
            h(
                "button",
                {
                    type: "button",
                    class: "place-default",
                    title: isDefault
                        ? "New decks go here and Open deck starts here; click to forget it"
                        : "New decks go here and Open deck starts here",
                    onclick: () =>
                        void setPlaces("default", isDefault ? null : here),
                },
                isDefault
                    ? "✓ Default location"
                    : "Make this the default location",
            ),
        );
    }

    // ── Typing ──

    path.addEventListener("input", () => {
        window.clearTimeout(typing);
        const { dir, prefix } = splitTyped(path.value);
        if (folder && samePath(dir, folder.path)) {
            filter = prefix;
            renderList();
        } else if (dir && !prefix) {
            // A whole folder typed ("…/talks/"): show it.
            typing = window.setTimeout(
                () => void go(dir, { quiet: true }),
                250,
            );
        }
    });

    async function complete(): Promise<void> {
        const { dir, prefix } = splitTyped(path.value);
        if (!folder || !samePath(dir, folder.path)) {
            if (!dir || !(await go(dir, { quiet: true }))) return;
            path.value = withSep(folder!.path) + prefix;
        }
        const f = folder!;
        const matches = startingWith(f.dirs, prefix);
        if (matches.length === 1) {
            await go(joinPath(f.path, matches[0]));
            return;
        }
        const common = commonPrefix(matches);
        filter = common.length > prefix.length ? common : prefix;
        path.value = withSep(f.path) + filter;
        renderList();
    }

    path.addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            void complete();
        } else if (e.key === "Enter") {
            e.preventDefault();
            const { dir, prefix } = splitTyped(path.value);
            const f = folder;
            if (f && prefix && samePath(dir, f.path)) {
                const exact = f.dirs.find(
                    (d) => d.toLowerCase() === prefix.toLowerCase(),
                );
                const only = startingWith(f.dirs, prefix);
                const into = exact ?? (only.length === 1 ? only[0] : null);
                if (into) {
                    void go(joinPath(f.path, into));
                    return;
                }
            }
            void go(path.value);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            entries()[0]?.focus();
        } else if (e.key === "Escape" && filter && folder) {
            // Clears the typed filter; a second Escape closes the dialog.
            e.preventDefault();
            path.value = withSep(folder.path);
            filter = "";
            renderList();
        }
    });

    list.addEventListener("keydown", (e) => {
        const items = entries();
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const next = at + (e.key === "ArrowDown" ? 1 : -1);
            if (next < 0) path.focus();
            else items[Math.min(next, items.length - 1)]?.focus();
        } else if (e.key === "Backspace") {
            e.preventDefault();
            if (filter) {
                path.focus();
                path.value = path.value.slice(0, -1);
                path.dispatchEvent(new Event("input"));
            } else if (folder?.parent) {
                void go(folder.parent, { focus: "list" });
            }
        } else if (
            e.key.length === 1 &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            e.key !== " "
        ) {
            // Typing in the list narrows it, through the path line.
            e.preventDefault();
            path.focus();
            path.value += e.key;
            path.dispatchEvent(new Event("input"));
        }
    });

    // ── Buttons ──

    star.addEventListener("click", () => {
        const here = folder?.path;
        if (!here) return;
        const isFavorite = places.favorites.some((p) => samePath(p, here));
        void setPlaces(isFavorite ? "remove" : "add", here);
    });

    system.addEventListener("click", async () => {
        system.disabled = true;
        const before = where.textContent;
        where.textContent =
            "A dialog is open on this computer (it may be behind the browser)…";
        const res = await request({
            action: "system-pick",
            path: folder?.path ?? start,
            files: files?.kind,
            title: files ? "Choose a video" : "Choose a folder",
        });
        system.disabled = false;
        where.textContent = before;
        if (!res.ok) {
            toast(res.error ?? "No dialog could be shown", "error");
            return;
        }
        const chosen = typeof res.path === "string" ? res.path : null;
        if (!chosen) return;
        if (files) files.onFile(chosen);
        else void go(chosen);
    });

    const el = h(
        "div",
        { class: "folder-picker" },
        h(
            "div",
            { class: "folder-bar" },
            path,
            system,
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "Your home folder",
                    onclick: () =>
                        void go(folder?.home ?? "~", { focus: "list" }),
                },
                "Home",
            ),
            star,
        ),
        placesRow,
        list,
        where,
    );
    void go(start);
    return { el, current: () => folder, focus: () => path.focus() };
}
