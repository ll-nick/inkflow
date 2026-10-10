// The slide list on the left: thumbnails of every slide in deck order, hidden
// slides included (dimmed), under a header per section (sectionui.ts). Click
// to edit a slide, drag to reorder (the picked slides together, into another
// section too), and the context menu / "+" button add, duplicate, hide and
// delete slides. Every change is a structured edit of the Deck(slides=[...])
// list in deck.py.

import { parseViewBox } from "../shared/viewbox";
import {
    copySlides,
    cutSlides,
    followPastedSlides,
    pasteFromClipboard,
} from "./clipboard";
import { clear, h, icon, toast } from "./dom";
import { openGallery } from "./gallery";
import { edit } from "./net";
import { renameSlideFiles } from "./rename";
import {
    dropOnHeader,
    dropOnSlide,
    sectionGapAtSlide,
    sorterRows,
} from "./sections";
import {
    addSectionAt,
    isCollapsed,
    moveSectionToGap,
    moveSlidesTo,
    revealCurrent,
    sectionHeader,
    sections,
    selectSection,
} from "./sectionui";
import { ed, emit, on } from "./state";
import type { SlideModel } from "./types";

const list = document.getElementById("sorter-list")!;
const addBtn = document.getElementById("sorter-add")!;
const menu = document.getElementById("context-menu")!;

// Click picks one slide; Ctrl/Cmd adds or removes one, Shift a range (for
// copying, cutting or deleting several at once).
// The slide list and the grid view both redraw on "slide-selection".
export function pickSlide(i: number, e: MouseEvent): void {
    ed.focus = "sorter";
    if (e.shiftKey) {
        const [a, b] = [Math.min(ed.current, i), Math.max(ed.current, i)];
        for (let k = a; k <= b; k++) ed.slideSelection.add(k);
        emit("slide-selection");
        return;
    }
    if (e.ctrlKey || e.metaKey) {
        if (!ed.slideSelection.size) ed.slideSelection.add(ed.current);
        if (ed.slideSelection.has(i)) ed.slideSelection.delete(i);
        else ed.slideSelection.add(i);
        emit("slide-selection");
        if (ed.slideSelection.has(i)) gotoSlide(i);
        return;
    }
    ed.slideSelection.clear();
    if (i === ed.current) emit("slide-selection");
    else gotoSlide(i);
}

export async function deleteSlides(): Promise<void> {
    const indices = [...ed.slideSelection].sort((a, b) => a - b);
    if (indices.length <= 1) {
        await deleteSlide(indices[0] ?? ed.current);
        return;
    }
    if (
        !window.confirm(
            `Delete ${indices.length} slides from the deck? (Their files stay on disk.)`,
        )
    ) {
        return;
    }
    const result = await edit({
        action: "slide",
        op: "delete",
        slides: indices,
    });
    if (result.ok) {
        ed.slideSelection.clear();
        ed.current = Math.max(0, indices[0] - 1);
        emit("slide");
    }
}

export function gotoSlide(deckIndex: number): void {
    const n = ed.model?.slides.length ?? 0;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, deckIndex));
    if (i === ed.current) return;
    ed.current = i;
    ed.selection = [];
    ed.scope = null;
    emit("slide");
}

// Thumbnails keyed by their SVG: an edit re-renders only the slides it changed.
// Each view (the slide list, the grid) keeps its own cache, since a DOM node can
// only be in one place.
export class Thumbs {
    private cache = new Map<string, HTMLElement>();
    private used = new Map<string, HTMLElement>();

    begin(): void {
        this.used = new Map();
    }

    end(): void {
        this.cache = this.used;
    }

