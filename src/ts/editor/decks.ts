// Decks as projects: the "deck ▾" menu in the toolbar creates a new deck,
// opens another one or a recent one. The server builds the new deck
// (editor/projects.py) and then serves it instead; the page reloads when the
// model of another deck arrives (net.ts).

import { closeDialog, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { folderPicker, type Places } from "./folderpicker";
import { request, stopReconnecting, whenConnected } from "./net";
import { openFiles } from "./rename";
import { menuItem, showMenu } from "./sorter";
import { ed, on } from "./state";

const menu = document.getElementById("context-menu")!;
const button = document.getElementById("btn-deck")!;

interface LookColours {
    bg: string;
    surface: string;
    heading: string;
    muted: string;
    accent: string;
}

interface Look {
    id: string;
    label: string;
    description: string;
    preview?: LookColours | null;
}

// A look's thumbnail: a tiny slide in its theme's colours (a title, two
// lines of text, a card and an accent), portrait for a poster.
function lookThumb(look: Look): HTMLElement | null {
    const c = look.preview;
    if (!c) return null;
    const bar = (cls: string, colour: string) => {
        const el = h("span", { class: cls });
        el.style.background = colour;
        return el;
    };
    const thumb = h(
        "span",
        { class: `look-thumb${look.id === "poster" ? " portrait" : ""}` },
        bar("look-thumb-title", c.heading),
        bar("look-thumb-line", c.muted),
        bar("look-thumb-line short", c.muted),
        bar("look-thumb-card", c.surface),
        bar("look-thumb-accent", c.accent),
    );
    thumb.style.background = c.bg;
    thumb.style.borderColor = c.surface;
    return thumb;
}

interface DeckInfo {
    repo: string | null;
    parent: string;
    name: string;
    home: string;
    current: string;
    themes: Look[];
    posterSizes?: { id: string; label: string }[];
    git: boolean;
    lfs: boolean;
    recent: string[];
    places?: Places;
}

function baseName(path: string): string {
    return (
        path
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() ?? path
    );
}

function join(dir: string, name: string): string {
    return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

function slug(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "my-deck"
    );
}

function renderButton(): void {
    const dir = ed.model?.projectDir;
    button.textContent = `${dir ? baseName(dir) : "deck"} ▾`;
    button.title = dir ? `${dir}\nDecks: new, open, recent` : "Decks";
}

async function info(): Promise<DeckInfo | null> {
    const res = await request({ action: "project-info" });
    if (!res.ok) {
        toast(res.error ?? "Cannot read the deck's folder", "error");
        return null;
    }
    return res as unknown as DeckInfo;
}

async function openMenu(): Promise<void> {
    const data = await info();
    if (!data) return;
    clear(menu);
    menu.append(
        menuItem("New deck…", () => newDeckDialog(data)),
        menuItem("Open deck…", () => openDeckDialog(data)),
    );
    if (data.recent.length) {
        menu.append(h("div", { class: "menu-title" }, "Recent decks"));
        for (const path of data.recent) {
            const dir = path.replace(/[\\/]deck\.py$/, "");
            const item = menuItem(baseName(dir), () => void openDeck(path));
            item.title = dir;
            menu.append(item);
        }
    }
    if (ed.model) {
        menu.append(
            h("div", { class: "menu-sep" }),
            menuItem("Files…", () => void openFiles()),
        );
    }
    menu.append(
        h("div", { class: "menu-sep" }),
        menuItem("Quit Inkflow", () => void quit()),
    );
    const r = button.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4);
}

async function openDeck(path: string): Promise<boolean> {
    const res = await request({ action: "open-deck", path });
    if (!res.ok) {
        toast(res.error ?? "Cannot open that deck", "error");
        return false;
    }
    closeDialog();
    if (res.redirect) {
        // Another inkflow has this deck open: edit it there, never in two
        // servers at once.
        toast("That deck is already open: switching to it…");
        location.assign(String(res.redirect));
        return true;
    }
    if (!res.opening) {
        toast("That deck is the one open here");
        return true;
    }
    toast(
        `Opening ${baseName(String(res.deck ?? path).replace(/[\\/]deck\.py$/, ""))}…`,
    );
    return true;
}

// ── New deck ──

