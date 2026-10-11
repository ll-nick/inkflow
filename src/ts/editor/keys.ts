// The editor's keyboard shortcuts on the page: which command a key press
// runs (with the keys a person chose instead of the defaults, remembered in
// this browser), the Keyboard shortcuts dialog that shows and changes them,
// and the toolbar's Help menu. The table and its rules are keystext.ts.

import { openDialog } from "./dialog";
import { clear, h } from "./dom";
import {
    assign,
    comboOf,
    commandOf,
    display,
    effective,
    filterShortcuts,
    GROUPS,
    type Overrides,
    parseOverrides,
    reset,
    retitle,
    type Shortcut,
    shortcut,
} from "./keystext";
import { closeMenu, menuItem, showMenu } from "./sorter";
import { emit } from "./state";

const KEY = "inkflow-editor-keys";
const DOCS = "https://ll-nick.github.io/inkflow/editor/";

let overrides: Overrides = {};
let bindings = effective(overrides);

function load(): void {
    try {
        overrides = parseOverrides(localStorage.getItem(KEY));
    } catch {
        overrides = {};
    }
    bindings = effective(overrides);
}

function save(next: Overrides): void {
    overrides = next;
    bindings = effective(overrides);
    try {
        if (Object.keys(overrides).length)
            localStorage.setItem(KEY, JSON.stringify(overrides));
        else localStorage.removeItem(KEY);
    } catch {
        // kept for this page only
    }
    retitleAll();
    emit("keys");
}

/** The command a key press runs, if any (fixed ones included). */
export function commandFor(e: KeyboardEvent): string | null {
    return commandOf(bindings, comboOf(e));
}

/** Whether a key press is one of command `id`'s keys. */
export function matches(e: KeyboardEvent, id: string): boolean {
    const combo = comboOf(e);
    return !!combo && (bindings[id] ?? []).includes(combo);
}

/** Command `id`'s keys as shown in menus and titles, "" when it has none. */
export function keyLabel(id: string): string {
    return (bindings[id] ?? []).map((k) => display(k)).join(", ");
}

/** The first of command `id`'s keys as shown ("" when none). */
export function firstKey(id: string): string {
    const k = bindings[id]?.[0];
    return k ? display(k) : "";
}

// ── titles ──

// Elements with `data-keys="id …"` have those commands' default keys in
// their title, as "(R)": they follow the keys chosen instead.
function retitleAll(): void {
    for (const el of document.querySelectorAll<HTMLElement>("[data-keys]")) {
        el.dataset.baseTitle ??= el.title;
        let title = el.dataset.baseTitle;
        for (const id of (el.dataset.keys ?? "").split(/\s+/)) {
            const s = shortcut(id);
            if (!s) continue;
            title = retitle(
                title,
                s.keys.map((k) => display(k)),
                (bindings[id] ?? []).map((k) => display(k)),
            );
        }
        el.title = title;
    }
}

// ── the dialog ──

let recording: { id: string; button: HTMLElement } | null = null;
let redraw: (() => void) | null = null;

function chips(keys: string[]): Node[] {
    if (!keys.length) return [h("span", { class: "keys-none" }, "none")];
    return keys.map((k) => h("kbd", {}, display(k)));
}

function stopRecording(): void {
    recording = null;
    window.removeEventListener("keydown", onRecordKey, true);
    redraw?.();
}

function onRecordKey(e: KeyboardEvent): void {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const combo = comboOf(e);
    if (!combo) return; // a modifier alone: wait for the key
    const { id } = recording;
    if (combo === "Escape") {
        stopRecording();
        return;
    }
    if (combo === "Backspace" || combo === "Delete") {
        save({ ...overrides, [id]: [] });
        note(`${shortcut(id)?.label}: no key now`);
        stopRecording();
        return;
    }
    const result = assign(overrides, id, combo);
    if (!result.ok) {
        note(result.error, true);
        return; // still listening: try another key
    }
    save(result.overrides);
    note(
        result.took
            ? `${display(combo)} was ${shortcut(result.took)?.label}'s; that has no key now`
            : "",
    );
    stopRecording();
}

let noteEl: HTMLElement | null = null;

function note(text: string, error = false): void {
    if (!noteEl) return;
    noteEl.textContent = text;
    noteEl.classList.toggle("error", error);
}

