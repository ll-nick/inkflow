// Starred slides: the author's marks on the slides to come back to. A star
// is on a slide's row in the slide list and in the grid view (click it, or
// press S), the grid can show the starred slides only, and `inkflow outline
// --starred` lists them for an agent. The server keeps them by slide id in
// .inkflow/stars.json (inkflow/editor/stars.py): no file of the deck
// changes, nothing is rebuilt, and an export or a presentation never shows
// them. The model lists the starred ids (`stars`); a `stars` message
// follows every change.

import { h } from "./dom";
import { edit, onMessage } from "./net";
import { starsOn, starTargets, starTitle } from "./starstext";
import { ed, emit } from "./state";

function starred(): Set<string> {
    return new Set(ed.model?.stars ?? []);
}

export function isStarred(deckIndex: number): boolean {
    const id = ed.model?.slides[deckIndex]?.id;
    return id != null && (ed.model?.stars ?? []).includes(id);
}

export function starCount(): number {
    return ed.model?.stars?.length ?? 0;
}

function setStars(ids: unknown): void {
    if (!ed.model || !Array.isArray(ids)) return;
    ed.model.stars = ids.filter((id): id is string => typeof id === "string");
    emit("stars");
}

/** Star the slides (deck indices), or take their stars off when all of them
 * have one. */
export async function toggleStar(indices: number[]): Promise<void> {
    const slides = ed.model?.slides ?? [];
    const on = starsOn(
        indices.map((i) => slides[i]?.id),
        starred(),
    );
    const result = await edit({ action: "star", slides: indices, on });
    if (result.ok) setStars(result.stars);
}

/** S: the picked slides in the list or grid, else the slide being edited. */
export function starSelection(): void {
    void toggleStar(starTargets(ed.focus, ed.slideSelection, ed.current));
}

/** The star on a slide's row or grid tile: shown when the slide is starred
 * or the pointer is over the row; a click sets or clears it. */
export function starButton(deckIndex: number): HTMLElement {
    const on = isStarred(deckIndex);
    const button = h(
        "button",
        {
            type: "button",
            class: `star-btn${on ? " on" : ""}`,
            "aria-pressed": String(on),
            title: starTitle(on),
            draggable: "false",
        },
        on ? "★" : "☆",
    );
    button.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggleStar([deckIndex]);
    });
    button.addEventListener("dblclick", (e) => e.stopPropagation());
    return button;
}

/** Bring a row's star in line with the model (the rows are kept between
 * rebuilds: sorter.ts). */
export function markStar(item: Element, deckIndex: number): void {
    const on = isStarred(deckIndex);
    item.classList.toggle("starred", on);
    const button = item.querySelector(".star-btn");
    if (!button || button.classList.contains("on") === on) return;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("title", starTitle(on));
    button.textContent = on ? "★" : "☆";
}

export function initStars(): void {
    onMessage("stars", (msg) => setStars(msg.stars));
}