function newDeckDialog(data: DeckInfo): void {
    const title = h("input", {
        type: "text",
        value: "My presentation",
    }) as HTMLInputElement;
    const name = h("input", {
        type: "text",
        value: data.name,
    }) as HTMLInputElement;
    let nameEdited = false;
    name.addEventListener("input", () => {
        nameEdited = true;
        update();
    });
    let titleEdited = false;
    title.addEventListener("input", () => {
        titleEdited = true;
        if (!nameEdited) name.value = slug(title.value);
        update();
    });

    let look = data.themes.some((t) => t.id === "current")
        ? "current"
        : "starter";
    // A poster's paper size; the A sizes share one canvas, so it can change
    // later in deck.py (Deck(size=...)) without redrawing anything.
    const size = h(
        "select",
        {},
        ...(data.posterSizes ?? []).map((s) =>
            h("option", { value: s.id }, s.label),
        ),
    ) as HTMLSelectElement;
    const sizeRow = h(
        "label",
        { class: "field inline poster-size" },
        h("span", { class: "field-label" }, "Paper size"),
        size,
    );
    sizeRow.hidden = true;
    const looks = h(
        "div",
        { class: "look-list" },
        ...data.themes.map((t) => {
            const radio = h("input", {
                type: "radio",
                name: "deck-look",
                value: t.id,
            }) as HTMLInputElement;
            radio.checked = t.id === look;
            radio.addEventListener("change", () => {
                look = t.id;
                sizeRow.hidden = look !== "poster";
                if (look === "poster" && !titleEdited) {
                    title.value = "My poster";
                    if (!nameEdited) name.value = slug(title.value);
                    update();
                }
            });
            return h(
                "label",
                { class: "look" },
                radio,
                lookThumb(t),
                h(
                    "span",
                    { class: "look-text" },
                    h("strong", {}, t.label),
                    h("span", { class: "hint" }, t.description),
                ),
            );
        }),
    );

    const git = h("input", { type: "checkbox" }) as HTMLInputElement;
    git.checked = true;
    git.addEventListener("change", () => update());
    const gitRow = h(
        "label",
        { class: "check-row" },
        git,
        "Create a git repository for this deck",
    );
    const gitNote = h("p", { class: "hint" });
    // Git LFS for videos, images and fonts, or git only (a small repository).
    const lfs = h("input", { type: "checkbox" }) as HTMLInputElement;
    lfs.checked = data.lfs;
    const lfsRow = h(
        "label",
        { class: "check-row" },
        lfs,
        "Store videos, images and fonts with Git LFS",
    );
    const lfsNote = h(
        "p",
        { class: "hint" },
        data.lfs
            ? "Untick for git only: media is kept in git itself, fine for a small repository."
            : "git-lfs is not installed, so this deck uses git only (its .gitattributes says so; install git-lfs to switch later).",
    );
    const full = h("p", { class: "hint full-path" });
    const picker = folderPicker(data.parent, () => update());

    function update(): void {
        const folder = picker.current();
        const parent = folder?.path ?? data.parent;
        full.textContent = `New deck: ${join(parent, name.value || "…")}`;
        const inRepo = !!folder?.repo;
        gitRow.hidden = inRepo || !data.git;
        lfsRow.hidden = !data.git || (!inRepo && !git.checked);
        lfsNote.hidden = lfsRow.hidden;
        gitNote.textContent = inRepo
            ? `It becomes a new folder of the git repository at ${folder?.repo}, versioned with it.`
            : data.git
              ? ""
              : "git is not installed, so the deck gets no repository.";
    }

    const create = h(
        "button",
        { type: "button", class: "pbtn primary" },
        "Create and open",
    ) as HTMLButtonElement;
    create.addEventListener("click", async () => {
        const folder = picker.current();
        if (!folder || !name.value.trim()) {
            toast("Choose a folder and a name for the deck", "error");
            return;
        }
        create.disabled = true;
        create.textContent = "Creating…";
        const res = await request({
            action: "new-deck",
            path: join(folder.path, name.value.trim()),
            title: title.value,
            theme: look,
            size: look === "poster" ? size.value : null,
            git: !folder.repo && git.checked,
            lfs: lfs.checked,
        });
        create.disabled = false;
        create.textContent = "Create and open";
        if (!res.ok) {
            toast(res.error ?? "Could not create the deck", "error");
            return;
        }
        closeDialog();
        toast(`Created ${name.value.trim()}; opening it…`, "ok");
    });

    openDialog(
        "New deck",
        h(
            "div",
            { class: "deck-form" },
            h(
                "label",
                { class: "field" },
                h("span", { class: "field-label" }, "Title"),
                title,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Look"),
                h("div", {}, looks, sizeRow),
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Where"),
                h(
                    "div",
                    {},
                    picker.el,
                    h(
                        "label",
                        { class: "field inline" },
                        h("span", { class: "field-label" }, "Folder name"),
                        name,
                    ),
                    full,
                    gitRow,
                    gitNote,
                    lfsRow,
                    lfsNote,
                ),
            ),
            h("div", { class: "btn-row end" }, create),
        ),
        { large: true },
    );
    update();
    title.select();
}

