// The slide list on the left: thumbnails of every slide in deck order, hidden
// slides included (dimmed), under a header per section (sectionui.ts). Click
// to edit a slide, drag to reorder (the picked slides together, into another
// section too), and the context menu / "+" button add, duplicate, hide and
// delete slides. Every change is a structured edit of the Deck(slides=[...])
// list in deck.py.

import { scheduleFit } from "../shared/fit";
import { parseViewBox } from "../shared/viewbox";
import {
    copySlides,
    cutSlides,
    followPastedSlides,
    pasteFromClipboard,
} from "./clipboard";
import { commentBadge, commentItems, markComments } from "./comments";
import { askSlideDelete } from "./deletedlg";
import { slideQuestion } from "./deletetext";
import { clear, h, icon, toast } from "./dom";
import { openGallery } from "./gallery";
import { saveAsLayout } from "./master";
import { edit } from "./net";
import { markProblems, problemBadge } from "./problems";
import { renameSlideFiles } from "./rename";
import {
    dropOnHeader,
    dropOnSlide,
    type Row,
    sectionGapAtSlide,
    sorterRows,
} from "./sections";
import {
    addSectionAt,
    headerPending,
    isCollapsed,
    moveSectionToGap,
    moveSlidesTo,
    revealCurrent,
    sectionHeader,
    sections,
    selectSection,
} from "./sectionui";
import { changeBadge, markChange, slideGitItems } from "./slidegit";
import { isStarred, markStar, starButton, toggleStar } from "./stars";
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
    const req = { action: "slide", op: "delete", slides: indices };
    const names = indices.map((i) => slideName(i));
    const answer = await askSlideDelete(
        slideQuestion(names),
        indices.length,
        req,
    );
    if (!answer) return;
    const result = await edit({ ...req, files: answer.files });
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

// Thumbnails keyed by their slide: an edit re-renders only the slides it
// changed. A thumbnail is drawn when it comes near the part of its list that
// is on screen and emptied again when it leaves, so a deck of hundreds of
// slides costs the page what a screenful does (every slide drawn at once was
// most of a 300-slide deck's load time, and of every switch of slide).
// Each view (the slide list, the grid) keeps its own cache, since a DOM node
// can only be in one place.
export class Thumbs {
    private cache = new Map<string, HTMLElement>();
    private used = new Map<string, HTMLElement>();
    private drawn = new WeakMap<Element, string>();
    private svgs = new WeakMap<Element, string>();
    private watch: IntersectionObserver | null = null;

    /** `scroller` is the element the thumbnails scroll in. */
    constructor(private scroller: HTMLElement) {}

    begin(): void {
        this.used = new Map();
    }

    end(): void {
        for (const [key, box] of this.cache) {
            if (this.used.get(key) !== box) this.watch?.unobserve(box);
        }
        this.cache = this.used;
    }

    /** A thumbnail taken out of its view by hand is no longer kept. */
    forget(svg: string | undefined): void {
        const box = svg == null ? undefined : this.cache.get(svg);
        if (!box || box.isConnected) return;
        this.watch?.unobserve(box);
        this.cache.delete(svg as string);
    }

    private observer(): IntersectionObserver | null {
        if (this.watch || typeof IntersectionObserver === "undefined") {
            return this.watch;
        }
        this.watch = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) this.draw(entry.target);
                    else this.empty(entry.target);
                }
            },
            // A screenful ahead in both directions, so scrolling shows
            // thumbnails, not boxes filling in.
            { root: this.scroller, rootMargin: "100% 0px" },
        );
        return this.watch;
    }

    private empty(box: Element): void {
        if (!this.drawn.has(box)) return;
        this.drawn.delete(box);
        box.replaceChildren();
    }

    private draw(box: Element): void {
        const markup = this.svgs.get(box);
        if (markup == null || this.drawn.get(box) === markup) return;
        this.drawn.set(box, markup);
        box.innerHTML = markup;
        const svg = box.querySelector("svg");
        if (!svg) return;
        const vb = parseViewBox(svg.getAttribute("viewBox"));
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
        // Thumbnails show the slide's final state, not its first build step.
        svg.querySelectorAll(".anim-pending").forEach((el) => {
            el.classList.remove("anim-pending");
        });
        svg.querySelectorAll("video").forEach((v) => {
            v.removeAttribute("autoplay");
        });
        // Its text fitted once it is in the page.
        scheduleFit(svg);
        // Ids inside thumbnails would shadow the canvas's own for url(#…)
        // lookups only if they came first in the document; the canvas does
        // (see editor.html).
    }

    thumb(slide: SlideModel): HTMLElement {
        const box = h("div", { class: "thumb" });
        if (slide.visibleIndex == null) {
            box.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
            return box;
        }
        const data = ed.slides[slide.visibleIndex];
        if (!data) return box;
        // By its markup: a slide whose notes or title changed looks the same.
        const key = data.svg;
        const cached = this.cache.get(key);
        if (cached && !this.used.has(key)) {
            this.used.set(key, cached);
            return cached;
        }
        this.used.set(key, box);
        this.svgs.set(box, data.svg);
        // A slide of another shape than the deck's keeps its own, known
        // before it is drawn so the list does not move when it is.
        const vb = parseViewBox(rootViewBox(data.svg));
        box.style.aspectRatio = `${vb.w} / ${vb.h}`;
        const watch = this.observer();
        if (watch) watch.observe(box);
        else this.draw(box);
        return box;
    }
}