    thumb(slide: SlideModel): HTMLElement {
        const box = h("div", { class: "thumb" });
        if (slide.visibleIndex == null) {
            box.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
            return box;
        }
        const data = ed.slides[slide.visibleIndex];
        if (!data) return box;
        const cached = this.cache.get(data.svg);
        if (cached && !this.used.has(data.svg)) {
            this.used.set(data.svg, cached);
            return cached;
        }
        this.used.set(data.svg, box);
        box.innerHTML = data.svg;
        const svg = box.querySelector("svg");
        if (svg) {
            const vb = parseViewBox(svg.getAttribute("viewBox"));
            svg.setAttribute("width", "100%");
            svg.setAttribute("height", "100%");
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
            // A slide of another shape than the deck's keeps its own.
            box.style.aspectRatio = `${vb.w} / ${vb.h}`;
            // Thumbnails show the slide's final state, not its first build step.
            svg.querySelectorAll(".anim-pending").forEach((el) => {
                el.classList.remove("anim-pending");
            });
            svg.querySelectorAll("video").forEach((v) => {
                v.removeAttribute("autoplay");
            });
            // Ids inside thumbnails would shadow the canvas's own for url(#…)
            // lookups only if they came first in the document; the canvas does
            // (see editor.html).
        }
        return box;
    }
}

const thumbs = new Thumbs();

/** What is being dragged in the slide list or the grid view. */
export type Drag =
    | { kind: "slides"; slides: number[] }
    | { kind: "section"; section: number };

export const dragging: { now: Drag | null } = { now: null };

/** The slides a drag starting on slide `i` carries: the picked ones when it
 * is one of them, else just it. */
export function dragSlides(i: number): number[] {
    if (ed.slideSelection.size > 1 && ed.slideSelection.has(i)) {
        return [...ed.slideSelection].sort((a, b) => a - b);
    }
    return [i];
}

const DROP_MARKS = ["drop-before", "drop-after", "drop-into"];

export function clearDropMarks(root: Element): void {
    root.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach(
        (el) => {
            el.classList.remove(...DROP_MARKS);
        },
    );
}

/** Mark where a dragged section would land: before section `gap`'s header,
 * or after `last` for the gap past the last section. */
export function markGap(
    root: Element,
    gap: number,
    last: Element | null,
): void {
    clearDropMarks(root);
    const head = root.querySelector(`.section-head[data-section="${gap}"]`);
    if (head) head.classList.add("drop-before");
    else last?.classList.add("drop-after");
}

/** A section dropped on header `k`: before it, or after it when the lower
 * half of a section showing no slides (collapsed or empty) is hit. */
export function headerGap(head: HTMLElement, k: number, e: DragEvent): number {
    const r = head.getBoundingClientRect();
    const lower = e.clientY > r.top + r.height / 2;
    const s = sections()[k];
    return lower && (isCollapsed(k) || !s?.count) ? k + 1 : k;
}

/** Drop past the last row: slides go last (in the last section), a section
 * after the others. */
export function dropAtEnd(drag: Drag): void {
    const all = sections();
    if (drag.kind === "section") {
        void moveSectionToGap(drag.section, all.length);
        return;
    }
    const n = ed.model?.slides.length ?? 0;
    void moveSlidesTo(drag.slides, n, all.length ? all.length - 1 : null);
}