// ── Open deck ──

function openDeckDialog(data: DeckInfo): void {
    const open = h(
        "button",
        { type: "button", class: "pbtn primary", disabled: true },
        "Open this deck",
    ) as HTMLButtonElement;
    const picker = folderPicker(
        data.places?.default ?? data.current.replace(/[\\/][^\\/]*$/, ""),
        (f) => {
            open.disabled = !f.isDeck;
            open.textContent = f.isDeck
                ? `Open ${baseName(f.path)}`
                : "No deck.py in this folder";
        },
    );
    open.addEventListener("click", () => {
        const f = picker.current();
        if (f?.isDeck) void openDeck(join(f.path, "deck.py"));
    });
    openDialog(
        "Open deck",
        h(
            "div",
            { class: "deck-form" },
            h("p", { class: "hint" }, "Go to a folder with a deck.py in it."),
            picker.el,
            h("div", { class: "btn-row end" }, open),
        ),
        { large: true },
    );
    picker.focus();
}

// Stops this server (the deck's files are saved as you go); the page says so.
async function quit(): Promise<void> {
    const res = await request({ action: "quit" });
    if (!res.ok) {
        toast(res.error ?? "Cannot stop inkflow from here", "error");
        return;
    }
    stopReconnecting();
    document.getElementById("start")?.remove();
    document.body.classList.add("start-mode");
    document.body.append(
        h(
            "div",
            { id: "start", class: "start" },
            h(
                "div",
                { class: "start-card" },
                h("div", { class: "start-logo" }, "ink", h("b", {}, "flow")),
                h(
                    "p",
                    { class: "start-lead" },
                    "Inkflow has stopped. Everything was saved as you went; you can close this tab.",
                ),
            ),
        ),
    );
}

// ── Start page ──
//
// The editor without a deck (`inkflow edit --start`, the desktop launcher):
// a new deck, another one from a folder, or a recent one. The server then
// serves that deck and the page reloads into it (net.ts).

export async function showStart(): Promise<void> {
    document.body.classList.add("start-mode");
    await whenConnected();
    const data = await info();
    const recent = h("div", { class: "start-recent" });
    if (data?.recent.length) {
        recent.append(h("h2", {}, "Recent decks"));
        for (const path of data.recent) {
            const dir = path.replace(/[\\/]deck\.py$/, "");
            recent.append(
                h(
                    "button",
                    {
                        type: "button",
                        class: "start-deck",
                        title: dir,
                        onclick: () => void openDeck(path),
                    },
                    h("span", { class: "start-deck-name" }, baseName(dir)),
                    h("span", { class: "start-deck-path" }, dir),
                ),
            );
        }
    }
    const action = (label: string, hint: string, fn: () => void) =>
        h(
            "button",
            { type: "button", class: "start-action", onclick: fn },
            h("span", { class: "start-action-label" }, label),
            h("span", { class: "start-action-hint" }, hint),
        );
    const page = h(
        "div",
        { id: "start", class: "start" },
        h(
            "div",
            { class: "start-card" },
            h("div", { class: "start-logo" }, "ink", h("b", {}, "flow")),
            h(
                "p",
                { class: "start-lead" },
                "Slides you draw, write and version.",
            ),
            h(
                "div",
                { class: "start-actions" },
                // Asked afresh each time: a default location saved in the
                // picker since counts.
                action(
                    "New deck…",
                    "Start from one of seven looks",
                    async () => {
                        const fresh = await info();
                        if (fresh) newDeckDialog(fresh);
                    },
                ),
                action("Open deck…", "A folder with a deck.py", async () => {
                    const fresh = await info();
                    if (fresh) openDeckDialog(fresh);
                }),
            ),
            recent,
            h(
                "button",
                {
                    type: "button",
                    class: "start-quit",
                    onclick: () => void quit(),
                },
                "Quit Inkflow",
            ),
        ),
    );
    document.body.append(page);
}

export function initDecks(): void {
    button.addEventListener("click", () => void openMenu());
    on("model", renderButton);
    renderButton();
}