const ROOT_VIEWBOX = /^<svg\b[^>]*?\sviewBox="([^"]*)"/;

/** A slide's viewBox attribute read off its markup, without parsing it. */
function rootViewBox(svg: string): string | null {
    const open = svg.slice(0, svg.indexOf(">") + 1);
    return ROOT_VIEWBOX.exec(open)?.[1] ?? null;
}

const thumbs = new Thumbs(list);

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
        slide.visible ? starButton(i) : null,
        changeBadge(i),
        problemBadge(i),
        commentBadge(i),
    );
    item.classList.toggle("starred", isStarred(i));
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

// What each row of the list shows, as last drawn. A render that would draw
// the same rows only moves the marks (the current slide, the picked ones),
// and one in which some slides look different draws those rows again:
// drawing the whole list for every rebuild and every click cost a 300-slide
// deck a third of a second each time.
interface RowFacts {
    text: string;
    svg: string | undefined;
}
let drawn: RowFacts[] = [];
let items: HTMLElement[] = [];

function rowFacts(row: Row): RowFacts {
    const editable = !!ed.model?.deckEditable;
    if (row.kind === "header") {
        const s = sections()[row.section];
        const text = `h ${row.section} ${s?.count} ${isCollapsed(row.section)} ${editable} ${s?.name}`;
        return { text, svg: undefined };
    }
    const slide = ed.model?.slides[row.index];
    const data =
        slide?.visibleIndex != null ? ed.slides[slide.visibleIndex] : null;
    return {
        text: `s ${row.index} ${slide?.visible} ${editable} ${slide?.title ?? slide?.id ?? slide?.src}`,
        svg: data?.svg,
    };
}

function rowItem(row: Row): HTMLElement {
    const slides = ed.model?.slides ?? [];
    return row.kind === "header"
        ? headerItem(row.section)
        : slideItem(slides[row.index], row.index);
}

function markRows(): void {
    for (const item of items) {
        if (!item.classList.contains("sorter-item")) continue;
        const i = Number(item.dataset.index);
        item.classList.toggle("active", i === ed.current);
        item.classList.toggle("picked", ed.slideSelection.has(i));
        markStar(item, i);
        markChange(item, i);
        markProblems(item, i);
        markComments(item, i);
    }
}

/** Draw the slide list. `anew` draws every row again whatever it showed
 * (a section being renamed, a header's state the rows do not tell). */
export function renderSorter(anew = false): void {
    const slides = ed.model?.slides ?? [];
    const rows = sorterRows(slides.length, sections(), isCollapsed);
    const facts = rows.map(rowFacts);
    const sameRows =
        !anew &&
        !headerPending() &&
        facts.length === drawn.length &&
        facts.every((f, i) => f.text === drawn[i].text);
    const before = list.querySelector(".active");
    if (sameRows) {
        facts.forEach((f, i) => {
            if (f.svg === drawn[i].svg) return;
            const fresh = rowItem(rows[i]);
            items[i].replaceWith(fresh);
            items[i] = fresh;
            thumbs.forget(drawn[i].svg);
        });
        drawn = facts;
        markRows();
    } else {
        // The list keeps its place: only what it shows is drawn (Thumbs),
        // and a list that jumped would draw another screenful.
        const top = list.scrollTop;
        drawn = facts;
        clear(list);
        thumbs.begin();
        items = rows.map(rowItem);
        list.append(...items);
        thumbs.end();
        list.scrollTop = top;
    }
    const active = list.querySelector(".active");
    if (active !== before || !sameRows) {
        active?.scrollIntoView({ block: "nearest" });
    }
    emit("sorter");
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
    const req = { action: "slide", op: "delete", slide: i };
    const answer = await askSlideDelete(slideQuestion([slideName(i)]), 1, req);
    if (!answer) return;
    const result = await edit({ ...req, files: answer.files });
    if (result.ok) {
        ed.current = Math.max(0, i - 1);
        emit("slide");
    }
}

function slideName(i: number): string {
    const slide = ed.model?.slides[i];
    return slide?.title ?? slide?.id ?? `slide ${i + 1}`;
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
                `Star ${ed.slideSelection.size} slides (or take their stars off)`,
                () => void toggleStar([...ed.slideSelection]),
            ),
        );
        menu.append(
            menuItem(
                `Delete ${ed.slideSelection.size} slides`,
                () => void deleteSlides(),
                !editable,
            ),
        );
        menu.append(...slideGitItems(i, menuItem));
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
    if (slide?.visible) {
        menu.append(
            menuItem(
                isStarred(i) ? "Take the star off" : "Star",
                () => void toggleStar([i]),
            ),
        );
    }
    menu.append(
        menuItem("Rename files…", () => renameSlideFiles(i), !editable),
    );
    menu.append(menuItem("Save as layout…", () => saveAsLayout(i), !editable));
    menu.append(menuItem("Delete", () => void deleteSlide(i), !editable));
    menu.append(
        menuItem("Add section here…", () => void addSectionAt(i), !editable),
    );
    const notes = commentItems(i, menuItem);
    if (notes.length) menu.append(h("div", { class: "menu-sep" }), ...notes);
    menu.append(...slideGitItems(i, menuItem));
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
    on("slide-selection", () => renderSorter());
    on("stars", () => renderSorter());
    on("slide-git", () => renderSorter());
    on("problems", () => renderSorter());
    on("comments", () => renderSorter());
    on("sections", () => renderSorter(true));
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
