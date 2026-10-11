// The command palette: Space, Ctrl+K or Ctrl+Shift+P (⌘ on a Mac) opens a
// search box over everything the editor does — the toolbar's buttons, the
// slide, Git and deck menus, the panels and views — and every slide by its
// number, title or id. Type a few letters (in order, not necessarily
// together), ↑/↓ to pick, Enter to run, Esc to close. Matching is in
// palettetext.ts.

import { addComment, openComments } from "./comments";
import { openCompare } from "./compare";
import { deckCommands } from "./decks";
import { clear, h } from "./dom";
import { openExport } from "./exportdlg";
import { openFind } from "./find";
import { gitCommands } from "./git";
import { toggleGrid } from "./grid";
import { keyLabel, matches, openShortcuts } from "./keys";
import { openMaster } from "./master";
import { type Command, fromTitle, rank } from "./palettetext";
import { togglePanel } from "./panels";
import { openProblems } from "./problems";
import { addSectionAt } from "./sectionui";
import {
    commitSlides,
    compareSlide,
    discardSlides,
    jumpToChange,
} from "./slidegit";
import {
    deleteSlide,
    duplicateSlide,
    gotoSlide,
    newSlideLike,
    toggleHidden,
} from "./sorter";
import { toggleStar } from "./stars";
import { ed, on } from "./state";
import { openTheme } from "./theme";
import { redo, toggleFullscreen, undo } from "./toolbar";

let box: HTMLElement | null = null;

function slideCommands(): Command[] {
    const slides = ed.model?.slides ?? [];
    return slides.map((s, i) => ({
        label: `${i + 1} ${s.title ?? s.id ?? s.src}${s.visible ? "" : " (hidden)"}`,
        group: "Slide",
        hint: `${s.id ?? ""} ${s.src}`,
        run: () => {
            ed.slideSelection.clear();
            gotoSlide(i);
        },
    }));
}

// The toolbar's buttons as commands, named by their titles.
function toolbarCommands(): Command[] {
    const out: Command[] = [];
    const seen = new Set<string>();
    for (const b of document.querySelectorAll<HTMLButtonElement>(
        "#toolbar button[title]",
    )) {
        // (deck ▾ is the deck commands; its title is the deck's folder.)
        if (b.disabled || b.hidden || !b.offsetParent || b.id === "btn-deck")
            continue;
        const { label, keys } = fromTitle(b.title);
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push({ label, group: "Toolbar", keys, run: () => b.click() });
    }
    return out;
}

function editorCommands(): Command[] {
    const i = ed.current;
    const editable = !!ed.model?.deckEditable;
    const out: Command[] = [
        {
            label: "Undo",
            group: "Edit",
            keys: "Ctrl+Z",
            run: () => void undo(),
        },
        {
            label: "Redo",
            group: "Edit",
            keys: "Ctrl+Shift+Z",
            run: () => void redo(),
        },
        {
            label: "Find and replace",
            group: "Edit",
            keys: keyLabel("edit.find"),
            run: () => openFind(),
        },
        { label: "Theme…", group: "Deck", run: () => void openTheme() },
        { label: "Export…", group: "Deck", run: () => openExport() },
        {
            label: "Handout view (slides with their notes)",
            group: "Deck",
            run: () => window.open("/handout", "_blank", "noopener"),
        },
        {
            label: "Slide master",
            group: "View",
            run: () => void openMaster(),
        },
        {
            label: "Grid view",
            group: "View",
            keys: keyLabel("view.grid"),
            run: () => toggleGrid(),
        },
        {
            label: "Show / hide the slide list",
            group: "View",
            keys: keyLabel("view.left"),
            run: () => togglePanel("left"),
        },
        {
            label: "Show / hide the notes",
            group: "View",
            keys: keyLabel("view.bottom"),
            run: () => togglePanel("bottom"),
        },
        {
            label: "Show / hide the properties",
            group: "View",
            keys: keyLabel("view.right"),
            run: () => togglePanel("right"),
        },
        {
            label: "Full screen",
            group: "View",
            keys: keyLabel("view.fullscreen"),
            run: () => toggleFullscreen(),
        },
        {
            label: "Keyboard shortcuts…",
            group: "Help",
            keys: keyLabel("help.shortcuts"),
            run: () => openShortcuts(),
        },
        { label: "Problems…", group: "Check", run: () => openProblems() },
        {
            label: "Problems on this slide…",
            group: "Check",
            run: () => openProblems(i),
        },
        {
            label: "Add comment",
            group: "Comments",
            keys: keyLabel("review.comment"),
            run: () => addComment(),
        },
        {
            label: "Comments on this slide…",
            group: "Comments",
            run: () => openComments(i),
        },
        {
            label: "Next slide with changes",
            group: "Git",
            keys: keyLabel("review.next-change"),
            run: () => jumpToChange(1),
        },
        {
            label: "Previous slide with changes",
            group: "Git",
            keys: keyLabel("review.prev-change"),
            run: () => jumpToChange(-1),
        },
        {
            label: "Compare this slide with the last commit",
            group: "Git",
            run: () => compareSlide(i),
        },
        {
            label: "Commit this slide…",
            group: "Git",
            run: () => void commitSlides([i]),
        },
        {
            label: "Discard changes to this slide…",
            group: "Git",
            run: () => void discardSlides([i]),
        },
        {
            label: "Compare the deck with the last commit",
            group: "Git",
            run: () =>
                openCompare({ kind: "commit", rev: "HEAD" }, { kind: "live" }),
        },
        {
            label: "Star / unstar this slide",
            group: "Slide",
            keys: keyLabel("slide.star"),
            run: () => void toggleStar([i]),
        },
    ];
    if (editable) {
        out.push(
            {
                label: "New slide like this one",
                group: "Slide",
                keys: keyLabel("slide.new"),
                run: () => void newSlideLike(i),
            },
            {
                label: "Duplicate this slide",
                group: "Slide",
                run: () => void duplicateSlide(i),
            },
            {
                label: "Hide / show this slide",
                group: "Slide",
                run: () => void toggleHidden(i),
            },
            {
                label: "Delete this slide",
                group: "Slide",
                run: () => void deleteSlide(i),
            },
            {
                label: "Add a section here",
                group: "Slide",
                run: () => void addSectionAt(i),
            },
        );
    }
    return out;
}

