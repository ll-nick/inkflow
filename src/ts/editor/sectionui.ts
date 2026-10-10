// Section headers in the slide list and the grid view: the name, the slide
// count and a caret that collapses the section (remembered per deck in this
// browser, never in deck.py); double-click renames, right-click has the
// section menu, and the header drags to move the whole section. Every change
// is one `slide` edit of deck.py (session.py `section-*` ops).

import { closeDialog, openDialog } from "./dialog";
import { h, icon } from "./dom";
import { edit } from "./net";
import {
    moveRequest,
    sectionKeys,
    sectionMoveTo,
    sectionOf,
    sectionSlides,
} from "./sections";
import { followSelect, gotoSlide, menuItem, showMenu } from "./sorter";
import { ed, emit } from "./state";
import type { SectionInfo } from "./types";

export function sections(): SectionInfo[] {
    return ed.model?.sections ?? [];
}

// ── Collapsed sections (per deck, this browser only) ──

let collapsedKeys: Set<string> | null = null;
let collapsedDeck = "";

function storageKey(): string {
    return `inkflow-editor-collapsed:${ed.model?.deckPath ?? ""}`;
}

function collapsedSet(): Set<string> {
    const deck = ed.model?.deckPath ?? "";
    if (collapsedKeys && collapsedDeck === deck) return collapsedKeys;
    collapsedDeck = deck;
    collapsedKeys = new Set();
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey()) ?? "[]");
        if (Array.isArray(saved)) {
            for (const k of saved)
                if (typeof k === "string") collapsedKeys.add(k);
        }
    } catch {
        // nothing remembered
    }
    return collapsedKeys;
}

function saveCollapsed(): void {
    try {
        localStorage.setItem(storageKey(), JSON.stringify([...collapsedSet()]));
    } catch {
        // not remembered
    }
}

export function isCollapsed(k: number): boolean {
    const key = sectionKeys(sections())[k];
    return key != null && collapsedSet().has(key);
}

export function setCollapsed(k: number, on: boolean): void {
    const key = sectionKeys(sections())[k];
    if (key == null) return;
    if (on) collapsedSet().add(key);
    else collapsedSet().delete(key);
    saveCollapsed();
    emit("sections");
}

function setAllCollapsed(on: boolean): void {
    const set = collapsedSet();
    for (const key of sectionKeys(sections())) {
        if (on) set.add(key);
        else set.delete(key);
    }
    saveCollapsed();
    emit("sections");
}

/** Open the section holding the slide being edited, so it is never hidden. */
export function revealCurrent(): boolean {
    const k = sectionOf(sections(), ed.current);
    if (k == null || !isCollapsed(k)) return false;
    const key = sectionKeys(sections())[k];
    collapsedSet().delete(key);
    saveCollapsed();
    return true;
}

// ── Edits ──

async function sectionEdit(req: Record<string, unknown>): Promise<boolean> {
    const result = await edit({
        action: "slide",
        follow: ed.current,
        ...req,
    });
    if (result.ok && typeof result.select === "number") {
        followSelect(result.select);
    }
    return result.ok;
}

/** Move `slides` so they land at `insertAt` in `section` (see sections.ts). */
export async function moveSlidesTo(
    slides: number[],
    insertAt: number,
    section: number | null,
): Promise<void> {
    const move = moveRequest(sections(), slides, insertAt, section);
    if (!move) return;
    if (await sectionEdit({ op: "move", ...move })) ed.slideSelection.clear();
}

/** Put section `k` at gap `gap` among the sections (0 = first). */
export async function moveSectionToGap(k: number, gap: number): Promise<void> {
    const to = sectionMoveTo(k, gap);
    if (to == null) return;
    await sectionEdit({ op: "section-move", section: k, to });
}

export async function addSectionAt(slide: number | null): Promise<void> {
    const name = await askName("Add section", "New section");
    if (name == null) return;
    await sectionEdit({ op: "section-add", slide, name });
}

async function removeSection(k: number, withSlides: boolean): Promise<void> {
    const s = sections()[k];
    if (!s) return;
    if (
        withSlides &&
        !window.confirm(
            `Remove section “${s.name}” and its ${s.count} slide${s.count === 1 ? "" : "s"} from the deck? (Their files stay on disk.)`,
        )
    ) {
        return;
    }
    await sectionEdit({ op: "section-remove", section: k, slides: withSlides });
}

export function selectSection(k: number): void {
    const indices = sectionSlides(sections(), k);
    ed.focus = "sorter";
    ed.slideSelection.clear();
    if (!indices.length) {
        emit("slide-selection");
        return;
    }
    for (const i of indices) ed.slideSelection.add(i);
    if (!indices.includes(ed.current)) gotoSlide(indices[0]);
    emit("slide-selection");
}