function row(s: Shortcut): HTMLElement {
    const keys = bindings[s.id] ?? [];
    const own = s.id in overrides;
    const live = recording?.id === s.id;
    const cells: Node[] = [h("span", { class: "keys-label" }, s.label)];
    if (s.fixed) {
        cells.push(
            h(
                "span",
                { class: "keys-fixed", title: "Fixed: these keys stay" },
                ...chips(keys),
            ),
        );
    } else {
        const button = h(
            "button",
            {
                type: "button",
                class: `keys-set${live ? " live" : ""}${own ? " own" : ""}`,
                title: "Click, then press the new keys (Esc: keep them, Backspace: no key)",
                "data-own-escape": "",
                onclick: () => {
                    if (live) {
                        stopRecording();
                        return;
                    }
                    recording = { id: s.id, button };
                    window.addEventListener("keydown", onRecordKey, true);
                    note("");
                    redraw?.();
                },
            },
            ...(live
                ? [h("span", { class: "keys-press" }, "Press keys…")]
                : chips(keys)),
        );
        cells.push(button);
        cells.push(
            own
                ? h(
                      "button",
                      {
                          type: "button",
                          class: "keys-reset",
                          title: `Back to ${s.keys.map((k) => display(k)).join(", ")}`,
                          onclick: () => {
                              save(reset(overrides, s.id));
                              note("");
                          },
                      },
                      "↺",
                  )
                : h("span", { class: "keys-reset-gap" }),
        );
    }
    return h("div", { class: `keys-row${s.fixed ? " fixed" : ""}` }, ...cells);
}

/** The Keyboard shortcuts dialog: every command with its keys, each
 * changeable by a click and a key press. */
export function openShortcuts(): void {
    const search = h("input", {
        type: "text",
        class: "keys-search",
        placeholder: "Search commands or keys",
        "aria-label": "Search commands or keys",
    }) as HTMLInputElement;
    const list = h("div", { class: "keys-list" });
    noteEl = h("p", { class: "keys-note", role: "status" });
    const resetAll = h(
        "button",
        {
            type: "button",
            class: "pbtn",
            title: "Every command back to its default keys",
            onclick: () => {
                save({});
                note("Every shortcut is back to its default");
            },
        },
        "Reset all",
    ) as HTMLButtonElement;
    redraw = () => {
        clear(list);
        const shown = filterShortcuts(bindings, search.value);
        for (const group of GROUPS) {
            const rows = shown.filter((s) => s.group === group);
            if (!rows.length) continue;
            list.append(
                h("h3", { class: "keys-group" }, group),
                ...rows.map(row),
            );
        }
        if (!shown.length)
            list.append(h("p", { class: "hint" }, "No command matches"));
        resetAll.disabled = !Object.keys(overrides).length;
        if (recording)
            list.querySelector<HTMLElement>(".keys-set.live")?.focus();
    };
    search.addEventListener("input", () => redraw?.());
    openDialog(
        "Keyboard shortcuts",
        h(
            "div",
            { class: "keys-dialog" },
            h("div", { class: "keys-head" }, search, resetAll),
            noteEl,
            list,
            h(
                "p",
                { class: "hint" },
                "Click a command's keys and press new ones. Your keys are kept in this browser. Ctrl stands for ⌘ on a Mac. The presenter's keys: press ? there.",
            ),
        ),
        {
            wide: true,
            onClose: () => {
                if (recording) stopRecording();
                redraw = null;
                noteEl = null;
            },
        },
    );
    redraw();
    search.focus();
}

// ── the Help menu ──

function openHelpMenu(button: HTMLElement): void {
    closeMenu();
    const withKeys = (label: string, id: string) =>
        firstKey(id) ? `${label}  (${firstKey(id)})` : label;
    const menu = document.getElementById("context-menu")!;
    menu.append(
        h("div", { class: "menu-title" }, "Settings"),
        menuItem(withKeys("Keyboard shortcuts…", "help.shortcuts"), () =>
            openShortcuts(),
        ),
        h("div", { class: "menu-sep" }),
        h("div", { class: "menu-title" }, "Help"),
        menuItem(withKeys("Command palette…", "help.palette"), () =>
            emit("palette"),
        ),
        menuItem("Editor guide ↗", () =>
            window.open(DOCS, "_blank", "noopener"),
        ),
    );
    const r = button.getBoundingClientRect();
    showMenu(Math.max(8, r.right - 220), r.bottom + 4);
}

export function initKeys(): void {
    load();
    retitleAll();
    const button = document.getElementById("btn-help");
    button?.addEventListener("click", (e) => {
        e.stopPropagation();
        openHelpMenu(button);
    });
    // A change made in another tab of this editor.
    window.addEventListener("storage", (e) => {
        if (e.key !== KEY) return;
        load();
        retitleAll();
        emit("keys");
        if (redraw) redraw();
    });
}