function slideItem(slide: SlideModel, i: number): HTMLElement {
    const item = h(
        "div",
        {
            class: `sorter-item${i === ed.current ? " active" : ""}${ed.slideSelection.has(i) ? " picked" : ""}${slide.visible ? "" : " hidden-slide"}`,
            draggable: ed.model?.deckEditable ? "true" : null,
            title: slide.title ?? slide.id ?? slide.src,
            "data-index": i,
        },
        h("span", { class: "sorter-num" }, String(i + 1)),
        thumbs.thumb(slide),
    );
    item.addEventListener("click", (e) => pickSlide(i, e));
    item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        ed.focus = "sorter";
        if (!ed.slideSelection.has(i)) {
            ed.slideSelection.clear();
            gotoSlide(i);
        }
        openSlideMenu(e.clientX, e.clientY, i);
    });
    item.addEventListener("dragstart", (e) => {
        dragging.now = { kind: "slides", slides: dragSlides(i) };
        e.dataTransfer?.setData("text/plain", String(i));
        item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
        dragging.now = null;
        item.classList.remove("dragging");
        clearDropMarks(list);
    });
    item.addEventListener("dragover", (e) => {
        const drag = dragging.now;
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        if (drag.kind === "section") {
            const gap = sectionGapAtSlide(sections(), i);
            markGap(list, gap, list.lastElementChild);
            return;
        }
        const r = item.getBoundingClientRect();
        clearDropMarks(list);
        item.classList.add(
            e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before",
        );
    });
    item.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const drag = dragging.now;
        clearDropMarks(list);
        if (!drag) return;
        if (drag.kind === "section") {
            const gap = sectionGapAtSlide(sections(), i);
            void moveSectionToGap(drag.section, gap);
            return;
        }
        const r = item.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        const target = dropOnSlide(sections(), i, after);
        void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return item;
}

function headerItem(k: number): HTMLElement {
    const head = sectionHeader(k, "sorter", (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) selectSection(k);
    });
    head.addEventListener("dragstart", (e) => {
        dragging.now = { kind: "section", section: k };
        e.dataTransfer?.setData("text/plain", `section:${k}`);
        head.classList.add("dragging");
    });
    head.addEventListener("dragend", () => {
        dragging.now = null;
        head.classList.remove("dragging");
        clearDropMarks(list);
    });
    head.addEventListener("dragover", (e) => {
        const drag = dragging.now;
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        if (drag.kind === "section") {
            markGap(list, headerGap(head, k, e), list.lastElementChild);
            return;
        }
        clearDropMarks(list);
        head.classList.add("drop-into");
    });
    head.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const drag = dragging.now;
        clearDropMarks(list);
        if (!drag) return;
        if (drag.kind === "section") {
            void moveSectionToGap(drag.section, headerGap(head, k, e));
            return;
        }
        const target = dropOnHeader(sections(), k);
        void moveSlidesTo(drag.slides, target.insertAt, target.section);
    });
    return head;
}