// ── A name, asked for in the editor's dialog ──

function askName(title: string, initial: string): Promise<string | null> {
    return new Promise((resolve) => {
        let answer: string | null = null;
        const input = h("input", {
            type: "text",
            class: "section-name-input",
            value: initial,
            "aria-label": "Section name",
        }) as HTMLInputElement;
        const ok = h(
            "button",
            { type: "submit", class: "pbtn primary" },
            "Add",
        );
        const form = h(
            "form",
            { class: "section-name-form" },
            input,
            ok,
        ) as HTMLFormElement;
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const name = input.value.trim();
            if (!name) return;
            answer = name;
            closeDialog();
        });
        openDialog(title, form, { onClose: () => resolve(answer) });
        input.focus();
        input.select();
    });
}

// ── Inline rename ──

function startRename(k: number, nameEl: HTMLElement): void {
    const s = sections()[k];
    if (!s || !ed.model?.deckEditable) return;
    const input = h("input", {
        type: "text",
        class: "section-rename",
        value: s.name,
        "aria-label": "Section name",
    }) as HTMLInputElement;
    let done = false;
    const finish = (commit: boolean) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (commit && name && name !== s.name) {
            void sectionEdit({ op: "section-rename", section: k, name });
        } else {
            emit("sections"); // put the name back
        }
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
        }
    });
    input.addEventListener("blur", () => finish(true));
    for (const ev of ["click", "dblclick", "pointerdown", "dragstart"]) {
        input.addEventListener(ev, (e) => e.stopPropagation());
    }
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
}

let renameNext: number | null = null;

// ── The header and its menu ──

export function openSectionMenu(x: number, y: number, k: number): void {
    const menu = document.getElementById("context-menu")!;
    const s = sections()[k];
    if (!s) return;
    const editable = !!ed.model?.deckEditable;
    const n = sections().length;
    menu.replaceChildren();
    menu.append(
        menuItem(
            "Rename…",
            () => {
                renameNext = k;
                emit("sections");
            },
            !editable,
        ),
        menuItem(
            "Select all slides in section",
            () => selectSection(k),
            s.count === 0,
        ),
        menuItem(
            "Move section up",
            () => void moveSectionToGap(k, k - 1),
            !editable || k === 0,
        ),
        menuItem(
            "Move section down",
            () => void moveSectionToGap(k, k + 2),
            !editable || k === n - 1,
        ),
        menuItem(isCollapsed(k) ? "Expand" : "Collapse", () =>
            setCollapsed(k, !isCollapsed(k)),
        ),
        menuItem("Collapse all", () => setAllCollapsed(true)),
        menuItem("Expand all", () => setAllCollapsed(false)),
        menuItem(
            "Remove section",
            () => void removeSection(k, false),
            !editable,
        ),
        menuItem(
            "Remove section and its slides…",
            () => void removeSection(k, true),
            !editable || s.count === 0,
        ),
    );
    showMenu(x, y);
}

/** One section's header row; `view` styles it for the list or the grid. */
export function sectionHeader(
    k: number,
    view: "sorter" | "grid",
    onClick?: (e: MouseEvent) => void,
): HTMLElement {
    const s = sections()[k];
    const collapsed = isCollapsed(k);
    const editable = !!ed.model?.deckEditable;
    const name = h("span", { class: "section-name" }, s.name);
    const caret = h(
        "button",
        {
            type: "button",
            class: "section-caret",
            title: collapsed ? "Expand section" : "Collapse section",
            "aria-expanded": collapsed ? "false" : "true",
            onclick: (e: MouseEvent) => {
                e.stopPropagation();
                setCollapsed(k, !collapsed);
            },
        },
        icon("down", 14),
    );
    const head = h(
        "div",
        {
            class: `section-head ${view}-section-head${collapsed ? " collapsed" : ""}`,
            draggable: editable ? "true" : null,
            "data-section": k,
            title: `${s.name}: ${s.count} slide${s.count === 1 ? "" : "s"}${editable ? " (drag to move the section, double-click to rename)" : ""}`,
        },
        caret,
        name,
        h(
            "span",
            { class: "section-count" },
            s.count === 0 ? "empty" : String(s.count),
        ),
    );
    name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRename(k, name);
    });
    head.addEventListener("click", (e) => onClick?.(e));
    head.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSectionMenu(e.clientX, e.clientY, k);
    });
    if (renameNext === k) {
        renameNext = null;
        queueMicrotask(() => startRename(k, name));
    }
    return head;
}
