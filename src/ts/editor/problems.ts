// Problems: each slide's row and grid tile carry a mark when the server's
// checks found something wrong with it (editor/problems.py): what
// `inkflow verify` finds after every build, and, once turned on in the
// Problems list, what `inkflow render --check` measures in a browser (text
// that does not fit, objects outside the slide, text too small, pictures too
// coarse; contrast only when ticked). The toolbar's ⚠ button opens the list;
// clicking a slide there goes to it.

import { closeDialog, dialogOpen, openDialog } from "./dialog";
import { clear, h } from "./dom";
import { onMessage, sendRaw } from "./net";
import {
    countMarked,
    type LayoutState,
    layoutWords,
    marked,
    type Problem,
    problemTitle,
    slidesWithProblems,
    worst,
} from "./problemstext";
import { gotoSlide } from "./sorter";
import { ed, emit, on } from "./state";

const button = document.getElementById("btn-problems") as HTMLButtonElement;
const CONTRAST_KEY = "inkflow-editor-check-contrast";
const HINTS_KEY = "inkflow-editor-problem-hints";

let problems: Problem[][] = [];
let layout: LayoutState = {
    on: false,
    contrast: false,
    running: false,
    error: null,
};
let listBody: HTMLElement | null = null;
let onlySlide: number | null = null;

function pref(key: string): boolean {
    try {
        return localStorage.getItem(key) === "1";
    } catch {
        return false;
    }
}

function setPref(key: string, on: boolean): void {
    try {
        localStorage.setItem(key, on ? "1" : "");
    } catch {
        // not remembered
    }
}

export function slideProblems(i: number): Problem[] {
    return problems.length === (ed.model?.slides.length ?? -1)
        ? (problems[i] ?? [])
        : [];
}

function paint(badge: Element, list: Problem[]): void {
    const shown = marked(list);
    const level = worst(shown);
    badge.textContent = shown.length ? "⚠" : "";
    badge.className = `problem-mark${level ? ` p-${level}` : ""}`;
    if (shown.length) badge.setAttribute("title", problemTitle(list));
    else badge.removeAttribute("title");
}

/** The mark on a slide's row or tile; a click lists its problems. */
export function problemBadge(i: number): HTMLElement {
    const badge = h("span", { class: "problem-mark" });
    paint(badge, slideProblems(i));
    badge.addEventListener("click", (e) => {
        if (!badge.textContent) return;
        e.stopPropagation();
        openProblems(i);
    });
    return badge;
}

export function markProblems(item: Element, i: number): void {
    const badge = item.querySelector(".problem-mark");
    if (badge) paint(badge, slideProblems(i));
}

function renderButton(): void {
    const n = countMarked(problems);
    button.hidden = !n && !layout.running;
    button.classList.toggle("busy", layout.running);
    button.querySelector(".problem-count")!.textContent = n ? String(n) : "";
    button.title = layout.running
        ? "Checking the layout…"
        : `${n} problem${n === 1 ? "" : "s"} on the slides`;
}

function slideName(i: number): string {
    const slide = ed.model?.slides[i];
    return slide?.title ?? slide?.id ?? `slide ${i + 1}`;
}

function renderList(): void {
    if (!listBody) return;
    const hints = pref(HINTS_KEY);
    const indices =
        onlySlide != null ? [onlySlide] : slidesWithProblems(problems, hints);
    clear(listBody);
    if (!indices.length || !slideProblems(indices[0]).length) {
        listBody.append(
            h("p", { class: "hint" }, "No problems found on the slides."),
        );
        return;
    }
    for (const i of indices) {
        const list = hints ? slideProblems(i) : marked(slideProblems(i));
        if (!list.length) continue;
        listBody.append(
            h(
                "button",
                {
                    type: "button",
                    class: "problem-slide",
                    title: "Go to this slide",
                    onclick: () => {
                        closeDialog();
                        ed.slideSelection.clear();
                        gotoSlide(i);
                    },
                },
                `${i + 1} · ${slideName(i)}`,
            ),
            h(
                "ul",
                { class: "problem-list" },
                ...list.map((p) =>
                    h(
                        "li",
                        { class: `p-${p.level}` },
                        h(
                            "span",
                            { class: "problem-level" },
                            p.level === "error"
                                ? "✖"
                                : p.level === "warn"
                                  ? "⚠"
                                  : "·",
                        ),
                        h("span", {}, p.message),
                    ),
                ),
            ),
        );
    }
}

/** The Problems list: every slide's, or slide `only`'s. */
export function openProblems(only: number | null = null): void {
    onlySlide = only;
    const contrast = h("input", { type: "checkbox" }) as HTMLInputElement;
    contrast.checked = pref(CONTRAST_KEY);
    const hints = h("input", { type: "checkbox" }) as HTMLInputElement;
    hints.checked = pref(HINTS_KEY);
    const status = h("p", { class: "hint" });
    const toggle = h("button", { type: "button", class: "pbtn" });
    const drawState = () => {
        status.textContent = layoutWords(layout);
        status.classList.toggle("warn", !!layout.error);
        toggle.textContent = layout.on
            ? "Stop checking the layout"
            : "Check the layout";
        toggle.classList.toggle("primary", !layout.on);
    };
    toggle.addEventListener("click", () => {
        sendRaw({
            type: "problems-check",
            on: !layout.on,
            contrast: contrast.checked,
        });
    });
    contrast.addEventListener("change", () => {
        setPref(CONTRAST_KEY, contrast.checked);
        if (layout.on)
            sendRaw({
                type: "problems-check",
                on: true,
                contrast: contrast.checked,
            });
    });
    hints.addEventListener("change", () => {
        setPref(HINTS_KEY, hints.checked);
        renderList();
    });
    listBody = h("div", { class: "problem-body" });
    const box = openDialog(
        only != null ? `Problems on slide ${only + 1}` : "Problems",
        h(
            "div",
            { class: "git-form" },
            h(
                "div",
                { class: "btn-row" },
                toggle,
                h(
                    "label",
                    { class: "problem-opt" },
                    contrast,
                    h("span", {}, "Also check text contrast"),
                ),
                h(
                    "label",
                    { class: "problem-opt" },
                    hints,
                    h("span", {}, "Show hints"),
                ),
                only != null
                    ? h(
                          "button",
                          {
                              type: "button",
                              class: "link-btn",
                              onclick: () => {
                                  onlySlide = null;
                                  renderList();
                              },
                          },
                          "All slides",
                      )
                    : null,
            ),
            status,
            listBody,
        ),
        {
            wide: true,
            onClose: () => {
                listBody = null;
            },
        },
    );
    box.classList.add("problems-dialog");
    drawState();
    renderList();
    redraw = drawState;
}

let redraw: (() => void) | null = null;

export function initProblems(): void {
    button.addEventListener("click", () => openProblems());
    onMessage("problems", (msg) => {
        problems = (msg.slides as Problem[][] | undefined) ?? [];
        layout = (msg.layout as LayoutState | undefined) ?? layout;
        renderButton();
        if (listBody && dialogOpen()) {
            renderList();
            redraw?.();
        }
        emit("problems");
    });
    on("model", renderButton);
}