export function renderSorter(): void {
    clear(list);
    thumbs.begin();
    const slides = ed.model?.slides ?? [];
    for (const row of sorterRows(slides.length, sections(), isCollapsed)) {
        list.append(
            row.kind === "header"
                ? headerItem(row.section)
                : slideItem(slides[row.index], row.index),
        );
    }
    thumbs.end();
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

function initListDrop(): void {
    list.addEventListener("dragover", (e) => {
        const drag = dragging.now;
        if (!drag || e.target !== list) return;
        e.preventDefault();
        if (drag.kind === "section") {
            markGap(list, sections().length, list.lastElementChild);
        } else {
            clearDropMarks(list);
            list.lastElementChild?.classList.add("drop-after");
        }
    });
    list.addEventListener("drop", (e) => {
        const drag = dragging.now;
        if (!drag || e.target !== list) return;
        e.preventDefault();
        clearDropMarks(list);
        dropAtEnd(drag);
    });
}

/** After an edit, show the slide at deck index `i` once the rebuild lists it. */
export function followSelect(i: number): void {
    pendingSelect = i;
}

export async function newSlide(
    layout: string | null,
    after = ed.current,
): Promise<void> {
    const result = await edit({
        action: "slide",
        op: "new",
        after,
        layout,
        name: "slide",
    });
    if (result.ok && result.select != null) pendingSelect = result.select;
}

/** A new slide after ``i`` on the same layout as slide ``i`` (Ctrl+M). */
export async function newSlideLike(i = ed.current): Promise<void> {
    const result = await edit({
        action: "slide",
        op: "new",
        after: i,
        like: i,
        name: "slide",
    });
    if (result.ok && result.select != null) pendingSelect = result.select;
}

export async function duplicateSlide(i = ed.current): Promise<void> {
    const result = await edit({ action: "slide", op: "duplicate", slide: i });
    if (result.ok && result.select != null) pendingSelect = result.select;
}

export async function deleteSlide(i = ed.current): Promise<void> {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    const name = slide.title ?? slide.id ?? `slide ${i + 1}`;
    if (
        !window.confirm(
            `Delete “${name}” from the deck? (Its files stay on disk.)`,
        )
    ) {
        return;
    }
    const result = await edit({ action: "slide", op: "delete", slide: i });
    if (result.ok) {
        ed.current = Math.max(0, i - 1);
        emit("slide");
    }
}

export async function toggleHidden(i = ed.current): Promise<void> {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    await edit({
        action: "slide",
        op: "hide",
        slide: i,
        hidden: slide.visible,
    });
}

// After an insert, follow the new slide once the rebuild lists it.
let pendingSelect: number | null = null;

export function closeMenu(): void {
    menu.classList.remove("open");
    clear(menu);
}

export function menuItem(
    label: string,
    fn: () => void,
    disabled = false,
): HTMLElement {
    return h(
        "button",
        {
            type: "button",
            class: "menu-item",
            disabled,
            onclick: () => {
                closeMenu();
                fn();
            },
        },
        label,
    );
}

export function openSlideMenu(x: number, y: number, i: number): void {
    const slide = ed.model?.slides[i];
    const editable = !!ed.model?.deckEditable;
    const many = ed.slideSelection.size > 1;
    clear(menu);
    menu.append(
        menuItem(
            many ? `Copy ${ed.slideSelection.size} slides` : "Copy",
            () => void copySlides(),
        ),
    );
    menu.append(
        menuItem(
            many ? "Cut slides" : "Cut",
            () => void cutSlides(),
            !editable,
        ),
    );
    menu.append(
        menuItem(
            "Paste after this slide",
            () => void pasteFromClipboard(),
            !editable,
        ),
    );
    if (many) {
        menu.append(
            menuItem(
                `Delete ${ed.slideSelection.size} slides`,
                () => void deleteSlides(),
                !editable,
            ),
        );
        showMenu(x, y);
        return;
    }
    menu.append(
        menuItem(
            "New slide after…",
            () => void openGallery({ mode: "insert", after: i }),
            !editable,
        ),
    );
    menu.append(menuItem("Duplicate", () => void duplicateSlide(i), !editable));
    menu.append(
        menuItem(
            slide?.visible ? "Hide (skip in presentation)" : "Show",
            () => void toggleHidden(i),
            !editable,
        ),
    );
    menu.append(
        menuItem("Rename files…", () => renameSlideFiles(i), !editable),
    );
    menu.append(menuItem("Delete", () => void deleteSlide(i), !editable));
    menu.append(
        menuItem("Add section here…", () => void addSectionAt(i), !editable),
    );
    showMenu(x, y);
}

export function showMenu(x: number, y: number): void {
    menu.classList.add("open");
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

export function initSorter(): void {
    on("model", () => {
        followPastedSlides();
        const n = ed.model?.slides.length ?? 0;
        if (pendingSelect != null && pendingSelect < n) {
            ed.current = pendingSelect;
            pendingSelect = null;
            emit("slide");
        }
        if (ed.current >= n) ed.current = Math.max(0, n - 1);
        renderSorter();
    });
    on("slide", () => {
        revealCurrent();
        renderSorter();
    });
    on("slide-selection", renderSorter);
    on("sections", renderSorter);
    initListDrop();
    addBtn.addEventListener("click", () => {
        if (!ed.model?.deckEditable) {
            toast(
                "deck.py builds its slides in code; add slides there",
                "error",
            );
            return;
        }
        void openGallery({ mode: "insert", after: ed.current });
    });
    document.addEventListener("pointerdown", (e) => {
        if (!menu.contains(e.target as Node)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
    });
}