export function paletteOpen(): boolean {
    return box !== null;
}

export function closePalette(): void {
    box?.remove();
    box = null;
}

/** Open the palette; `query` starts it typed. */
export async function openPalette(query = ""): Promise<void> {
    if (box) {
        box.querySelector("input")?.focus();
        return;
    }
    const input = h("input", {
        type: "text",
        class: "palette-input",
        placeholder: "Type a command or a slide…",
        "aria-label": "Command or slide",
    }) as HTMLInputElement;
    input.value = query;
    const list = h("div", { class: "palette-list", role: "listbox" });
    box = h(
        "div",
        {
            id: "palette",
            onpointerdown: (e: Event) => {
                if (e.target === box) closePalette();
            },
        },
        h("div", { class: "palette-box" }, input, list),
    );
    document.body.append(box);
    input.focus();
    let all: Command[] = [
        ...editorCommands(),
        ...toolbarCommands(),
        ...slideCommands(),
    ];
    let shown: Command[] = [];
    let at = 0;
    const draw = () => {
        shown = rank(all, input.value);
        at = Math.min(at, Math.max(0, shown.length - 1));
        clear(list);
        shown.forEach((c, k) => {
            const row = h(
                "div",
                {
                    class: `palette-row${k === at ? " on" : ""}`,
                    role: "option",
                    "aria-selected": String(k === at),
                    onpointerdown: (e: Event) => {
                        e.preventDefault();
                        run(c);
                    },
                    onpointermove: () => {
                        if (at === k) return;
                        at = k;
                        mark();
                    },
                },
                h("span", { class: "palette-label" }, c.label),
                h("span", { class: "palette-group" }, c.group),
                c.keys ? h("kbd", {}, c.keys) : null,
            );
            list.append(row);
        });
        if (!shown.length)
            list.append(
                h("div", { class: "palette-empty" }, "Nothing matches"),
            );
    };
    const mark = () => {
        list.querySelectorAll(".palette-row").forEach((r, k) => {
            r.classList.toggle("on", k === at);
            r.setAttribute("aria-selected", String(k === at));
        });
        list.children[at]?.scrollIntoView({ block: "nearest" });
    };
    const run = (c: Command) => {
        closePalette();
        c.run();
    };
    input.addEventListener("input", () => {
        at = 0;
        draw();
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = shown.length;
            if (n) at = (at + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
            mark();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[at]) run(shown[at]);
        } else if (e.key === "Escape") {
            e.preventDefault();
            closePalette();
        }
        e.stopPropagation();
    });
    draw();
    // The menus that ask the server (git status, recent decks) join when
    // they answer.
    const more = await Promise.all([
        gitCommands().catch(() => []),
        deckCommands().catch(() => []),
    ]);
    if (!box) return;
    all = [...all, ...more.flat()];
    draw();
}

function wantsPalette(e: KeyboardEvent): boolean {
    if (!matches(e, "help.palette")) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return true;
    // A plain key (Space) only where it would do nothing else: not on a
    // button, in a field, while typing on the slide or in the compare view.
    const target = e.target as HTMLElement | null;
    if (
        target?.closest(
            "input, textarea, select, button, a, [contenteditable], #dialog",
        )
    )
        return false;
    return !document.body.classList.contains("compare-mode") && !ed.richEditing;
}

export function initPalette(): void {
    on("palette", () => void openPalette());
    document.addEventListener(
        "keydown",
        (e) => {
            if (!wantsPalette(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            void openPalette();
        },
        true,
    );
}
